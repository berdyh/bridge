import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, PluginContext } from "./contracts.js";
import { runPlugin } from "./runtime.js";
import { RpcPeer } from "./rpc.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); vi.useRealTimers(); });

async function setup() {
  const input = new PassThrough();
  const output = new PassThrough();
  const host = new RpcPeer(output, input);
  let context!: PluginContext;
  const runtime = await runPlugin((value) => { context = value; }, {
    manifest: { id: "test", app: "app", entry: "plugin.js", permissions: { agents: ["stub"] } },
    dataDir: "/synthetic", input, output,
  });
  host.onRequest = async (method) => method === "host/startAgentSession" ? { sessionId: "one" } : null;
  closers.push(async () => { await runtime.close(); host.close(); input.destroy(); output.destroy(); });
  return { context, host, input };
}

describe("public session quiescence", () => {
  it("resolves only the explicit receipt, independently of close and workflow completion", async () => {
    const { context, host } = await setup();
    const session = await context.startAgentSession({ agent: "stub" });
    await session.cancel();
    await session.close();
    expect(await Promise.race([session.quiescence, Promise.resolve("pending")])).toBe("pending");
    host.notify("host/sessionEnded", { sessionId: "one", reason: "cancelled", quiescence: { status: "quiescent", mechanism: "linux-pid-namespace" } });
    await expect(session.quiescence).resolves.toEqual({ status: "quiescent", mechanism: "linux-pid-namespace" });
    await expect(session.ended).resolves.toEqual({ reason: "cancelled" });
  });

  it.each([undefined, { status: "quiescent", mechanism: "process-group" }, { status: "group-empty", mechanism: "process-group" }, { status: "quiescent" }])("missing or malformed evidence is incomplete (%j)", async (quiescence) => {
    const { context, host } = await setup();
    const session = await context.startAgentSession({ agent: "stub" });
    host.notify("host/sessionEnded", { sessionId: "one", reason: "closed", quiescence });
    await expect(session.quiescence).resolves.toEqual({ status: "incomplete", mechanism: "unknown", reason: "cleanup-unavailable" });
  });

  it("a host disconnect settles every pending receipt incomplete", async () => {
    const { context, input } = await setup();
    const session = await context.startAgentSession({ agent: "stub" });
    input.end();
    await expect(session.quiescence).resolves.toEqual({ status: "incomplete", mechanism: "unknown", reason: "disconnected" });
    await expect(session.prompt("after disconnect")).rejects.toThrow("closed");
  });

  it("receives independent automatic cleanup completion while logical ended remains pending", async () => {
    const { context, host } = await setup();
    const session = await context.startAgentSession({ agent: "stub" });
    host.notify("host/sessionQuiescence", { sessionId: "one", quiescence: { status: "incomplete", mechanism: "unknown", reason: "timeout" } });
    await expect(session.quiescence).resolves.toEqual({ status: "incomplete", mechanism: "unknown", reason: "timeout" });
    expect(await Promise.race([session.ended, Promise.resolve("pending")])).toBe("pending");
    await expect(session.prompt("after cleanup receipt")).rejects.toThrow("closed");
    host.notify("host/sessionEnded", { sessionId: "one", reason: "budget" });
    await expect(session.ended).resolves.toEqual({ reason: "budget" });
  });

  it("bounds cleanup completion even when an older host never sends an ended notification", async () => {
    const { context } = await setup();
    const session = await context.startAgentSession({ agent: "stub" });
    vi.useFakeTimers();
    await session.close();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(session.quiescence).resolves.toEqual({ status: "incomplete", mechanism: "unknown", reason: "timeout" });
  });

  it("does not lose disconnect evidence between a start response and registration", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let context!: PluginContext;
    const runtime = await runPlugin((value) => { context = value; }, {
      manifest: { id: "test", app: "app", entry: "plugin.js", permissions: { agents: ["stub"] } },
      dataDir: "/synthetic", input, output,
    });
    closers.push(async () => { await runtime.close(); input.destroy(); output.destroy(); });
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        const message = JSON.parse(line) as { id?: number; method?: string };
        if (message.method !== "host/startAgentSession") continue;
        input.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "raced" } }) + "\n");
        void runtime.close();
      }
    });
    const session = await context.startAgentSession({ agent: "stub" });
    await expect(session.quiescence).resolves.toEqual({ status: "incomplete", mechanism: "unknown", reason: "disconnected" });
  });

  it("retains a receipt arriving with the start response before registration", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let context!: PluginContext;
    const runtime = await runPlugin((value) => { context = value; }, {
      manifest: { id: "test", app: "app", entry: "plugin.js", permissions: { agents: ["stub"] } },
      dataDir: "/synthetic", input, output,
    });
    closers.push(async () => { await runtime.close(); input.destroy(); output.destroy(); });
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        const message = JSON.parse(line) as { id?: number; method?: string };
        if (message.method !== "host/startAgentSession") continue;
        input.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "early" } }) + "\n"
          + JSON.stringify({ jsonrpc: "2.0", method: "host/sessionQuiescence", params: { sessionId: "early", quiescence: { status: "quiescent", mechanism: "linux-pid-namespace" } } }) + "\n"
          + JSON.stringify({ jsonrpc: "2.0", method: "host/sessionEnded", params: { sessionId: "early", reason: "closed" } }) + "\n");
      }
    });
    const session: AgentSession = await context.startAgentSession({ agent: "stub" });
    await expect(session.quiescence).resolves.toMatchObject({ status: "quiescent" });
  });
});
