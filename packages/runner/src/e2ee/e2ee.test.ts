import { existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  base64UrlDecode,
  base64UrlEncode,
  createFrameCodec,
  createSpake2,
  deriveChannelKeys,
  generateKeyPair,
  type FrameCodec,
  type KeyPair,
} from "@berdyh/bridge-crypto";
import {
  ENROLL_CODE_TTL_MS,
  HANDSHAKE_TIMEOUT_MS,
  type E2EEFrame,
  type HandshakeIO,
  type JsonRpcMessage,
  type PakeDone,
  type PakeMessage,
  type PakeReply,
  type SequencedFrame,
  isE2EEFrame,
} from "@berdyh/bridge-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type E2eeApp,
  type EnrollmentWire,
  EnrollError,
  type RunnerWire,
  acceptEnrollment,
  enroll,
  listBrowsers,
  type PendingEnrollment,
  readEnrollWindow,
  recordDecision,
  revokeBrowser,
  wrapRunnerChannel,
} from "./index.js";
import { enrollAad } from "./enrollment.js";
import { mutateTrustList, statePath } from "./store.js";
import { appPathsOf } from "../paths.js";

// --- harness --------------------------------------------------------------------

let dir: string;
let app: E2eeApp;
const ctxOf = (overrides: Partial<{ now: () => Date; e2ee: boolean }> = {}) => ({ app, e2ee: true, ...overrides });
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-e2ee-"));
  app = { appId: "app", runnerId: "r1", paths: appPathsOf({ config: dir, data: dir, state: dir }, "app") };
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** What the relay would see: every body of a `pake` or `frame` envelope, serialized. */
const relayTap: string[] = [];
beforeEach(() => {
  relayTap.length = 0;
});
const tap = (body: unknown) => void relayTap.push(JSON.stringify(body));

/** The runner's link for one enrolling browser (the CLI's job in production): an `EnrollmentWire` and the browser's end. */
function enrollmentLink(enrollId: string, ctx = ctxOf()) {
  const runnerHandlers = new Set<(m: PakeMessage) => void>();
  const browserHandlers = new Set<(m: PakeMessage) => void>();
  const closeHandlers = new Set<(r?: string) => void>();
  const closes: (string | undefined)[] = [];
  let started: Promise<void> | undefined;
  const wire: EnrollmentWire = {
    appId: app.appId,
    enrollId,
    closed: false,
    handshake: {
      send(m) {
        tap(m);
        queueMicrotask(() => browserHandlers.forEach((h) => h(m)));
      },
      onMessage(h) {
        runnerHandlers.add(h);
        return () => void runnerHandlers.delete(h);
      },
    },
    onClose(h) {
      closeHandlers.add(h);
      return () => void closeHandlers.delete(h);
    },
    close(reason) {
      if (wire.closed) return;
      (wire as { closed: boolean }).closed = true;
      closes.push(reason);
      for (const h of closeHandlers) h(reason);
    },
  };
  const browser: HandshakeIO = {
    send(m) {
      tap(m);
      queueMicrotask(() => {
        if (m.t === "pake/start" && !started) started = acceptEnrollment(wire, m, ctx);
        else runnerHandlers.forEach((h) => h(m));
      });
    },
    onMessage(h) {
      browserHandlers.add(h);
      return () => void browserHandlers.delete(h);
    },
  };
  return { wire, browser, closes, finished: () => started ?? Promise.resolve() };
}

const waitMessage = <T extends PakeMessage["t"]>(io: HandshakeIO, t: T) =>
  new Promise<Extract<PakeMessage, { t: T }>>((resolve) => {
    const off = io.onMessage((m) => {
      if (m.t !== t) return;
      off();
      resolve(m as Extract<PakeMessage, { t: T }>);
    });
  });

/** The browser half of SPAKE2 enrollment, written against bridge-crypto only. */
async function browserEnroll(opts: {
  code: string;
  io: HandshakeIO;
  enrollId: string;
  label?: string;
  keyPair?: KeyPair;
  /** Stop after `pake/reply` without confirming. */
  stopAfterReply?: boolean;
}): Promise<{ done?: PakeDone; early?: PakeDone; runnerPublicKey?: Uint8Array; keyPair: KeyPair; macOk?: boolean; reply?: PakeReply }> {
  const keyPair = opts.keyPair ?? (await generateKeyPair());
  const spake = createSpake2({ role: "browser", password: opts.code, idA: new TextEncoder().encode(opts.enrollId), idB: new TextEncoder().encode(app.runnerId) });
  const replyOrDone = new Promise<PakeReply | PakeDone>((resolve) => {
    const off = opts.io.onMessage((m) => {
      if (m.t === "pake/reply" || m.t === "pake/done") {
        off();
        resolve(m);
      }
    });
  });
  opts.io.send({ t: "pake/start", v: 1, enrollId: opts.enrollId, msg: base64UrlEncode(spake.message) });
  const first = await replyOrDone;
  if (first.t === "pake/done") return { early: first, keyPair };
  if (opts.stopAfterReply) return { keyPair, reply: first };
  const result = spake.finish(base64UrlDecode(first.msg));
  const aad = enrollAad(opts.enrollId, first.codeId, app.runnerId);
  const mac = result.confirmation;
  const sealed = await result.seal(new TextEncoder().encode(JSON.stringify({ publicKey: base64UrlEncode(keyPair.publicKey), label: opts.label ?? "Test browser" })), aad);
  const macOk = result.verifyPeerConfirmation(base64UrlDecode(first.mac));
  const runnerPublicKey = macOk ? await result.open(first.sealed, aad) : undefined;
  const donePromise = waitMessage(opts.io, "pake/done");
  opts.io.send({ t: "pake/confirm", v: 1, enrollId: opts.enrollId, codeId: first.codeId, mac: base64UrlEncode(mac), sealed });
  const done = await donePromise;
  return { done, runnerPublicKey, keyPair, macOk, reply: first };
}

/** Opens an enrollment window with a prompt that records what it was shown. */
function openEnrollment(confirm: (browser: { label: string; keyId: string }) => Promise<boolean> = async () => true, signal?: AbortSignal) {
  const shown: { code?: string; expiresAt?: string } = {};
  const confirmed: { label: string; keyId: string }[] = [];
  let result!: ReturnType<typeof enroll>;
  const codeReady = new Promise<string>((resolve) => {
    const promise = enroll(app, {
      showCode(code, expiresAt) {
        shown.code = code;
        shown.expiresAt = expiresAt;
        resolve(code);
      },
      async confirm(browser) {
        confirmed.push(browser);
        return confirm(browser);
      },
    }, { pollMs: 20, signal });
    promise.catch(() => undefined);
    result = promise;
  });
  return { codeReady, result: () => result, shown, confirmed };
}

const randomId = () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));

/** A `RunnerWire` and the browser's end of it. */
function sessionLink(browserKeyId: string, sid = randomId()) {
  const frameHandlers = new Set<(f: SequencedFrame) => void>();
  const closeHandlers = new Set<(r?: string) => void>();
  const handshakeHandlers = new Set<(m: PakeMessage) => void>();
  const browserHandshake = new Set<(m: PakeMessage) => void>();
  const sent: SequencedFrame[] = [];
  const closes: (string | undefined)[] = [];
  const toBrowser = new Set<(f: SequencedFrame) => void>();
  const wire: RunnerWire = {
    appId: app.appId,
    browserKeyId,
    sid,
    bindSession(kid) {
      (wire as { kid?: string }).kid = kid;
    },
    closed: false,
    handshake: {
      send(m) {
        tap(m);
        queueMicrotask(() => browserHandshake.forEach((h) => h(m)));
      },
      onMessage(h) {
        handshakeHandlers.add(h);
        return () => void handshakeHandlers.delete(h);
      },
    },
    sendFrame(f) {
      tap(f);
      sent.push(f);
      queueMicrotask(() => toBrowser.forEach((h) => h(f)));
    },
    onFrame(h) {
      frameHandlers.add(h);
      return () => void frameHandlers.delete(h);
    },
    onClose(h) {
      closeHandlers.add(h);
      return () => void closeHandlers.delete(h);
    },
    close(reason) {
      if (wire.closed) return;
      (wire as { closed: boolean }).closed = true;
      closes.push(reason);
      for (const h of closeHandlers) h(reason);
    },
  };
  const browserIO: HandshakeIO = {
    send(m) {
      tap(m);
      queueMicrotask(() => handshakeHandlers.forEach((h) => h(m)));
    },
    onMessage(h) {
      browserHandshake.add(h);
      return () => void browserHandshake.delete(h);
    },
  };
  return {
    wire,
    sid,
    browserIO,
    sent,
    closes,
    deliver(frame: SequencedFrame) {
      tap(frame);
      for (const h of [...frameHandlers]) h(frame);
    },
    onBrowserFrame(h: (f: SequencedFrame) => void) {
      toBrowser.add(h);
    },
  };
}

/** The browser half of the session handshake, written against bridge-crypto only. */
async function browserSession(link: ReturnType<typeof sessionLink>, identity: KeyPair, runnerPublicKey: Uint8Array) {
  const ephemeral = await generateKeyPair();
  const accepted = waitMessage(link.browserIO, "session/accept");
  link.browserIO.send({ t: "session/init", v: 1, sid: link.sid, eph: base64UrlEncode(ephemeral.publicKey) });
  const accept = await accepted;
  const keys = await deriveChannelKeys({
    role: "browser",
    ownStatic: identity,
    ownEphemeral: ephemeral,
    peerStaticPublic: runnerPublicKey,
    peerEphemeralPublic: base64UrlDecode(accept.eph),
  });
  const codec: FrameCodec = createFrameCodec(keys);
  const received: JsonRpcMessage[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  link.onBrowserFrame((frame) => {
    chain = chain.then(async () => {
      if (isE2EEFrame(frame)) received.push(await codec.decrypt(frame));
    });
  });
  return { codec, received, kid: codec.kid };
}

/** Enrolls `identity` through the full flow and returns the runner's public key. */
async function enrollBrowser(identity: KeyPair, label = "Test browser", enrollId = randomId()) {
  const window = openEnrollment();
  const code = await window.codeReady;
  const link = enrollmentLink(enrollId);
  const outcome = await browserEnroll({ code, io: link.browser, enrollId, keyPair: identity, label });
  await window.result();
  return { ...outcome, window };
}

const hello = (id = 1): JsonRpcMessage => ({ jsonrpc: "2.0", id, method: "ping", params: { secret: "launch-codes-42" } });

// --- enrollment -----------------------------------------------------------------

describe("enrollment", () => {
  it("enrolls a browser with the code, then they can talk", async () => {
    const identity = await generateKeyPair();
    const { done, runnerPublicKey, window } = await enrollBrowser(identity, "Work laptop");
    expect(done).toMatchObject({ t: "pake/done", ok: true, browserKeyId: identity.id });
    expect(window.shown.code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
    expect(window.confirmed).toEqual([{ label: "Work laptop", keyId: identity.id }]);
    const browsers = await listBrowsers(app);
    expect(browsers).toHaveLength(1);
    expect(browsers[0]).toMatchObject({ browserKeyId: identity.id, label: "Work laptop", publicKey: base64UrlEncode(identity.publicKey) });

    // the window is gone: single use
    await expect(fs.stat(statePath(app, "enroll"))).rejects.toThrow();

    const link = sessionLink(identity.id);
    const channel = wrapRunnerChannel(link.wire, ctxOf());
    const received: JsonRpcMessage[] = [];
    channel.onMessage((m) => received.push(m));
    const browser = await browserSession(link, identity, runnerPublicKey!);
    expect(link.wire.kid).toBe(browser.kid);
    link.deliver(await browser.codec.encrypt(hello(1)));
    await vi_waitFor(() => received.length === 1);
    expect(received[0]).toEqual(hello(1));
    channel.send({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    await vi_waitFor(() => browser.received.length === 1);
    expect(browser.received[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    channel.close();
  });

  it("stores state privately: directories 0700, files 0600", async () => {
    const identity = await generateKeyPair();
    await enrollBrowser(identity);
    for (const kind of ["trust", "identity"] as const) {
      const file = statePath(app, kind);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
  });

  it("keeps one stable identity key per app, and a different one per app", async () => {
    const a = await enrollBrowser(await generateKeyPair());
    const b = await enrollBrowser(await generateKeyPair());
    expect(base64UrlEncode(b.runnerPublicKey!)).toBe(base64UrlEncode(a.runnerPublicKey!));
    const other: E2eeApp = { ...app, appId: "other-app", paths: appPathsOf({ config: dir, data: dir, state: dir }, "other-app") };
    const before = app;
    app = other;
    const c = await enrollBrowser(await generateKeyPair());
    app = before;
    expect(base64UrlEncode(c.runnerPublicKey!)).not.toBe(base64UrlEncode(a.runnerPublicKey!));
    expect(await listBrowsers(other)).toHaveLength(1);
    expect(await listBrowsers(app)).toHaveLength(2);
  });

  it("locks the code after 5 wrong codes, even for the right one, and enroll() rejects", async () => {
    const window = openEnrollment();
    const code = await window.codeReady;
    const failed = window.result().then(() => "ok", (e: unknown) => e);
    const wrong = code[0] === "B" ? `C${code.slice(1)}` : `B${code.slice(1)}`;
    const left: (number | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      const enrollId = randomId();
      const link = enrollmentLink(enrollId);
      const outcome = await browserEnroll({ code: wrong, io: link.browser, enrollId });
      expect(outcome.macOk).toBe(false);
      expect(outcome.done).toMatchObject({ ok: false, reason: "bad_code" });
      left.push(outcome.done!.attemptsLeft);
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    const enrollId = randomId();
    const link = enrollmentLink(enrollId);
    const sixth = await browserEnroll({ code, io: link.browser, enrollId });
    expect(sixth.early).toMatchObject({ ok: false, reason: "locked" });
    const error = await failed;
    expect(error).toBeInstanceOf(EnrollError);
    expect((error as EnrollError).reason).toBe("locked");
    expect(await listBrowsers(app)).toEqual([]);
  });

  it("charges an attempt when pake/reply is sent, not when the confirmation fails", async () => {
    const window = openEnrollment();
    const code = await window.codeReady;
    window.result().catch(() => undefined);
    // five starts that never confirm, one of them a repeat with the same enrollId
    const repeated = randomId();
    for (const enrollId of [randomId(), randomId(), repeated, repeated, randomId()]) {
      const link = enrollmentLink(enrollId);
      const outcome = await browserEnroll({ code, io: link.browser, enrollId, stopAfterReply: true });
      expect(outcome.reply?.t).toBe("pake/reply");
      link.wire.close("browser went away");
      await link.finished();
    }
    const enrollId = randomId();
    const link = enrollmentLink(enrollId);
    const sixth = await browserEnroll({ code, io: link.browser, enrollId });
    expect(sixth.early).toMatchObject({ ok: false, reason: "locked" });
  });

  it("refuses an expired code", async () => {
    const window = openEnrollment();
    const code = await window.codeReady;
    window.result().catch(() => undefined);
    const late = ctxOf({ now: () => new Date(Date.now() + 11 * 60 * 1000) });
    const enrollId = randomId();
    const link = enrollmentLink(enrollId, late);
    const outcome = await browserEnroll({ code, io: link.browser, enrollId });
    expect(outcome.early).toMatchObject({ ok: false, reason: "expired" });
    expect(await listBrowsers(app)).toEqual([]);
  });

  it("answers no_enrollment_open once the code was used", async () => {
    const identity = await generateKeyPair();
    const { window } = await enrollBrowser(identity);
    const enrollId = randomId();
    const link = enrollmentLink(enrollId);
    const again = await browserEnroll({ code: window.shown.code!, io: link.browser, enrollId });
    expect(again.early).toMatchObject({ ok: false, reason: "no_enrollment_open" });
  });

  it("does not trust a browser the local user rejects, and keeps the window for another try", async () => {
    const answers = [false, true];
    const window = openEnrollment(async () => answers.shift()!);
    const code = await window.codeReady;
    const first = await generateKeyPair();
    const firstId = randomId();
    const rejected = await browserEnroll({ code, io: enrollmentLink(firstId).browser, enrollId: firstId, keyPair: first, label: "Stranger" });
    expect(rejected.done).toMatchObject({ ok: false, reason: "rejected_by_user" });
    expect(await listBrowsers(app)).toEqual([]);
    const second = await generateKeyPair();
    const secondId = randomId();
    const accepted = await browserEnroll({ code, io: enrollmentLink(secondId).browser, enrollId: secondId, keyPair: second, label: "Me" });
    expect(accepted.done).toMatchObject({ ok: true, browserKeyId: second.id });
    await expect(window.result()).resolves.toMatchObject({ browserKeyId: second.id, label: "Me" });
    expect((await listBrowsers(app)).map((b) => b.browserKeyId)).toEqual([second.id]);
  });

  it("shows the user a sanitized label (no control or bidi characters)", async () => {
    const identity = await generateKeyPair();
    const { window } = await enrollBrowser(identity, "\u001b[31mEvil‮\nlaptop\u0000");
    expect(window.confirmed[0]!.label).toBe("[31mEvil laptop");
  });

  it("refuses a second open window for the same app and ends cleanly on abort", async () => {
    const controller = new AbortController();
    const prompt = { showCode: () => {}, confirm: async () => true };
    const first = enroll(app, prompt, { signal: controller.signal, pollMs: 20 });
    first.catch(() => undefined);
    await tick(30);
    await expect(enroll(app, prompt)).rejects.toMatchObject({ reason: "already_open" });
    controller.abort();
    await expect(first).rejects.toMatchObject({ reason: "aborted" });
    await expect(fs.stat(statePath(app, "enroll"))).rejects.toThrow();
  });

  it("never trusts a browser when the enrollment was cancelled while the prompt was pending", async () => {
    const controller = new AbortController();
    let answer!: (accepted: boolean) => void;
    let asked = false;
    let shown!: (code: string) => void;
    const code = new Promise<string>((resolve) => (shown = resolve));
    const result = enroll(
      app,
      {
        showCode: (c) => shown(c),
        confirm: () => {
          asked = true;
          return new Promise<boolean>((resolve) => (answer = resolve));
        },
      },
      { signal: controller.signal, pollMs: 20 },
    );
    result.catch(() => undefined);
    const identity = await generateKeyPair();
    const enrollId = randomId();
    const browser = browserEnroll({ code: await code, io: enrollmentLink(enrollId).browser, enrollId, keyPair: identity });
    await vi_waitFor(() => asked);
    controller.abort();
    answer(true); // the user answers after the cancel
    await expect(result).rejects.toMatchObject({ reason: "aborted" });
    const outcome = await browser;
    expect(outcome.done).toMatchObject({ ok: false });
    expect(outcome.done).not.toHaveProperty("proof");
    expect(await listBrowsers(app)).toEqual([]);
  });

  it("answers protocol_error for a malformed SPAKE2 message without charging an attempt", async () => {
    const window = openEnrollment();
    const code = await window.codeReady;
    window.result().catch(() => undefined);
    const enrollId = randomId();
    const link = enrollmentLink(enrollId);
    const done = waitMessage(link.browser, "pake/done");
    link.browser.send({ t: "pake/start", v: 1, enrollId, msg: base64UrlEncode(new Uint8Array(5)) });
    expect(await done).toMatchObject({ ok: false, reason: "protocol_error" });
    const good = randomId();
    const ok = await browserEnroll({ code, io: enrollmentLink(good).browser, enrollId: good });
    expect(ok.done?.ok).toBe(true);
  });

  it("ends the attempt when the wire closes while waiting for the user, and discards a late yes", async () => {
    let answer!: (yes: boolean) => void;
    const window = openEnrollment(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const code = await window.codeReady;
    const result = window.result().then(() => "trusted", () => "rejected");
    const enrollId = randomId();
    const link = enrollmentLink(enrollId);
    const pending = browserEnroll({ code, io: link.browser, enrollId });
    await vi_waitFor(() => window.confirmed.length === 1);
    link.wire.close("socket dropped");
    await link.finished();
    answer(true);
    await tick(100);
    expect(await listBrowsers(app)).toEqual([]);
    void pending.catch(() => undefined);
    void result;
  });

  it("waits for the local user's answer far longer than the session handshake timeout", async () => {
    // Only timers are faked: the file system stays real, so the lock and the window keep working.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let answer!: (yes: boolean) => void;
    const window = openEnrollment(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const code = await window.codeReady;
    const identity = await generateKeyPair();
    const enrollId = randomId();
    const link = enrollmentLink(enrollId);
    const outcome = browserEnroll({ code, io: link.browser, enrollId, keyPair: identity });
    while (window.confirmed.length === 0) await new Promise((resolve) => setImmediate(resolve));

    // A person at a terminal: well past 15 s, the attempt is still open and nobody was told no.
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS * 4);
    expect(link.wire.closed).toBe(false);
    expect(relayTap.some((body) => body.includes('"pake/done"'))).toBe(false);

    answer(true);
    expect((await outcome).done).toMatchObject({ ok: true, browserKeyId: identity.id });
    await expect(window.result()).resolves.toMatchObject({ browserKeyId: identity.id });
    expect((await listBrowsers(app)).map((b) => b.browserKeyId)).toEqual([identity.id]);
  });

  it("still bounds the exchange before the user is asked by the handshake timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const window = openEnrollment();
    const code = await window.codeReady;
    const enrollId = randomId();
    const link = enrollmentLink(enrollId);
    // pake/start and pake/reply, but the browser never sends pake/confirm.
    await browserEnroll({ code, io: link.browser, enrollId, stopAfterReply: true });
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 1);
    await link.finished();
    expect(link.wire.closed).toBe(true);
    expect(window.confirmed).toEqual([]);
    expect(await listBrowsers(app)).toEqual([]);
  });

  it("trusts no one, and keeps the code, when the user says yes after the wire is already closed", async () => {
    const answers: ((yes: boolean) => void)[] = [];
    const window = openEnrollment(() => new Promise<boolean>((resolve) => answers.push(resolve)));
    const code = await window.codeReady;
    const enrollId = randomId();
    const link = enrollmentLink(enrollId);
    void browserEnroll({ code, io: link.browser, enrollId }).catch(() => undefined);
    await vi_waitFor(() => window.confirmed.length === 1);
    // The socket is gone but its close event has not reached the enrollment yet.
    (link.wire as { closed: boolean }).closed = true;
    answers[0]!(true);
    await link.finished();
    await tick(100);

    expect(await listBrowsers(app)).toEqual([]);
    const stored = JSON.parse(await fs.readFile(statePath(app, "enroll"), "utf8")) as Record<string, unknown>;
    expect(stored.consumed).toBeUndefined();
    expect(stored.pending).toBeUndefined();
    expect(stored.decision).toBeUndefined();

    // The code is still good: another browser can use it.
    const second = await generateKeyPair();
    const secondId = randomId();
    const retry = browserEnroll({ code, io: enrollmentLink(secondId).browser, enrollId: secondId, keyPair: second, label: "Me" });
    await vi_waitFor(() => window.confirmed.length === 2);
    answers[1]!(true);
    expect((await retry).done).toMatchObject({ ok: true, browserKeyId: second.id });
    await expect(window.result()).resolves.toMatchObject({ browserKeyId: second.id });
    expect((await listBrowsers(app)).map((b) => b.browserKeyId)).toEqual([second.id]);
  });

  /**
   * Makes `wire.closed` flip from inside the test, deterministically: `closed` is the
   * wire's own flag or whatever `trigger` says when it is read. (close() sets the flag.)
   */
  function closedWhen(wire: EnrollmentWire, trigger: () => boolean): void {
    let flag = false;
    Object.defineProperty(wire, "closed", {
      get: () => flag || trigger(),
      set: (value: boolean) => void (flag = value),
    });
  }
  const readOrEmpty = (file: string): string => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };

  it("takes the trust back when the wire closes after the commit, so no entry is left without a pake/done", async () => {
    const window = openEnrollment();
    const code = await window.codeReady;
    const enrollId = randomId();
    const link = enrollmentLink(enrollId);
    // The wire goes away right after the browser is trusted and the code consumed.
    closedWhen(link.wire, () => readOrEmpty(statePath(app, "enroll")).includes('"consumed":true'));
    void browserEnroll({ code, io: link.browser, enrollId }).catch(() => undefined);
    await vi_waitFor(() => window.confirmed.length === 1);
    await link.finished();
    await tick(100);

    expect(await listBrowsers(app)).toEqual([]);
    expect(relayTap.some((body) => body.includes('"pake/done"') && body.includes('"ok":true'))).toBe(false);
    // `bridge enroll` is not told that it worked, and the code is still good.
    const stored = JSON.parse(readOrEmpty(statePath(app, "enroll"))) as Record<string, unknown>;
    expect(stored.consumed).toBeUndefined();
    expect(stored.decision).toBeUndefined();
    const second = await generateKeyPair();
    const secondId = randomId();
    const retry = browserEnroll({ code, io: enrollmentLink(secondId).browser, enrollId: secondId, keyPair: second });
    expect((await retry).done).toMatchObject({ ok: true, browserKeyId: second.id });
    await expect(window.result()).resolves.toMatchObject({ browserKeyId: second.id });
  });

  it("does not report success when the wire closed after the commit and the rollback is still waiting on the trust lock", async () => {
    const abort = new AbortController();
    const window = openEnrollment(async () => true, abort.signal);
    const code = await window.codeReady;
    const enrollId = randomId();
    const link = enrollmentLink(enrollId);
    const trustLock = `${statePath(app, "trust")}.lock`;
    // The wire goes away after the commit, and another process holds the trust lock, so the
    // daemon's rollback has to wait.
    closedWhen(link.wire, () => {
      if (!readOrEmpty(statePath(app, "enroll")).includes('"consumed":true')) return false;
      try {
        writeFileSync(trustLock, "", { flag: "wx" });
      } catch {
        // already held
      }
      return true;
    });
    void browserEnroll({ code, io: link.browser, enrollId }).catch(() => undefined);
    await vi_waitFor(() => window.confirmed.length === 1);
    await vi_waitFor(() => readOrEmpty(trustLock) !== "" || existsSync(trustLock));
    await tick(150);
    abort.abort();
    // Committed but never delivered: not a success.
    await expect(window.result()).rejects.toMatchObject({ reason: "unconfirmed" });
    expect(relayTap.some((body) => body.includes('"pake/done"') && body.includes('"ok":true'))).toBe(false);
    await fs.rm(trustLock, { force: true });
    await link.finished();
    await tick(100);
    expect(await listBrowsers(app)).toEqual([]);
  });

  it("takes the trust back when persisting the accepted decision fails", async () => {
    const abort = new AbortController();
    const window = openEnrollment(async () => true, abort.signal);
    const code = await window.codeReady;
    const enrollId = randomId();
    const link = enrollmentLink(enrollId);
    const enrollFile = statePath(app, "enroll");
    const realRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === enrollFile && readOrEmpty(String(from)).includes('"consumed":true')) {
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      }
      return realRename(from, to);
    });
    try {
      void browserEnroll({ code, io: link.browser, enrollId }).catch(() => undefined);
      await vi_waitFor(() => window.confirmed.length === 1);
      await link.finished();
      await tick(100);
      expect(relayTap.some((body) => body.includes('"pake/done"') && body.includes('"ok":true'))).toBe(false);
      expect(await listBrowsers(app)).toEqual([]);
    } finally {
      spy.mockRestore();
      abort.abort();
      await window.result().catch(() => undefined);
    }
  });

  it("seals the proof before the browser is trusted, and reports success only after pake/done went out", async () => {
    const identity = await generateKeyPair();
    const { done, window } = await enrollBrowser(identity);
    expect(done).toMatchObject({ ok: true });
    expect(done).toHaveProperty("proof");
    await expect(window.result()).resolves.toMatchObject({ browserKeyId: identity.id });
  });

  describe("decisions recorded by another process", () => {
    /** What the CLI's non-TTY confirm does: wait for a decision on the asked attempt, or for it to be withdrawn. */
    function windowConfirm(): (browser: { label: string; keyId: string }, o?: { signal?: AbortSignal }) => Promise<boolean> {
      return async (browser, options) => {
        const first = await readEnrollWindow(app);
        if (first?.pending?.keyId !== browser.keyId) return false;
        const attemptId = first.pending.attemptId;
        while (!options?.signal?.aborted) {
          const window = await readEnrollWindow(app);
          if (window?.decision?.attemptId === attemptId) return window.decision.accepted;
          if (window?.pending?.attemptId !== attemptId) return false;
          await tick(10);
        }
        return false;
      };
    }
    const pendingOf = async () => {
      let pending: PendingEnrollment | undefined;
      for (let i = 0; i < 200 && !pending; i++) {
        pending = (await readEnrollWindow(app))?.pending;
        if (!pending) await tick(5);
      }
      if (!pending) throw new Error("no pending browser");
      return pending;
    };

    it("treats an identical decision as recorded, refuses a different one, and lets the confirm resolve from it", async () => {
      const window = openEnrollment(windowConfirm());
      const code = await window.codeReady;
      const identity = await generateKeyPair();
      const enrollId = randomId();
      const browser = browserEnroll({ code, io: enrollmentLink(enrollId).browser, enrollId, keyPair: identity, label: "Phone" });
      const pending = await pendingOf();
      const codeId = (await readEnrollWindow(app))!.codeId;
      expect(pending.keyId).toBe(identity.id);

      // Another process answers; the same answer again is recorded too, a different one is not.
      expect(await recordDecision(app, codeId, pending.attemptId, true, new Date())).toBe(true);
      expect(await recordDecision(app, codeId, pending.attemptId, true, new Date())).toBe(true);
      expect(await recordDecision(app, codeId, pending.attemptId, false, new Date())).toBe(false);
      expect((await readEnrollWindow(app))?.decision?.accepted).toBe(true);

      expect((await browser).done).toMatchObject({ ok: true, browserKeyId: identity.id });
      await expect(window.result()).resolves.toMatchObject({ browserKeyId: identity.id, label: "Phone" });
      expect((await listBrowsers(app)).map((b) => b.browserKeyId)).toEqual([identity.id]);
    });

    it("a deny from another process ends the confirm at once (the pending request is withdrawn), not at expiry", async () => {
      const window = openEnrollment(windowConfirm());
      const code = await window.codeReady;
      const enrollId = randomId();
      const first = browserEnroll({ code, io: enrollmentLink(enrollId).browser, enrollId, label: "Stranger" });
      const pending = await pendingOf();
      const codeId = (await readEnrollWindow(app))!.codeId;
      const started = Date.now();
      expect(await recordDecision(app, codeId, pending.attemptId, false, new Date())).toBe(true);
      expect((await first).done).toMatchObject({ ok: false, reason: "rejected_by_user" });
      expect(Date.now() - started).toBeLessThan(ENROLL_CODE_TTL_MS / 100);
      expect(await listBrowsers(app)).toEqual([]);
      // The window stays open for another try, and a stale answer for the old attempt is refused.
      expect(await recordDecision(app, codeId, pending.attemptId, true, new Date())).toBe(false);
      const secondId = randomId();
      const second = await generateKeyPair();
      // the same confirm now sees only the new attempt
      const accepted = browserEnroll({ code, io: enrollmentLink(secondId).browser, enrollId: secondId, keyPair: second, label: "Me" });
      const next = await pendingOf();
      expect(next.attemptId).not.toBe(pending.attemptId);
      expect(await recordDecision(app, codeId, next.attemptId, true, new Date())).toBe(true);
      expect((await accepted).done).toMatchObject({ ok: true, browserKeyId: second.id });
      await window.result();
    });

    it("follows an accept that was recorded before enroll() looked at the request (no prompt, no hang until expiry)", async () => {
      let asked = false;
      let result!: ReturnType<typeof enroll>;
      const shown = new Promise<string>((resolve) => {
        result = enroll(app, { showCode: (c) => resolve(c), confirm: async () => ((asked = true), true) }, { pollMs: 400 });
        result.catch(() => undefined);
      });
      await shown;
      // The request and its answer land together, with the daemon's delivery already done, in the gap
      // between two looks of enroll() (written to the file directly: an in-process write would wake it).
      const file = statePath(app, "enroll");
      const window = JSON.parse(readFileSync(file, "utf8"));
      const stamp = new Date().toISOString();
      writeFileSync(
        file,
        JSON.stringify({
          ...window,
          consumed: true,
          pending: { attemptId: "a1", enrollId: "e1", label: "Fast", publicKey: "pk", keyId: "key-fast" },
          decision: { attemptId: "a1", accepted: true, delivered: true, enrolledAt: stamp },
        }),
      );
      const started = Date.now();
      await expect(result).resolves.toEqual({ browserKeyId: "key-fast", label: "Fast", enrolledAt: stamp });
      expect(Date.now() - started).toBeLessThan(ENROLL_CODE_TTL_MS / 100);
      expect(asked).toBe(false);
    });

    it("a decision for an attempt that is no longer pending is refused", async () => {
      const window = openEnrollment(() => new Promise<boolean>(() => {}));
      const code = await window.codeReady;
      const enrollId = randomId();
      void browserEnroll({ code, io: enrollmentLink(enrollId).browser, enrollId });
      const pending = await pendingOf();
      const codeId = (await readEnrollWindow(app))!.codeId;
      expect(await recordDecision(app, codeId, "some-other-attempt", true, new Date())).toBe(false);
      expect(await recordDecision(app, "some-other-code", pending.attemptId, true, new Date())).toBe(false);
      expect((await readEnrollWindow(app))?.decision).toBeUndefined();
    });
  });

  describe("rolling back a re-enrollment", () => {
    async function reenrollWithWireLost(onLost: () => void): Promise<string[]> {
      const identity = await generateKeyPair();
      await enrollBrowser(identity, "Old name");
      const window = openEnrollment();
      const code = await window.codeReady;
      const enrollId = randomId();
      const link = enrollmentLink(enrollId);
      let lost = false;
      // The wire is lost as soon as the new entry is written; `onLost` runs then (a concurrent actor).
      closedWhen(link.wire, () => {
        if (lost) return true;
        if (!readOrEmpty(statePath(app, "trust")).includes("Renamed")) return false;
        lost = true;
        onLost();
        return true;
      });
      void browserEnroll({ code, io: link.browser, enrollId, keyPair: identity, label: "Renamed" }).catch(() => undefined);
      await vi_waitFor(() => window.confirmed.length === 1);
      await link.finished();
      await tick(100);
      return (await listBrowsers(app)).map((entry) => entry.label);
    }

    it("puts the previous entry back when nothing else changed", async () => {
      expect(await reenrollWithWireLost(() => undefined)).toEqual(["Old name"]);
    });

    it("does not resurrect a browser that was revoked while the re-enrollment was committing", async () => {
      const labels = await reenrollWithWireLost(() => writeFileSync(statePath(app, "trust"), `${JSON.stringify({ v: 1, browsers: [] })}\n`));
      expect(labels).toEqual([]);
    });
  });

  it("stops waiting for a prompt nobody answers once the code expires, and dismisses it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let clock = Date.now();
    let promptSignal: AbortSignal | undefined;
    let shown!: (code: string) => void;
    const code = new Promise<string>((resolve) => (shown = resolve));
    const result = enroll(
      app,
      {
        showCode: (c) => shown(c),
        confirm: (_browser, options) => {
          promptSignal = options?.signal;
          return new Promise<boolean>(() => undefined); // nobody answers
        },
      },
      { pollMs: 20, now: () => new Date(clock) },
    );
    const settled = result.then(() => "resolved", (error: unknown) => error);
    const enrollId = randomId();
    void browserEnroll({ code: await code, io: enrollmentLink(enrollId).browser, enrollId }).catch(() => undefined);
    while (promptSignal === undefined) await new Promise((resolve) => setImmediate(resolve));
    expect(promptSignal.aborted).toBe(false);

    clock += ENROLL_CODE_TTL_MS;
    await vi.advanceTimersByTimeAsync(ENROLL_CODE_TTL_MS);
    expect(await settled).toMatchObject({ reason: "expired" });
    expect(promptSignal.aborted).toBe(true);
    expect(await listBrowsers(app)).toEqual([]);
  });

  it("returns pake/done no_enrollment_open in plaintext mode", async () => {
    const link = enrollmentLink("pre", ctxOf({ e2ee: false }));
    const done = waitMessage(link.browser, "pake/done");
    link.browser.send({ t: "pake/start", v: 1, enrollId: "pre", msg: base64UrlEncode(new Uint8Array(32)) });
    expect(await done).toMatchObject({ reason: "no_enrollment_open" });
  });
});

describe("trust list API", () => {
  it("lists oldest first and revokes exactly one browser", async () => {
    const early = await generateKeyPair();
    const late = await generateKeyPair();
    await enrollBrowser(late, "second");
    await enrollBrowser(early, "first");
    // enrolledAt follows enrollment order
    expect((await listBrowsers(app)).map((b) => b.label)).toEqual(["second", "first"]);
    expect(await revokeBrowser(app, late.id)).toBe(true);
    expect(await revokeBrowser(app, late.id)).toBe(false);
    expect((await listBrowsers(app)).map((b) => b.label)).toEqual(["first"]);
  });
});

// --- sessions -------------------------------------------------------------------

async function enrolled() {
  const identity = await generateKeyPair();
  const { runnerPublicKey } = await enrollBrowser(identity);
  return { identity, runnerPublicKey: runnerPublicKey! };
}

describe("encrypted sessions", () => {
  it("refuses a browser that is not in the trust list", async () => {
    const { runnerPublicKey } = await enrolled();
    const stranger = await generateKeyPair();
    const link = sessionLink(stranger.id);
    const channel = wrapRunnerChannel(link.wire, ctxOf());
    const accepted = waitMessage(link.browserIO, "session/accept").then(() => true);
    link.browserIO.send({ t: "session/init", v: 1, sid: link.sid, eph: base64UrlEncode((await generateKeyPair()).publicKey) });
    await vi_waitFor(() => channel.closed);
    expect(link.closes).toEqual(["not_trusted"]);
    expect(await Promise.race([accepted, tick(20).then(() => false)])).toBe(false);
    void runnerPublicKey;
  });

  it("closes the handshake of a revoked browser's next session with not_trusted", async () => {
    const { identity, runnerPublicKey } = await enrolled();
    const live = sessionLink(identity.id);
    const liveChannel = wrapRunnerChannel(live.wire, ctxOf());
    await browserSession(live, identity, runnerPublicKey);
    expect(await revokeBrowser(app, identity.id)).toBe(true);
    // The live session is dropped as `revoked` (an error on the wire), never as `not_trusted`.
    expect(liveChannel.closed).toBe(true);
    expect(live.closes).toEqual(["revoked"]);

    const retry = sessionLink(identity.id);
    const second = wrapRunnerChannel(retry.wire, ctxOf());
    retry.browserIO.send({ t: "session/init", v: 1, sid: retry.sid, eph: base64UrlEncode((await generateKeyPair()).publicKey) });
    await vi_waitFor(() => second.closed);
    expect(retry.closes).toEqual(["not_trusted"]);
    expect(retry.sent).toEqual([]);
  });

  it("keeps every other handshake failure a generic one", async () => {
    const { identity } = await enrolled();
    // A malformed init (the ephemeral key is not 32 bytes), from a trusted browser.
    const malformed = sessionLink(identity.id);
    const first = wrapRunnerChannel(malformed.wire, ctxOf());
    malformed.browserIO.send({ t: "session/init", v: 1, sid: malformed.sid, eph: base64UrlEncode(new Uint8Array(5)) });
    await vi_waitFor(() => first.closed);
    expect(malformed.closes).toEqual(["handshake failed"]);

    // The same malformed init from a stranger is a generic failure too: the key is not checked first.
    const stranger = sessionLink((await generateKeyPair()).id);
    const second = wrapRunnerChannel(stranger.wire, ctxOf());
    stranger.browserIO.send({ t: "session/init", v: 1, sid: stranger.sid, eph: base64UrlEncode(new Uint8Array(5)) });
    await vi_waitFor(() => second.closed);
    expect(stranger.closes).toEqual(["handshake failed"]);

    // A wire that already has a kid was created by a plaintext frame: encrypted mode refuses it.
    const plain = sessionLink(identity.id);
    (plain.wire as { kid?: string }).kid = "plaintext-kid";
    const third = wrapRunnerChannel(plain.wire, ctxOf());
    await vi_waitFor(() => third.closed);
    expect(plain.closes).toEqual(["handshake failed"]);
  });

  it("refuses a revoked browser, and drops its live channel at once", async () => {
    const { identity, runnerPublicKey } = await enrolled();
    const live = sessionLink(identity.id);
    const channel = wrapRunnerChannel(live.wire, ctxOf());
    await browserSession(live, identity, runnerPublicKey);
    expect(channel.closed).toBe(false);

    expect(await revokeBrowser(app, identity.id)).toBe(true);
    expect(channel.closed).toBe(true);
    expect(live.closes).toEqual(["revoked"]);
    expect(await revokeBrowser(app, identity.id)).toBe(false);

    const retry = sessionLink(identity.id);
    const second = wrapRunnerChannel(retry.wire, ctxOf());
    retry.browserIO.send({ t: "session/init", v: 1, sid: retry.sid, eph: base64UrlEncode((await generateKeyPair()).publicKey) });
    await vi_waitFor(() => second.closed);
    expect(retry.closes).toEqual(["not_trusted"]);
    expect(retry.sent).toEqual([]);
  });

  it("notices a revocation made by another process through the trust file", async () => {
    const { identity, runnerPublicKey } = await enrolled();
    const live = sessionLink(identity.id);
    const channel = wrapRunnerChannel(live.wire, ctxOf());
    await browserSession(live, identity, runnerPublicKey);
    // `bridge browsers revoke` runs elsewhere: it only rewrites the file
    await mutateTrustList(app, () => ({ list: [], result: undefined }));
    await vi_waitFor(() => channel.closed, 3000);
    expect(live.closes).toEqual(["revoked"]);
  });

  it("fails closed when the trust list is corrupt", async () => {
    const { identity } = await enrolled();
    await fs.writeFile(statePath(app, "trust"), "{ not json", { mode: 0o600 });
    const link = sessionLink(identity.id);
    const channel = wrapRunnerChannel(link.wire, ctxOf());
    link.browserIO.send({ t: "session/init", v: 1, sid: link.sid, eph: base64UrlEncode((await generateKeyPair()).publicKey) });
    await vi_waitFor(() => channel.closed);
    // An unreadable list is a failure, not a verdict on the key: generic, not `not_trusted`.
    expect(link.closes).toEqual(["handshake failed"]);
    await expect(listBrowsers(app)).rejects.toThrow("trust list");
  });

  it("rejects a replayed frame and ends the session", async () => {
    const { identity, runnerPublicKey } = await enrolled();
    const link = sessionLink(identity.id);
    const channel = wrapRunnerChannel(link.wire, ctxOf());
    const received: JsonRpcMessage[] = [];
    channel.onMessage((m) => received.push(m));
    const browser = await browserSession(link, identity, runnerPublicKey);
    const frame = await browser.codec.encrypt(hello(1));
    link.deliver(frame);
    await vi_waitFor(() => received.length === 1);
    link.deliver(frame);
    await vi_waitFor(() => channel.closed);
    expect(received).toHaveLength(1);
    expect(link.closes).toEqual(["channel error"]);
  });

  it("rejects a gap and a tampered frame", async () => {
    const { identity, runnerPublicKey } = await enrolled();
    const gap = sessionLink(identity.id);
    const channelA = wrapRunnerChannel(gap.wire, ctxOf());
    const browserA = await browserSession(gap, identity, runnerPublicKey);
    await browserA.codec.encrypt(hello(1));
    gap.deliver(await browserA.codec.encrypt(hello(2)));
    await vi_waitFor(() => channelA.closed);

    const forged = sessionLink(identity.id);
    const channelB = wrapRunnerChannel(forged.wire, ctxOf());
    const browserB = await browserSession(forged, identity, runnerPublicKey);
    const frame = await browserB.codec.encrypt(hello(1));
    forged.deliver({ ...frame, ct: frame.ct.slice(0, -2) + (frame.ct.endsWith("AA") ? "BB" : "AA") });
    await vi_waitFor(() => channelB.closed);
  });

  it("refuses plaintext frames when E2EE is on", async () => {
    const { identity, runnerPublicKey } = await enrolled();
    const link = sessionLink(identity.id);
    const channel = wrapRunnerChannel(link.wire, ctxOf());
    const received: JsonRpcMessage[] = [];
    channel.onMessage((m) => received.push(m));
    const browser = await browserSession(link, identity, runnerPublicKey);
    link.deliver({ v: 1, kid: browser.kid, seq: 1, msg: hello(1) });
    await vi_waitFor(() => channel.closed);
    expect(received).toEqual([]);
  });

  it("refuses a wire created by a plaintext data frame when E2EE is on", async () => {
    const link = sessionLink("somebody");
    (link.wire as { kid?: string }).kid = "plain-session-kid";
    const channel = wrapRunnerChannel(link.wire, ctxOf());
    await vi_waitFor(() => channel.closed);
    expect(link.sent).toEqual([]);
  });

  it("drops frames of another kid before they reach the codec, and the session survives", async () => {
    const { identity, runnerPublicKey } = await enrolled();
    const link = sessionLink(identity.id);
    const channel = wrapRunnerChannel(link.wire, ctxOf());
    const received: JsonRpcMessage[] = [];
    channel.onMessage((m) => received.push(m));
    const browser = await browserSession(link, identity, runnerPublicKey);
    const foreign: E2EEFrame = { v: 1, kid: randomId(), seq: 1, nonce: base64UrlEncode(new Uint8Array(12)), ct: base64UrlEncode(new Uint8Array(32)) };
    link.deliver(foreign);
    link.deliver({ v: 1, kid: foreign.kid, seq: 7, msg: hello(9) });
    link.deliver(await browser.codec.encrypt(hello(1)));
    await vi_waitFor(() => received.length === 1);
    expect(channel.closed).toBe(false);
    link.deliver(await browser.codec.encrypt(hello(2)));
    await vi_waitFor(() => received.length === 2);
    expect(received.map((m) => m.id)).toEqual([1, 2]);
  });

  it("derives fresh keys for every session of the same browser", async () => {
    const { identity, runnerPublicKey } = await enrolled();
    const first = sessionLink(identity.id);
    const a = wrapRunnerChannel(first.wire, ctxOf());
    const kidA = (await browserSession(first, identity, runnerPublicKey)).kid;
    a.close("superseded");
    const second = sessionLink(identity.id);
    const b = wrapRunnerChannel(second.wire, ctxOf());
    const kidB = (await browserSession(second, identity, runnerPublicKey)).kid;
    expect(kidB).not.toBe(kidA);
    b.close();
  });

  it("an attacker with the wrong long-term key cannot talk in an enrolled browser's name", async () => {
    const { identity, runnerPublicKey } = await enrolled();
    const impostor = await generateKeyPair();
    const link = sessionLink(identity.id);
    const channel = wrapRunnerChannel(link.wire, ctxOf());
    const received: JsonRpcMessage[] = [];
    channel.onMessage((m) => received.push(m));
    const fake = await browserSession(link, impostor, runnerPublicKey);
    const frame = await fake.codec.encrypt(hello(1));
    // its kid differs (it is derived from the keys), so the frame is dropped before the codec...
    link.deliver(frame);
    await tick(50);
    expect(received).toEqual([]);
    // ...and a frame that borrows the session's kid fails authentication and ends the session
    const real = (link.wire as { kid?: string }).kid!;
    link.deliver({ ...frame, kid: real });
    await vi_waitFor(() => channel.closed);
    expect(received).toEqual([]);
  });
});

// --- relay blindness ------------------------------------------------------------

describe("relay blindness", () => {
  it("shows the relay only ciphertext: no code, key, label or JSON-RPC in any body", async () => {
    const identity = await generateKeyPair();
    const { runnerPublicKey, window } = await enrollBrowser(identity, "Secret laptop name");
    const link = sessionLink(identity.id);
    const channel = wrapRunnerChannel(link.wire, ctxOf());
    channel.onMessage(() => {});
    const browser = await browserSession(link, identity, runnerPublicKey!);
    link.deliver(await browser.codec.encrypt(hello(1)));
    channel.send({ jsonrpc: "2.0", id: 1, result: { text: "private agent output" } });
    await vi_waitFor(() => browser.received.length === 1);

    expect(relayTap.length).toBeGreaterThanOrEqual(6);
    const seen = relayTap.join("\n");
    for (const needle of [
      window.shown.code!,
      "Secret laptop name",
      "launch-codes-42",
      "private agent output",
      "jsonrpc",
      '"method"',
      base64UrlEncode(identity.publicKey),
      base64UrlEncode(runnerPublicKey!),
    ]) expect(seen).not.toContain(needle);
    const frames = relayTap.map((body) => JSON.parse(body) as Record<string, unknown>).filter((body) => "ct" in body && "seq" in body);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const frame of frames) expect(Object.keys(frame).sort()).toEqual(["ct", "kid", "nonce", "seq", "v"]);
    channel.close();
  });
});

async function vi_waitFor(check: () => boolean, timeout = 1500): Promise<void> {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not reached in time");
    await tick(5);
  }
}
