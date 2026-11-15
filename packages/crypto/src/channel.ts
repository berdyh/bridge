import type { ChannelKeyParams, ChannelKeys } from "./contracts.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64UrlEncode } from "./encoding.js";
import { BridgeCryptoError } from "./errors.js";
import { concat, copyBytes, importAes, utf8 } from "./internal.js";
import { channelSecrets } from "./channel-internal.js";

/** The per-session key schedule. See `ChannelKeys`. */
export async function deriveChannelKeys(params: ChannelKeyParams): Promise<ChannelKeys> {
  if (params.role !== "browser" && params.role !== "runner") throw new BridgeCryptoError("malformed");
  const role = params.role;
  const ownStatic = copyBytes(params.ownStatic.publicKey, 32);
  const ownEphemeral = copyBytes(params.ownEphemeral.publicKey, 32);
  const peerStatic = copyBytes(params.peerStaticPublic, 32);
  const peerEphemeral = copyBytes(params.peerEphemeralPublic, 32);
  const sorted = [ownStatic, ownEphemeral, peerStatic, peerEphemeral].sort((a, b) => {
    for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return 0;
  });
  const info = concat(utf8("bridge channel v1"), ...sorted);
  const secrets: Uint8Array[] = [];
  let ikm: Uint8Array<ArrayBuffer> | undefined, raw: Uint8Array | undefined;
  try {
    // Canonical term order: SS, EE, browser-static/runner-ephemeral,
    // browser-ephemeral/runner-static. Sequence keeps cleanup reliable on failure.
    secrets.push(await params.ownStatic.agree(peerStatic));
    secrets.push(await params.ownEphemeral.agree(peerEphemeral));
    if (role === "browser") {
      secrets.push(await params.ownStatic.agree(peerEphemeral));
      secrets.push(await params.ownEphemeral.agree(peerStatic));
    } else {
      secrets.push(await params.ownEphemeral.agree(peerStatic));
      secrets.push(await params.ownStatic.agree(peerEphemeral));
    }
    ikm = concat(...secrets);
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    raw = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info }, key, 512));
    const b2r = await importAes(raw.subarray(0, 32));
    const r2b = await importAes(raw.subarray(32));
    const keys: ChannelKeys = Object.freeze({
      kid: base64UrlEncode(sha256(info).subarray(0, 16)), role,
      destroy() { channelSecrets.delete(keys); },
    });
    channelSecrets.set(keys, { b2r, r2b });
    return keys;
  } finally { for (const secret of secrets) secret.fill(0); ikm?.fill(0); raw?.fill(0); }
}
