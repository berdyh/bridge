import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { confinedExecutionSupport } from "./confined.js";
import { confinedSocketDirectoryFits } from "./confined-sockets.js";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
// Explicit short project-local fixtures keep long clean worktrees under sun_path.
const scratch = process.env.BRIDGE_TEST_SOCKET_ROOT ?? path.join(repo, ".ci-local/s");
function requireShortFixtureRoot(): void {
  if (!path.isAbsolute(scratch) || !confinedSocketDirectoryFits(path.join(scratch, "q-XXXXXX", "b0"))) {
    throw new Error("Unix-socket fixtures need a short absolute base directory (a socket path must fit sun_path); set BRIDGE_TEST_SOCKET_ROOT to one, for example `.ci-local/s` in the checkout");
  }
}
const broker = fileURLToPath(new URL("./fixtures/confined-broker.mjs", import.meta.url));
const shipped = () => import(pathToFileURL(path.join(repo, "packages/runner/dist/acp/confined.js")).href);

describe("shipped confined resource refusals", () => {
  it("fails closed with a missing configured seccomp helper before running a command", async () => {
    requireShortFixtureRoot();
    if (!confinedExecutionSupport().supported) return; // The main integration asserts explicit refusal here.
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(scratch, "h-"));
    try {
      const { writeConfinedLaunch, confinedSettings, runtimeReadPaths } = await shipped();
      const target = path.join(root, "MUST_NOT_RUN");
      const settings = confinedSettings(runtimeReadPaths([process.execPath]), [root], []);
      settings.seccomp = { applyPath: path.join(root, "missing-helper") };
      const launch = await writeConfinedLaunch(path.join(root, "launch"), process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'unsafe')`], settings, false, root);
      const proc = spawn(launch.command, launch.args, { cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      const code = await new Promise<number | null>((resolve, reject) => { const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("helper refusal hung")); }, 10000); proc.once("error", reject); proc.once("close", (status) => { clearTimeout(timer); resolve(status); }); });
      expect(code).not.toBe(0);
      expect(stderr).toContain("confined-v1 sandbox failed");
      await expect(stat(target)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);

  it("bounds RPC identity/body sizes and revokes a slow feed before unbounded buffering", async () => {
    requireShortFixtureRoot();
    if (!confinedExecutionSupport().supported) return;
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(scratch, "q-"));
    const { startConfinedBrokers } = await shipped();
    let calls = 0;
    let resources: Awaited<ReturnType<typeof startConfinedBrokers>> | undefined;
    try {
      resources = await startConfinedBrokers({ sessionId: "synthetic", execution: { profile: "confined-v1", network: [] }, servers: [{ name: "broker", command: process.execPath, args: [broker], secretTransport: "fd3" }], allow: ["mcp__broker__noisy"], secret: Buffer.from("SYNTHETIC_MEMORY_ONLY"), brokerTools: { before: async () => { calls++; return true; }, after: async () => {} } }, path.join(root, "b"), { PATH: process.env.PATH! }, [], root);
      const endpoint = new URL(resources.servers[0]!.args[1]!);
      const token = resources.servers[0]!.args[2]!;
      const send = (frame: unknown): Promise<number> => new Promise((resolve, reject) => {
        const req = httpRequest({ socketPath: resources!.mitm.socketPath, path: `${endpoint.href}/send`, method: "POST", headers: { authorization: token } }, (res) => { res.resume(); resolve(res.statusCode!); });
        req.on("error", reject); req.end(JSON.stringify(frame));
      });
      expect(await send({ jsonrpc: "2.0", id: "x".repeat(256), method: "tools/list" })).toBe(400);
      expect(await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "admin" } })).toBe(403);
      expect(await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "noisy", arguments: { payload: "é".repeat(600000) } } })).toBe(413);
      expect(calls).toBe(0);
      const feed = httpRequest({ socketPath: resources.mitm.socketPath, path: `${endpoint.href}/events`, headers: { authorization: token } });
      const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => { feed.on("response", resolve); feed.on("error", reject); feed.end(); });
      response.pause();
      expect(await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "noisy", arguments: {} } })).toBe(204);
      let refused = false;
      for (let i = 0; i < 50 && !refused; i++) { await new Promise((resolve) => setTimeout(resolve, 20)); refused = await send({ jsonrpc: "2.0", id: 10 + i, method: "ping" }) === 403; }
      expect(refused).toBe(true);
      expect(calls).toBe(1);
      response.destroy(); feed.destroy();
      expect(await resources.close()).toBe(true);
    } finally { await resources?.close(); await rm(root, { recursive: true, force: true }); }
  }, 15000);
});
