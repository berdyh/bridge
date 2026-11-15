import type { Bytes, KeyPair, StoredKeyPair } from "./contracts.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64UrlEncode } from "./encoding.js";
import { BridgeCryptoError } from "./errors.js";
import { copyBytes, equalBytes, randomBytes } from "./internal.js";

const WRAP_AAD = new TextEncoder().encode("bridge x25519 wrap v1");

/** A fresh X25519 pair: WebCrypto when it supports X25519, noble otherwise. */
export async function generateKeyPair(options?: { extractable?: false }): Promise<KeyPair> {
  if (options?.extractable !== undefined && options.extractable !== false) throw new BridgeCryptoError("malformed");
  let generated: CryptoKeyPair;
  try {
    generated = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]) as CryptoKeyPair;
  } catch (error) {
    // Only lack of algorithm support is a reason to switch implementations.
    if (typeof error !== "object" || error === null || !("name" in error) || error.name !== "NotSupportedError") throw new BridgeCryptoError("malformed");
    const secret = randomBytes(32);
    try { return await wrapSecret(secret); }
    finally { secret.fill(0); }
  }
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", generated.publicKey));
  return makePair({ kind: "webcrypto", publicKey, privateKey: generated.privateKey });
}

/**
 * Explicit Node-only persistence path. The caller must encrypt this raw record
 * at rest and wipe its secret bytes after use. Never use raw storage in browsers.
 * Normal browser and ephemeral generation stays nonextractable via generateKeyPair.
 */
export async function generateRawKeyPair(): Promise<Extract<StoredKeyPair, { kind: "raw" }>> {
  const secretKey = randomBytes(32);
  try { return { kind: "raw", publicKey: x25519.getPublicKey(secretKey), secretKey }; }
  catch { secretKey.fill(0); throw new BridgeCryptoError("malformed"); }
}

/** Restores a pair from `KeyPair.toStored()`. */
export async function loadKeyPair(stored: StoredKeyPair): Promise<KeyPair> {
  let secret: Uint8Array<ArrayBuffer> | undefined;
  try {
    const publicKey = copyBytes(stored.publicKey, 32);
    if (stored.kind === "raw") {
      // Keep the Node store's persistence format; makePair takes its own copy.
      secret = copyBytes(stored.secretKey, 32);
      if (!equalBytes(x25519.getPublicKey(secret), publicKey)) throw new Error();
      return await makePair({ kind: "raw", publicKey, secretKey: secret });
    }
    if (stored.kind === "wrapped") {
      validateWrappingKey(stored.wrappingKey);
      const iv = copyBytes(stored.iv, 12), wrapped = copyBytes(stored.wrapped, 48);
      secret = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: WRAP_AAD, tagLength: 128 }, stored.wrappingKey, wrapped));
      if (secret.length !== 32 || !equalBytes(x25519.getPublicKey(secret), publicKey)) throw new Error();
      return await makePair({ kind: "wrapped", publicKey, wrappingKey: stored.wrappingKey, iv, wrapped });
    }
    if (stored.kind !== "webcrypto") throw new Error();
    const key = stored.privateKey;
    if (key.type !== "private" || key.extractable || key.algorithm.name !== "X25519" || !key.usages.includes("deriveBits")) throw new Error();
    // Check that the public bytes belong to the opaque private key, without exporting it.
    secret = randomBytes(32);
    const probe = x25519.getPublicKey(secret);
    const peer = await crypto.subtle.importKey("raw", copyBytes(probe), "X25519", true, []);
    const expected = x25519.getSharedSecret(secret, publicKey);
    let actual: Uint8Array | undefined;
    try {
      actual = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, key, 256));
      if (!equalBytes(expected, actual)) throw new Error();
    } finally { expected.fill(0); actual?.fill(0); }
    return await makePair({ kind: "webcrypto", publicKey, privateKey: key });
  } catch { throw new BridgeCryptoError("malformed"); }
  finally { secret?.fill(0); }
}

/** `KeyPair.id` for a bare public key: base64url(SHA-256(publicKey)[0..16)). */
export async function keyIdOf(publicKey: Bytes): Promise<string> {
  return base64UrlEncode(sha256(copyBytes(publicKey, 32)).subarray(0, 16));
}

function validateWrappingKey(key: CryptoKey): void {
  if (key.type !== "secret" || key.extractable || key.algorithm.name !== "AES-GCM" || (key.algorithm as AesKeyAlgorithm).length !== 256 || !key.usages.includes("encrypt") || !key.usages.includes("decrypt")) throw new BridgeCryptoError("malformed");
}

async function wrapSecret(secret: Bytes): Promise<KeyPair> {
  const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = randomBytes(12);
  const raw = copyBytes(secret, 32);
  try {
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: WRAP_AAD, tagLength: 128 }, wrappingKey, raw));
    return await makePair({ kind: "wrapped", publicKey: x25519.getPublicKey(secret), wrappingKey, iv, wrapped });
  } finally { raw.fill(0); }
}

async function makePair(value: StoredKeyPair): Promise<KeyPair> {
  const publicKey = copyBytes(value.publicKey, 32);
  const id = await keyIdOf(publicKey);
  let stored: StoredKeyPair | undefined = value.kind === "raw"
    ? { kind: "raw", publicKey, secretKey: copyBytes(value.secretKey, 32) }
    : value;
  return {
    get publicKey() { return new Uint8Array(publicKey); },
    id,
    async agree(peerPublicKey) {
      if (!stored) throw new BridgeCryptoError("malformed");
      const current = stored;
      let secret: Bytes | undefined, shared: Bytes | undefined;
      try {
        const peerBytes = copyBytes(peerPublicKey, 32);
        if (current.kind === "webcrypto") {
          const peer = await crypto.subtle.importKey("raw", peerBytes, "X25519", true, []);
          shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, current.privateKey, 256));
        } else if (current.kind === "wrapped") {
          secret = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: copyBytes(current.iv), additionalData: WRAP_AAD, tagLength: 128 }, current.wrappingKey, copyBytes(current.wrapped)));
          shared = x25519.getSharedSecret(secret, peerBytes);
        } else {
          shared = x25519.getSharedSecret(current.secretKey, peerBytes);
        }
        if (equalBytes(new Uint8Array(32), shared)) throw new Error();
        if (!stored) { shared.fill(0); throw new BridgeCryptoError("malformed"); }
        return shared;
      } catch {
        shared?.fill(0);
        throw new BridgeCryptoError(stored ? "bad_point" : "malformed");
      } finally { secret?.fill(0); }
    },
    async toStored() {
      if (!stored) throw new BridgeCryptoError("malformed");
      if (stored.kind === "webcrypto") return { ...stored, publicKey: new Uint8Array(publicKey) };
      if (stored.kind === "raw") return { kind: "raw", publicKey: new Uint8Array(publicKey), secretKey: new Uint8Array(stored.secretKey) };
      return { ...stored, publicKey: new Uint8Array(publicKey), iv: new Uint8Array(stored.iv), wrapped: new Uint8Array(stored.wrapped) };
    },
    destroy() {
      if (stored?.kind === "raw") stored.secretKey.fill(0);
      if (stored?.kind === "wrapped") { stored.iv.fill(0); stored.wrapped.fill(0); }
      stored = undefined;
    },
  };
}
