import { describe, expect, expectTypeOf, it } from "vitest";
import { type ChannelLayer, createPlainLayer, HANDSHAKE_TIMEOUT_MS, isPlainFrame } from "./index.js";

const msg = (id: number) => ({ jsonrpc: "2.0" as const, id, method: "ping" });

describe("plain layer", () => {
  it("numbers frames from 1 and round-trips in order", async () => {
    const a = createPlainLayer();
    const b = createPlainLayer({ kid: a.kid });
    const f1 = await a.seal(msg(1));
    const f2 = await a.seal(msg(2));
    expect([f1.seq, f2.seq]).toEqual([1, 2]);
    expect(f1.kid).toBe(a.kid);
    expect(await b.open(f1)).toEqual(msg(1));
    expect(await b.open(f2)).toEqual(msg(2));
  });
  it("rejects replays and gaps", async () => {
    const a = createPlainLayer();
    const b = createPlainLayer({ kid: a.kid });
    const f1 = await a.seal(msg(1));
    await a.seal(msg(2));
    const f3 = await a.seal(msg(3));
    await b.open(f1);
    await expect(b.open(f1)).rejects.toThrow("replay");
    await expect(b.open(f3)).rejects.toThrow("gap");
  });
  it("picks a distinct random base64url kid per instance, so a restarted sender is a new session", () => {
    const kids = new Set(Array.from({ length: 50 }, () => createPlainLayer().kid));
    expect(kids.size).toBe(50);
    for (const kid of kids) expect(kid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(createPlainLayer({ kid: "fixed" }).kid).toBe("fixed");
  });
  it("produces frames the plain-frame guard accepts, whatever the kid", async () => {
    const f = await createPlainLayer().seal(msg(1));
    expect(isPlainFrame(f)).toBe(true);
  });
  it("the runner adopts the browser's kid, so both directions carry it and stale sessions are rejected", async () => {
    const browser = createPlainLayer();
    const runner = createPlainLayer({ kid: browser.kid });
    const stale = createPlainLayer();
    expect(runner.kid).toBe(browser.kid);
    expect((await runner.seal(msg(1))).kid).toBe(browser.kid);
    await expect(browser.open(await runner.seal(msg(2)))).rejects.toThrow("gap");
    const fresh = createPlainLayer({ kid: browser.kid });
    await expect(fresh.open(await stale.seal(msg(1)))).rejects.toThrow("bad_kid");
    await expect(fresh.open(await browser.seal(msg(1)))).resolves.toEqual(msg(1));
  });
  it("starts without a handshake", async () => {
    await expect(createPlainLayer().start({ send: () => {}, onMessage: () => () => {} })).resolves.toBeUndefined();
  });
});

describe("session rules", () => {
  it("bounds the handshake", () => expect(HANDSHAKE_TIMEOUT_MS).toBe(15_000));
  it("has no re-key member: keys rotate per session, a reconnect resumes", () => {
    expectTypeOf<ChannelLayer>().not.toHaveProperty("rekey");
    expect(Object.keys(createPlainLayer()).sort()).toEqual(["close", "kid", "kind", "open", "seal", "start"]);
  });
});
