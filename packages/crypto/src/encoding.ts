import type { Bytes } from "./contracts.js";
import { BridgeCryptoError } from "./errors.js";

/** Unpadded base64url, matching every binary field on the wire. */
export function base64UrlEncode(bytes: Bytes): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Throws CryptoError "malformed" on characters outside the alphabet or padding. */
export function base64UrlDecode(text: string): Bytes {
  try {
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error();
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    // Reject alternate encodings with nonzero unused tail bits.
    if (base64UrlEncode(bytes) !== text) throw new Error();
    return bytes;
  } catch {
    throw new BridgeCryptoError("malformed");
  }
}
