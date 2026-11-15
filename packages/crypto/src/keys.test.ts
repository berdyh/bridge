import { describe, expect, it, vi } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateKeyPair, generateRawKeyPair, keyIdOf, loadKeyPair } from "./keys.js";
import { base64UrlDecode } from "./encoding.js";
import type { StoredKeyPair } from "./contracts.js";

function withoutNativeX25519() {
  const original = crypto.subtle.generateKey.bind(crypto.subtle);
  return vi.spyOn(crypto.subtle, "generateKey").mockImplementation((algorithm, extractable, usages) => {
    const name = typeof algorithm === "string" ? algorithm : algorithm.name;
    if (name === "X25519") return Promise.reject(new DOMException("unsupported", "NotSupportedError"));
    return original(algorithm, extractable, usages) as Promise<CryptoKeyPair & CryptoKey>;
  });
}

describe("X25519 keys", () => {
  it.each(["webcrypto", "wrapped"] as const)("generates, stores and reloads nonextractable %s pairs", async (kind) => {
    const spy = kind === "wrapped" ? withoutNativeX25519() : undefined;
    try {
      const a = await generateKeyPair(), b = await generateKeyPair();
      const saved = await a.toStored();
      expect(saved.kind).toBe(kind);
      expect(saved).not.toHaveProperty("secretKey");
      const opaque = saved.kind === "webcrypto" ? saved.privateKey : saved.kind === "wrapped" ? saved.wrappingKey : undefined;
      expect(opaque?.extractable).toBe(false);
      await expect(crypto.subtle.exportKey("raw", opaque!)).rejects.toThrow();
      const restored = await loadKeyPair(structuredClone(saved));
      expect(restored.publicKey).toEqual(a.publicKey);
      expect(restored.id).toBe(a.id);
      expect(base64UrlDecode(a.id)).toHaveLength(16);
      expect(await restored.agree(b.publicKey)).toEqual(await b.agree(a.publicKey));
      const publicBytes = a.publicKey; publicBytes.fill(0);
      expect(a.publicKey).not.toEqual(publicBytes);
      saved.publicKey.fill(0);
      expect(restored.publicKey).not.toEqual(saved.publicKey);
      a.destroy(); a.destroy();
      await expect(a.agree(b.publicKey)).rejects.toMatchObject({ code: "malformed" });
      await expect(a.toStored()).rejects.toMatchObject({ code: "malformed" });
      restored.destroy(); b.destroy();
    } finally { spy?.mockRestore(); }
  });

  it("interoperates between native and fallback X25519", async () => {
    const native = await generateKeyPair();
    const spy = withoutNativeX25519();
    try {
      const fallback = await generateKeyPair();
      expect(await native.agree(fallback.publicKey)).toEqual(await fallback.agree(native.publicKey));
      fallback.destroy();
    } finally { spy.mockRestore(); native.destroy(); }
  });

  it("only falls back for NotSupportedError", async () => {
    const spy = vi.spyOn(crypto.subtle, "generateKey").mockRejectedValue(new DOMException("failure", "OperationError"));
    try { await expect(generateKeyPair()).rejects.toMatchObject({ code: "malformed" }); }
    finally { spy.mockRestore(); }
  });

  it.each(["webcrypto", "wrapped"] as const)("rejects malformed and low-order %s peers", async (kind) => {
    const spy = kind === "wrapped" ? withoutNativeX25519() : undefined;
    try {
      const a = await generateKeyPair();
      for (const point of [new Uint8Array(31), new Uint8Array(32), Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? 1 : 0)]) {
        await expect(a.agree(point)).rejects.toMatchObject({ code: "bad_point", message: "crypto operation failed" });
      }
      a.destroy();
    } finally { spy?.mockRestore(); }
  });

  it("preserves raw Node storage with defensive secret copies", async () => {
    const secretKey = new Uint8Array(32).fill(42);
    const saved: StoredKeyPair = { kind: "raw", secretKey, publicKey: x25519.getPublicKey(secretKey) };
    const key = await loadKeyPair(saved);
    const stored = await key.toStored();
    expect(stored.kind).toBe("raw");
    if (stored.kind !== "raw") throw new Error("expected Node storage");
    expect(stored.secretKey).toEqual(secretKey);
    expect(stored.secretKey).not.toBe(secretKey);
    expect(secretKey).toEqual(new Uint8Array(32).fill(42));
    expect(await keyIdOf(key.publicKey)).toBe(key.id);
    stored.secretKey.fill(0);
    expect(await key.toStored()).toEqual(saved);
    saved.secretKey.fill(7);
    const next = await key.toStored();
    expect(next.kind === "raw" && next.secretKey).toEqual(new Uint8Array(32).fill(42));
    key.destroy();
    expect(next.kind === "raw" && next.secretKey).toEqual(new Uint8Array(32).fill(42));
    await expect(key.toStored()).rejects.toMatchObject({ code: "malformed" });
    await expect(loadKeyPair({ ...saved, publicKey: new Uint8Array(32) })).rejects.toMatchObject({ code: "malformed" });
  });

  it("generates a Node identity through the public API and restores it from bytes after destruction", async () => {
    const api = await import("./index.js");
    expect(api.generateRawKeyPair).toBe(generateRawKeyPair);
    const saved = await api.generateRawKeyPair();
    const other = await api.generateRawKeyPair();
    expect(saved.kind).toBe("raw");
    expect(saved.secretKey).toHaveLength(32);
    expect(saved.secretKey).not.toEqual(other.secretKey);
    const identity = await loadKeyPair(saved), peer = await generateKeyPair();
    const publicKey = identity.publicKey, id = identity.id;
    const shared = await peer.agree(publicKey);
    // Model the plaintext payload of the runner's encrypted file store. No
    // CryptoKey or live handle can survive this byte-only JSON round trip.
    const stored = await identity.toStored();
    if (stored.kind !== "raw") throw new Error("expected Node storage");
    const serialized = JSON.stringify({ publicKey: [...stored.publicKey], secretKey: [...stored.secretKey] });
    saved.secretKey.fill(0); stored.secretKey.fill(0);
    identity.destroy();
    const decoded = JSON.parse(serialized) as { publicKey: number[]; secretKey: number[] };
    const restored = await loadKeyPair({ kind: "raw", publicKey: new Uint8Array(decoded.publicKey), secretKey: new Uint8Array(decoded.secretKey) });
    expect(restored.publicKey).toEqual(publicKey);
    expect(restored.id).toBe(id);
    expect(await restored.agree(peer.publicKey)).toEqual(shared);
    await expect(restored.agree(new Uint8Array(32))).rejects.toMatchObject({ code: "bad_point" });
    restored.destroy(); peer.destroy(); other.secretKey.fill(0); shared.fill(0);
  });

  it("rejects a stored native public/private mismatch or extractable private key", async () => {
    const a = await generateKeyPair(), b = await generateKeyPair();
    const saved = await a.toStored();
    expect(saved.kind).toBe("webcrypto");
    await expect(loadKeyPair({ ...saved, publicKey: b.publicKey })).rejects.toMatchObject({ code: "malformed" });
    const exportable = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]) as CryptoKeyPair;
    await expect(loadKeyPair({ kind: "webcrypto", publicKey: a.publicKey, privateKey: exportable.privateKey })).rejects.toMatchObject({ code: "malformed" });
    a.destroy(); b.destroy();
  });

  it("rejects tampered fallback storage and public-key substitution", async () => {
    const spy = withoutNativeX25519();
    try {
      const a = await generateKeyPair(), b = await generateKeyPair();
      const saved = await a.toStored();
      if (saved.kind !== "wrapped") throw new Error("expected fallback");
      for (const field of ["wrapped", "iv", "publicKey"] as const) {
        const tampered = { ...saved, [field]: new Uint8Array(saved[field]) };
        tampered[field][0] = tampered[field][0]! ^ 1;
        await expect(loadKeyPair(tampered)).rejects.toMatchObject({ code: "malformed" });
      }
      const swapped = await b.toStored();
      if (swapped.kind !== "wrapped") throw new Error("expected fallback");
      await expect(loadKeyPair({ ...saved, wrappingKey: swapped.wrappingKey })).rejects.toMatchObject({ code: "malformed" });
      a.destroy(); b.destroy();
    } finally { spy.mockRestore(); }
  });

  it("matches a known SHA-256 public key id", async () => {
    // SHA256(32 zero bytes) = 66687aadf862bd776c8fc18b8e9f8e20...
    expect(bytesToHex(base64UrlDecode(await keyIdOf(new Uint8Array(32))))).toBe("66687aadf862bd776c8fc18b8e9f8e20");
    await expect(keyIdOf(new Uint8Array(31))).rejects.toMatchObject({ code: "malformed" });
  });
});
