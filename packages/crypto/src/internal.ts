/** Internal composition helpers; deliberately absent from the package barrel. */
import { isBytes } from "@noble/hashes/utils.js";
import type { SealedBlob } from "@berdyh/bridge-protocol";
import type { Bytes } from "./contracts.js";
import { base64UrlDecode, base64UrlEncode } from "./encoding.js";
import { BridgeCryptoError } from "./errors.js";

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

export function copyBytes(value: Bytes, length?: number): Uint8Array<ArrayBuffer> {
  if (!isBytes(value) || (length !== undefined && value.length !== length)) throw new BridgeCryptoError("malformed");
  return new Uint8Array(value);
}

export function concat(...parts: Bytes[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** Fixed work for the expected MAC size, including on a wrong length. */
export function equalBytes(expected: Bytes, actual: Bytes): boolean {
  if (!isBytes(actual)) return false;
  let diff = expected.length ^ actual.length;
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ (actual[i] ?? 0);
  return diff === 0;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export async function importAes(secret: Bytes): Promise<CryptoKey> {
  const raw = copyBytes(secret);
  try { return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]); }
  finally { raw.fill(0); }
}

export async function seal(key: CryptoKey, plaintext: Bytes, aad: Bytes): Promise<SealedBlob> {
  const input = copyBytes(plaintext);
  try {
    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: copyBytes(aad), tagLength: 128 }, key, input);
    return { nonce: base64UrlEncode(iv), ct: base64UrlEncode(new Uint8Array(ct)) };
  } catch { throw new BridgeCryptoError("auth_failed"); }
  finally { input.fill(0); }
}

export async function open(key: CryptoKey, blob: SealedBlob, aad: Bytes): Promise<Bytes> {
  try {
    const iv = copyBytes(base64UrlDecode(blob.nonce), 12);
    const ct = copyBytes(base64UrlDecode(blob.ct));
    if (ct.length < 16) throw new Error();
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: copyBytes(aad), tagLength: 128 }, key, ct));
  } catch { throw new BridgeCryptoError("auth_failed"); }
}
