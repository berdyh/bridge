import { describe, expect, it } from "vitest";
import { PairingError, pollForToken, refreshAccessToken, startDeviceAuthorization } from "../src/index.js";
import { baseConfig, fakeClock, fakeFetch } from "./helpers.js";

const AUTH_OK = {
  device_code: "DC",
  user_code: "BCDF-GHJK",
  verification_uri: "https://app.example/connect",
  verification_uri_complete: "https://app.example/connect?c=BCDF-GHJK",
  expires_in: 600,
  interval: 5,
};
const TOKEN_OK = { access_token: "AT", refresh_token: "RT", token_type: "Bearer", expires_in: 3600, scope: "openid" };

function setup(replies: Parameters<typeof fakeFetch>[0], over = {}) {
  const f = fakeFetch(replies);
  const c = fakeClock();
  const config = baseConfig({ fetch: f.fn, sleep: c.sleep, now: c.now, ...over });
  return { f, c, config };
}
const auth = (c: { now: () => number }, interval = 5, ttl = 600) => ({
  deviceCode: "DC",
  interval,
  expiresAt: c.now() + ttl * 1000,
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PairingError) return e.code;
    throw e;
  }
  return "resolved";
}

describe("startDeviceAuthorization", () => {
  it("sends client id, scope and device details, and parses the response", async () => {
    const { f, c, config } = setup([{ body: AUTH_OK }]);
    const a = await startDeviceAuthorization(config);
    const call = f.calls[0]!;
    expect(call.url).toBe(config.deviceAuthorizationUrl);
    expect(call.params).toEqual({
      client_id: "client-1",
      scope: "openid offline_access",
      device_name: "laptop",
      device_os: "linux",
      runner_version: "1.2.3",
    });
    expect(call.params).not.toHaveProperty("client_secret");
    expect(a).toMatchObject({ deviceCode: "DC", userCode: "BCDF-GHJK", interval: 5, expiresIn: 600 });
    expect(a.expiresAt).toBe(c.now() + 600_000);
    expect(a.verificationUriComplete).toContain("BCDF");
  });

  it("supports json encoding and custom device param names (path 2)", async () => {
    const { f, config } = setup([{ body: AUTH_OK }], {
      encoding: "json",
      deviceParams: { hostname: "hostname", os: "os", runnerVersion: "version" },
    });
    await startDeviceAuthorization(config);
    expect(f.calls[0]!.params).toMatchObject({ hostname: "laptop", os: "linux", version: "1.2.3" });
  });

  it("defaults interval to 5 when absent", async () => {
    const { interval, ...rest } = AUTH_OK;
    void interval;
    const { config } = setup([{ body: rest }]);
    expect((await startDeviceAuthorization(config)).interval).toBe(5);
  });

  it("omits verificationUriComplete when the server does not send it", async () => {
    const { verification_uri_complete, ...rest } = AUTH_OK;
    void verification_uri_complete;
    const { config } = setup([{ body: rest }]);
    const a = await startDeviceAuthorization(config);
    expect(a).not.toHaveProperty("verificationUriComplete");
  });

  it("rejects an interval delivered as a string (protocol contract)", async () => {
    const { config } = setup([{ body: { ...AUTH_OK, interval: "5" } }]);
    expect(await code(startDeviceAuthorization(config))).toBe("invalid_response");
  });

  it("rejects verification_url in place of verification_uri", async () => {
    const { verification_uri, ...rest } = AUTH_OK;
    void verification_uri;
    const { config } = setup([{ body: { ...rest, verification_url: "https://x/y" } }]);
    expect(await code(startDeviceAuthorization(config))).toBe("invalid_response");
  });

  it.each([
    ["an OAuth error body", { status: 400, body: { error: "invalid_client" } }, "oauth_error"],
    ["missing required fields", { body: { device_code: "x" } }, "invalid_response"],
    ["a non-JSON 200", { status: 200, raw: "<html>" }, "invalid_response"],
    ["a network error", new Error("boom"), "network_error"],
    ["a bare 503", { status: 503, raw: "" }, "server_error"],
  ] as const)("fails with the right code on %s", async (_name, reply, expected) => {
    const { config } = setup([reply as never]);
    expect(await code(startDeviceAuthorization(config))).toBe(expected);
  });
});

describe("pollForToken", () => {
  it("waits the interval first, then returns tokens on approval", async () => {
    const { f, c, config } = setup([{ body: TOKEN_OK }]);
    const t = await pollForToken(config, auth(c));
    expect(c.sleeps).toEqual([5000]);
    expect(f.calls[0]!.params).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "DC",
      client_id: "client-1",
    });
    expect(t).toMatchObject({ accessToken: "AT", refreshToken: "RT", tokenType: "Bearer", scope: "openid" });
    expect(t.expiresAt).toBe(c.now() + 3_600_000);
  });

  it("keeps polling on authorization_pending", async () => {
    const pending = { status: 400, body: { error: "authorization_pending" } };
    const { f, c, config } = setup([pending, pending, { body: TOKEN_OK }]);
    await pollForToken(config, auth(c));
    expect(f.calls).toHaveLength(3);
    expect(c.sleeps).toEqual([5000, 5000, 5000]);
  });

  it("adds 5s permanently on slow_down", async () => {
    const slow = { status: 400, body: { error: "slow_down" } };
    const pending = { status: 400, body: { error: "authorization_pending" } };
    const { c, config } = setup([slow, pending, slow, { body: TOKEN_OK }]);
    await pollForToken(config, auth(c));
    expect(c.sleeps).toEqual([5000, 10_000, 10_000, 15_000]);
  });

  it("throws access_denied", async () => {
    const { c, config } = setup([{ status: 400, body: { error: "access_denied" } }]);
    const err = await pollForToken(config, auth(c)).catch((e: PairingError) => e);
    expect(err).toBeInstanceOf(PairingError);
    expect((err as PairingError).code).toBe("access_denied");
  });

  it("throws expired_token from the server", async () => {
    const { c, config } = setup([{ status: 400, body: { error: "expired_token" } }]);
    expect(await code(pollForToken(config, auth(c)))).toBe("expired_token");
  });

  it("throws expired_token locally once the deadline passes, without more requests", async () => {
    const pending = { status: 400, body: { error: "authorization_pending" } };
    const { f, c, config } = setup([pending, pending, pending, pending]);
    expect(await code(pollForToken(config, auth(c, 5, 12)))).toBe("expired_token");
    expect(f.calls.length).toBeLessThanOrEqual(2);
  });

  it("treats an already-expired code as expired with no request", async () => {
    const { f, c, config } = setup([]);
    expect(await code(pollForToken(config, auth(c, 5, 0)))).toBe("expired_token");
    expect(f.calls).toHaveLength(0);
  });

  it("aborts before the first sleep", async () => {
    const pre = new AbortController();
    pre.abort();
    const a = setup([]);
    expect(await code(pollForToken(a.config, auth(a.c), { signal: pre.signal }))).toBe("aborted");
  });

  it("maps a plain-Error sleep rejection to aborted when the signal fired", async () => {
    const ctl = new AbortController();
    const b = setup([], {
      sleep: async () => {
        ctl.abort();
        throw new Error("sleep cancelled");
      },
    });
    expect(await code(pollForToken(b.config, auth(b.c), { signal: ctl.signal }))).toBe("aborted");
  });

  it("rethrows a sleep failure when the signal did not fire", async () => {
    const b = setup([], {
      sleep: async () => {
        throw new Error("timer broke");
      },
    });
    await expect(pollForToken(b.config, auth(b.c))).rejects.toThrow("timer broke");
  });

  it("aborts during fetch", async () => {
    const ctl = new AbortController();
    const d = setup([]);
    const config = baseConfig({
      sleep: d.c.sleep,
      now: d.c.now,
      fetch: async () => {
        ctl.abort();
        throw new Error("aborted by signal");
      },
    });
    expect(await code(pollForToken(config, auth(d.c), { signal: ctl.signal }))).toBe("aborted");
  });

  it("passes the abort signal to fetch and sleep", async () => {
    const ctl = new AbortController();
    const { f, c, config } = setup([{ body: TOKEN_OK }]);
    await pollForToken(config, auth(c), { signal: ctl.signal });
    const sent = f.calls[0]!.init.signal!;
    expect(sent.aborted).toBe(false);
    ctl.abort();
    expect(sent.aborted).toBe(true);
  });

  it("retries network errors and bare 5xx, then succeeds", async () => {
    const ok = setup([new Error("reset"), { status: 502, raw: "" }, { body: TOKEN_OK }]);
    expect((await pollForToken(ok.config, auth(ok.c))).accessToken).toBe("AT");
  });

  it("gives up after repeated network errors", async () => {
    const bad = setup([new Error("1"), new Error("2"), new Error("3"), new Error("4")]);
    expect(await code(pollForToken(bad.config, auth(bad.c)))).toBe("network_error");
  });

  it.each(["server_error", "temporarily_unavailable"])("retries a 5xx JSON body with error %s", async (error) => {
    const ok = setup([{ status: 503, body: { error } }, { body: TOKEN_OK }]);
    expect((await pollForToken(ok.config, auth(ok.c))).accessToken).toBe("AT");
  });

  it("surfaces server_error after repeated 5xx with a JSON error body", async () => {
    const reply = { status: 503, body: { error: "temporarily_unavailable" } };
    const bad = setup([reply, reply, reply, reply]);
    expect(await code(pollForToken(bad.config, auth(bad.c)))).toBe("server_error");
  });

  it("maps invalid_grant on poll to invalid_grant", async () => {
    const { c, config } = setup([{ status: 400, body: { error: "invalid_grant" } }]);
    expect(await code(pollForToken(config, auth(c)))).toBe("invalid_grant");
  });

  it("fails on unknown OAuth errors", async () => {
    const a = setup([{ status: 400, body: { error: "invalid_client" } }]);
    expect(await code(pollForToken(a.config, auth(a.c)))).toBe("oauth_error");
  });

  it("fails on a tokenless 200", async () => {
    const b = setup([{ body: {} }]);
    expect(await code(pollForToken(b.config, auth(b.c)))).toBe("invalid_response");
  });

  it("expires locally, without a further request, when slow_down pushes the next poll past the deadline", async () => {
    const slow = { status: 400, body: { error: "slow_down" } };
    const { f, c, config } = setup([slow, { body: TOKEN_OK }]);
    // t+5s: request -> slow_down -> interval 10s -> t+15s is past the 12s deadline.
    expect(await code(pollForToken(config, auth(c, 5, 12)))).toBe("expired_token");
    expect(f.calls).toHaveLength(1);
  });

  it("sets redirect: error so tokens are never re-POSTed to a redirect target", async () => {
    const { f, c, config } = setup([{ body: TOKEN_OK }]);
    await pollForToken(config, auth(c));
    expect(f.calls[0]!.init.redirect).toBe("error");
  });

  it("never leaks token values into error messages", async () => {
    const { c, config } = setup([{ status: 400, body: { error: "weird", access_token: "SECRET", device_code: "DC" } }]);
    const err = (await pollForToken(config, auth(c)).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("SECRET");
  });
});

describe("refreshAccessToken", () => {
  it("sends a refresh grant with no secret and keeps the old refresh token if not rotated", async () => {
    const { f, config } = setup([{ body: { access_token: "AT2", token_type: "Bearer", expires_in: 60 } }]);
    const t = await refreshAccessToken(config, "RT");
    expect(f.calls[0]!.params).toEqual({ grant_type: "refresh_token", refresh_token: "RT", client_id: "client-1" });
    expect(t).toMatchObject({ accessToken: "AT2", refreshToken: "RT" });
  });

  it("uses a rotated refresh token", async () => {
    const { config } = setup([{ body: { access_token: "AT2", token_type: "Bearer", refresh_token: "RT2" } }]);
    expect((await refreshAccessToken(config, "RT")).refreshToken).toBe("RT2");
  });

  it("maps invalid_grant", async () => {
    const a = setup([{ status: 400, body: { error: "invalid_grant" } }]);
    expect(await code(refreshAccessToken(a.config, "RT"))).toBe("invalid_grant");
  });

  it("maps a bare 500 to server_error", async () => {
    const b = setup([{ status: 500, raw: "" }]);
    expect(await code(refreshAccessToken(b.config, "RT"))).toBe("server_error");
  });

  it("forwards the AbortSignal to fetch", async () => {
    const ctl = new AbortController();
    const { f, config } = setup([{ body: { access_token: "AT2", token_type: "Bearer" } }]);
    await refreshAccessToken(config, "RT", { signal: ctl.signal });
    const sent = f.calls[0]!.init.signal!;
    expect(sent.aborted).toBe(false);
    ctl.abort();
    expect(sent.aborted).toBe(true);
    expect(f.calls[0]!.init.redirect).toBe("error");
  });
});
