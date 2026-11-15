/** RFC 9382 composition, kept internal so production cannot inject scalars. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Bytes } from "./contracts.js";
import { concat, randomBytes, utf8 } from "./internal.js";

export const Point: typeof ed25519.Point = ed25519.Point;
export const ORDER = Point.Fn.ORDER;
export const M: InstanceType<typeof Point> = Point.fromHex("d048032c6ea0b6d697ddc2e86bda85a33adac920f1bf18e1b0c6d166a5cecdaf");
export const N: InstanceType<typeof Point> = Point.fromHex("d3bfb518f44f3430f29d0c92af503865a1ed3281dc69b35dd868ba85f886c4ab");

export function numberBE(bytes: Bytes): bigint {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  return n;
}

export function scalarBytes(n: bigint): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
  return out;
}

export function randomScalar(): Uint8Array<ArrayBuffer> {
  for (;;) {
    const bytes = randomBytes(32);
    bytes[0] = bytes[0]! & 31;
    const n = numberBE(bytes);
    if (n > 0n && n < ORDER) return bytes;
    bytes.fill(0);
  }
}

/** Public, fixed salt is a suite label, not an enrollment identifier. */
export function passwordScalar(password: string): Uint8Array<ArrayBuffer> {
  const pw = utf8(password);
  const digest = scrypt(pw, utf8("bridge spake2 password v1"), { N: 16384, r: 8, p: 1, dkLen: 40 });
  try { return scalarBytes(numberBE(digest) % ORDER); }
  finally { pw.fill(0); digest.fill(0); }
}

/** RFC lengths are uint64 LE; w is fixed-width BE, unlike point encodings. */
export function transcript(...parts: Bytes[]): Uint8Array<ArrayBuffer> {
  return concat(...parts.flatMap((part) => {
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(part.length), true);
    return [length, part];
  }));
}

export function schedule(tt: Bytes): { encryption: Bytes; confirmationA: Bytes; confirmationB: Bytes } {
  const hash = sha256(tt);
  const keys = hkdf(sha256, hash.subarray(16), undefined, utf8("ConfirmationKeys"), 32);
  try {
    return {
      encryption: hash.slice(0, 16),
      confirmationA: hmac(sha256, keys.subarray(0, 16), tt),
      confirmationB: hmac(sha256, keys.subarray(16), tt),
    };
  } finally { hash.fill(0); keys.fill(0); }
}
