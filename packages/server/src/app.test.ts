import { beforeAll, describe, expect, it, vi } from "vitest";

import type { AuthVerifier, BridgeServerConfig, DeviceStore, RelayGateway, RelayPeer, UpgradeVerdict } from "./contracts.js";
import { createBridgeApp, tokenFingerprint } from "./app.js";

const boom = () => Promise.reject(new Error("identity provider down"));

function build(overrides: { verifier?: Partial<AuthVerifier>; store?: Partial<DeviceStore>; config?: Partial<BridgeServerConfig>; verdictGateway?: boolean } = {}) {
  const accept = vi.fn(async (_request: Request, _peer: RelayPeer) => new Response(null, { status: 200 }));
  const disconnect = vi.fn(async () => 0);
  const acceptVerdict = vi.fn(async (_request: Request, _verdict: UpgradeVerdict) => new Response(null, { status: 200, headers: { "x-verdict": "1" } }));
  const relay: RelayGateway = { accept, disconnect, ...(overrides.verdictGateway === false ? {} : { acceptVerdict }) };
  const store: DeviceStore = {
    getDevice: async () => undefined,
    listDevices: async () => [],
    upsertDevice: async () => "ok",
    touchLastSeen: async () => false,
    revokeDevice: async () => ({ credentialIds: [] }),
    isRevoked: async () => false,
    isCredentialRevoked: async () => false,
    ...overrides.store,
  };
  const verifier: AuthVerifier = {
    verifyBrowser: async () => ({ userId: "alice" }),
    verifyRunner: async () => ({ userId: "alice", credentialId: "c1" }),
    ...overrides.verifier,
  };
  const config: BridgeServerConfig = {
    app: { id: "app", name: "App" },
    origin: "https://app.example",
    auth: { issuer: "https://idp.example", clientId: "c", deviceAuthorizationEndpoint: "https://idp.example/d", tokenEndpoint: "https://idp.example/t" },
    adapters: { relay, store, verifier },
    ...overrides.config,
  };
  return { host: createBridgeApp(config), accept, disconnect, acceptVerdict };
}

const runnerUpgrade = () =>
  new Request("https://app.example/relay/runner?runnerId=r1", { headers: { authorization: "Bearer t", upgrade: "websocket" } });
const browserUpgrade = () =>
  new Request("https://app.example/relay/browser?browserKeyId=k1", { headers: { authorization: "Bearer t", origin: "https://app.example", upgrade: "websocket" } });
const api = (path: string, method = "GET") =>
  new Request(`https://app.example${path}`, { method, headers: { authorization: "Bearer t", origin: "https://app.example" } });

describe("discovery enrollment page", () => {
  it("advertises the configured path and omits it when unset", async () => {
    for (const enrollPage of [undefined, "/bridge/enroll", "/"]) {
      const { host } = build({ config: enrollPage === undefined ? {} : { enrollPage } });
      const doc = await (await host.fetch(new Request("https://app.example/.well-known/bridge.json"))).json();
      if (enrollPage === undefined) expect(doc).not.toHaveProperty("enrollPage");
      else expect(doc).toHaveProperty("enrollPage", enrollPage);
    }
  });

  it.each([
    "https://evil.example/enroll", "https://app.example/enroll", "//evil.example/enroll",
    "/\\evil.example/enroll", "\\\\evil.example/enroll", "enroll", "", "/enroll?next=x",
    "/enroll#code=x", "/enroll?", "/enroll#", "/enroll\n", "/enroll\t", "/en roll", "/enroll\u007f",
  ])("rejects an invalid enrollPage at construction: %j", (enrollPage) => {
    expect(() => build({ config: { enrollPage } })).toThrow(/enrollPage/);
  });
});

describe("revoked runner at upgrade gets a verdict, not a bare 403", () => {
  const verdict = { type: "revoked", runnerId: "r1" };

  it("answers a revoked runner id with the verdict and never registers it", async () => {
    const { host, accept, acceptVerdict } = build({ store: { isRevoked: async (_u, id) => id === "r1" } });
    const res = await host.fetch(runnerUpgrade());
    expect(res.headers.get("x-verdict")).toBe("1");
    expect(acceptVerdict).toHaveBeenCalledOnce();
    expect(acceptVerdict.mock.calls[0]![1]).toEqual(verdict);
    expect(accept).not.toHaveBeenCalled();
    const auth = await host.authorizeRelayUpgrade(runnerUpgrade());
    expect(auth).toMatchObject({ ok: false, verdict });
    if (!auth.ok) expect(auth.response.status).toBe(403);
  });

  it("answers a revoked credential presented with another runner id, naming that id", async () => {
    const { host, accept, acceptVerdict } = build({ store: { isCredentialRevoked: async (_u, credentialId) => credentialId === "c1" } });
    const other = new Request("https://app.example/relay/runner?runnerId=fresh-id", { headers: { authorization: "Bearer t", upgrade: "websocket" } });
    await host.fetch(other);
    expect(acceptVerdict).toHaveBeenCalledOnce();
    expect(acceptVerdict.mock.calls[0]![1]).toEqual({ type: "revoked", runnerId: "fresh-id" });
    expect(accept).not.toHaveBeenCalled();
  });

  it("keeps the 403 where the gateway cannot deliver a verdict, or fails to", async () => {
    const plain = build({ store: { isRevoked: async () => true }, verdictGateway: false });
    const res = await plain.host.fetch(runnerUpgrade());
    expect(res.status).toBe(403);
    expect(plain.accept).not.toHaveBeenCalled();

    const failing = build({ store: { isRevoked: async () => true } });
    failing.acceptVerdict.mockRejectedValueOnce(new Error("no socket pair"));
    expect((await failing.host.fetch(runnerUpgrade())).status).toBe(403);
    expect(failing.accept).not.toHaveBeenCalled();
  });

  it("gives a revoked runner credential the verdict only when the store confirms the revoke, else 401", async () => {
    const revokedPrincipal = async () => ({ userId: "alice", credentialId: "c1", revoked: true as const });
    const confirmed = build({ verifier: { verifyRunner: revokedPrincipal }, store: { isCredentialRevoked: async (u, c) => u === "alice" && c === "c1" } });
    const res = await confirmed.host.fetch(runnerUpgrade());
    expect(res.headers.get("x-verdict")).toBe("1");
    expect(confirmed.acceptVerdict.mock.calls[0]![1]).toEqual(verdict);
    expect(confirmed.accept).not.toHaveBeenCalled();

    // Revoked at the provider only (say, in its dashboard), not by a device revoke here: nothing is confirmed.
    const unconfirmed = build({ verifier: { verifyRunner: revokedPrincipal } });
    expect((await unconfirmed.host.fetch(runnerUpgrade())).status).toBe(401);
    // A revoked principal without a credential id cannot be confirmed either.
    const noId = build({ verifier: { verifyRunner: async () => ({ userId: "alice", revoked: true as const }) }, store: { isCredentialRevoked: async () => true, isRevoked: async () => true } });
    expect((await noId.host.fetch(runnerUpgrade())).status).toBe(401);
    for (const h of [unconfirmed, noId]) {
      expect(h.accept).not.toHaveBeenCalled();
      expect(h.acceptVerdict).not.toHaveBeenCalled();
    }
    // An infrastructure failure of the confirming lookup is 503, never access or a verdict.
    const down = build({ verifier: { verifyRunner: revokedPrincipal }, store: { isCredentialRevoked: boom } });
    expect((await down.host.fetch(runnerUpgrade())).status).toBe(503);
    expect(down.acceptVerdict).not.toHaveBeenCalled();
  });

  describe("a long-offline runner whose token the verifier no longer accepts", () => {
    const refuse = { verifyRunner: async () => undefined };
    const known = (over: Partial<DeviceStore> = {}) => {
      const lookup = vi.fn(async (fp: string) => (fp === TOKEN_FP ? { userId: "alice", credentialId: "c1" } : undefined));
      return { lookup, store: { revokedCredentialByFingerprint: lookup, isCredentialRevoked: async () => true, ...over } };
    };
    // The test requests carry "Bearer t".
    let TOKEN_FP = "";
    beforeAll(async () => { TOKEN_FP = await tokenFingerprint("t"); });

    it("hashes the token as lowercase hex SHA-256", async () => {
      expect(await tokenFingerprint("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    it("gives the verdict when the fingerprint names a credential of a revoked device and the store confirms it", async () => {
      const { lookup, store } = known();
      const h = build({ verifier: refuse, store });
      const res = await h.host.fetch(runnerUpgrade());
      expect(res.headers.get("x-verdict")).toBe("1");
      expect(h.acceptVerdict.mock.calls[0]![1]).toEqual(verdict);
      expect(lookup).toHaveBeenCalledWith(TOKEN_FP);
      expect(lookup.mock.calls[0]![0]).not.toContain("t".repeat(2)); // the hash, not the token
      expect(h.accept).not.toHaveBeenCalled();
    });

    it("keeps the 401 for an unknown token, an unconfirmed credential, a store without the method, and a lookup error", async () => {
      const unknown = build({ verifier: refuse, store: { revokedCredentialByFingerprint: async () => undefined } });
      const notRevoked = build({ verifier: refuse, store: known({ isCredentialRevoked: async () => false }).store });
      const noMethod = build({ verifier: refuse });
      const lookupFails = build({ verifier: refuse, store: { revokedCredentialByFingerprint: boom } });
      const confirmFails = build({ verifier: refuse, store: known({ isCredentialRevoked: boom }).store });
      for (const h of [unknown, notRevoked, noMethod, lookupFails, confirmFails]) {
        expect((await h.host.fetch(runnerUpgrade())).status).toBe(401);
        expect(h.accept).not.toHaveBeenCalled();
        expect(h.acceptVerdict).not.toHaveBeenCalled();
      }
    });

    it("does not look up browsers, oversized tokens, or tokens the verifier failed on (503)", async () => {
      const { lookup, store } = known();
      const browser = build({ verifier: { verifyBrowser: async () => undefined }, store });
      await browser.host.fetch(browserUpgrade());
      const big = new Request("https://app.example/relay/runner?runnerId=r1", { headers: { authorization: `Bearer ${"a".repeat(5000)}`, upgrade: "websocket" } });
      expect((await build({ verifier: refuse, store }).host.fetch(big)).status).toBe(401);
      expect((await build({ verifier: { verifyRunner: boom }, store }).host.fetch(runnerUpgrade())).status).toBe(503);
      expect(lookup).not.toHaveBeenCalled();
    });

    it("binds the fingerprint (a hash, never the token) with a verified credential, only for a store that looks fingerprints up", async () => {
      const withLookup = build({ store: { revokedCredentialByFingerprint: async () => undefined } });
      await withLookup.host.fetch(runnerUpgrade());
      const peer = withLookup.accept.mock.calls[0]![1];
      expect(peer).toMatchObject({ credentialFingerprint: TOKEN_FP });
      expect(JSON.stringify(withLookup.accept.mock.calls[0]![1])).not.toContain('"t"');
      const plain = build();
      await plain.host.fetch(runnerUpgrade());
      expect(plain.accept.mock.calls[0]![1]).not.toHaveProperty("credentialFingerprint");
      const noCredential = build({ verifier: { verifyRunner: async () => ({ userId: "alice" }) }, store: { revokedCredentialByFingerprint: async () => undefined } });
      await noCredential.host.fetch(runnerUpgrade());
      expect(noCredential.accept.mock.calls[0]![1]).not.toHaveProperty("credentialFingerprint");
    });
  });

  it("never lets a principal marked revoked reach a socket or a device route", async () => {
    const revokedPrincipal = async () => ({ userId: "alice", credentialId: "c1", revoked: true as const });
    const h = build({ verifier: { verifyBrowser: revokedPrincipal }, store: { isCredentialRevoked: async () => true } });
    expect((await h.host.fetch(browserUpgrade())).status).toBe(401);
    expect((await h.host.fetch(api("/bridge/devices"))).status).toBe(401);
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.acceptVerdict).not.toHaveBeenCalled();
  });

  it("gives no verdict without a valid token, and not before the upgrade header check", async () => {
    const { host, accept, acceptVerdict } = build({ store: { isRevoked: async () => true, isCredentialRevoked: async () => true }, verifier: { verifyRunner: async () => undefined } });
    expect((await host.fetch(runnerUpgrade())).status).toBe(401);
    const noToken = new Request("https://app.example/relay/runner?runnerId=r1", { headers: { upgrade: "websocket" } });
    expect((await host.fetch(noToken)).status).toBe(401);
    const auth = await host.authorizeRelayUpgrade(runnerUpgrade());
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.verdict).toBeUndefined();

    const revoked = build({ store: { isRevoked: async () => true } });
    const plainGet = new Request("https://app.example/relay/runner?runnerId=r1", { headers: { authorization: "Bearer t" } });
    expect((await revoked.host.fetch(plainGet)).status).toBe(426);
    expect(accept).not.toHaveBeenCalled();
    expect(acceptVerdict).not.toHaveBeenCalled();
    expect(revoked.acceptVerdict).not.toHaveBeenCalled();
  });

  it("upgrades a non-revoked runner as before, and never gives a browser a verdict", async () => {
    const ok = build();
    const res = await ok.host.fetch(runnerUpgrade());
    expect(res.status).toBe(200);
    expect(ok.accept).toHaveBeenCalledWith(expect.anything(), { role: "runner", userId: "alice", runnerId: "r1", credentialId: "c1" });
    expect(ok.acceptVerdict).not.toHaveBeenCalled();

    const browser = build({ store: { isRevoked: async () => true, isCredentialRevoked: async () => true } });
    await browser.host.fetch(browserUpgrade());
    expect(browser.accept).toHaveBeenCalledOnce();
    expect(browser.acceptVerdict).not.toHaveBeenCalled();
  });
});

describe("infrastructure failures are 503, never access", () => {
  it("answers 503 when verifyRunner throws on a runner upgrade", async () => {
    const { host, accept } = build({ verifier: { verifyRunner: boom } });
    const res = await host.fetch(runnerUpgrade());
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("identity provider down");
    const auth = await host.authorizeRelayUpgrade(runnerUpgrade());
    expect(auth.ok).toBe(false);
    expect(accept).not.toHaveBeenCalled();
  });

  it("answers 503 when verifyBrowser throws on a browser upgrade", async () => {
    const { host, accept } = build({ verifier: { verifyBrowser: boom } });
    expect((await host.fetch(browserUpgrade())).status).toBe(503);
    expect(accept).not.toHaveBeenCalled();
  });

  it("answers 503 when the revocation check of the store throws", async () => {
    const { host, accept } = build({ store: { isRevoked: boom } });
    expect((await host.fetch(runnerUpgrade())).status).toBe(503);
    const credential = build({ store: { isCredentialRevoked: boom } });
    expect((await credential.host.fetch(runnerUpgrade())).status).toBe(503);
    expect(accept).not.toHaveBeenCalled();
    expect(credential.accept).not.toHaveBeenCalled();
  });

  it("answers 503 on every device API route when verifyBrowser throws", async () => {
    const { host, disconnect } = build({ verifier: { verifyBrowser: boom } });
    for (const [path, method] of [
      ["/bridge/devices", "GET"],
      ["/bridge/devices/r1", "GET"],
      ["/bridge/devices/r1/last-seen", "GET"],
      ["/bridge/devices/r1", "DELETE"],
    ] as const) {
      expect((await host.fetch(api(path, method))).status, `${method} ${path}`).toBe(503);
    }
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("still answers 401 for a token the verifier merely rejects", async () => {
    const { host } = build({ verifier: { verifyRunner: async () => undefined, verifyBrowser: async () => undefined } });
    expect((await host.fetch(runnerUpgrade())).status).toBe(401);
    expect((await host.fetch(api("/bridge/devices"))).status).toBe(401);
  });
});

describe("DELETE /bridge/devices/:id is idempotent", () => {
  it("re-runs the closes and the provider revoke for an already revoked device", async () => {
    const revokeRunnerCredentials = vi.fn(async () => undefined);
    const { host, disconnect } = build({
      store: { revokeDevice: async () => ({ credentialIds: ["c1"], alreadyRevoked: true }) },
      verifier: { revokeRunnerCredentials },
    });
    const res = await host.fetch(api("/bridge/devices/r1", "DELETE"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true, closedSockets: 0, alreadyRevoked: true });
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(revokeRunnerCredentials).toHaveBeenCalledWith("alice", ["c1"]);
  });

  it("reports a failed socket close, still revokes at the provider, and a retry succeeds", async () => {
    const revokeRunnerCredentials = vi.fn(async () => undefined);
    let revoked = false;
    const { host, disconnect } = build({
      store: {
        revokeDevice: async () => {
          const result = { credentialIds: ["c1"], ...(revoked ? { alreadyRevoked: true } : {}) };
          revoked = true;
          return result;
        },
      },
      verifier: { revokeRunnerCredentials },
    });
    disconnect.mockRejectedValue(new Error("DO fetch failed"));
    const first = await host.fetch(api("/bridge/devices/r1", "DELETE"));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ revoked: true, closedSockets: 0, socketCloseFailed: true });
    expect(revokeRunnerCredentials).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(2);
    disconnect.mockResolvedValue(1);
    const retry = await host.fetch(api("/bridge/devices/r1", "DELETE"));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ revoked: true, closedSockets: 2, alreadyRevoked: true });
    expect(revokeRunnerCredentials).toHaveBeenCalledTimes(2);
  });

  it("still answers 404 for a device that was never known", async () => {
    const { host, disconnect } = build({ store: { revokeDevice: async () => undefined } });
    expect((await host.fetch(api("/bridge/devices/zz", "DELETE"))).status).toBe(404);
    expect(disconnect).not.toHaveBeenCalled();
  });
});

describe("relay routes require a WebSocket upgrade", () => {
  const without = (make: () => Request, upgrade?: string) => {
    const r = make();
    const headers = new Headers(r.headers);
    headers.delete("upgrade");
    if (upgrade) headers.set("upgrade", upgrade);
    return new Request(r.url, { headers });
  };

  it.each([
    ["runner", runnerUpgrade],
    ["browser", browserUpgrade],
  ])("answers 426 to a plain GET on the %s route before verifying or accepting", async (_role, make) => {
    const verifyRunner = vi.fn(async () => ({ userId: "alice" }));
    const verifyBrowser = vi.fn(async () => ({ userId: "alice" }));
    const { host, accept } = build({ verifier: { verifyRunner, verifyBrowser } });
    const res = await host.fetch(without(make));
    expect(res.status).toBe(426);
    expect(res.headers.get("upgrade")).toBe("websocket");
    expect((await host.authorizeRelayUpgrade(without(make))).ok).toBe(false);
    expect((await host.fetch(without(make, "h2c"))).status).toBe(426);
    expect(verifyRunner).not.toHaveBeenCalled();
    expect(verifyBrowser).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([
    ["runner", runnerUpgrade],
    ["browser", browserUpgrade],
  ])("accepts Upgrade: WebSocket in any case on the %s route", async (_role, make) => {
    const { host, accept } = build();
    expect((await host.fetch(without(make, "WebSocket"))).status).toBe(200);
    expect(accept).toHaveBeenCalledTimes(1);
  });
});
