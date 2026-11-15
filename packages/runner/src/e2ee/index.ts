import { type ChannelLayer, createPlainLayer, type JsonRpcMessage, type PakeStart } from "@berdyh/bridge-protocol";

import type { BrowserChannel } from "../acp/contracts.js";
import type { E2eeApp, EnrollmentWire, EnrollPrompt, EnrollResult, RunnerE2eeContext, RunnerWire, TrustedBrowser } from "./contracts.js";
import { acceptEnrollmentImpl, enrollImpl, type EnrollOptions } from "./enrollment.js";
import { createRunnerE2eeLayer, dropLive, registerLive } from "./layer.js";
import { mutateTrustList, readTrustList } from "./store.js";

export type * from "./contracts.js";
export { EnrollError, type EnrollOptions, recordDecision } from "./enrollment.js";
export { type EnrollmentDecision, type EnrollWindow, type PendingEnrollment, readEnrollWindow, removeAppState, TrustListError, wrapKeyNameOf } from "./store.js";
/** Advisory lock around a read-modify-write of a state file (`<file>.lock`, in-process and cross-process). */
export { withFileLock } from "./fsutil.js";

/**
 * Builds a `BrowserChannel` from a wire and a layer: starts the layer's session
 * setup first, then seals outgoing messages and opens incoming frames strictly in
 * order. Any layer failure (replay, gap, bad tag) closes the channel and the wire.
 * Shared by the plaintext default below and by the encrypted layer. One wire and
 * one layer are one session: when a newer session for the same `browserKeyId`
 * starts, the demultiplexer closes this wire and builds a new wire and channel (see
 * "Sessions" on `ChannelLayer`).
 */
export function channelFromLayer(wire: RunnerWire, layer: ChannelLayer, channelId: string = `${wire.appId}/${wire.browserKeyId}`): BrowserChannel {
  const messageHandlers = new Set<(m: JsonRpcMessage) => void>();
  const closeHandlers = new Set<(reason?: string) => void>();
  let closed = false;
  let inbound: Promise<unknown> = Promise.resolve();

  const shut = (reason?: string): void => {
    if (closed) return;
    closed = true;
    layer.close();
    wire.close(reason);
    for (const h of [...closeHandlers]) h(reason);
    closeHandlers.clear();
    messageHandlers.clear();
  };

  const ready = layer.start(wire.handshake).catch((e: unknown) => {
    shut(e instanceof Error ? e.message : "handshake failed");
    throw e;
  });
  ready.then(
    () => {
      if (!closed) wire.bindSession(layer.kid);
    },
    () => {},
  );

  wire.onFrame((frame) => {
    inbound = inbound
      .then(() => ready)
      .then(async () => {
        // An encrypted layer must never see a frame of another session: any decrypt
        // fault, even `bad_kid`, destroys its codec. Such frames are dropped here, and
        // the reliable link has already answered them (Sessions rule 3).
        if (layer.kind === "e2ee" && frame.kid !== layer.kid) return;
        const message = await layer.open(frame);
        if (!closed) for (const h of [...messageHandlers]) h(message);
      })
      .catch(() => shut("channel error"));
  });
  wire.onClose((reason) => shut(reason));

  let outbound: Promise<unknown> = Promise.resolve();
  return {
    channelId,
    appId: wire.appId,
    browserKeyId: wire.browserKeyId,
    get closed() {
      return closed;
    },
    send(message) {
      if (closed) return;
      outbound = outbound
        .then(() => ready)
        .then(() => layer.seal(message))
        .then((frame) => {
          if (!closed) wire.sendFrame(frame);
        })
        .catch(() => shut("channel error"));
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => void messageHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => void closeHandlers.delete(handler);
    },
    close: shut,
  };
}

/**
 * The CLI passes every browser wire through this. With `ctx.e2ee` false it is the
 * plaintext layer (the plaintext test harness, `BRIDGE_E2EE=0`). With `ctx.e2ee` it is the
 * encrypted layer: the session handshake runs against the trust list, plaintext
 * frames are refused, and revoking the browser closes the channel.
 */
export function wrapRunnerChannel(wire: RunnerWire, ctx: RunnerE2eeContext): BrowserChannel {
  if (!ctx.e2ee) return channelFromLayer(wire, createPlainLayer(wire.kid === undefined ? {} : { kid: wire.kid }));
  const suffix = wire.sid ?? globalThis.crypto.randomUUID();
  const channel = channelFromLayer(wire, createRunnerE2eeLayer(wire, ctx), `${wire.appId}/${wire.browserKeyId}/${suffix}`);
  const unregister = registerLive(ctx.app, { browserKeyId: wire.browserKeyId, close: (reason) => channel.close(reason) });
  channel.onClose(unregister);
  if (channel.closed) unregister();
  return channel;
}

/**
 * The daemon-side half of enrollment. The CLI calls it for every `EnrollmentWire`, i.e.
 * for every `pake/start` that opens an enrollment attempt, handing over that first
 * message too (so the wire never has to buffer it). It runs the `pake/*` exchange
 * on `wire.handshake` against the enrollment window that `enroll` opened (the two
 * are separate processes and share state through files under the app's bridge config folder (`ctx.app.paths.configDir`)),
 * and resolves when the attempt has ended with `pake/done`, ok or not. With no
 * window open it answers `pake/done { ok: false, reason: "no_enrollment_open" }`
 * itself. The wire is closed by the link after the `pake/done` is sent.
 *
 * The attempt is charged when `pake/reply` is sent, and the browser's details go to
 * the process running `enroll` for the local user's yes or no. Two waits bound the
 * attempt: the exchange up to the browser's details by `HANDSHAKE_TIMEOUT_MS`, and the
 * user's answer by the life of the code (`ENROLL_CODE_TTL_MS`), because a person at a
 * terminal takes longer than a handshake. The browser is added to the trust list, and
 * the code consumed, here and only here: in one locked step, while the wire is still
 * open and `pake/done` can be sent. A yes that arrives after the wire is gone is
 * discarded and trusts no one.
 */
export function acceptEnrollment(wire: EnrollmentWire, start: PakeStart, ctx: RunnerE2eeContext): Promise<void> {
  return acceptEnrollmentImpl(wire, start, ctx);
}

/**
 * Opens an enrollment window for `app`: creates the 8-character code (10 minutes,
 * single use, 5 attempts), shows it through `prompt`, and resolves when a browser
 * completes SPAKE2 and the local user confirms. The browser is then in the trust
 * list. A rejected browser leaves the window open for another try; expiry, a locked
 * code or `options.signal` reject with `EnrollError`.
 */
export function enroll(app: E2eeApp, prompt: EnrollPrompt, options?: EnrollOptions): Promise<EnrollResult> {
  return enrollImpl(app, prompt, options);
}

/** The trusted browsers of `app`, oldest first. Throws `TrustListError` on a corrupt file. */
export async function listBrowsers(app: E2eeApp): Promise<TrustedBrowser[]> {
  return (await readTrustList(app)).sort((a, b) => a.enrolledAt.localeCompare(b.enrolledAt));
}

/**
 * Removes a browser from the trust list and drops its live channel at once. In the
 * daemon's own process the channel closes immediately; a daemon in another process
 * (`bridge browsers revoke`) notices the changed trust file within a poll interval,
 * and in every case the revoked key's next `session/init` fails the trust lookup.
 */
export async function revokeBrowser(app: E2eeApp, browserKeyId: string): Promise<boolean> {
  const removed = await mutateTrustList(app, (list) => {
    const next = list.filter((entry) => entry.browserKeyId !== browserKeyId);
    return next.length === list.length ? { result: false } : { list: next, result: true };
  });
  dropLive(app, browserKeyId);
  return removed;
}
