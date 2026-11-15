import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PLUGIN_ID, APP_ID, CONTAINMENT_CLI, ContainedWorld, assemblePlugin, containedRequest, steps, type RunReport } from "./containment-world.js";
import { Machine } from "./machine.js";
import { connectApp, deployApp, type AppDeployment } from "./world.js";

const SECRET = "not-the-canary";
/** The real CLI behind the scripted terminal (no agent is needed to install). */
const SEAMS_CLI = path.join(path.dirname(CONTAINMENT_CLI), "..", "fixtures", "bridge-cli.mjs");
const linuxX64 = process.platform === "linux" && process.arch === "x64";
const resultsOf = (report: RunReport, i = 0): { tool: string; toolCallId: string; outcome: string; ran: boolean; output?: string }[] => {
  const prompt = report.prompts![i]!;
  if (!prompt.ok) throw new Error(`prompt ${i} failed: ${JSON.stringify(prompt.error)}`);
  return (JSON.parse(prompt.text) as { results: [] }).results;
};

describe.skipIf(!linuxX64)("headless approvals", () => {
  let world: ContainedWorld;
  const contained = (over: Record<string, unknown> = {}) => containedRequest({ secret: SECRET, ...over });

  beforeAll(async () => {
    world = await ContainedWorld.create({ e2ee: false });
  }, 120_000);
  afterAll(async () => {
    await world?.dispose();
  });

  it("an approved tool is answered without asking anyone, and audited; its events and the end reach the plugin", async () => {
    const report = await world.run(contained({ tools: { builtins: "none", allow: ["mcp__stub__echo"] } }), [steps({ tool: "mcp__stub__echo", via: "ask", input: { text: "hi" } })]);
    const [call] = resultsOf(report);
    expect(call).toMatchObject({ tool: "mcp__stub__echo", outcome: "selected allow", ran: true, output: "echo: hi" });
    expect(report.events!.filter((e) => e.id === call!.toolCallId).map((e) => [e.type, e.status])).toEqual([
      ["tool_call", "pending"],
      ["tool_call_update", "completed"],
    ]);
    expect(report.ended).toBe("closed");
    const audit = (await world.audit()).filter((r) => r.toolCallId === call!.toolCallId);
    expect(audit.length).toBeGreaterThan(0);
    // The plugin's own session id is the audit's: no cwd-name lookup is needed to join them.
    expect(audit.every((r) => r.sessionId === report.sessionId)).toBe(true);
    expect(audit.every((r) => r.toolName === "mcp__stub__echo")).toBe(true);
    expect(audit.some((r) => r.decision === "allow" && r.trigger?.kind === "headless" && r.servers?.join() === "stub")).toBe(true);
  });

  it("a plugin finds its session's audit records by the id it was given", async () => {
    const report = await world.run(contained({ tools: { builtins: "none", allow: ["mcp__stub__echo"] } }), [steps({ tool: "mcp__stub__echo", via: "ask", input: { text: "join" } })]);
    expect(report.sessionId).toBeDefined();
    const mine = (await world.audit()).filter((r) => r.sessionId === report.sessionId);
    expect(mine.map((r) => r.toolName)).toContain("mcp__stub__echo");
    expect((await world.auditOfSession(report.sessionId!)).map((r) => r.toolName)).toContain("mcp__stub__echo");
  });

  it("an out-of-set tool is refused, and audited", async () => {
    const report = await world.run(contained(), [steps({ tool: "Bash", via: "askOnly" })]);
    const [call] = resultsOf(report);
    expect(call).toMatchObject({ outcome: "selected reject", ran: false });
    const audit = await world.auditOf(ContainedWorld.only(report));
    expect(audit.map((r) => [r.toolCallId, r.decision])).toEqual([[call!.toolCallId, "reject"]]);
  });

  it("an attached-but-unlisted tool's tool_call frame ends the session with breach", async () => {
    const report = await world.run(contained({ tools: { builtins: "none", allow: ["mcp__stub__read"] } }), [steps({ tool: "mcp__stub__echo", via: "frame" })]);
    expect(report.ended).toBe("breach");
    expect(report.prompts![0]).toMatchObject({ ok: false, error: { code: -32017 } });
    expect((await world.auditOf(ContainedWorld.only(report))).map((r) => r.toolName)).toContain("mcp__stub__echo");
  });

  it("a call with no permission request (the readOnlyHint tool) is audited with decision none and counted against the budget", async () => {
    const report = await world.run(contained({ tools: { builtins: "none", allow: ["mcp__stub__read", "mcp__stub__echo"] }, budget: { maxToolCalls: 1 } }), [
      steps({ tool: "mcp__stub__read", via: "frame", input: { page: "1" } }, { tool: "mcp__stub__echo", via: "ask", input: { text: "second" } }),
    ]);
    // One call is the budget: the unprompted read used it, so the echo that follows ends the session.
    expect(report.ended).toBe("budget");
    expect(report.prompts![0]).toMatchObject({ ok: false, error: { code: -32018 } });
    const audit = await world.auditOf(ContainedWorld.only(report));
    const read = audit.filter((r) => r.toolName === "mcp__stub__read");
    expect(read.length).toBeGreaterThan(0);
    expect(read.some((r) => r.decision === "none")).toBe(true);
    expect(audit.some((r) => r.decision === "allow")).toBe(false);
  });

  it("a non-contained request with mcpServers or headless: true is -32016, and no agent is spawned", async () => {
    for (const request of [{ agent: "claude", mcpServers: ["stub"] }, { agent: "claude", headless: true }]) {
      const report = await world.run(request);
      expect(report, JSON.stringify(request)).toMatchObject({ started: false, error: { code: -32016 } });
      expect(report.spawned).toEqual([]);
    }
  });

  it("`bridge plugin add --yes npm:...` without --integrity is refused", async () => {
    const out = await world.cli(["plugin", "add", "npm:e2e-mcp-plugin@1.0.0", "--yes"]);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toMatch(/--yes installs from npm need a pinned hash/);
  });

  it("`--yes` on a widened update is refused; the installed version stays", async () => {
    const widened = await assemblePlugin(path.join(world.machine.root, "mcp-plugin-1.1.0"), {
      version: "1.1.0",
      manifest: (m) => {
        const permissions = m.permissions as { headless: { tools: string[] } };
        return { ...m, permissions: { ...permissions, headless: { tools: [...permissions.headless.tools, "mcp__stub__write"] } } };
      },
    });
    const out = await world.cli(["plugin", "add", widened, "--replace", "--yes"]);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toMatch(/This update adds .*mcp__stub__write.*; run it in a terminal to confirm/);
    expect((await world.cli(["plugin", "list"])).stdout).toMatch(new RegExp(`^${PLUGIN_ID}\\t1\\.0\\.0\\t`, "m"));
  });

  it("`pluginApprovals: false` in the app's config.json turns the approvals off", async () => {
    await mkdir(path.dirname(world.appConfigFile), { recursive: true });
    await writeFile(world.appConfigFile, JSON.stringify({ policy: { pluginApprovals: false } }));
    try {
      await world.restartRunner();
      const report = await world.run(contained({ tools: { builtins: "none", allow: ["mcp__stub__echo"] } }), [steps({ tool: "mcp__stub__echo", via: "ask", input: { text: "hi" } })]);
      const [call] = resultsOf(report);
      expect(call).toMatchObject({ outcome: "selected reject", ran: false });
      expect((await world.auditOf(ContainedWorld.only(report))).some((r) => r.toolCallId === call!.toolCallId && r.decision === "reject")).toBe(true);
    } finally {
      await rm(world.appConfigFile, { force: true });
      await world.restartRunner();
    }
    // Back on with the file gone.
    const again = await world.run(contained({ tools: { builtins: "none", allow: ["mcp__stub__echo"] } }), [steps({ tool: "mcp__stub__echo", via: "ask", input: { text: "hi" } })]);
    expect(resultsOf(again)[0]).toMatchObject({ outcome: "selected allow", ran: true });
  });

  it("`bridge plugin revoke` makes the next start fail with -32019", async () => {
    expect((await world.run(contained())).started).toBe(true);
    const revoked = await world.cli(["plugin", "revoke", PLUGIN_ID, "--yes"]);
    expect(revoked.code, revoked.stderr).toBe(0);
    const report = await world.run(contained());
    expect(report).toMatchObject({ started: false, error: { code: -32019 } });
    expect(report.spawned).toEqual([]);
  });
});

/** A CA and a server certificate for 127.0.0.1, made with openssl in `dir`. */
function testCa(dir: string): { ca: string; key: string; cert: string } {
  const file = (name: string) => path.join(dir, name);
  const run = (args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", file("ca.key"), "-out", file("ca.pem"), "-days", "2", "-subj", "/CN=bridge e2e test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", file("server.key"), "-out", file("server.csr"), "-subj", "/CN=127.0.0.1"]);
  execFileSync("sh", ["-c", `printf 'subjectAltName=IP:127.0.0.1\\nbasicConstraints=CA:FALSE\\nextendedKeyUsage=serverAuth\\n' > "${file("server.ext")}"`]);
  run(["x509", "-req", "-in", file("server.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key"), "-CAcreateserial", "-out", file("server.pem"), "-days", "2", "-extfile", file("server.ext")]);
  return { ca: file("ca.pem"), key: file("server.key"), cert: file("server.pem") };
}

describe.skipIf(!linuxX64)("install from a package", () => {
  let app: AppDeployment;
  let machine: Machine;
  let server: Server;
  let origin = "";
  let tarballSha = "";
  let ca = "";
  let systemctlLog = "";
  const cli = (args: string[], options: { tty?: boolean; input?: string } = {}) =>
    machine.exec(args, options.input ?? "", { NODE_EXTRA_CA_CERTS: ca }, { entry: SEAMS_CLI, tty: options.tty === true });

  beforeAll(async () => {
    app = await deployApp(APP_ID);
    machine = await Machine.create();
    await connectApp(machine, app);
    // The package, as an npm-style tarball (`package/` prefix), served over https with a test CA.
    const pkg = await assemblePlugin(path.join(machine.root, "tarball", "package"));
    const tgz = path.join(machine.root, "tarball", "mcp-plugin-1.0.0.tgz");
    execFileSync("tar", ["--format=ustar", "-czf", tgz, "-C", path.dirname(pkg), "package"]);
    const body = await readFile(tgz);
    tarballSha = createHash("sha256").update(body).digest("hex");
    await mkdir(path.join(machine.root, "tls"));
    const tls = testCa(path.join(machine.root, "tls"));
    ca = tls.ca;
    server = createServer({ key: await readFile(tls.key), cert: await readFile(tls.cert) }, (req, res) => {
      if (req.url === "/mcp-plugin-1.0.0.tgz") {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
        res.end(body);
      } else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    // The fake service runner: an installed unit, and a `systemctl` that says it is active and records every call.
    systemctlLog = path.join(machine.root, "systemctl.log");
    const unit = path.join(machine.configDir, "systemd", "user", "bridge-runner.service");
    await mkdir(path.dirname(unit), { recursive: true });
    await writeFile(unit, "[Service]\nExecStart=/bin/true\n");
    const systemctl = path.join(machine.binDir, "systemctl");
    await writeFile(systemctl, `#!/bin/sh\necho "$*" >> "${systemctlLog}"\ncase "$*" in *is-active*) echo active ;; esac\nexit 0\n`);
    await chmod(systemctl, 0o755);
  }, 120_000);
  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await machine?.dispose();
    await app?.close();
  });

  it("an http:// source is refused: plugin sources are https only", async () => {
    const out = await cli(["plugin", "add", `http://127.0.0.1:1/mcp-plugin-1.0.0.tgz`, "--sha256", tarballSha, "--yes"]);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toMatch(/must use https/);
  });

  it("a wrong --sha256 is refused and nothing is installed", async () => {
    const wrong = createHash("sha256").update("not the tarball").digest("hex");
    const out = await cli(["plugin", "add", `${origin}/mcp-plugin-1.0.0.tgz`, "--sha256", wrong], { tty: true, input: "y\n" });
    expect(out.code).not.toBe(0);
    expect(out.stderr).toMatch(/--sha256 does not match/);
    expect((await cli(["plugin", "list"])).stdout).toContain("No plugins installed");
    expect(await readFile(systemctlLog, "utf8").catch(() => "")).not.toMatch(/restart/);
  });

  it("the right --sha256 installs (consent at the terminal), and the running service is restarted", async () => {
    const out = await cli(["plugin", "add", `${origin}/mcp-plugin-1.0.0.tgz`, "--sha256", tarballSha], { tty: true, input: "y\n" });
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain(`Verified sha256 ${tarballSha}`);
    expect(out.stdout).toContain("mcp__stub__read");
    expect(out.stdout).toContain("Restarting the bridge service");
    expect(await readFile(systemctlLog, "utf8")).toMatch(/^--user restart bridge-runner\.service$/m);
    expect((await cli(["plugin", "list"])).stdout).toMatch(new RegExp(`^${PLUGIN_ID}\\t1\\.0\\.0\\tapp ${APP_ID}$`, "m"));
  });
});
