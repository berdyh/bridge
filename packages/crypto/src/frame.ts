import type { ChannelKeys, FrameCodec } from "./contracts.js";
import { isJsonRpcMessage, type E2EEFrame, type JsonRpcMessage } from "@berdyh/bridge-protocol";
import { frameEncryptionInvocations, getChannelSecrets } from "./channel-internal.js";
import { BridgeCryptoError, isCryptoError } from "./errors.js";
import { open, seal, utf8 } from "./internal.js";

const MAX_ENCRYPTION_INVOCATIONS = 2 ** 32;

/** A codec for one side of one session. See `FrameCodec`. */
export function createFrameCodec(keys: ChannelKeys): FrameCodec {
  getChannelSecrets(keys);
  const kid = keys.kid;
  const outgoing = keys.role === "browser" ? "b2r" : "r2b";
  const incoming = keys.role === "browser" ? "r2b" : "b2r";
  // Seq starts at 1 and advances only after successful encryption. Independently,
  // random-nonce AES-GCM allows at most 2^32 invocations per key per direction.
  // Reserve each attempt before sealing, including failures; exhaustion is fatal.
  let nextSeq = 1, lastAccepted = 0, active = true;
  let encryptQueue: Promise<unknown> = Promise.resolve();
  let decryptQueue: Promise<unknown> = Promise.resolve();
  const assertActive = () => {
    if (!active) throw new BridgeCryptoError("malformed");
    getChannelSecrets(keys);
  };
  const destroy = () => { active = false; keys.destroy(); };
  // Fixed tuple encoding. Direction is implicit in the role, never peer-selected.
  const aad = (seq: number, dir: string) => utf8(JSON.stringify([1, kid, seq, dir]));
  return {
    kid,
    get nextSeq() { return nextSeq; },
    get lastAccepted() { return lastAccepted; },
    encrypt(message) {
      let input: Uint8Array;
      try {
        assertActive();
        if (!isJsonRpcMessage(message)) throw new Error();
        const text = JSON.stringify(message);
        if (!isJsonRpcMessage(JSON.parse(text))) throw new Error();
        input = utf8(text);
      } catch { return Promise.reject(new BridgeCryptoError("malformed")); }
      const pending = encryptQueue.then(async (): Promise<E2EEFrame> => {
        try {
          assertActive();
          if (!Number.isSafeInteger(nextSeq)) throw new BridgeCryptoError("malformed");
          const seq = nextSeq;
          const key = getChannelSecrets(keys)[outgoing];
          const invocations = frameEncryptionInvocations.get(key) ?? 0;
          if (invocations >= MAX_ENCRYPTION_INVOCATIONS) throw new BridgeCryptoError("malformed");
          frameEncryptionInvocations.set(key, invocations + 1);
          const blob = await seal(key, input, aad(seq, outgoing));
          assertActive();
          nextSeq++;
          return { v: 1, kid, seq, ...blob };
        } catch (error) {
          destroy();
          throw isCryptoError(error) ? error : new BridgeCryptoError("auth_failed");
        } finally { input.fill(0); }
      });
      encryptQueue = pending.catch(() => undefined);
      return pending;
    },
    decrypt(frame) {
      // Every decrypt fault, including bad_kid, destroys this codec and its keys.
      // Client/runner layers MUST filter other-kid frames before calling decrypt
      // (packages/client/src/contracts.ts:46-52 and the runner's mirror contract).
      // Snapshot fields before async work so caller mutation cannot alter the AAD.
      let captured: E2EEFrame;
      try { captured = { v: frame.v, kid: frame.kid, seq: frame.seq, nonce: frame.nonce, ct: frame.ct }; }
      catch { destroy(); return Promise.reject(new BridgeCryptoError("malformed")); }
      const pending = decryptQueue.then(async (): Promise<JsonRpcMessage> => {
        let plaintext: Uint8Array | undefined;
        try {
          assertActive();
          if (captured.v !== 1) throw new BridgeCryptoError("malformed");
          if (captured.kid !== kid) throw new BridgeCryptoError("bad_kid");
          if (!Number.isSafeInteger(captured.seq) || captured.seq < 1) throw new BridgeCryptoError("malformed");
          if (captured.seq <= lastAccepted) throw new BridgeCryptoError("replay");
          if (captured.seq !== lastAccepted + 1) throw new BridgeCryptoError("gap");
          plaintext = await open(getChannelSecrets(keys)[incoming], captured, aad(captured.seq, incoming));
          assertActive();
          const message: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
          if (!isJsonRpcMessage(message)) throw new Error();
          lastAccepted = captured.seq;
          return message;
        } catch (error) {
          destroy();
          throw isCryptoError(error) ? error : new BridgeCryptoError("auth_failed");
        } finally { plaintext?.fill(0); }
      });
      decryptQueue = pending.catch(() => undefined);
      return pending;
    },
    destroy,
  };
}
