import { isValidUserCode, normalizeUserCode } from "@berdyh/bridge-protocol";
import type { Bytes, Spake2Params, Spake2Result, Spake2Session } from "./contracts.js";
import { BridgeCryptoError } from "./errors.js";
import { copyBytes, equalBytes, importAes, open, seal, utf8 } from "./internal.js";
import { M, N, Point, numberBE, passwordScalar, randomScalar, schedule, transcript } from "./spake2-internal.js";

/** SPAKE2 over edwards25519 per RFC 9382. See `Spake2Session`. */
export function createSpake2(params: Spake2Params): Spake2Session {
  if ((params.role !== "browser" && params.role !== "runner") || typeof params.password !== "string" || !isValidUserCode(params.password)) throw new BridgeCryptoError("malformed");
  const role = params.role;
  const idA = copyBytes(params.idA), idB = copyBytes(params.idB);
  const wBytes = passwordScalar(normalizeUserCode(params.password));
  const xBytes = randomScalar();
  const mask = role === "browser" ? M : N;
  let w = numberBE(wBytes);
  const masked = Point.BASE.multiply(numberBE(xBytes)).add(w === 0n ? Point.ZERO : mask.multiply(w));
  const message = masked.toBytes();
  let active = true;
  let result: Spake2Result | undefined;
  const consume = () => { active = false; w = 0n; wBytes.fill(0); xBytes.fill(0); };
  return {
    role,
    get message() { return new Uint8Array(message); },
    finish(peerMessage: Bytes): Spake2Result {
      if (!active) throw new BridgeCryptoError("malformed");
      let tt: Bytes | undefined;
      try {
        const peerBytes = copyBytes(peerMessage, 32);
        const peer = Point.fromBytes(peerBytes, false);
        peer.assertValidity();
        if (!equalBytes(peerBytes, peer.toBytes()) || peer.isSmallOrder()) throw new Error();
        const otherMask = role === "browser" ? N : M;
        const unmasked = peer.subtract(w === 0n ? Point.ZERO : otherMask.multiply(w)).clearCofactor();
        if (unmasked.equals(Point.ZERO)) throw new Error();
        const shared = unmasked.multiply(numberBE(xBytes)).toBytes();
        try {
          tt = transcript(idA, idB, role === "browser" ? message : peerBytes, role === "browser" ? peerBytes : message, shared, wBytes);
          const derived = schedule(tt);
          result = createResult(role, derived);
          return result;
        } finally { shared.fill(0); }
      } catch { throw new BridgeCryptoError("bad_point"); }
      finally { tt?.fill(0); consume(); }
    },
    destroy() { consume(); result?.destroy(); },
  };
}

function createResult(role: Spake2Params["role"], keys: ReturnType<typeof schedule>): Spake2Result {
  const ownMac = role === "browser" ? keys.confirmationA : keys.confirmationB;
  const peerMac = role === "browser" ? keys.confirmationB : keys.confirmationA;
  let active = true, confirmed = false;
  let aes: Promise<CryptoKey> | undefined;
  // Bind sealed key exchange to its sender as well as the caller's enrollment AAD.
  const sealingAad = (aad: Bytes, sending: boolean) => transcript(
    utf8("bridge spake2 seal v1"),
    utf8((role === "browser") === sending ? "b2r" : "r2b"), copyBytes(aad),
  );
  const destroy = () => { active = false; confirmed = false; keys.encryption.fill(0); ownMac.fill(0); peerMac.fill(0); aes = undefined; };
  const getKey = async () => {
    if (!active) throw new BridgeCryptoError("confirmation_failed");
    aes ??= importAes(keys.encryption);
    const key = await aes;
    keys.encryption.fill(0);
    if (!active) throw new BridgeCryptoError("confirmation_failed");
    return key;
  };
  return {
    get confirmation() { if (!active) throw new BridgeCryptoError("confirmation_failed"); return new Uint8Array(ownMac); },
    verifyPeerConfirmation(mac) {
      if (!active) return false;
      confirmed = equalBytes(peerMac, mac);
      if (!confirmed) destroy();
      return confirmed;
    },
    async seal(plaintext, aad) {
      const boundAad = sealingAad(aad, true);
      const input = copyBytes(plaintext);
      let blob;
      try { blob = await seal(await getKey(), input, boundAad); }
      finally { input.fill(0); }
      if (!active) throw new BridgeCryptoError("confirmation_failed");
      return blob;
    },
    async open(blob, aad) {
      if (!confirmed) throw new BridgeCryptoError("confirmation_failed");
      const boundAad = sealingAad(aad, false);
      const captured = { nonce: blob.nonce, ct: blob.ct };
      const plaintext = await open(await getKey(), captured, boundAad);
      if (!active) { plaintext.fill(0); throw new BridgeCryptoError("confirmation_failed"); }
      return plaintext;
    },
    destroy,
  };
}
