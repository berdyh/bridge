import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_KEY,
  getValidAccessToken,
  loadTokens,
  pairAndStore,
  clearTokens,
  saveTokens,
  PairingError,
} from "../src/index.js";
import { baseConfig, fakeClock, fakeFetch, memoryStore } from "./helpers.js";

describe("token store", () => {
  it("round-trips and tolerates corrupt data", async () => {
    const s = memoryStore();
    expect(await loadTokens(s)).toBeNull();
    await saveTokens(s, { accessToken: "A", tokenType: "Bearer" });
    expect((await loadTokens(s))?.accessToken).toBe("A");
    await s.set(DEFAULT_TOKEN_KEY, "not json");
    expect(await loadTokens(s)).toBeNull();
  });

  it("pairAndStore persists polled tokens", async () => {
    const s = memoryStore();
    const f = fakeFetch([{ body: { access_token: "AT", token_type: "Bearer", refresh_token: "RT" } }]);
    const c = fakeClock();
    const config = baseConfig({ fetch: f.fn, sleep: c.sleep, now: c.now });
    await pairAndStore(config, s, { deviceCode: "DC", interval: 1, expiresAt: c.now() + 60_000 });
    expect((await loadTokens(s))?.refreshToken).toBe("RT");
  });

  it("returns a fresh token without a request, refreshes an expiring one", async () => {
    const s = memoryStore();
    const c = fakeClock();
    await saveTokens(s, { accessToken: "OLD", refreshToken: "RT", tokenType: "Bearer", expiresAt: c.now() + 10 * 60_000 });
    const f = fakeFetch([{ body: { access_token: "NEW", token_type: "Bearer", expires_in: 3600 } }]);
    const config = baseConfig({ fetch: f.fn, now: c.now });
    expect(await getValidAccessToken(config, s)).toBe("OLD");
    expect(f.calls).toHaveLength(0);
    c.advance(10 * 60_000);
    expect(await getValidAccessToken(config, s)).toBe("NEW");
    expect((await loadTokens(s))?.refreshToken).toBe("RT");
  });

  it("clears the store when the refresh token is rejected", async () => {
    const s = memoryStore();
    const c = fakeClock();
    await saveTokens(s, { accessToken: "OLD", refreshToken: "RT", tokenType: "Bearer", expiresAt: c.now() - 1 });
    const f = fakeFetch([{ status: 400, body: { error: "invalid_grant" } }]);
    const config = baseConfig({ fetch: f.fn, now: c.now });
    await expect(getValidAccessToken(config, s)).rejects.toMatchObject({ code: "invalid_grant" });
    expect(s.data.size).toBe(0);
  });

  it("errors when nothing is stored or no refresh token exists", async () => {
    const s = memoryStore();
    const config = baseConfig();
    await expect(getValidAccessToken(config, s)).rejects.toBeInstanceOf(PairingError);
    await saveTokens(s, { accessToken: "A", tokenType: "Bearer", expiresAt: 1 });
    await expect(getValidAccessToken(config, s)).rejects.toMatchObject({ code: "no_refresh_token" });
  });

  const expired = (c: { now: () => number }, rt = "RT1") => ({
    accessToken: "OLD",
    refreshToken: rt,
    tokenType: "Bearer",
    expiresAt: c.now() - 1,
  });

  it("concurrent callers against a rotating server do not wipe the rotated token", async () => {
    const s = memoryStore();
    const c = fakeClock();
    await saveTokens(s, expired(c));
    const f = fakeFetch([
      { body: { access_token: "A2", token_type: "Bearer", refresh_token: "RT2", expires_in: 3600 } },
      { status: 400, body: { error: "invalid_grant" } },
    ]);
    const config = baseConfig({ fetch: f.fn, now: c.now });
    const res = await Promise.allSettled([getValidAccessToken(config, s), getValidAccessToken(config, s)]);
    expect(res.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(f.calls).toHaveLength(1);
    expect((await loadTokens(s))?.refreshToken).toBe("RT2");
  });

  it("does not clear a refresh token rotated by another holder of the same backing store", async () => {
    const backing = memoryStore();
    // Two independent store objects over one backing map: single-flight cannot help, the guard must.
    const mk = () => ({ ...backing, get: backing.get, set: backing.set, delete: backing.delete });
    const sA = mk();
    const sB = mk();
    const c = fakeClock();
    await saveTokens(backing, expired(c));
    let rt1Uses = 0;
    let aDone!: () => void;
    const afterA = new Promise<void>((r) => (aDone = r));
    const config = baseConfig({
      now: c.now,
      fetch: async () => {
        if (++rt1Uses === 1) {
          return new Response(
            JSON.stringify({ access_token: "A2", token_type: "Bearer", refresh_token: "RT2", expires_in: 3600 }),
          );
        }
        // Second use of RT1 is rejected, and only after A has saved RT2.
        await afterA;
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      },
    });
    const pA = getValidAccessToken(config, sA).finally(aDone);
    const pB = getValidAccessToken(config, sB);
    const [ra, rb] = await Promise.allSettled([pA, pB]);
    expect(ra.status).toBe("fulfilled");
    // A valid newer credential is stored, so the caller must not be told to pair again.
    expect(rb).toMatchObject({ status: "rejected", reason: { code: "credentials_changed" } });
    expect((await loadTokens(backing))?.refreshToken).toBe("RT2");
  });

  it("re-pair during a refresh that gets invalid_grant keeps the new pairing and reports credentials_changed", async () => {
    const s = memoryStore();
    const c = fakeClock();
    await saveTokens(s, expired(c));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const config = baseConfig({
      now: c.now,
      fetch: async () => {
        await gate;
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      },
    });
    const p = getValidAccessToken(config, s);
    await saveTokens(s, { accessToken: "NEW", refreshToken: "RT-NEW", tokenType: "Bearer", expiresAt: c.now() + 3_600_000 });
    release();
    await expect(p).rejects.toMatchObject({ code: "credentials_changed" });
    expect((await loadTokens(s))?.refreshToken).toBe("RT-NEW");
  });

  it("invalid_grant after a clear still reports invalid_grant (pairing is the right response)", async () => {
    const s = memoryStore();
    const c = fakeClock();
    await saveTokens(s, expired(c));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const config = baseConfig({
      now: c.now,
      fetch: async () => {
        await gate;
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      },
    });
    const p = getValidAccessToken(config, s);
    await clearTokens(s);
    release();
    await expect(p).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await loadTokens(s)).toBeNull();
  });

  it("forceRefresh refreshes a still-fresh token", async () => {
    const s = memoryStore();
    const c = fakeClock();
    await saveTokens(s, { accessToken: "OLD", refreshToken: "RT", tokenType: "Bearer", expiresAt: c.now() + 3_600_000 });
    const f = fakeFetch([{ body: { access_token: "NEW", token_type: "Bearer", expires_in: 3600 } }]);
    const config = baseConfig({ fetch: f.fn, now: c.now });
    expect(await getValidAccessToken(config, s, { forceRefresh: true })).toBe("NEW");
    expect(f.calls).toHaveLength(1);
  });

  it("forceRefresh refreshes a token with no expiresAt", async () => {
    const s = memoryStore();
    await saveTokens(s, { accessToken: "OLD", refreshToken: "RT", tokenType: "Bearer" });
    const f = fakeFetch([{ body: { access_token: "NEW", token_type: "Bearer" } }]);
    const config = baseConfig({ fetch: f.fn });
    expect(await getValidAccessToken(config, s)).toBe("OLD");
    expect(await getValidAccessToken(config, s, { forceRefresh: true })).toBe("NEW");
  });

  it("honours a custom skewMs", async () => {
    const s = memoryStore();
    const c = fakeClock();
    await saveTokens(s, { accessToken: "OLD", refreshToken: "RT", tokenType: "Bearer", expiresAt: c.now() + 5 * 60_000 });
    const f = fakeFetch([{ body: { access_token: "NEW", token_type: "Bearer" } }]);
    const config = baseConfig({ fetch: f.fn, now: c.now });
    expect(await getValidAccessToken(config, s)).toBe("OLD");
    expect(await getValidAccessToken(config, s, { skewMs: 10 * 60_000 })).toBe("NEW");
  });

  it("honours a custom key and leaves the default key alone", async () => {
    const s = memoryStore();
    const c = fakeClock();
    await saveTokens(s, expired(c, "RTX"), "other");
    const f = fakeFetch([{ body: { access_token: "NEW", token_type: "Bearer", refresh_token: "RTY" } }]);
    const config = baseConfig({ fetch: f.fn, now: c.now });
    expect(await getValidAccessToken(config, s, { key: "other" })).toBe("NEW");
    expect((await loadTokens(s, "other"))?.refreshToken).toBe("RTY");
    expect(await loadTokens(s)).toBeNull();
  });

  function gatedFetch(replies: Response[]) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const fn = async () => {
      const r = replies[calls++];
      await gate;
      return r!;
    };
    return { fn, release, calls: () => calls };
  }
  const ok = (access: string, refresh?: string) =>
    new Response(
      JSON.stringify({ access_token: access, token_type: "Bearer", expires_in: 3600, ...(refresh ? { refresh_token: refresh } : {}) }),
    );
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it("does not restore credentials cleared while a refresh is pending", async () => {
    const s = memoryStore();
    const c = fakeClock();
    await saveTokens(s, expired(c));
    const g = gatedFetch([ok("NEW", "RT2")]);
    const config = baseConfig({ fetch: g.fn, now: c.now });
    const p = getValidAccessToken(config, s);
    const settled = p.then(() => "ok", (e: unknown) => e);
    await tick();
    await clearTokens(s);
    g.release();
    expect(await settled).toMatchObject({ code: "credentials_changed" });
    expect(s.data.size).toBe(0);
  });

  it("does not overwrite an account paired while a refresh is pending", async () => {
    const s = memoryStore();
    const c = fakeClock();
    await saveTokens(s, expired(c));
    const g = gatedFetch([ok("NEW", "RT2")]);
    const config = baseConfig({ fetch: g.fn, now: c.now });
    const settled = getValidAccessToken(config, s).then(() => "ok", (e: unknown) => e);
    await tick();
    await saveTokens(s, { accessToken: "OTHER", refreshToken: "RTX", tokenType: "Bearer" });
    g.release();
    expect(await settled).toMatchObject({ code: "credentials_changed" });
    expect((await loadTokens(s))?.refreshToken).toBe("RTX");
  });

  it("a forced refresh does not join an in-flight normal lookup", async () => {
    const s = memoryStore();
    const c = fakeClock();
    await saveTokens(s, { accessToken: "OLD", refreshToken: "RT", tokenType: "Bearer", expiresAt: c.now() + 3_600_000 });
    const f = fakeFetch([{ body: { access_token: "NEW", token_type: "Bearer", expires_in: 3600 } }]);
    const config = baseConfig({ fetch: f.fn, now: c.now });
    const normal = getValidAccessToken(config, s);
    const forced = getValidAccessToken(config, s, { forceRefresh: true });
    const forced2 = getValidAccessToken(config, s, { forceRefresh: true });
    expect(await normal).toBe("OLD");
    expect(await forced).toBe("NEW");
    expect(await forced2).toBe("NEW");
    expect(f.calls).toHaveLength(1);
  });

  /** Store whose set/delete park until the test releases them, to force write ordering. */
  function manualStore() {
    const data = new Map<string, string>();
    const pending: { op: "set" | "delete"; run: () => void }[] = [];
    const park = (op: "set" | "delete", apply: () => void) =>
      new Promise<void>((resolve) => {
        pending.push({ op, run: () => (apply(), resolve()) });
      });
    const store = {
      data,
      pending,
      get: async (k: string) => data.get(k) ?? null,
      set: (k: string, v: string) => park("set", () => void data.set(k, v)),
      delete: (k: string) => park("delete", () => void data.delete(k)),
    };
    return store;
  }
  const flush = async () => {
    for (let i = 0; i < 20; i++) await tick();
  };

  it("serialises a clearTokens issued while the refresh write is in flight", async () => {
    const s = manualStore();
    const c = fakeClock();
    s.data.set(DEFAULT_TOKEN_KEY, JSON.stringify(expired(c)));
    const f = fakeFetch([{ body: { access_token: "NEW", token_type: "Bearer", refresh_token: "RT2" } }]);
    const config = baseConfig({ fetch: f.fn, now: c.now });
    const refresh = getValidAccessToken(config, s);
    await flush();
    expect(s.pending.map((p) => p.op)).toEqual(["set"]); // check passed, write issued
    const cleared = clearTokens(s);
    await flush();
    // Without the mutex the delete would be issued now and could land before the set.
    expect(s.pending.map((p) => p.op)).toEqual(["set"]);
    s.pending.shift()!.run();
    await flush();
    expect(s.pending.map((p) => p.op)).toEqual(["delete"]);
    s.pending.shift()!.run();
    await refresh;
    await cleared;
    expect(s.data.size).toBe(0);
  });

  it("serialises a re-pair save issued while the refresh write is in flight", async () => {
    const s = manualStore();
    const c = fakeClock();
    s.data.set(DEFAULT_TOKEN_KEY, JSON.stringify(expired(c)));
    const f = fakeFetch([{ body: { access_token: "NEW", token_type: "Bearer", refresh_token: "RT2" } }]);
    const config = baseConfig({ fetch: f.fn, now: c.now });
    const refresh = getValidAccessToken(config, s);
    await flush();
    const saved = saveTokens(s, { accessToken: "OTHER", refreshToken: "RTX", tokenType: "Bearer" });
    await flush();
    expect(s.pending).toHaveLength(1);
    s.pending.shift()!.run();
    await flush();
    expect(s.pending.map((p) => p.op)).toEqual(["set"]);
    s.pending.shift()!.run();
    await refresh;
    await saved;
    expect((await loadTokens(s))?.refreshToken).toBe("RTX");
  });

  it("a queued clear makes a waiting refresh commit discard instead of restoring", async () => {
    const s = manualStore();
    const c = fakeClock();
    s.data.set(DEFAULT_TOKEN_KEY, JSON.stringify(expired(c)));
    const f = fakeFetch([{ body: { access_token: "NEW", token_type: "Bearer", refresh_token: "RT2" } }]);
    const config = baseConfig({ fetch: f.fn, now: c.now });
    // An earlier mutation holds the lock while the refresh response arrives.
    const first = saveTokens(s, expired(c));
    await flush();
    const refresh = getValidAccessToken(config, s).then(() => "ok", (e: unknown) => e);
    await flush();
    const cleared = clearTokens(s);
    s.pending.shift()!.run(); // first save lands
    await flush();
    expect(s.pending.map((p) => p.op)).toEqual(["delete"]);
    s.pending.shift()!.run();
    await first;
    await cleared;
    expect(await refresh).toMatchObject({ code: "credentials_changed" });
    expect(s.data.size).toBe(0);
    expect(s.pending).toHaveLength(0);
  });

  it("keeps working after a store write rejects", async () => {
    const s = memoryStore();
    const real = s.set;
    s.set = async () => {
      throw new Error("disk full");
    };
    await expect(saveTokens(s, { accessToken: "A", tokenType: "Bearer" })).rejects.toThrow("disk full");
    s.set = real;
    await saveTokens(s, { accessToken: "B", tokenType: "Bearer" });
    expect((await loadTokens(s))?.accessToken).toBe("B");
  });
});
