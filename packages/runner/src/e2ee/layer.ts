import { promises as fs } from "node:fs";

import {
  base64UrlDecode,
  base64UrlEncode,
  createFrameCodec,
  deriveChannelKeys,
  generateKeyPair,
  type FrameCodec,
  type KeyPair,
} from "@berdyh/bridge-crypto";
import {
  HANDSHAKE_TIMEOUT_MS,
  isE2EEFrame,
  type ChannelLayer,
  type HandshakeIO,
  type JsonRpcMessage,
  type SequencedFrame,
  type SessionInit,
} from "@berdyh/bridge-protocol";

import type { E2eeApp, RunnerE2eeContext, RunnerWire } from "./contracts.js";
import { findTrusted, loadRunnerIdentity, readTrustList, statePath, touchLastSeen } from "./store.js";

/** One generic failure for the peer-visible side: which check failed stays local. */
const HANDSHAKE_FAILED = "handshake failed";

/**
 * The close reason for a browser key that is not in the trust list (never enrolled, or
 * revoked and so removed). It is the only handshake failure the browser is told apart:
 * everything else stays `handshake failed`, which reaches the browser as `error`. It
 * tells a browser only about its own key, which it already knows (it sent it), so the
 * relay and the browser learn nothing about other keys or the rest of the trust list.
 */
const NOT_TRUSTED = "not_trusted";

/**
 * The runner's end-to-end encrypted layer for one browser session. `start` waits for
 * the browser's `session/init`, looks the wire's `browserKeyId` up in the trust
 * list, answers `session/accept` with a fresh ephemeral key and derives the channel
 * keys from both long-term and both ephemeral keys. A browser that is not trusted
 * never gets an `accept`, so the session dies in `start`, with the reason `not_trusted`
 * when the key is absent from the list (see `NOT_TRUSTED`) and `handshake failed` for every
 * other failure (a malformed init, an unreadable trust list, a crypto fault).
 *
 * Keys live exactly as long as the layer: a socket reconnect resumes the session
 * with the same codec (Sessions rule 8); a new session is a new layer.
 */
export function createRunnerE2eeLayer(wire: RunnerWire, ctx: RunnerE2eeContext): ChannelLayer {
  const { app } = ctx;
  const now = ctx.now ?? (() => new Date());
  let codec: FrameCodec | undefined;
  let closed = false;
  let startCalled = false;
  let abortStart: (() => void) | undefined;

  return {
    kind: "e2ee",
    // Never equals a real kid before `start` resolves.
    get kid() {
      return codec?.kid ?? "";
    },
    async start(io: HandshakeIO): Promise<void> {
      if (startCalled) throw new Error(HANDSHAKE_FAILED);
      startCalled = true;
      // A wire that already has a kid was created by a plaintext data frame. Encrypted mode refuses plaintext.
      if (wire.kid !== undefined) throw new Error(HANDSHAKE_FAILED);

      const init = await new Promise<SessionInit>((resolve, reject) => {
        const timer = setTimeout(() => finish(() => reject(new Error(HANDSHAKE_FAILED))), HANDSHAKE_TIMEOUT_MS);
        const off = io.onMessage((message) => {
          if (message.t !== "session/init") return;
          if (wire.sid !== undefined && message.sid !== wire.sid) return;
          finish(() => resolve(message));
        });
        const finish = (settle: () => void) => {
          clearTimeout(timer);
          off();
          abortStart = undefined;
          settle();
        };
        abortStart = () => finish(() => reject(new Error(HANDSHAKE_FAILED)));
        if (closed) abortStart();
      });

      let identity: KeyPair | undefined;
      let ephemeral: KeyPair | undefined;
      try {
        const peerEphemeral = base64UrlDecode(init.eph);
        if (peerEphemeral.length !== 32) throw new Error(HANDSHAKE_FAILED);
        // Read fresh: a browser revoked a moment ago must not get a session.
        const trusted = await findTrusted(app, wire.browserKeyId);
        if (!trusted) throw new Error(NOT_TRUSTED);
        identity = await loadRunnerIdentity(app);
        ephemeral = await generateKeyPair();
        const keys = await deriveChannelKeys({
          role: "runner",
          ownStatic: identity,
          ownEphemeral: ephemeral,
          peerStaticPublic: base64UrlDecode(trusted.publicKey),
          peerEphemeralPublic: peerEphemeral,
        });
        const next = createFrameCodec(keys);
        if (closed || !(await findTrusted(app, wire.browserKeyId))) {
          next.destroy();
          // Closed meanwhile is a plain failure; removed from the list meanwhile is a revocation.
          throw new Error(closed ? HANDSHAKE_FAILED : NOT_TRUSTED);
        }
        codec = next;
        io.send({ t: "session/accept", v: 1, sid: init.sid, eph: base64UrlEncode(ephemeral.publicKey) });
        touchLastSeen(app, wire.browserKeyId, now()).catch(() => undefined);
      } catch (error) {
        throw new Error(error instanceof Error && error.message === NOT_TRUSTED ? NOT_TRUSTED : HANDSHAKE_FAILED);
      } finally {
        identity?.destroy();
        ephemeral?.destroy();
      }
    },
    async seal(message: JsonRpcMessage): Promise<SequencedFrame> {
      if (!codec) throw new Error("no session");
      return codec.encrypt(message);
    },
    async open(frame: SequencedFrame): Promise<JsonRpcMessage> {
      // Plaintext frames and frames of another session never reach the codec: any
      // decrypt fault destroys it, so the channel filters by kid before calling us
      // and this is the second line of defence.
      if (!codec || !isE2EEFrame(frame) || frame.kid !== codec.kid) throw new Error("rejected frame");
      return codec.decrypt(frame);
    },
    close(): void {
      closed = true;
      abortStart?.();
      codec?.destroy();
    },
  };
}

// --- live channels and revocation ---------------------------------------------

interface LiveChannel {
  browserKeyId: string;
  close(reason?: string): void;
}

interface Registry {
  app: E2eeApp;
  live: Set<LiveChannel>;
  timer?: NodeJS.Timeout;
  signature?: string;
  checking: boolean;
}

const registries = new Map<string, Registry>();
const REVOCATION_POLL_MS = 250;

async function signatureOf(file: string): Promise<string> {
  try {
    const stat = await fs.stat(file);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

async function checkRegistry(key: string, registry: Registry): Promise<void> {
  if (registry.checking) return;
  registry.checking = true;
  try {
    const signature = await signatureOf(key);
    if (signature === registry.signature) return;
    registry.signature = signature;
    let trusted: Set<string>;
    try {
      trusted = new Set((await readTrustList(registry.app)).map((entry) => entry.browserKeyId));
    } catch {
      trusted = new Set(); // an unreadable trust list trusts nobody
    }
    for (const live of [...registry.live]) if (!trusted.has(live.browserKeyId)) live.close("revoked");
  } finally {
    registry.checking = false;
  }
}

/**
 * Registers a live channel so that revoking its browser closes it. Another process
 * (`bridge browsers revoke`) rewrites the trust file; the daemon notices on a short
 * poll of the file's stat, and `revokeBrowser` in the same process drops it at once
 * (`dropLive`). Returns the unregister function.
 */
export function registerLive(app: E2eeApp, channel: LiveChannel): () => void {
  const key = statePath(app, "trust");
  let registry = registries.get(key);
  if (!registry) {
    registry = { app, live: new Set(), checking: false };
    registries.set(key, registry);
    const created = registry;
    void signatureOf(key).then((signature) => {
      created.signature ??= signature;
    });
    created.timer = setInterval(() => void checkRegistry(key, created), REVOCATION_POLL_MS);
    created.timer.unref();
  }
  registry.live.add(channel);
  return () => {
    const current = registries.get(key);
    if (!current) return;
    current.live.delete(channel);
    if (current.live.size === 0) {
      clearInterval(current.timer);
      registries.delete(key);
    }
  };
}

/** Closes every live channel of `browserKeyId` for `app` in this process. Returns how many. */
export function dropLive(app: E2eeApp, browserKeyId: string, reason = "revoked"): number {
  const registry = registries.get(statePath(app, "trust"));
  if (!registry) return 0;
  let dropped = 0;
  for (const live of [...registry.live]) {
    if (live.browserKeyId !== browserKeyId) continue;
    dropped++;
    live.close(reason);
  }
  return dropped;
}
