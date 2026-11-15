import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { RELAY_CLOSE_REPLACED, RELAY_CLOSE_REVOKED, bearerSubprotocol, RELAY_SUBPROTOCOL } from "@berdyh/bridge-protocol";

import { revokedVerdictFrame } from "@berdyh/bridge-server";
import { createMemoryDeviceStore } from "./memory-store.js";
import { createNodeBridgeServer, type NodeBridgeServer } from "./server.js";
import { createStubAuthVerifier } from "./stub-auth.js";
import { createWsRelayTransport } from "./ws-transport.js";

const AUTH = {
  issuer: "https://idp.example",
  clientId: "c",
  deviceAuthorizationEndpoint: "https://idp.example/d",
  tokenEndpoint: "https://idp.example/t",
};
const tokens = {
  browser: { "bt-alice": "alice", "bt-bob": "bob" },
  runner: { "rt-alice": "alice", "rt-alice-2": "alice", "rt-bob": "bob" },
};

let servers: NodeBridgeServer[] = [];
let sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function start(extra: Partial<Parameters<typeof createNodeBridgeServer>[0]> = {}) {
  const store = createMemoryDeviceStore();
  const verifier = createStubAuthVerifier(tokens);
  const server = await createNodeBridgeServer({
    app: { id: "t", name: "Test" },
    auth: AUTH,
    adapters: { store, verifier },
    ...extra,
  });
  servers.push(server);
  return { server, store, verifier };
}

type Client = { ws: WebSocket; inbox: string[]; closed: Promise<number>; next(pred?: (s: string) => boolean): Promise<string> };

function track(ws: WebSocket): Client {
  const inbox: string[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (d) => {
    inbox.push(d.toString());
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  sockets.push(ws);
  return {
    ws,
    inbox,
    closed,
    async next(pred = () => true) {
      for (;;) {
        const i = inbox.findIndex(pred);
        if (i >= 0) return inbox.splice(i, 1)[0]!;
        await new Promise<void>((r) => waiters.push(r));
      }
    },
  };
}

const wsUrl = (server: NodeBridgeServer, path: string) => server.url.replace("http", "ws") + path;

async function runner(server: NodeBridgeServer, token: string, runnerId: string, hello: object | null = {}) {
  const ws = new WebSocket(wsUrl(server, `/relay/runner?runnerId=${runnerId}`), { headers: { authorization: `Bearer ${token}` } });
  const c = track(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  if (hello) {
    ws.send(JSON.stringify({ type: "hello", runnerId, runnerVersion: "1.0.0", protocol: { min: 1, max: 1 }, hostname: "h", os: "linux", ...hello }));
    await c.next((s) => s.includes('"welcome"'));
  }
  return c;
}

async function browser(server: NodeBridgeServer, token: string, browserKeyId: string) {
  const ws = new WebSocket(wsUrl(server, `/relay/browser?browserKeyId=${browserKeyId}`), [RELAY_SUBPROTOCOL, bearerSubprotocol(token)], {
    headers: { origin: server.url },
  });
  const c = track(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return c;
}

const frame = (to: "runner" | "browser", runnerId: string, browserKeyId: string, body: unknown) =>
  JSON.stringify({ to, runnerId, browserKeyId, kind: "frame", body });

describe("Node bridge server", () => {
  it("serves discovery with the bound origin and the default relay url", async () => {
    const { server } = await start();
    const doc = (await (await fetch(`${server.url}/.well-known/bridge.json`)).json()) as { origin: string; relayUrl: string };
    expect(doc.origin).toBe(server.url);
    expect(doc.relayUrl).toBe(server.url.replace("http", "ws") + "/relay");
    expect(doc).not.toHaveProperty("enrollPage");
  });

  it("advertises the configured enrollment path", async () => {
    const { server } = await start({ enrollPage: "/bridge/enroll" });
    const doc = await (await fetch(`${server.url}/.well-known/bridge.json`)).json();
    expect(doc).toHaveProperty("enrollPage", "/bridge/enroll");
  });

  it("rejects an off-origin enrollment page and cleans up the transport", async () => {
    const relay = createWsRelayTransport();
    const shutdown = vi.spyOn(relay, "shutdown");
    await expect(start({ enrollPage: "//evil.example/enroll", adapters: { relay } })).rejects.toThrow(/enrollPage/);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("refuses unauthenticated, wrong-origin, and bad-token upgrades", async () => {
    const { server } = await start();
    const attempt = (path: string, opts: WebSocket.ClientOptions, protocols?: string[]) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(wsUrl(server, path), protocols ?? [], opts);
        ws.once("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
        ws.once("open", () => resolve(101));
        ws.once("error", () => undefined);
        sockets.push(ws);
      });
    expect(await attempt("/relay/runner?runnerId=r1", {})).toBe(401);
    expect(await attempt("/relay/runner?runnerId=r1", { headers: { authorization: "Bearer nope" } })).toBe(401);
    expect(await attempt("/relay/runner", { headers: { authorization: "Bearer rt-alice" } })).toBe(400);
    expect(await attempt("/relay/browser?browserKeyId=k", { headers: { origin: "https://evil.example" } }, [bearerSubprotocol("bt-alice")])).toBe(403);
    expect(await attempt("/relay/browser?browserKeyId=k", {}, [bearerSubprotocol("bt-alice")])).toBe(403);
    // A browser token is not a runner credential, and the reverse.
    expect(await attempt("/relay/runner?runnerId=r1", { headers: { authorization: "Bearer bt-alice" } })).toBe(401);
  });

  it("routes only within one user (two users, two runners)", async () => {
    const { server } = await start();
    const ra = await runner(server, "rt-alice", "run-a");
    const rb = await runner(server, "rt-bob", "run-b");
    const ba = await browser(server, "bt-alice", "bk-alice");
    const bb = await browser(server, "bt-bob", "bk-bob");

    ba.ws.send(frame("runner", "run-a", "bk-alice", "hi alice"));
    expect(JSON.parse(await ra.next((s) => s.includes("hi alice"))).body).toBe("hi alice");

    // Alice addressing Bob's runner is refused and Bob sees nothing.
    ba.ws.send(frame("runner", "run-b", "bk-alice", "intrusion"));
    expect(JSON.parse(await ba.next((s) => s.includes("unknown_runner"))).body).toMatchObject({ type: "error", code: "unknown_runner" });

    rb.ws.send(frame("browser", "run-b", "bk-bob", "hi bob"));
    expect(JSON.parse(await bb.next((s) => s.includes("hi bob"))).body).toBe("hi bob");

    expect(rb.inbox.filter((s) => s.includes("intrusion"))).toEqual([]);
    expect(bb.inbox.filter((s) => s.includes("run-a"))).toEqual([]);
    expect(ba.inbox.filter((s) => s.includes("run-b"))).toEqual([]);
    expect(ra.inbox.filter((s) => s.includes("hi bob"))).toEqual([]);
  });

  it("announces presence and peer_reconnected", async () => {
    const { server } = await start();
    const b = await browser(server, "bt-alice", "bk-1");
    const r = await runner(server, "rt-alice", "run-a");
    const presence = JSON.parse(await b.next((s) => s.includes('"presence"')));
    expect(presence.body).toMatchObject({ runnerId: "run-a", online: true, runnerVersion: "1.0.0", hostname: "h" });
    expect(JSON.parse(await b.next((s) => s.includes("peer_reconnected"))).body).toMatchObject({ peer: "runner", runnerId: "run-a" });
    expect(JSON.parse(await r.next((s) => s.includes("peer_reconnected"))).body).toMatchObject({ peer: "browser", browserKeyId: "bk-1" });
    r.ws.close();
    const offline = JSON.parse(await b.next((s) => s.includes('"online":false'))).body;
    expect(offline).toMatchObject({ online: false });
    expect(offline).not.toHaveProperty("hostname");
  });

  it.each([
    ["Büro Rechner 🖥", "Büro Rechner 🖥"], ["x".repeat(255), "x".repeat(255)],
    [undefined, undefined], ["", undefined], ["x".repeat(256), undefined],
    ...["\u0000", "\t", "\n", "\u001b", "\u007f", "\u0085", "\u009f", "\u2028", "\u2029"].map((control) => [`bad${control}name`, undefined]),
  ])("bounds hostname %j in device records and presence for current and later browsers", async (hostname, expected) => {
    const { server, store } = await start();
    const current = await browser(server, "bt-alice", "current");
    await runner(server, "rt-alice", "run-a", { hostname });
    const initial = JSON.parse(await current.next((s) => s.includes('"presence"'))).body;
    const later = await browser(server, "bt-alice", "later");
    const replay = JSON.parse(await later.next((s) => s.includes('"presence"'))).body;
    for (const body of [initial, replay]) {
      expect(body).toMatchObject({ runnerId: "run-a", online: true });
      if (expected === undefined) expect(body).not.toHaveProperty("hostname");
      else expect(body.hostname).toBe(expected);
    }
    expect((await store.getDevice("alice", "run-a"))?.hostname).toBe(expected ?? "unknown");
  });

  it("replaces an older browser socket with the same browserKeyId (4409)", async () => {
    const { server } = await start();
    const first = await browser(server, "bt-alice", "bk-same");
    const second = await browser(server, "bt-alice", "bk-same");
    expect(await first.closed).toBe(RELAY_CLOSE_REPLACED);
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("negotiates the version: update_required for a too-old runner", async () => {
    const { server } = await start({ protocol: { min: 2, max: 3 }, latestRunnerVersion: "9.9.9" });
    const r = await runner(server, "rt-alice", "run-a", null);
    r.ws.send(JSON.stringify({ type: "hello", runnerId: "run-a", runnerVersion: "0.1.0", protocol: { min: 1, max: 1 } }));
    const msg = JSON.parse(await r.next());
    expect(msg).toMatchObject({ kind: "control", body: { type: "update_required", server: { min: 2, max: 3 }, latestRunnerVersion: "9.9.9" } });
    await r.closed;
  });

  it("reports the negotiated version in the welcome", async () => {
    const { server } = await start();
    const r = await runner(server, "rt-alice", "run-a", null);
    r.ws.send(JSON.stringify({ type: "hello", runnerId: "run-a", runnerVersion: "1", protocol: { min: 1, max: 7 } }));
    expect(JSON.parse(await r.next())).toEqual({ type: "welcome", protocol: 1 });
  });

  it("revocation through the device API closes the runner's socket and blocks reconnects", async () => {
    const { server, store } = await start();
    const r = await runner(server, "rt-alice", "run-a");
    const auth = { authorization: "Bearer bt-alice" };

    const list = (await (await fetch(`${server.url}/bridge/devices`, { headers: auth })).json()) as { devices: { deviceId: string }[] };
    expect(list.devices.map((d) => d.deviceId)).toEqual(["run-a"]);
    expect((await fetch(`${server.url}/bridge/devices`)).status).toBe(401);

    // Bob cannot revoke Alice's device.
    expect((await fetch(`${server.url}/bridge/devices/run-a`, { method: "DELETE", headers: { authorization: "Bearer bt-bob" } })).status).toBe(404);
    expect(r.ws.readyState).toBe(WebSocket.OPEN);

    const res = await fetch(`${server.url}/bridge/devices/run-a`, { method: "DELETE", headers: auth });
    expect(res.status).toBe(200);
    expect(await r.closed).toBe(RELAY_CLOSE_REVOKED);
    expect(await store.isRevoked("alice", "run-a")).toBe(true);

    // The same credential under a fresh runner id: the stub IdP reports it revoked and the store confirms, so it gets the verdict.
    const verdict = await runner(server, "rt-alice", "run-fresh", null);
    expect(await verdict.next()).toBe(revokedVerdictFrame("run-fresh"));
    expect(await verdict.closed).toBe(RELAY_CLOSE_REVOKED);
    // Another credential of the same user still works.
    const ok = await runner(server, "rt-alice-2", "run-other");
    expect(ok.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("refuses a revoked credential from the store alone when the verifier cannot revoke", async () => {
    const inner = createStubAuthVerifier(tokens);
    const { server } = await start({
      adapters: { store: createMemoryDeviceStore(), verifier: { verifyBrowser: inner.verifyBrowser, verifyRunner: inner.verifyRunner } },
    });
    const r = await runner(server, "rt-alice", "run-a");
    const live = await runner(server, "rt-alice-2", "run-live"); // another credential of the same user
    await fetch(`${server.url}/bridge/devices/run-a`, { method: "DELETE", headers: { authorization: "Bearer bt-alice" } });
    await r.closed;
    // The token verified and the credential is revoked: the upgrade completes only to say so.
    const verdict = await runner(server, "rt-alice", "run-fresh", null);
    expect(await verdict.next()).toBe(revokedVerdictFrame("run-fresh"));
    expect(await verdict.closed).toBe(RELAY_CLOSE_REVOKED);
    // The live runner of the same user was not displaced, and still takes routed frames.
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
    const b = await browser(server, "bt-alice", "bk-1");
    const f = frame("runner", "run-live", "bk-1", "x");
    b.ws.send(f);
    expect(await live.next((s) => s === f)).toBe(f);
  });

  it("gives a revoked runner id the revoked verdict and close, and leaves a live runner of the same user alone", async () => {
    const { server, store } = await start();
    const live = await runner(server, "rt-alice-2", "run-live");
    const revokedRunner = await runner(server, "rt-alice", "run-gone");
    await fetch(`${server.url}/bridge/devices/run-gone`, { method: "DELETE", headers: { authorization: "Bearer bt-alice" } });
    expect(await revokedRunner.closed).toBe(RELAY_CLOSE_REVOKED);

    // Offline at revoke: the same id asks again with a still-valid token (alice's second credential).
    const lastSeen = (await store.getDevice("alice", "run-gone"))?.lastSeen;
    const again = await runner(server, "rt-alice-2", "run-gone", null);
    expect(await again.next()).toBe(revokedVerdictFrame("run-gone"));
    expect(await again.closed).toBe(RELAY_CLOSE_REVOKED);
    expect((await store.getDevice("alice", "run-gone"))?.lastSeen).toBe(lastSeen);
    expect(live.ws.readyState).toBe(WebSocket.OPEN);

    // The live runner still gets frames: its registration was not displaced.
    const b = await browser(server, "bt-alice", "bk-1");
    const f = frame("runner", "run-live", "bk-1", "x");
    b.ws.send(f);
    expect(await live.next((s) => s === f)).toBe(f);
  });

  it("answers an invalid token with 401 and a non-revoked id with a normal upgrade", async () => {
    const { server } = await start();
    await expect(runner(server, "rt-nope", "run-a")).rejects.toThrow("HTTP 401");
    const ok = await runner(server, "rt-alice", "run-a");
    expect(ok.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("gives a long-offline runner the verdict although the identity provider refuses its token", async () => {
    const inner = createStubAuthVerifier(tokens);
    let providerForgot = false;
    const verifier = { ...inner, verifyRunner: async (t: string) => (providerForgot && t === "rt-alice" ? undefined : inner.verifyRunner(t)) };
    const { server } = await start({ adapters: { store: createMemoryDeviceStore(), verifier } });
    const r = await runner(server, "rt-alice", "run-a");
    await fetch(`${server.url}/bridge/devices/run-a`, { method: "DELETE", headers: { authorization: "Bearer bt-alice" } });
    await r.closed;
    providerForgot = true; // as Clerk after about a minute: an unknown key, no revoked flag
    const verdict = await runner(server, "rt-alice", "run-a", null);
    expect(await verdict.next()).toBe(revokedVerdictFrame("run-a"));
    expect(await verdict.closed).toBe(RELAY_CLOSE_REVOKED);
    // An unknown token is still 401, and a store without the lookup keeps it for the real one too.
    await expect(runner(server, "rt-never-bound", "run-a")).rejects.toThrow("HTTP 401");
    const plain = await start({ adapters: { store: { ...createMemoryDeviceStore(), revokedCredentialByFingerprint: undefined }, verifier: { ...inner, verifyRunner: async () => undefined } } });
    await expect(runner(plain.server, "rt-alice", "run-a")).rejects.toThrow("HTTP 401");
  });

  it("closes sockets that hold a revoked credential under another runner id", async () => {
    const { server } = await start();
    const r1 = await runner(server, "rt-alice", "run-a");
    const r2 = await runner(server, "rt-alice", "run-b"); // same credential, other id
    await fetch(`${server.url}/bridge/devices/run-a`, { method: "DELETE", headers: { authorization: "Bearer bt-alice" } });
    expect(await r1.closed).toBe(RELAY_CLOSE_REVOKED);
    expect(await r2.closed).toBe(RELAY_CLOSE_REVOKED);
  });

  it("writes last-seen at most once per interval (via the store)", async () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const { server, store } = await start({ now: () => new Date(clock) });
    const first = await runner(server, "rt-alice", "run-a");
    expect((await store.getDevice("alice", "run-a"))?.lastSeen).toBe("2026-01-01T00:00:00.000Z");
    first.ws.close();
    await first.closed;
    clock += 60_000; // one minute later: inside the 5 minute window
    const second = await runner(server, "rt-alice", "run-a");
    expect((await store.getDevice("alice", "run-a"))?.lastSeen).toBe("2026-01-01T00:00:00.000Z");
    second.ws.close();
    await second.closed;
    clock += 10 * 60_000;
    const third = await runner(server, "rt-alice", "run-a");
    expect((await store.getDevice("alice", "run-a"))?.lastSeen).toBe(new Date(clock).toISOString());
    const seen = (await (await fetch(`${server.url}/bridge/devices/run-a/last-seen`, { headers: { authorization: "Bearer bt-alice" } })).json()) as { lastSeen: string };
    expect(seen.lastSeen).toBe(new Date(clock).toISOString());
    third.ws.close();
  });

  it("taps forwarded envelopes byte-identical, and nothing else", async () => {
    const taps: { raw: string; from: string; to: string }[] = [];
    const { server } = await start({ tap: (raw, m) => taps.push({ raw, from: m.from.role, to: m.to.role }) });
    const r = await runner(server, "rt-alice", "run-a");
    const b = await browser(server, "bt-alice", "bk-1");
    const raw = '{"to":"runner",  "runnerId":"run-a","browserKeyId":"bk-1","kind":"frame","body":"\\u0000 not json {"}';
    b.ws.send(raw);
    await r.next((s) => s === raw);
    expect(taps).toEqual([{ raw, from: "browser", to: "runner" }]);
  });

  it("is off by default and does not break without a tap", async () => {
    const { server } = await start();
    const r = await runner(server, "rt-alice", "run-a");
    const b = await browser(server, "bt-alice", "bk-1");
    b.ws.send(frame("runner", "run-a", "bk-1", "x"));
    await r.next((s) => s.includes('"frame"'));
  });

  it("closes binary frames with 1003", async () => {
    const { server } = await start();
    const r = await runner(server, "rt-alice", "run-a");
    r.ws.send(Buffer.from([1, 2, 3]));
    expect(await r.closed).toBe(1003);
  });

  it("closes a runner that does not say hello first", async () => {
    const { server } = await start();
    const r = await runner(server, "rt-alice", "run-a", null);
    r.ws.send(frame("browser", "run-a", "bk", "x"));
    expect(await r.closed).toBe(1008);
  });

  it("replaces an older socket of the same runnerId with 4409, without reporting the runner offline", async () => {
    const { server } = await start();
    const b = await browser(server, "bt-alice", "bk-1");
    const first = await runner(server, "rt-alice", "run-a");
    await b.next((s) => s.includes('"online":true'));
    const second = await runner(server, "rt-alice", "run-a");
    expect(await first.closed).toBe(RELAY_CLOSE_REPLACED);
    expect(second.ws.readyState).toBe(WebSocket.OPEN);

    // Traffic reaches the new socket only.
    b.ws.send(frame("runner", "run-a", "bk-1", "to the new one"));
    await second.next((s) => s.includes("to the new one"));
    await new Promise((r) => setTimeout(r, 50));
    expect(b.inbox.filter((s) => s.includes('"online":false') || s.includes("peer_gone"))).toEqual([]);
  });

  it("drops a peer over maxQueuedBytes: the sender gets error/backpressure, the slow peer is terminated", async () => {
    const { server } = await start({ maxQueuedBytes: 600 });
    const r = await runner(server, "rt-alice", "run-a");
    const b = await browser(server, "bt-alice", "bk-1");
    await r.next((s) => s.includes("peer_reconnected"));
    b.ws.send(frame("runner", "run-a", "bk-1", "x".repeat(2000)));
    expect(JSON.parse(await b.next((s) => s.includes("backpressure"))).body).toMatchObject({ type: "error", code: "backpressure" });
    expect(await r.closed).toBe(1006); // terminated, not a queued close frame
    expect(r.inbox.filter((s) => s.includes("xxxx"))).toEqual([]);
    // The browser is told the runner is gone.
    expect(JSON.parse(await b.next((s) => s.includes('"online":false'))).body).toMatchObject({ online: false });
  });

  it("closes a runner that never sends hello within helloTimeoutMs", async () => {
    const { server } = await start({ liveness: { helloTimeoutMs: 60 } });
    const silent = await runner(server, "rt-alice", "run-a", null);
    const greeted = await runner(server, "rt-alice-2", "run-b");
    expect(await silent.closed).toBe(1008);
    expect(greeted.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("refreshes lastSeen on a runner's pong, throttled by the store interval", async () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const store = createMemoryDeviceStore();
    const touch = vi.spyOn(store, "touchLastSeen");
    const { server } = await start({ now: () => new Date(clock), adapters: { store, verifier: createStubAuthVerifier(tokens) }, liveness: { pingIntervalMs: 20, helloTimeoutMs: 0 } });
    const r = await runner(server, "rt-alice", "run-a");
    const base = touch.mock.calls.length;
    await new Promise((res) => setTimeout(res, 120)); // several pongs inside the window
    // The first pong asks the store once (which refuses, the handshake just wrote); the rest are cut.
    expect(touch.mock.calls.length).toBe(base + 1);
    expect((await store.getDevice("alice", "run-a"))?.lastSeen).toBe("2026-01-01T00:00:00.000Z");
    clock += 10 * 60_000;
    await vi.waitFor(async () => expect((await store.getDevice("alice", "run-a"))?.lastSeen).toBe(new Date(clock).toISOString()));
    const after = touch.mock.calls.length;
    await new Promise((res) => setTimeout(res, 120)); // more pongs, same window
    expect(touch.mock.calls.length).toBe(after);
    expect(r.ws.readyState).toBe(WebSocket.OPEN);
  });
});
