import { describe, expect, it } from "vitest";
import { acknowledgeEnrollment, clearTokens, getValidAccessToken, loadTokens, pairAndStore, saveTokens, type TokenSet } from "../src/index.js";
import { baseConfig, fakeClock, fakeFetch, memoryStore } from "./helpers.js";

const receipt = { deviceCode: "d".repeat(64), receipt: "e".repeat(64) };
const tokens: TokenSet = { accessToken: "ak_secret", tokenType: "Bearer", enrollmentReceipt: receipt };

describe("enrollment acknowledgement", () => {
  it("persists an opaque nonexpiring token before acknowledgement, strips receipt afterward and never refreshes it", async () => {
    const store = memoryStore(); const clock = fakeClock();
    const replies = fakeFetch([{ body: { access_token: "ak_secret", token_type: "Bearer", enrollment_receipt: receipt.receipt } }, { body: { acknowledged: true } }]);
    let calls = 0;
    const config = baseConfig({ ...clock, fetch: async (...args) => {
      if (++calls === 2) expect(await loadTokens(store)).toMatchObject({ accessToken: "ak_secret", enrollmentReceipt: { deviceCode: receipt.deviceCode } });
      return replies.fn(...args);
    } });
    const result = await pairAndStore(config, store, { deviceCode: receipt.deviceCode, interval: 5, expiresAt: clock.now() + 60_000 });
    expect(result).toEqual({ accessToken: "ak_secret", tokenType: "Bearer" });
    expect(await loadTokens(store)).toEqual(result);
    clock.advance(1_000_000);
    expect(await getValidAccessToken(config, store)).toBe("ak_secret");
    expect(replies.calls).toHaveLength(2);
    expect(replies.calls[1]!.params).toEqual({ client_id: config.clientId, grant_type: "urn:berdyh:bridge:enrollment-ack", device_code: receipt.deviceCode, enrollment_receipt: receipt.receipt });
    expect(replies.calls[1]!.url).toBe(config.tokenUrl);
  });

  it("does not acknowledge when protected storage fails", async () => {
    const clock = fakeClock();
    const replies = fakeFetch([{ body: { access_token: "ak_secret", token_type: "Bearer", enrollment_receipt: receipt.receipt } }]);
    const store = memoryStore(); store.set = async () => { throw new Error("storage unavailable"); };
    await expect(pairAndStore(baseConfig({ ...clock, fetch: replies.fn }), store, { deviceCode: receipt.deviceCode, interval: 5, expiresAt: clock.now() + 60_000 })).rejects.toThrow("storage unavailable");
    expect(replies.calls).toHaveLength(1);
  });

  it("bounds retries and retains saved receipt for restart recovery; OAuth has no acknowledgement", async () => {
    const store = memoryStore(); await saveTokens(store, tokens);
    const clock = fakeClock(); const failed = fakeFetch([{ status: 503 }, new Error("lost response"), { status: 503 }]);
    await expect(getValidAccessToken(baseConfig({ ...clock, fetch: failed.fn }), store)).rejects.toMatchObject({ code: "server_error" });
    expect(failed.calls).toHaveLength(3); expect(clock.sleeps).toEqual([1000, 2000]);
    expect(await loadTokens(store)).toEqual(tokens);
    const recovered = fakeFetch([{ body: { acknowledged: true } }]);
    expect(await getValidAccessToken(baseConfig({ ...clock, fetch: recovered.fn }), store)).toBe("ak_secret");
    expect(await loadTokens(store)).toEqual({ accessToken: "ak_secret", tokenType: "Bearer" });
    const oauth = { accessToken: "oauth", tokenType: "Bearer", refreshToken: "refresh" };
    expect(await acknowledgeEnrollment(baseConfig({ fetch: failed.fn }), oauth)).toBe(oauth);
    expect(failed.calls).toHaveLength(3);
  });

  it("does not overwrite a concurrent credential replacement after acknowledgement", async () => {
    const store = memoryStore(); await saveTokens(store, tokens);
    const config = baseConfig({ fetch: async () => {
      await saveTokens(store, { accessToken: "ak_new", tokenType: "Bearer" });
      return new Response(JSON.stringify({ acknowledged: true }), { status: 200 });
    } });
    await expect(getValidAccessToken(config, store)).rejects.toMatchObject({ code: "credentials_changed" });
    expect((await loadTokens(store))?.accessToken).toBe("ak_new");
  });

  it("pairAndStore cannot resurrect a credential cleared while acknowledgement was in flight", async () => {
    const store = memoryStore(); const clock = fakeClock(); let calls = 0;
    const config = baseConfig({ ...clock, fetch: async () => {
      if (++calls === 1) return new Response(JSON.stringify({ access_token: "ak_secret", token_type: "Bearer", enrollment_receipt: receipt.receipt }));
      await clearTokens(store);
      return new Response(JSON.stringify({ acknowledged: true }));
    } });
    await expect(pairAndStore(config, store, { deviceCode: receipt.deviceCode, interval: 5, expiresAt: clock.now() + 60_000 })).rejects.toMatchObject({ code: "credentials_changed" });
    expect(await loadTokens(store)).toBeNull();
  });
});
