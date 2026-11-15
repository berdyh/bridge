import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { ProcessCleanupResult } from "./cleanup.js";
import type { AgentAdapter } from "./contracts.js";
import { spawnAcpProcess } from "./process.js";
import { createAcpProxy } from "./proxy.js";

it("revokes logical access immediately and bounds a hung adapter cleanup without upgrading ended to success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-quiescence-timeout-"));
  let settle!: (receipt: ProcessCleanupResult) => void;
  const cleanup = new Promise<ProcessCleanupResult>((resolve) => { settle = resolve; });
  const adapter: AgentAdapter = {
    id: "stub", availability: async () => ({ id: "stub", available: true }),
    async spawn() {
      const proc = await spawnAcpProcess({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/stub-agent.mjs", import.meta.url))], cwd: root, env: { PATH: process.env.PATH ?? "" }, killGraceMs: 20 });
      return { ...proc, cleanup: () => cleanup };
    },
  };
  const proxy = createAcpProxy({ appId: "app", adapters: [adapter], defaultCwd: root, policy: { mode: "ask", allowSession: () => true, decidePermission: () => ({ action: "cancel" }) } });
  try {
    const session = await proxy.broker.start({ appId: "app", pluginId: "test", agent: "stub", cwd: root });
    vi.useFakeTimers();
    await session.close();
    await expect(session.ended).resolves.toEqual({ reason: "closed" });
    expect(proxy.sessionCount()).toBe(0);
    await expect(session.prompt("after close")).rejects.toThrow("closed");
    expect(await Promise.race([session.quiescence, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(session.quiescence).resolves.toEqual({ status: "incomplete", mechanism: "unknown", reason: "timeout" });
    settle({ status: "quiescent", mechanism: "linux-pid-namespace" });
    await expect(session.quiescence).resolves.toMatchObject({ status: "incomplete" });
  } finally {
    settle({ status: "incomplete", mechanism: "process-group", reason: "descendants-unverified" });
    vi.useRealTimers();
    await proxy.close();
    await rm(root, { recursive: true, force: true });
  }
});
