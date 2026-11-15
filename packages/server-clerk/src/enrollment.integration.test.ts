import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRecord } from "@berdyh/bridge-protocol";
import { createBridgeApp, createRelayCore, type BridgeServerConfig, type RelayConnection, type RelayHandler, type RelayTransport } from "@berdyh/bridge-server";
import { pairAndStore, startDeviceAuthorization, getValidAccessToken, type CredentialStore, type PairingConfig } from "../../pairing/src/index.js";
import { enrollmentFixture, MemoryEnrollmentStore } from "../../server/test/enrollment-fixture.js";
import { createMemoryDeviceStore } from "../../server-node/src/memory-store.js";

const sdk = vi.hoisted(() => ({ create: vi.fn(), verifyToken: vi.fn() }));
vi.mock("@clerk/backend", () => ({ createClerkClient: sdk.create, verifyToken: sdk.verifyToken }));
import { createClerkEnrollmentIssuer, validEnrollmentKey } from "./enrollment-issuer.js";
import { createClerkVerifier } from "./clerk-verifier.js";

interface Key {
  id: string; secret: string; subject: string; scopes: string[]; claims: Record<string, unknown> | null;
  expiration: number; createdAt: number; expired: boolean; revoked: boolean;
}
function provider(namespace: string) {
  const keys = new Map<string, Key>(); let number = 0;
  const create = vi.fn(async (request: { subject: string; scopes: string[]; claims: Record<string, unknown>; secondsUntilExpiration: number }) => {
    const key: Key = { id: `key${++number}`, secret: `ak_${namespace}_secret${number}`, subject: request.subject, scopes: request.scopes, claims: request.claims, createdAt: 1_800_000_000_000, expiration: 1_800_000_000_000 + request.secondsUntilExpiration * 1000, expired: false, revoked: false };
    keys.set(key.id, key); return { ...key };
  });
  const get = vi.fn(async (id: string) => { const key = keys.get(id); if (!key) throw { status: 404 }; return { ...key }; });
  const verify = vi.fn(async (secret: string) => { const key = [...keys.values()].find((k) => k.secret === secret); if (!key) throw { status: 401 }; return { ...key }; });
  const revoke = vi.fn(async ({ apiKeyId }: { apiKeyId: string }) => { const key = keys.get(apiKeyId); if (key) key.revoked = true; });
  const list = vi.fn(async ({ subject, offset = 0, limit = 100 }: { subject: string; offset?: number; limit?: number }) => {
    const data = [...keys.values()].filter((k) => k.subject === subject);
    return { data: data.slice(offset, offset + limit).map((k) => ({ ...k })), totalCount: data.length };
  });
  return { keys, apiKeys: { create, get, verify, revoke, list } };
}
let providers: Map<string, ReturnType<typeof provider>>;
beforeEach(() => {
  vi.resetAllMocks(); providers = new Map();
  sdk.create.mockImplementation(({ secretKey }: { secretKey: string }) => {
    if (!providers.has(secretKey)) providers.set(secretKey, provider(secretKey));
    return providers.get(secretKey);
  });
  sdk.verifyToken.mockImplementation(async (_token: string, opts: { secretKey: string; authorizedParties: string[] }) => ({ sub: "user_alice", sid: "sess_one", iss: `https://${opts.secretKey}.clerk.test`, azp: opts.authorizedParties[0] }));
});

async function application(id: string, sharedStore = new MemoryEnrollmentStore()) {
  const origin = `https://${id}.test`;
  const verifier = createClerkVerifier({ secretKey: id, authorizedParties: [origin], issuer: `https://${id}.clerk.test`, enrollment: { appId: id } });
  const issuer = createClerkEnrollmentIssuer({ secretKey: id, appId: id });
  const enrollment = await enrollmentFixture({ appId: id, clientId: `bridge-${id}`, origin, verifier, issuer, store: sharedStore });
  const devices = createMemoryDeviceStore();
  const connections = new Map<string, RelayConnection>(); const closed: string[] = []; let core: RelayHandler;
  const transport: RelayTransport = {
    bind(handler) { core = handler; },
    async accept(_r, peer) {
      const conn = { id: String(connections.size + 1), peer, state: { connectedAt: new Date(enrollment.now()).toISOString() } };
      connections.set(conn.id, conn); await core.onOpen(conn);
      if (peer.role === "runner") await core.onMessage(conn, JSON.stringify({ type: "hello", runnerId: peer.runnerId, runnerVersion: "0.2.0", protocol: { min: 1, max: 1 } }));
      return new Response(null, { status: 200 });
    },
    async disconnect(userId, filter) {
      const matches = transport.connections(userId, filter); for (const conn of matches) transport.close(conn.id, 4003, "revoked"); return matches.length;
    },
    connections(userId, filter = {}) { return [...connections.values()].filter((c) => c.peer.userId === userId && Object.entries(filter).every(([key, value]) => c.peer[key as keyof typeof c.peer] === value)); },
    send() { return "sent"; },
    close(id) { connections.delete(id); closed.push(id); },
    setState(id, state) { const conn = connections.get(id); if (conn) connections.set(id, { ...conn, state }); },
  };
  const config: BridgeServerConfig = { app: { id, name: id }, origin, auth: { issuer: `https://${id}.clerk.test`, clientId: `bridge-${id}`, deviceAuthorizationEndpoint: origin + "/bridge/enrollment/device", tokenEndpoint: origin + "/bridge/enrollment/token" }, adapters: { store: devices, verifier, relay: transport } };
  transport.bind(createRelayCore(config, transport)); const host = createBridgeApp(config);
  const pairing: PairingConfig = { clientId: `bridge-${id}`, deviceAuthorizationUrl: config.auth.deviceAuthorizationEndpoint, tokenUrl: config.auth.tokenEndpoint, scope: "bridge:runner", device: { hostname: "Laptop", os: "linux", runnerVersion: "0.2.0" }, fetch: (url, init) => enrollment.app.fetch(new Request(url, init)), now: enrollment.now, sleep: async (ms) => { enrollment.advance(ms); } };
  const connect = (token: string, runnerId: string) => host.fetch(new Request(origin + "/relay/runner?runnerId=" + runnerId, { headers: { authorization: "Bearer " + token, upgrade: "websocket" } }));
  const enroll = async () => {
    const auth = await startDeviceAuthorization(pairing); expect((await enrollment.approve(auth.userCode)).status).toBe(200);
    const data = new Map<string, string>();
    const credentials: CredentialStore = { get: async (key) => data.get(key) ?? null, set: async (key, value) => { data.set(key, value); }, delete: async (key) => { data.delete(key); } };
    const tokens = await pairAndStore(pairing, credentials, auth);
    expect(tokens).not.toHaveProperty("expiresAt"); expect(tokens).not.toHaveProperty("refreshToken"); expect(tokens).not.toHaveProperty("enrollmentReceipt");
    expect(await getValidAccessToken(pairing, credentials)).toBe(tokens.accessToken);
    return tokens.accessToken;
  };
  const remove = (runnerId: string) => host.fetch(new Request(origin + "/bridge/devices/" + runnerId, { method: "DELETE", headers: { origin, authorization: "Bearer session" } }));
  return { ...enrollment, host, verifier, issuer, pairing, devices, connect, enroll, remove, closed, connections, provider: providers.get(id)! };
}

describe("real public enrollment → pairing → Clerk verification → relay → device revocation", () => {
  it("isolates two machines and two apps; a tombstone rejects retained credentials under old/new runner ids despite provider delay", async () => {
    const a = await application("a"); const b = await application("b", a.options.store as MemoryEnrollmentStore);
    const first = await a.enroll(); const second = await a.enroll(); const otherApp = await b.enroll();
    expect(first).not.toBe(second);
    expect((await a.connect(first, "machine-1")).status).toBe(200);
    expect((await a.connect(second, "machine-2")).status).toBe(200);
    expect((await b.connect(otherApp, "machine-1")).status).toBe(200);
    expect((await b.connect(first, "cross-app")).status).toBe(401);
    expect((await a.remove("machine-1")).status).toBe(200);
    expect(a.closed).toHaveLength(1); expect(a.connections.size).toBe(1); expect(b.connections.size).toBe(1);
    // Deliberately return authentic-but-stale provider state: local durable deny still wins.
    const original = a.provider.apiKeys.verify.getMockImplementation()!;
    a.provider.apiKeys.verify.mockImplementation(async (secret) => ({ ...await original(secret), revoked: false }));
    for (const id of ["machine-1", "fresh-identity"]) expect((await a.connect(first, id)).status).toBe(403);
    expect((await a.connect(second, "machine-2")).status).toBe(200);
    expect((await b.connect(otherApp, "machine-1")).status).toBe(200);
    // Offline revoke behaves identically; a new explicit approval produces a new usable credential.
    a.connections.clear(); await a.remove("machine-2");
    expect((await a.connect(second, "new-offline-id")).status).toBe(403);
    const fresh = await a.enroll(); expect(fresh).not.toBe(first); expect((await a.connect(fresh, "new-approved-machine")).status).toBe(200);
    expect((await a.devices.listDevices("user_alice")).map((r: DeviceRecord) => r.deviceId)).toEqual(["new-approved-machine"]);
  });

  it("strict enrollment verification refuses browser-created, overbroad, wrong-app and unbounded keys", async () => {
    const a = await application("a"); const token = await a.enroll(); const key = [...a.provider.keys.values()][0]!;
    const baseline = structuredClone(key);
    for (const patch of [{ claims: null }, { claims: { ...baseline.claims, bridgeAppId: "other" } }, { claims: { ...baseline.claims, bridgePurpose: "admin" } }, { claims: { ...baseline.claims, bridgeEnrollmentId: "invented" } }, { scopes: [] }, { scopes: ["bridge:runner", "admin"] }, { expiration: null }, { expiration: key.createdAt + 91 * 86400_000 }]) {
      Object.assign(key, baseline, patch); expect(await a.verifier.verifyRunner(token)).toBeUndefined();
    }
    Object.assign(key, baseline); expect(await a.verifier.verifyRunner(token)).toEqual({ userId: "user_alice", credentialId: "api_key:key1" });
    expect(validEnrollmentKey(key, { appId: "a" })).toBe(true);
  });

  it("finds and revokes an abandoned key when Clerk created it but its one-time response was lost", async () => {
    const a = await application("a");
    const create = a.provider.apiKeys.create.getMockImplementation()!;
    a.provider.apiKeys.create.mockImplementationOnce(async (request) => { await create(request); throw new Error("lost response"); });
    const auth = await startDeviceAuthorization(a.pairing);
    expect((await a.approve(auth.userCode)).status).toBe(503);
    expect((await a.approve(auth.userCode)).status).toBe(400);
    expect(a.provider.apiKeys.create).toHaveBeenCalledOnce();
    await a.app.cleanup();
    expect([...a.provider.keys.values()][0]!.revoked).toBe(true);
    expect(a.provider.apiKeys.list).toHaveBeenCalledWith({ subject: "user_alice", includeInvalid: true, limit: 100, offset: 0 });
  });

  it("issuer cannot create/revoke another app or user's key", async () => {
    const a = await application("a"); await a.enroll(); const key = [...a.provider.keys.values()][0]!;
    const request = { appId: "a", userId: "user_alice", enrollmentId: key.claims!.bridgeEnrollmentId as string };
    await expect(a.issuer.issue({ ...request, appId: "b", device: { hostname: "Laptop", os: "linux", runnerVersion: "0.2.0" } })).rejects.toThrow("ownership");
    await expect(a.issuer.revoke({ ...request, userId: "user_bob", credentialId: "api_key:key1" })).rejects.toThrow("owner");
    expect(key.revoked).toBe(false);
  });

  it("uses the installed SDK create/verify wire contract without a secret retrieval or automatic create retry", async () => {
    const actual = await vi.importActual<typeof import("@clerk/backend")>("@clerk/backend");
    sdk.create.mockImplementation(actual.createClerkClient);
    const claims = { bridgeAppId: "a", bridgePurpose: "runner", bridgeEnrollmentId: "e".repeat(64) };
    const wire = { object: "api_key", type: "api_key", id: "key_wire", name: "Bridge runner", subject: "user_alice", scopes: ["bridge:runner"], claims, revoked: false, revocation_reason: null, expired: false, expiration: 1_800_000_000_000 + 90 * 86400_000, created_at: 1_800_000_000_000, updated_at: 1_800_000_000_000, created_by: "user_alice", description: null, last_used_at: null, secret: "ak_wire_secret" };
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify(fail ? { errors: [{ code: "internal_error", message: "test failure" }] } : wire), { status: fail ? 503 : 200, headers: { "content-type": "application/json" } });
    }));
    try {
      const issuer = createClerkEnrollmentIssuer({ appId: "a", secretKey: "sk_test_x" });
      const request = { appId: "a", enrollmentId: claims.bridgeEnrollmentId, userId: "user_alice", device: { hostname: "Laptop", os: "linux", runnerVersion: "0.2.0" } };
      expect(await issuer.issue(request)).toEqual({ credentialId: "api_key:key_wire", secret: "ak_wire_secret" });
      expect(calls).toEqual([{ path: expect.stringMatching(/\/api_keys$/), body: { name: "Bridge runner", subject: "user_alice", created_by: "user_alice", scopes: ["bridge:runner"], seconds_until_expiration: 90 * 86400, claims } }]);
      const verifier = createClerkVerifier({ secretKey: "sk_test_x", issuer: "https://a.clerk.test", authorizedParties: ["https://a.test"], enrollment: { appId: "a" } });
      expect(await verifier.verifyRunner("ak_wire_secret")).toEqual({ userId: "user_alice", credentialId: "api_key:key_wire" });
      expect(calls.at(-1)?.path).toMatch(/\/api_keys\/verify$/);
      fail = true; const before = calls.length;
      await expect(issuer.issue(request)).rejects.toThrow();
      expect(calls.length).toBe(before + 1);
      expect(calls.every((c) => !c.path.includes("secret"))).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});
