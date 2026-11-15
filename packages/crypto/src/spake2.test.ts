import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ED25519_TORSION_SUBGROUP } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { createSpake2 } from "./spake2.js";
import { M, N, Point, numberBE, passwordScalar, schedule, transcript } from "./spake2-internal.js";
import { utf8 } from "./internal.js";
import type { Spake2Params } from "./contracts.js";

const fixtures: { idA: string; idB: string; password: string; w: string; x: string; y: string; pA: string; pB: string; K: string; TT: string; Ke: string; cA: string; cB: string }[] = JSON.parse(readFileSync("src/fixtures/edwards25519.json", "utf8"));
const params = (role: Spake2Params["role"], password = "BCDFGHJK"): Spake2Params => ({ role, password, idA: utf8("browser"), idB: utf8("runner") });
function pair(aCode = "BCDFGHJK", bCode = aCode) {
  const a = createSpake2(params("browser", aCode)), b = createSpake2(params("runner", bCode));
  return { a, b, ar: a.finish(b.message), br: b.finish(a.message) };
}

describe("RFC 9382 SPAKE2", () => {
  it("uses the published edwards25519 constants, in the prime-order subgroup", () => {
    expect(M.toHex()).toBe("d048032c6ea0b6d697ddc2e86bda85a33adac920f1bf18e1b0c6d166a5cecdaf");
    expect(N.toHex()).toBe("d3bfb518f44f3430f29d0c92af503865a1ed3281dc69b35dd868ba85f886c4ab");
    expect(M.isTorsionFree() && N.isTorsionFree()).toBe(true);
  });

  // RFC 9382 Appendix B publishes P-256 vectors only. Its first full vector
  // validates the exact same transcript encoding and SHA256/HKDF/HMAC schedule.
  it("passes the published Appendix B transcript and confirmation vector", () => {
    const pA = hexToBytes("04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c");
    const pB = hexToBytes("0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7");
    const k = hexToBytes("0412af7e89717850671913e6b469ace67bd90a4df8ce45c2af19010175e37eed69f75897996d539356e2fa6a406d528501f907e04d97515fbe83db277b715d3325");
    const w = hexToBytes("2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f");
    const keys = schedule(transcript(utf8("server"), utf8("client"), pA, pB, k, w));
    expect(bytesToHex(keys.encryption)).toBe("0e0672dc86f8e45565d338b0540abe69");
    expect(bytesToHex(keys.confirmationA)).toBe("58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0");
    expect(bytesToHex(keys.confirmationB)).toBe("d3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26dc459b");
  });

  it.each(fixtures)("matches independent edwards25519 fixture A=$idA B=$idB", (v) => {
    // Fixtures come from affine integer arithmetic + Python hashlib/hmac,
    // independently of noble and of these production composition functions.
    expect(bytesToHex(passwordScalar(v.password))).toBe(v.w);
    const w = numberBE(hexToBytes(v.w));
    const pa = Point.BASE.multiply(numberBE(hexToBytes(v.x))).add(M.multiply(w)).toBytes();
    const pb = Point.BASE.multiply(numberBE(hexToBytes(v.y))).add(N.multiply(w)).toBytes();
    expect(bytesToHex(pa)).toBe(v.pA);
    expect(bytesToHex(pb)).toBe(v.pB);
    const k = Point.fromBytes(pb).subtract(N.multiply(w)).clearCofactor().multiply(numberBE(hexToBytes(v.x))).toBytes();
    expect(bytesToHex(k)).toBe(v.K);
    const tt = transcript(utf8(v.idA), utf8(v.idB), pa, pb, k, hexToBytes(v.w));
    expect(bytesToHex(tt)).toBe(v.TT);
    const keys = schedule(tt);
    expect(bytesToHex(keys.encryption)).toBe(v.Ke);
    expect(bytesToHex(keys.confirmationA)).toBe(v.cA);
    expect(bytesToHex(keys.confirmationB)).toBe(v.cB);
    const original = crypto.getRandomValues.bind(crypto);
    let scalar = hexToBytes(v.x);
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      if (array instanceof Uint8Array && array.length === 32) { array.set(scalar); return array; }
      return original(array);
    });
    try {
      const a = createSpake2({ role: "browser", password: v.password, idA: utf8(v.idA), idB: utf8(v.idB) });
      scalar = hexToBytes(v.y);
      const b = createSpake2({ role: "runner", password: v.password, idA: utf8(v.idA), idB: utf8(v.idB) });
      expect(bytesToHex(a.message)).toBe(v.pA);
      expect(bytesToHex(b.message)).toBe(v.pB);
      expect(bytesToHex(a.finish(b.message).confirmation)).toBe(v.cA);
      expect(bytesToHex(b.finish(a.message).confirmation)).toBe(v.cB);
      a.destroy(); b.destroy();
    } finally { spy.mockRestore(); }
  });

  it("normalizes the code and confirms both directions, without reflection", async () => {
    const { a, b, ar, br } = pair("bcdf-ghjk", "BCDF GHJK");
    const macA = ar.confirmation, macB = br.confirmation;
    expect(ar.verifyPeerConfirmation(macB)).toBe(true);
    expect(br.verifyPeerConfirmation(macA)).toBe(true);
    const aad = utf8("enrollment"), payload = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await br.seal(payload, aad);
    expect(await ar.open(sealed, aad)).toEqual(payload);
    const reverse = await ar.seal(payload, aad);
    expect(await br.open(reverse, aad)).toEqual(payload);
    await expect(ar.open(reverse, aad)).rejects.toMatchObject({ code: "auth_failed" });
    expect(sealed.nonce).not.toBe(reverse.nonce);
    await expect(ar.open(sealed, utf8("other enrollment"))).rejects.toMatchObject({ code: "auth_failed" });
    await expect(ar.open({ ...sealed, nonce: "AA" }, aad)).rejects.toMatchObject({ code: "auth_failed" });
    await expect(ar.open({ ...sealed, ct: "AA" }, aad)).rejects.toMatchObject({ code: "auth_failed" });
    expect(() => a.finish(b.message)).toThrow(expect.objectContaining({ code: "malformed" }));
    a.destroy(); b.destroy();
    await expect(ar.seal(payload, aad)).rejects.toMatchObject({ code: "confirmation_failed" });
  });

  it("allows the runner to seal a reply before confirmation, but gates opening", async () => {
    const { a, b, ar, br } = pair();
    const blob = await br.seal(utf8("runner key"), utf8("aad"));
    await expect(ar.open(blob, utf8("aad"))).rejects.toMatchObject({ code: "confirmation_failed" });
    expect(ar.verifyPeerConfirmation(br.confirmation)).toBe(true);
    expect(bytesToHex(await ar.open(blob, utf8("aad")))).toBe(bytesToHex(utf8("runner key")));
    a.destroy(); b.destroy();
  });

  it.each(["BCDFGHJK", "BCDFGHJL"])("a runner reply checks guess %s without any pake/confirm, including reused enrollId", async (guess) => {
    // Repeated starts bind the same enrollId. Each reply reveals whether that
    // start's guess was correct, even if the client never sends confirmation.
    for (let start = 0; start < 2; start++) {
      const a = createSpake2({ ...params("browser", guess), idA: utf8("same-enrollId") });
      const b = createSpake2({ ...params("runner"), idA: utf8("same-enrollId") });
      try {
        const br = b.finish(a.message);
        const sealed = await br.seal(utf8("runner public key"), utf8("same-enrollId"));
        const ar = a.finish(b.message);
        const correct = guess === "BCDFGHJK";
        expect(ar.verifyPeerConfirmation(br.confirmation)).toBe(correct);
        if (correct) expect(bytesToHex(await ar.open(sealed, utf8("same-enrollId")))).toBe(bytesToHex(utf8("runner public key")));
        // Deliberately never send ar.confirmation or verify it at the runner.
      } finally { a.destroy(); b.destroy(); }
    }
  });

  it.each(["wrong code", "wrong identity", "reflection", "short MAC", "long MAC", "modified MAC"])("fails closed for %s", (kind) => {
    const a = createSpake2(params("browser"));
    const b = createSpake2({ ...params("runner", kind === "wrong code" ? "BCDFGHJL" : "BCDFGHJK"), idB: utf8(kind === "wrong identity" ? "other" : "runner") });
    const ar = a.finish(b.message), br = b.finish(a.message);
    let mac = br.confirmation;
    if (kind === "reflection") mac = ar.confirmation;
    if (kind === "short MAC") mac = mac.subarray(0, 31);
    if (kind === "long MAC") mac = new Uint8Array(33);
    if (kind === "modified MAC") mac[0] = mac[0]! ^ 1;
    expect(ar.verifyPeerConfirmation(mac)).toBe(false);
    expect(ar.verifyPeerConfirmation(br.confirmation)).toBe(false);
    a.destroy(); b.destroy();
  });

  it.each([new Uint8Array(31), new Uint8Array(32).fill(255), ...ED25519_TORSION_SUBGROUP.map(hexToBytes)])("rejects invalid and small-order peer points", (point) => {
    const a = createSpake2(params("browser"));
    expect(() => a.finish(point)).toThrow(expect.objectContaining({ code: "bad_point" }));
    expect(() => a.finish(point)).toThrow(expect.objectContaining({ code: "malformed" }));
    a.destroy();
  });

  it("rejects a masked identity shared point", () => {
    const a = createSpake2(params("browser"));
    expect(() => a.finish(N.multiply(numberBE(passwordScalar("BCDFGHJK"))).toBytes())).toThrow(expect.objectContaining({ code: "bad_point" }));
  });
  it("destroys a session before finish and returns defensive message/MAC copies", () => {
    const a = createSpake2(params("browser"));
    const original = a.message, modified = a.message; modified.fill(0);
    expect(a.message).toEqual(original);
    a.destroy(); a.destroy();
    expect(() => a.finish(original)).toThrow(expect.objectContaining({ code: "malformed" }));
    const { a: liveA, b, ar, br } = pair();
    const mac = br.confirmation; const changed = br.confirmation; changed.fill(0);
    expect(br.confirmation).toEqual(mac);
    expect(ar.verifyPeerConfirmation(mac)).toBe(true);
    liveA.destroy(); b.destroy();
  });
  it.each(["", "ABCDEFGH", "BCDFGHJ", "BCDFGHJKK", "12345678"])("rejects an invalid code %j", (password) => {
    expect(() => createSpake2(params("browser", password))).toThrow(expect.objectContaining({ code: "malformed" }));
  });
  it("does not expose internal helpers through the barrel", async () => {
    const exports = await import("./index.js");
    expect(exports).not.toHaveProperty("getChannelSecrets");
    expect(exports).not.toHaveProperty("passwordScalar");
  });
});
