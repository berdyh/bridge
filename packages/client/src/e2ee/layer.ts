import {
  base64UrlDecode,
  base64UrlEncode,
  createFrameCodec,
  deriveChannelKeys,
  generateKeyPair,
  loadKeyPair,
  type FrameCodec,
  type KeyPair,
  type StoredKeyPair,
} from "@berdyh/bridge-crypto";
import {
  HANDSHAKE_TIMEOUT_MS,
  isE2EEFrame,
  type ChannelLayer,
  type HandshakeIO,
  type JsonRpcMessage,
  type SequencedFrame,
  type SessionAccept,
} from "@berdyh/bridge-protocol";

import type { ClientE2eeContext } from "../contracts.js";
import { KEY_NAME, runnerKeyName } from "./wire.js";

/** The one peer-visible failure text; which check failed stays local. */
const FAILED = "handshake failed";

/**
 * The browser's end-to-end encrypted layer for one session. `start` loads the
 * long-term key and the runner's public key (both stored at enrollment), sends
 * `session/init` with a fresh ephemeral key, and derives the channel keys from the
 * runner's `session/accept`. No enrollment, no session. Keys live as long as the
 * layer: a socket reconnect resumes the session with them (Sessions rule 8).
 */
export function createClientE2eeLayer(ctx: ClientE2eeContext): ChannelLayer {
  let codec: FrameCodec | undefined;
  let closed = false;
  let started = false;
  let abortStart: (() => void) | undefined;
  const random = ctx.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)));

  return {
    kind: "e2ee",
    // Never equals a real kid before `start` resolves.
    get kid() {
      return codec?.kid ?? "";
    },
    async start(io: HandshakeIO): Promise<void> {
      if (started) throw new Error(FAILED);
      started = true;
      let identity: KeyPair | undefined;
      let ephemeral: KeyPair | undefined;
      try {
        const storedKey = await ctx.keyStore.load(KEY_NAME);
        const storedRunner = await ctx.keyStore.load(runnerKeyName(ctx.runnerId));
        if (storedKey === undefined || typeof storedRunner !== "string") throw new Error("not enrolled");
        identity = await loadKeyPair(storedKey as StoredKeyPair);
        // The socket is opened under the key's id; any other id is not what the runner trusts.
        if (identity.id !== ctx.browserKeyId) throw new Error("not enrolled");
        const runnerKey = base64UrlDecode(storedRunner);
        if (runnerKey.length !== 32) throw new Error(FAILED);
        ephemeral = await generateKeyPair();
        const sid = base64UrlEncode(random(16));

        const accept = await new Promise<SessionAccept>((resolve, reject) => {
          const finish = (settle: () => void) => {
            clearTimeout(timer);
            off();
            abortStart = undefined;
            settle();
          };
          const timer = setTimeout(() => finish(() => reject(new Error(FAILED))), HANDSHAKE_TIMEOUT_MS);
          const off = io.onMessage((message) => {
            if (message.t === "session/accept" && message.sid === sid) finish(() => resolve(message));
          });
          abortStart = () => finish(() => reject(new Error(FAILED)));
          if (closed) return abortStart();
          io.send({ t: "session/init", v: 1, sid, eph: base64UrlEncode(ephemeral!.publicKey) });
        });

        const peerEphemeral = base64UrlDecode(accept.eph);
        if (peerEphemeral.length !== 32) throw new Error(FAILED);
        const keys = await deriveChannelKeys({
          role: "browser",
          ownStatic: identity,
          ownEphemeral: ephemeral,
          peerStaticPublic: runnerKey,
          peerEphemeralPublic: peerEphemeral,
        });
        const next = createFrameCodec(keys);
        if (closed) {
          next.destroy();
          throw new Error(FAILED);
        }
        codec = next;
      } catch (error) {
        throw error instanceof Error && error.message === "not enrolled" ? error : new Error(FAILED);
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
      // Plaintext frames and other sessions' frames never reach the codec: any decrypt
      // fault destroys it. `createChannel` filters by kid first; this is the second line.
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
