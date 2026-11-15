import { describe, expect, it, vi } from "vitest";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { x25519 } from "@noble/curves/ed25519.js";
import type { E2EEFrame, JsonRpcMessage } from "@berdyh/bridge-protocol";
import type { ChannelKeys } from "./contracts.js";
import { deriveChannelKeys } from "./channel.js";
import { frameEncryptionInvocations, getChannelSecrets } from "./channel-internal.js";
import { createFrameCodec } from "./frame.js";
import { generateKeyPair, loadKeyPair } from "./keys.js";
import { base64UrlDecode, base64UrlEncode } from "./encoding.js";
import { concat, utf8 } from "./internal.js";

const message: JsonRpcMessage = { jsonrpc: "2.0", id: 7, method: "session/prompt", params: { text: "Hello 🌍" } };
async function channel() {
  const bs = await generateKeyPair(), be = await generateKeyPair(), rs = await generateKeyPair(), re = await generateKeyPair();
  const browser = await deriveChannelKeys({ role: "browser", ownStatic: bs, ownEphemeral: be, peerStaticPublic: rs.publicKey, peerEphemeralPublic: re.publicKey });
  const runner = await deriveChannelKeys({ role: "runner", ownStatic: rs, ownEphemeral: re, peerStaticPublic: bs.publicKey, peerEphemeralPublic: be.publicKey });
  bs.destroy(); be.destroy(); rs.destroy(); re.destroy();
  return { browser, runner, b: createFrameCodec(browser), r: createFrameCodec(runner) };
}

describe("channel schedule and frames", () => {
  it("derives the specified four DH terms, canonical transcript and directional keys", async () => {
    const secrets = [11, 22, 33, 44].map((n) => new Uint8Array(32).fill(n));
    const pubs = secrets.map((s) => x25519.getPublicKey(s));
    const pairs = await Promise.all(secrets.map((secretKey, i) => loadKeyPair({ kind: "raw", secretKey, publicKey: pubs[i]! })));
    const b = await deriveChannelKeys({ role: "browser", ownStatic: pairs[0]!, ownEphemeral: pairs[1]!, peerStaticPublic: pubs[2]!, peerEphemeralPublic: pubs[3]! });
    const r = await deriveChannelKeys({ role: "runner", ownStatic: pairs[2]!, ownEphemeral: pairs[3]!, peerStaticPublic: pubs[0]!, peerEphemeralPublic: pubs[1]! });
    const sorted = [...pubs].sort((a, z) => {
      for (let i = 0; i < 32; i++) if (a[i] !== z[i]) return a[i]! - z[i]!;
      return 0;
    });
    const info = concat(utf8("bridge channel v1"), ...sorted);
    const ikm = concat(x25519.getSharedSecret(secrets[0]!, pubs[2]!), x25519.getSharedSecret(secrets[1]!, pubs[3]!), x25519.getSharedSecret(secrets[0]!, pubs[3]!), x25519.getSharedSecret(secrets[1]!, pubs[2]!));
    const expected = hkdf(sha256, ikm, new Uint8Array(32), info, 64);
    expect(b.kid).toBe(base64UrlEncode(sha256(info).subarray(0, 16)));
    expect(r.kid).toBe(b.kid);
    expect(Object.keys(b).sort()).toEqual(["destroy", "kid", "role"]);
    for (const keys of [b, r]) {
      const state = getChannelSecrets(keys);
      for (const [i, direction] of ["b2r", "r2b"].entries()) {
        const key = state[direction as "b2r" | "r2b"];
        expect(key.extractable).toBe(false);
        expect(key.algorithm).toEqual({ name: "AES-GCM", length: 256 });
        await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
        const iv = new Uint8Array(12);
        const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8("schedule check"));
        const reference = await crypto.subtle.importKey("raw", new Uint8Array(expected.subarray(i * 32, (i + 1) * 32)), "AES-GCM", false, ["decrypt"]);
        expect(Array.from(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, reference, ct)))).toEqual(Array.from(utf8("schedule check")));
      }
    }
    b.destroy(); r.destroy(); pairs.forEach((p) => p.destroy()); ikm.fill(0); expected.fill(0); secrets.forEach((s) => s.fill(0));
  });

  it("round-trips both directions with strictly increasing sequences and random 12-byte nonces", async () => {
    const { b, r } = await channel();
    const spy = vi.spyOn(crypto, "getRandomValues");
    try {
      const first = await b.encrypt(message), second = await b.encrypt({ jsonrpc: "2.0", result: "OK" });
      expect(first.seq).toBe(1); expect(second.seq).toBe(2); expect(b.nextSeq).toBe(3);
      expect(base64UrlDecode(first.nonce)).toHaveLength(12);
      expect(first.nonce).not.toBe(second.nonce);
      expect(spy.mock.calls.filter(([arg]) => arg?.byteLength === 12)).toHaveLength(2);
      expect(await r.decrypt(first)).toEqual(message);
      expect(await r.decrypt(second)).toEqual({ jsonrpc: "2.0", result: "OK" });
      expect(r.lastAccepted).toBe(2);
      expect(await b.decrypt(await r.encrypt(message))).toEqual(message);
    } finally { spy.mockRestore(); b.destroy(); r.destroy(); }
  });

  it.each(["browser", "runner"] as const)("caps %s encryption at 2^32 invocations and ends the session", async (role) => {
    const { browser, runner, b, r } = await channel();
    const sender = role === "browser" ? b : r, receiver = role === "browser" ? r : b;
    const keys = role === "browser" ? browser : runner;
    const key = getChannelSecrets(keys)[role === "browser" ? "b2r" : "r2b"];
    // Package-private forced counter: exercise the real limit without billions of calls.
    frameEncryptionInvocations.set(key, 2 ** 32 - 1);
    const encryptSpy = vi.spyOn(crypto.subtle, "encrypt");
    const nonceSpy = vi.spyOn(crypto, "getRandomValues");
    try {
      const last = await sender.encrypt(message);
      expect(frameEncryptionInvocations.get(key)).toBe(2 ** 32);
      expect(await receiver.decrypt(last)).toEqual(message);
      // The other direction has its own budget and still works before exhaustion.
      const reply = await receiver.encrypt(message);
      expect(await sender.decrypt(reply)).toEqual(message);
      const results = await Promise.allSettled(Array.from({ length: 3 }, () => sender.encrypt(message)));
      for (const result of results) expect(result).toMatchObject({ status: "rejected", reason: { code: "malformed", message: "crypto operation failed" } });
      expect(encryptSpy).toHaveBeenCalledTimes(2);
      expect(nonceSpy.mock.calls.filter(([arg]) => arg?.byteLength === 12)).toHaveLength(2);
      expect(sender.nextSeq).toBe(2);
      expect(frameEncryptionInvocations.get(key)).toBe(2 ** 32);
      expect(() => getChannelSecrets(keys)).toThrow(expect.objectContaining({ code: "malformed" }));
      await expect(sender.decrypt(reply)).rejects.toMatchObject({ code: "malformed" });
      await expect(sender.encrypt(message)).rejects.toMatchObject({ code: "malformed" });
    } finally { encryptSpy.mockRestore(); nonceSpy.mockRestore(); b.destroy(); r.destroy(); }
  });

  it("does not reset a key's invocation budget when another codec is created", async () => {
    const { browser, b, r } = await channel();
    const key = getChannelSecrets(browser).b2r;
    frameEncryptionInvocations.set(key, 2 ** 32 - 2);
    try {
      await b.encrypt(message);
      const another = createFrameCodec(browser);
      await another.encrypt(message);
      expect(frameEncryptionInvocations.get(key)).toBe(2 ** 32);
      await expect(b.encrypt(message)).rejects.toMatchObject({ code: "malformed" });
      await expect(another.encrypt(message)).rejects.toMatchObject({ code: "malformed" });
    } finally { b.destroy(); r.destroy(); }
  });

  it("charges failed AES-GCM invocations and destroys the codec", async () => {
    const { browser, b, r } = await channel();
    const key = getChannelSecrets(browser).b2r;
    frameEncryptionInvocations.set(key, 2 ** 32 - 1);
    const spy = vi.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(new Error("AES failure"));
    try {
      await expect(b.encrypt(message)).rejects.toMatchObject({ code: "auth_failed" });
      expect(frameEncryptionInvocations.get(key)).toBe(2 ** 32);
      expect(b.nextSeq).toBe(1);
      await expect(b.encrypt(message)).rejects.toMatchObject({ code: "malformed" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); b.destroy(); r.destroy(); }
  });

  it("a bad_kid destroys the receiver's keys and invalidates queued valid frames", async () => {
    const { runner, b, r } = await channel();
    const frame = await b.encrypt(message);
    try {
      const results = await Promise.allSettled([r.decrypt({ ...frame, kid: "retired-session" }), r.decrypt(frame)]);
      expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "bad_kid", message: "crypto operation failed" } });
      expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "malformed" } });
      expect(r.lastAccepted).toBe(0);
      expect(() => getChannelSecrets(runner)).toThrow(expect.objectContaining({ code: "malformed" }));
      await expect(r.encrypt(message)).rejects.toMatchObject({ code: "malformed" });
      expect(() => createFrameCodec(runner)).toThrow(expect.objectContaining({ code: "malformed" }));
    } finally { b.destroy(); r.destroy(); }
  });

  it.each(["v", "kid", "seq", "nonce", "ct"] as const)("rejects tampered %s with a generic error and no accepted sequence", async (field) => {
    const { b, r } = await channel();
    const frame = await b.encrypt(message);
    const changed: E2EEFrame = { ...frame };
    if (field === "v") changed.v = 2 as 1;
    else if (field === "seq") changed.seq = 2;
    else if (field === "kid") changed.kid = "other";
    else {
      const data = base64UrlDecode(changed[field]); data[0] = data[0]! ^ 1;
      changed[field] = base64UrlEncode(data);
    }
    await expect(r.decrypt(changed)).rejects.toMatchObject({ message: "crypto operation failed" });
    expect(r.lastAccepted).toBe(0);
    await expect(r.decrypt(frame)).rejects.toMatchObject({ code: "malformed" });
    b.destroy(); r.destroy();
  });

  it("authenticates the sequence even when the forged value is the next one", async () => {
    const { b, r } = await channel();
    await b.encrypt(message);
    const frame = await b.encrypt(message);
    await expect(r.decrypt({ ...frame, seq: 1 })).rejects.toMatchObject({ code: "auth_failed" });
    expect(r.lastAccepted).toBe(0);
    b.destroy(); r.destroy();
  });

  it("rejects reflected direction", async () => {
    const { b, r } = await channel();
    await expect(b.decrypt(await b.encrypt(message))).rejects.toMatchObject({ code: "auth_failed" });
    b.destroy(); r.destroy();
  });
  it("rejects replays and closes the session", async () => {
    const { b, r } = await channel();
    const frame = await b.encrypt(message);
    await r.decrypt(frame);
    await expect(r.decrypt(frame)).rejects.toMatchObject({ code: "replay" });
    expect(r.lastAccepted).toBe(1);
    await expect(r.encrypt(message)).rejects.toMatchObject({ code: "malformed" });
    b.destroy(); r.destroy();
  });
  it("rejects gaps, requiring a new session", async () => {
    const { b, r } = await channel();
    const first = await b.encrypt(message), second = await b.encrypt(message);
    await expect(r.decrypt(second)).rejects.toMatchObject({ code: "gap" });
    await expect(r.decrypt(first)).rejects.toMatchObject({ code: "malformed" });
    expect(r.lastAccepted).toBe(0);
    b.destroy(); r.destroy();
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects malformed seq %s", async (seq) => {
    const { b, r } = await channel();
    await expect(r.decrypt({ ...await b.encrypt(message), seq })).rejects.toMatchObject({ code: "malformed" });
    b.destroy(); r.destroy();
  });
  it.each(["nonce", "ct"] as const)("rejects malformed %s", async (field) => {
    const { b, r } = await channel();
    await expect(r.decrypt({ ...await b.encrypt(message), [field]: "AA=" })).rejects.toMatchObject({ code: "auth_failed" });
    b.destroy(); r.destroy();
  });
  it("serializes concurrent encryption and decryption in call order", async () => {
    const { b, r } = await channel();
    const frames = await Promise.all(Array.from({ length: 20 }, (_, id) => b.encrypt({ jsonrpc: "2.0", id })));
    expect(frames.map((f) => f.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const messages = await Promise.all(frames.map((frame) => r.decrypt(frame)));
    expect(messages.map((m) => m.id)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(r.lastAccepted).toBe(20);
    b.destroy(); r.destroy();
  });
  it("snapshots inputs before queued work", async () => {
    const { b, r } = await channel();
    const mutable: JsonRpcMessage = { jsonrpc: "2.0", id: 1 };
    const pending = b.encrypt(mutable); mutable.id = 99;
    const frame = await pending;
    const decrypted = r.decrypt(frame); frame.seq = 99; frame.ct = "invalid";
    expect(await decrypted).toEqual({ jsonrpc: "2.0", id: 1 });
    b.destroy(); r.destroy();
  });
  it("rejects bad plaintext without allocating a sequence", async () => {
    const { b, r } = await channel();
    await expect(b.encrypt({ jsonrpc: "1.0" } as unknown as JsonRpcMessage)).rejects.toMatchObject({ code: "malformed" });
    const cyclic: JsonRpcMessage = { jsonrpc: "2.0" }; cyclic.self = cyclic;
    await expect(b.encrypt(cyclic)).rejects.toMatchObject({ code: "malformed" });
    expect(b.nextSeq).toBe(1);
    expect(await r.decrypt(await b.encrypt(message))).toEqual(message);
    b.destroy(); r.destroy();
  });
  it("rejects authenticated non-JSON-RPC plaintext", async () => {
    const { browser, b, r } = await channel();
    const key = getChannelSecrets(browser).b2r;
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: utf8(JSON.stringify([1, b.kid, 1, "b2r"])) }, key, utf8('{"jsonrpc":"1.0"}'));
    await expect(r.decrypt({ v: 1, kid: b.kid, seq: 1, nonce: base64UrlEncode(nonce), ct: base64UrlEncode(new Uint8Array(ct)) })).rejects.toMatchObject({ code: "auth_failed" });
    expect(r.lastAccepted).toBe(0);
    b.destroy(); r.destroy();
  });
  it("destroy invalidates queued operations and externally destroyed keys", async () => {
    const { browser, b, r } = await channel();
    const pending = b.encrypt(message); b.destroy();
    await expect(pending).rejects.toMatchObject({ code: "malformed" });
    expect(b.nextSeq).toBe(1);
    expect(() => createFrameCodec(browser)).toThrow(expect.objectContaining({ code: "malformed" }));
    r.destroy(); r.destroy();
    const another = await channel(); another.runner.destroy();
    await expect(another.r.decrypt(await another.b.encrypt(message))).rejects.toMatchObject({ code: "malformed" });
    another.b.destroy(); another.r.destroy();
  });
  it.each(["encrypt", "decrypt"] as const)("external key destruction invalidates in-flight %s", async (operation) => {
    const { browser, runner, b, r } = await channel();
    const frame = operation === "decrypt" ? await b.encrypt(message) : undefined;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const original = crypto.subtle[operation].bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, operation).mockImplementation(async (...args) => {
      const result = await original(...args);
      entered(); await gate;
      return result;
    });
    try {
      const pending = operation === "encrypt" ? b.encrypt(message) : r.decrypt(frame!);
      await ready;
      (operation === "encrypt" ? browser : runner).destroy();
      release();
      await expect(pending).rejects.toMatchObject({ code: "malformed" });
      expect(r.lastAccepted).toBe(0);
      if (operation === "encrypt") expect(b.nextSeq).toBe(1);
    } finally { release(); spy.mockRestore(); b.destroy(); r.destroy(); }
  });
  it("fresh ephemeral keys produce a different session", async () => {
    const a = await channel(), b = await channel();
    expect(a.b.kid).not.toBe(b.b.kid);
    await expect(b.r.decrypt(await a.b.encrypt(message))).rejects.toMatchObject({ code: "bad_kid" });
    a.b.destroy(); a.r.destroy(); b.b.destroy(); b.r.destroy();
  });
  it("rejects forged ChannelKeys objects", () => {
    expect(() => createFrameCodec({ kid: "fake", role: "browser", destroy() {} } as ChannelKeys)).toThrow(expect.objectContaining({ code: "malformed" }));
  });
});
