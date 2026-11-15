import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectBridge, type BridgeClient } from "@berdyh/bridge-client";
import type { JsonRpcMessage, MessageStream } from "@berdyh/bridge-protocol";
import { browserSocket, cliBinary, cliCommand, ObservedSocket, samplePlugin, silentPeer, startCli, startWorker, until } from "./harness.js";
import { assertWirePrivacy } from "./wire-privacy.js";

function rpc(channel: MessageStream<JsonRpcMessage>) {
  let next = 0;
  const notifications: JsonRpcMessage[] = [];
  const pending = new Map<number, { resolve(value: JsonRpcMessage): void; reject(error: Error): void }>();
  channel.onMessage((message) => {
    if (typeof message.id === "number" && pending.has(message.id)) pending.get(message.id)!.resolve(message);
    else notifications.push(message);
  });
  channel.onClose((reason) => { for (const p of pending.values()) p.reject(new Error(`Channel closed: ${reason}`)); });
  return {
    notifications,
    async request(method: string, params: unknown = {}): Promise<JsonRpcMessage> {
      const id = ++next;
      let timer: NodeJS.Timeout | undefined;
      try {
        const response = new Promise<JsonRpcMessage>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 15_000);
        });
        void response.catch(() => {});
        await channel.send({ jsonrpc: "2.0", id, method, params });
        return await response;
      } finally { clearTimeout(timer); pending.delete(id); }
    },
  };
}

describe("real wrangler dev, local D1 and encrypted runner", () => {
  let worker: Awaited<ReturnType<typeof startWorker>>;
  let runner: ReturnType<typeof startCli> | undefined;
  let browser: BridgeClient | undefined;
  let binary: string;

  beforeAll(async () => {
    // Exercise the real Worker with the binding off, before enabling the harness.
    const locked = await startWorker(false);
    try {
      expect((await fetch(`${locked.origin}/oauth/token`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${locked.origin}/__test/state`, { headers: { authorization: "Bearer test-browser" } })).status).toBe(404);
      expect((await fetch(`${locked.origin}/bridge/devices`, { headers: { authorization: "Bearer test-browser" } })).status).toBe(401);
    } finally { await locked.close(); }
    worker = await startWorker();
    expect((await fetch(`${worker.origin}/relay/browser?browserKeyId=forged`, {
      headers: { origin: "https://another-app.example", authorization: "Bearer test-browser" },
    })).status).toBe(403);
    expect((await fetch(`${worker.origin}/bridge/devices`, { headers: { authorization: "Bearer test-runner" } })).status).toBe(401);
    await mkdir(path.join(worker.dir, "home"));
    binary = await cliBinary(worker.dir);
  });

  afterAll(async () => {
    browser?.close();
    await runner?.close();
    for (const socket of ObservedSocket.all) socket.terminate();
    await worker?.close();
    ObservedSocket.all.length = 0;
  });

  it("pairs, enrolls with SPAKE2, streams ACP, and echoes through a plugin subprocess", async () => {
    await cliCommand(binary, worker.dir, ["connect", worker.origin, "--yes"]);
    await cliCommand(binary, worker.dir, ["plugin", "add", await samplePlugin(worker.dir), "--yes"]);
    // apps.json (v2) lists id -> origin; the record, with this runner's id, is in the app's own bridge/ folder.
    const { apps: [listed] } = JSON.parse(await readFile(path.join(worker.dir, "config/bridge/apps.json"), "utf8")) as { apps: { appId: string }[] };
    expect(listed).toBeDefined();
    const app = JSON.parse(await readFile(path.join(worker.dir, "config", listed!.appId, "bridge/app.json"), "utf8")) as { appId: string; runnerId: string };
    runner = startCli(binary, worker.dir, ["run"]);
    await until(() => runner!.output().includes("[sample-app] online"), "runner hello");
    const headers = { authorization: "Bearer test-browser" };
    expect((await fetch(`${worker.origin}/bridge/devices`)).status).toBe(401);
    const devices = await (await fetch(`${worker.origin}/bridge/devices`, { headers })).json() as { devices: { deviceId: string }[] };
    expect(devices.devices.map((d) => d.deviceId)).toEqual([app!.runnerId]);
    const keys = new Map<string, unknown>();
    browser = await connectBridge({ discoveryUrl: `${worker.origin}/.well-known/bridge.json`,
      getSessionToken: async () => "test-browser", webSocket: browserSocket(worker.origin),
      keyStore: { load: async (key) => keys.get(key), save: async (key, value) => { keys.set(key, value); }, delete: async (key) => { keys.delete(key); } },
    });
    const enrollment = startCli(binary, worker.dir, ["enroll", app!.appId]);
    try {
      await until(() => /\b[BCDFGHJKLMNPQRSTVWXYZ]{8}\b/.test(enrollment.output()), "enrollment code");
      const code = enrollment.output().match(/\b[BCDFGHJKLMNPQRSTVWXYZ]{8}\b/)![0];
      const enrolled = await browser.enroll(code, app!.runnerId);
      expect(await enrollment.finished, enrollment.output()).toBe(0);
      expect(enrollment.output()).toContain(enrolled.browserKeyId);
    } finally { await enrollment.close(); }

    const localUi: string[] = [];
    browser.onLocalUi(({ url }) => localUi.push(url));
    const channel = await browser.channel(app!.runnerId);
    const client = rpc(channel);
    expect(await client.request("initialize", { protocolVersion: 1 })).toHaveProperty("result");
    const created = await client.request("session/new", { cwd: path.join(worker.dir, "home") });
    expect(created.error).toBeUndefined();
    const sessionId = (created.result as { sessionId: string }).sessionId;
    const secret = "CF_E2EE_PRIVATE_PROMPT_7f025d";
    expect((await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: secret }] })).result).toEqual({ stopReason: "end_turn" });
    expect(JSON.stringify(client.notifications)).toContain(secret);
    expect((await client.request("_sample/echo", { secret })).result).toEqual({ secret });
    await until(() => localUi.length > 0, "plugin local UI handoff");
    expect(new URL(localUi[0]!).hostname).toBe("127.0.0.1");
    expect(await (await fetch(localUi[0]!)).text()).toContain("Bridge sample plugin");
    const wire = [...runner.wire, ...ObservedSocket.all.flatMap((s) => [...s.sent, ...s.received])];
    const envelopes = wire.filter((text) => text.startsWith("{")).map((text) => JSON.parse(text));
    const encrypted = envelopes.filter((e) => e.kind === "frame" && e.body?.ct);
    expect(encrypted.length).toBeGreaterThan(4);
    expect(encrypted.some((e) => e.to === "runner")).toBe(true);
    expect(encrypted.some((e) => e.to === "browser")).toBe(true);
    for (const text of wire) assertWirePrivacy(text, secret);

    // No application frames during this interval. The SDKs themselves ping every
    // 20 s; the server's fixed 60 s idle deadline is swept every 30 s.
    const before = await worker.diagnostics();
    const runnerPingsBefore = runner.wire.filter((text) => text === "bridge:ping").length;
    const sockets = ObservedSocket.all.filter((s) => s.readyState === 1);
    expect(sockets).toHaveLength(1);
    const sentBefore = sockets.map((s) => s.sent.length);
    const reconnectsBefore = ObservedSocket.all.length;
    const silent = await silentPeer(worker.origin);
    let silentClose: { code: number; reason: string } | undefined;
    silent.on("close", (code, reason) => { silentClose = { code, reason: String(reason) }; });
    try {
      // Wait asynchronously; no test-side keepalive substitutes for peer heartbeats.
      await until(() => Boolean(silentClose), "silent peer idle timeout", 100_000);
      expect(silentClose).toEqual({ code: 1001, reason: "heartbeat timeout" });
      expect(ObservedSocket.all).toHaveLength(reconnectsBefore);
      for (const [i, socket] of sockets.entries()) {
        expect(socket.readyState).toBe(1);
        expect(socket.sent.slice(sentBefore[i])).toContain("bridge:ping");
        expect(socket.received).toContain("bridge:pong");
      }
      expect(runner.wire.filter((text) => text === "bridge:ping").length).toBeGreaterThan(runnerPingsBefore);
      expect(runner.wire).toContain("bridge:pong");
      // The very first application frame after the quiet interval must route.
      expect((await client.request("_sample/echo", { wake: "first frame after idle" })).result).toEqual({ wake: "first frame after idle" });
      const after = await worker.diagnostics();
      expect(after.sockets).toHaveLength(2);
      for (const socket of after.sockets) expect(socket.autoResponseAt).toBeGreaterThan(0);
      // Hibernation is measured, never inferred just from surviving idle sockets.
      const hibernated = after.boot !== before.boot;
      if (hibernated) {
        expect(after.firstMessage?.boot).toBe(after.boot);
        expect(JSON.parse(after.firstMessage!.message).kind).toBe("frame");
      }
      process.stderr.write(`Hibernation: ${hibernated ? "constructor changed; the first inbound frame handled by the fresh DO instance routed" : "GAP: local runtime did not evict the DO; attachment restoration remains adapter-unit-test evidence"}\n`);
    } finally { silent.terminate(); }

    // The browser must abandon a connection when pong delivery stops, even
    // though the underlying WebSocket still receives all other traffic.
    const browserSocketNow = sockets.find((s) => s.url.includes("/browser"))!;
    browserSocketNow.dropPongs = true;
    await until(() => browserSocketNow.closedCode !== undefined, "missing-pong peer closed", 35_000);
    expect(browserSocketNow.readyState).toBe(3);
    await until(() => browser!.transport.state === "open", "browser reconnect after missing pong");
    expect((await client.request("_sample/echo", { reconnect: true })).result).toEqual({ reconnect: true });

    await cliCommand(binary, worker.dir, ["browsers", "revoke", app!.appId, browser.transport.browserKeyId]);
    await until(() => channel.closed, "browser revoked locally");
    const response = await fetch(`${worker.origin}/bridge/devices/${app!.runnerId}`, { method: "DELETE", headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revoked: true });
    await until(() => runner!.output().includes("[sample-app] revoked"), "device revocation closes runner");
    expect((await fetch(`${worker.origin}/bridge/devices/${app!.runnerId}`, { headers })).status).toBe(404);
  });
});
