import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSleep } from "../src/http.js";
import { PairingError, startDeviceAuthorization } from "../src/index.js";
import { baseConfig } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("defaultSleep", () => {
  it("rejects with aborted when the signal fires, and a later tick does not resolve it", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    const p = defaultSleep(5000, ctl.signal);
    const settled = p.then(
      () => "resolved",
      (e: unknown) => (e instanceof PairingError ? e.code : "other"),
    );
    ctl.abort();
    expect(await settled).toBe("aborted");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it("rejects immediately when already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(defaultSleep(5000, ctl.signal)).rejects.toMatchObject({ code: "aborted" });
  });

  it("resolves after the delay and removes the abort listener", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    const remove = vi.spyOn(ctl.signal, "removeEventListener");
    const p = defaultSleep(5000, ctl.signal);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("default fetch resolution", () => {
  it("uses globalThis.fetch, looked up at call time, when none is injected", async () => {
    const spy = vi.fn(async () =>
      new Response(
        JSON.stringify({ device_code: "D", user_code: "U", verification_uri: "https://x", expires_in: 60 }),
      ),
    );
    vi.stubGlobal("fetch", spy);
    const a = await startDeviceAuthorization(baseConfig());
    expect(a.deviceCode).toBe("D");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("request deadline", () => {
  const hanging = (calls: { signal?: AbortSignal | null }[]) => (_url: string, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      calls.push({ signal: init.signal });
      init.signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
    });

  it("fails a request the server never answers with network_error after the deadline", async () => {
    const calls: { signal?: AbortSignal | null }[] = [];
    const config = baseConfig({ fetch: hanging(calls) as never, requestTimeoutMs: 20 });
    await expect(startDeviceAuthorization(config)).rejects.toMatchObject({ code: "network_error" });
    expect(calls[0]!.signal).toBeDefined();
  });

  it("still cancels at once, as aborted, when the caller's signal fires first", async () => {
    const calls: { signal?: AbortSignal | null }[] = [];
    const config = baseConfig({ fetch: hanging(calls) as never, requestTimeoutMs: 60_000 });
    const ctl = new AbortController();
    const p = startDeviceAuthorization(config, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    await expect(p).rejects.toMatchObject({ code: "aborted" });
  });
});
