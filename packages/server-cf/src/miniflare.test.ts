import { RELAY_CLOSE_REVOKED } from "@berdyh/bridge-protocol";
import { revokedVerdictFrame } from "@berdyh/bridge-server";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
// Installed via Wrangler; no dependency installation or manifest edits needed.
const paths = [require.resolve("wrangler/package.json")];
const { Miniflare, convertV4MiniflareOptions } = require(require.resolve("miniflare", { paths }));
const WebSocketClient = require(require.resolve("ws", { paths }));
const { build } = require(require.resolve("esbuild", { paths }));
let mf: any;
let scratch: string;
const previousTmpDir = process.env.TMPDIR;
beforeAll(async () => {
  const base = new URL("../.wrangler/", import.meta.url).pathname;
  mkdirSync(base, { recursive: true });
  scratch = mkdtempSync(`${base}miniflare-tests-`);
  // Keep workerd/Miniflare scratch files inside this task's owned package.
  process.env.TMPDIR = scratch;
  const bundle = await build({ entryPoints: [new URL("./miniflare-fixture.js", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "browser", target: "es2023" });
  mf = new Miniflare(convertV4MiniflareOptions({ name: "test-bridge", cf: false, modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-01", durableObjects: { RELAY: { className: "Relay", useSQLite: true } }, d1Databases: ["DB"], cachePersist: false }));
  const db = await mf.getD1Database("DB");
  for (const file of ["0001_devices.sql", "0002_credential_fingerprint.sql"]) {
    const migration = readFileSync(new URL(`../../server-d1/migrations/${file}`, import.meta.url), "utf8");
    for (const sql of migration.replace(/--[^\n]*/g, "").split(";").filter((s) => s.trim())) await db.prepare(sql).run();
  }
}, 30_000);
afterAll(async () => {
  try { await mf?.dispose(); } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpDir;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
});
const hello = (id: string) => JSON.stringify({ type: "hello", runnerId: id, runnerVersion: "1.0.0", protocol: { min: 1, max: 1 } });
async function connect(role: string, token: string, id: string) {
  const base = await mf.ready;
  // Bound the Miniflare proxy TCP tail after the actual close frame is exchanged.
  const ws = new WebSocketClient(`ws://${base.host}/relay/${role}?${role === "runner" ? "runnerId" : "browserKeyId"}=${id}`, "bridge.v1", { closeTimeout: 100, headers: { authorization: `Bearer ${token}`, origin: "https://app.test" } });
  const messages: string[] = []; ws.on("message", (data: { toString(): string }) => messages.push(data.toString()));
  const closed = new Promise<number>((resolve) => ws.once("close", (code: number) => resolve(code)));
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return { ws, messages, closed };
}
describe("Workers runtime (Miniflare)", () => {
  it("serves discovery via Hono and denies unauthenticated sockets", async () => {
    const response = await mf.dispatchFetch("https://app.test/.well-known/bridge.json"); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ auth: { issuer: "https://auth.test" }, enrollPage: "/bridge/enroll" });
    expect((await mf.dispatchFetch("https://app.test/relay/runner?runnerId=x", { headers: { upgrade: "websocket" } })).status).toBe(401);
  });
  it("auto-responds to text pings before hello and after hibernation without handing heartbeats to core", async () => {
    const runner = await connect("runner", "alice", "heartbeat");
    try {
      runner.ws.send("bridge:pong"); runner.ws.send("bridge:ping");
      await expect.poll(() => runner.messages.includes("bridge:pong")).toBe(true);
      runner.ws.send(hello("heartbeat"));
      await expect.poll(() => runner.messages.some((m) => m.startsWith("{") && JSON.parse(m).type === "welcome")).toBe(true);
      await mf.unsafeEvictDurableObject("test-bridge", "Relay", { name: "alice", webSockets: "hibernate" });
      runner.ws.send("bridge:ping");
      await expect.poll(() => runner.messages.filter((m) => m === "bridge:pong").length).toBe(2);
      expect(runner.ws.readyState).toBe(1);
    } finally { runner.ws.close(); }
  });
  it("runs the core over hibernation sockets, replaces browsers and revokes D1 credentials", async () => {
    const runner = await connect("runner", "alice", "pc"); runner.ws.send(hello("pc"));
    await expect.poll(() => runner.messages.some((m) => JSON.parse(m).type === "welcome")).toBe(true);
    // Real D1: the hello bound the credential with the hash of the token, never the token itself.
    const bound = await (await mf.getD1Database("DB")).prepare("SELECT credential_id, fingerprint FROM bridge_device_credentials WHERE user_id = 'alice' AND device_id = 'pc'").all();
    expect(bound.results).toEqual([{ credential_id: "key-alice", fingerprint: "2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90" }]);
    const otherUser = await connect("runner", "bob", "pc"); otherUser.ws.send(hello("pc"));
    await expect.poll(() => otherUser.messages.some((m) => JSON.parse(m).type === "welcome")).toBe(true);
    const browser = await connect("browser", "browser", "key");
    const closed = new Promise<number>((r) => browser.ws.once("close", (code: number) => r(code)));
    const replacement = await connect("browser", "browser", "key"); expect(await closed).toBe(4409); 
    await mf.unsafeEvictDurableObject("test-bridge", "Relay", { name: "alice", webSockets: "hibernate" });
    const frame = JSON.stringify({ to: "runner", runnerId: "pc", browserKeyId: "key", kind: "frame", body: { ciphertext: "opaque" } });
    replacement.ws.send(frame); await expect.poll(() => runner.messages.includes(frame)).toBe(true);
    expect(otherUser.messages).not.toContain(frame);
    const runnerClosed = new Promise<number>((r) => runner.ws.once("close", (code: number) => r(code)));
    const revoked = await mf.dispatchFetch("https://app.test/bridge/devices/pc", { method: "DELETE", headers: { authorization: "Bearer browser", origin: "https://app.test" } });
    expect(revoked.status).toBe(200); expect(await runnerClosed).toBe(RELAY_CLOSE_REVOKED);
    // The revoked credential asks again under a new id: the upgrade completes only for the verdict.
    const renamed = await connect("runner", "alice", "renamed");
    expect(await renamed.closed).toBe(RELAY_CLOSE_REVOKED);
    expect(renamed.messages).toEqual([revokedVerdictFrame("renamed")]);
    // Never registered: the user's Durable Object holds no runner for it, and a live socket of another user is untouched.
    expect(otherUser.ws.readyState).toBe(1);
    const blind = await connect("runner", "alice", "pc");
    expect(await blind.closed).toBe(RELAY_CLOSE_REVOKED);
    expect(blind.messages).toEqual([revokedVerdictFrame("pc")]);
    // No valid token: still 401, never a verdict.
    expect((await mf.dispatchFetch("https://app.test/relay/runner?runnerId=renamed", { headers: { upgrade: "websocket", authorization: "Bearer nobody" } })).status).toBe(401);
    otherUser.ws.close();
    replacement.ws.close();
  });
});
