import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ranProblems } from "./containment-real-checks.js";
import { setAdapterVersion, MEASURED_ADAPTER_VERSION } from "./containment-stack.js";
import { APP_ID, ContainedWorld, P1_OPTIONS, PLUGIN_ID, containedRequest, findFiles, rpcCode, steps, type StubRecord } from "./containment-world.js";
import { collectingApp } from "./world.js";

const SECRET = "not-the-canary";
const contained = (over: Record<string, unknown> = {}) => containedRequest({ secret: SECRET, ...over });

/** The runner-side paths of the app on `world`'s machine (XDG state is the default `<home>/.local/state`). */
function appPaths(world: ContainedWorld) {
  const state = path.join(world.machine.home, ".local", "state", APP_ID, "bridge");
  return {
    state,
    sessions: path.join(state, "sessions"),
    tmp: path.join(state, "tmp"),
    audit: path.join(state, "audit", `${PLUGIN_ID}.jsonl`),
    installDir: path.join(world.machine.dataDir, APP_ID, "bridge", "plugins", PLUGIN_ID, "1.0.0"),
    dataDir: path.join(world.machine.dataDir, APP_ID, "bridge", "plugin-data", PLUGIN_ID),
  };
}

/** The `session/new` params the claude containment profile sends for a session of `record` with the one `stub` server: `{cwd, ...sessionNew}`. */
function expectedSessionNew(world: ContainedWorld, record: StubRecord) {
  const p = appPaths(world);
  const id = path.basename(record.cwd);
  return {
    cwd: path.join(p.sessions, id),
    mcpServers: [
      {
        name: "stub",
        command: process.execPath,
        args: [path.join(p.installDir, "mcp.mjs"), "--secret-file", path.join(p.tmp, `bridge-acp-secrets-${id}`, "stub"), "--probe-dir", p.dataDir],
        env: [],
      },
    ],
    _meta: { claudeCode: { options: P1_OPTIONS } },
  };
}

/** `root` and every process below it, from /proc (linux). */
function processTree(root: number): number[] {
  const parent = new Map<number, number>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      parent.set(Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {
      // gone meanwhile
    }
  }
  const tree = [root];
  for (let i = 0; i < tree.length; i++) for (const [pid, ppid] of parent) if (ppid === tree[i]) tree.push(pid);
  return tree;
}

const resultsOf = (text: string): { tool?: string; toolCallId?: string; outcome?: string; ran?: boolean }[] => (JSON.parse(text) as { results: [] }).results;

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("containment, stub agent at the pinned adapter's place (enrolled page, E2EE)", () => {
  let world: ContainedWorld;

  beforeAll(async () => {
    world = await ContainedWorld.create({ e2ee: true });
  }, 120_000);
  afterAll(async () => {
    await world?.dispose();
  });

  describe("item 1: tool list", () => {
    it("the session/new params the stub receives equal the profile, and the stub has only the attached server's tools", async () => {
      const report = await world.run(contained(), [steps({ tool: "mcp__stub__read", via: "frame", input: { page: "1" } })]);
      expect(report.started, JSON.stringify(report.error)).toBe(true);
      const record = ContainedWorld.only(report);
      expect(record.sessionNew).toEqual(expectedSessionNew(world, record));
      // The stub runs in that folder, and offers the model the two tools of `stub`, nothing built in.
      expect(record.cwd).toBe(record.sessionNew!.cwd);
      expect(record.tools).toEqual(["mcp__stub__read", "mcp__stub__echo"]);
      expect(report.ended).toBe("closed");
    });
  });

  describe("item 2: no other tool", () => {
    const OUTSIDE = ["Bash", "Read", "WebFetch", "mcp__other__x", "mcp__stub__echo"];

    it("a permission request for each (allow: [mcp__stub__read]) is refused at the permission boundary, and audited", async () => {
      const report = await world.run(contained(), [steps(...OUTSIDE.map((tool) => ({ tool, via: "askOnly" })))]);
      const prompt = report.prompts![0]!;
      expect(prompt.ok, JSON.stringify(prompt)).toBe(true);
      const results = resultsOf((prompt as { text: string }).text);
      expect(results.map((r) => [r.tool, r.outcome, r.ran])).toEqual(OUTSIDE.map((tool) => [tool, "selected reject", false]));
      // Recorded by call id: a request that came with no frame carries no tool name into the audit (records come from frames).
      const audit = await world.auditOf(ContainedWorld.only(report));
      expect(audit.map((r) => [r.toolCallId, r.decision])).toEqual(results.map((r) => [r.toolCallId, "reject"]));
      expect(report.ended).toBe("closed");
    });

    it.each(OUTSIDE)("a %s tool call frame with no permission request kills the session: the plugin gets ended breach", async (tool) => {
      const since = (await world.audit()).length;
      const report = await world.run(contained(), [steps({ tool, via: "frame" })]);
      const record = ContainedWorld.only(report);
      expect(report.ended).toBe("breach");
      // A run against a real claude login reads this same report and audit delta: the enforced breach of the intended call is not a failure.
      expect(ranProblems(report, 1, { tool, audit: (await world.audit()).slice(since) })).toEqual([]);
      expect(report.prompts![0]).toMatchObject({ ok: false, error: { code: -32017 } });
      expect(await world.hostPid(record)).toBeUndefined();
      const audit = await world.auditOf(record);
      expect(audit.map((r) => r.toolName)).toContain(tool);
    });
  });

  describe("item 3: planted files, with a control", () => {
    let plants: { homeClaudeMd: string; stateClaudeMd: string; mcpJson: string; hookSettings: string };

    beforeAll(async () => {
      const m = world.machine;
      const p = appPaths(world);
      plants = {
        homeClaudeMd: path.join(m.home, "CLAUDE.md"),
        stateClaudeMd: path.join(p.state, "CLAUDE.md"),
        mcpJson: path.join(m.project, ".mcp.json"),
        hookSettings: path.join(m.project, ".claude", "settings.json"),
      };
      const userServer = JSON.stringify({ mcpServers: { planted_user: { type: "stdio", command: "/bin/false", args: [] } } });
      const files: [string, string][] = [
        [plants.homeClaudeMd, "planted: CLAUDE.md above every session cwd\n"],
        [plants.stateClaudeMd, "planted: CLAUDE.md above the sessions folder\n"],
        [plants.mcpJson, JSON.stringify({ mcpServers: { planted_project: { command: "/bin/false", args: [] } } })],
        [plants.hookSettings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/bin/false" }] }] } })],
        // A user MCP server where the staged config dir comes from (bridge's own login folder) and in the person's own
        // CLAUDE_CONFIG_DIR; and an extra block in bridge's login file, which the staged copy must not carry.
        [path.join(path.dirname(m.claudeLogin), ".claude.json"), userServer],
        [path.join(path.dirname(m.claudeLogin), "settings.json"), JSON.stringify({ hooks: { SessionStart: [] } })],
        [path.join(m.decoys.claudeConfigDir, ".claude.json"), userServer],
        [path.join(m.decoys.claudeConfigDir, "settings.json"), JSON.stringify({ decoy: true })],
      ];
      for (const [file, text] of files) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, text);
      }
      const login = JSON.parse(await readFile(m.claudeLogin, "utf8")) as Record<string, unknown>;
      await writeFile(m.claudeLogin, JSON.stringify({ ...login, mcpOAuth: { planted_user: { accessToken: "planted" } } }), { mode: 0o600 });
    });

    it("the contained session's spawn sees none of them", async () => {
      const report = await world.run(contained(), [steps({ tool: "mcp__stub__read", via: "frame" })]);
      const record = ContainedWorld.only(report);
      expect(record.cwd).toBe(path.join(appPaths(world).sessions, path.basename(record.cwd)));
      expect(record.cwdEntries).toEqual([]);
      expect(record.seen).toEqual([]);
      // The staged config dir holds the login's OAuth block and nothing else, and is neither of the planted folders.
      expect(record.configDir).toMatchObject({ names: [".credentials.json"], loginKeys: ["claudeAiOauth"] });
      expect(record.env.CLAUDE_CONFIG_DIR).not.toBe(world.machine.decoys.claudeConfigDir);
      expect(record.env.CLAUDE_CONFIG_DIR).not.toBe(path.dirname(world.machine.claudeLogin));
      expect(record.tools).toEqual(["mcp__stub__read", "mcp__stub__echo"]);
    });

    it("control: a browser session in the planted folder does see the cwd files", async () => {
      const connection = await world.acp(collectingApp([]));
      await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const before = new Set((await world.records()).map((r) => r.id));
      const session = await connection.agent.request("session/new", { cwd: world.machine.project, mcpServers: [] });
      await connection.agent.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
      const control = (await world.records()).filter((r) => !before.has(r.id));
      expect(control).toHaveLength(1);
      expect(control[0]!.cwd).toBe(world.machine.project);
      expect(control[0]!.seen).toEqual(expect.arrayContaining([plants.homeClaudeMd, plants.hookSettings, plants.mcpJson]));
    });
  });

  describe("item 5: browser frame", () => {
    it("session/new with mcpServers or _meta.claudeCode from the enrolled page is -32602, and no agent is spawned", async () => {
      const connection = await world.acp(collectingApp([]));
      await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const before = (await world.records()).length;
      const cwd = world.machine.project;
      const server = { name: "page", command: "/bin/sh", args: ["-c", "true"], env: [] };
      expect(await rpcCode(connection.agent.request("session/new", { cwd, mcpServers: [server] }))).toBe(-32602);
      expect(await rpcCode(connection.agent.request("session/new", { cwd, mcpServers: [], _meta: { claudeCode: { options: { tools: [] } } } }))).toBe(-32602);
      expect((await world.records()).length).toBe(before);
    });
  });

  describe("item 6: refusal code", () => {
    it("a contained codex request is -32016, and no agent is spawned", async () => {
      const report = await world.run(contained({ agent: "codex" }));
      expect(report).toMatchObject({ started: false, error: { code: -32016 } });
      expect(report.spawned).toEqual([]);
    });

    it("a contained claude request with the adapter version outside the measured one is -32016, and no agent is spawned", async () => {
      await setAdapterVersion(world.stack, "0.93.0");
      try {
        const report = await world.run(contained());
        expect(report).toMatchObject({ started: false, error: { code: -32016 } });
        expect(report.spawned).toEqual([]);
      } finally {
        await setAdapterVersion(world.stack, MEASURED_ADAPTER_VERSION);
      }
      // The same request on the measured version starts: the refusal above was the version.
      expect((await world.run(contained())).started).toBe(true);
    });
  });

  describe("item 8: slash commands", () => {
    it("happy path: the stub emits the 2-name command update after session/new; no breach", async () => {
      const report = await world.run(contained(), [steps({ tool: "mcp__stub__read", via: "frame" })]);
      const record = ContainedWorld.only(report);
      expect(record.advertised).toEqual(["mcp", "remote-control"]);
      expect(report.prompts![0]!.ok).toBe(true);
      expect(report.ended).toBe("closed");
      expect((await world.auditOf(record)).some((r) => r.toolCallId === "available_commands_update")).toBe(false);
    });

    it("the stub emitting `init` as well ends the session in breach, audited", async () => {
      await world.stubBehaviour({ commands: ["mcp", "remote-control", "init"] });
      try {
        const report = await world.run(contained(), [steps({ tool: "mcp__stub__read", via: "frame" })]);
        const record = ContainedWorld.only(report);
        expect(record.advertised).toEqual(["mcp", "remote-control", "init"]);
        // The update arrives right after session/new: the start or the first prompt sees the end.
        if (report.started) expect(report.ended).toBe("breach");
        else expect(report.error?.code).toBe(-32017);
        expect((await world.auditOf(record)).some((r) => r.toolCallId === "available_commands_update")).toBe(true);
      } finally {
        await world.stubBehaviour(undefined);
      }
    });

    it("a plugin prompt \"/init\" is -32602 and the stub receives no prompt", async () => {
      const report = await world.run(contained(), ["/init"], { hold: true });
      const record = ContainedWorld.only(report);
      expect(report.prompts![0]).toMatchObject({ ok: false, error: { code: -32602 } });
      expect((await world.recordNow(record.id)).prompts).toEqual([]);
      expect((await world.finish(report.sessionId!)).ended).toBe("closed");
    });

    it("the session/new params the stub receives equal {cwd, ...sessionNew} of the profile exactly, both extraArgs included", async () => {
      const report = await world.run(contained());
      const record = ContainedWorld.only(report);
      expect(record.sessionNew).toEqual(expectedSessionNew(world, record));
      expect((record.sessionNew!._meta as { claudeCode: { options: { extraArgs: unknown } } }).claudeCode.options.extraArgs).toEqual({
        restricted: null,
        "disable-slash-commands": null,
      });
    });
  });
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("secret canary (plaintext channel, so a leak would show at the relay)", () => {
  let world: ContainedWorld;
  const canary = `CANARY-${randomBytes(16).toString("hex")}`;

  beforeAll(async () => {
    world = await ContainedWorld.create({ e2ee: false });
  }, 120_000);
  afterAll(async () => {
    await world?.dispose();
  });

  it("reaches the MCP server's secret file and nothing else: env, argv, frames, logs, audit, events", async () => {
    const p = appPaths(world);
    // The plugin reads the canary from its own data folder: it never crosses the page, so the relay check below is about the runner.
    await mkdir(p.dataDir, { recursive: true });
    await writeFile(path.join(p.dataDir, "canary.txt"), canary);
    const { secret: _none, ...request } = contained();
    const report = await world.run(request, [steps({ tool: "mcp__stub__read", via: "frame", input: { page: "7" } })], { hold: true, secretFrom: "canary.txt" });
    expect(report.started, JSON.stringify(report.error)).toBe(true);
    const record = ContainedWorld.only(report);

    // Found: the MCP fixture read exactly the canary from its secret file (a private 0600 file).
    const probes = (await findFiles(p.dataDir, (n) => /^mcp-probe-\d+\.json$/.test(n))).map((f) => JSON.parse(readFileSync(f, "utf8")) as { pid: number; secretSha256: string; secretFileMode: string });
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ secretSha256: createHash("sha256").update(canary).digest("hex"), secretFileMode: "600" });

    // Absent from the env and argv of the adapter and every child, read from /proc while the session is open.
    const rootPid = await world.hostPid(record);
    expect(rootPid, "live fixture root must map to one verified host process").toBeDefined();
    const mappedPids = await Promise.all([record.pid, ...record.mcpChildren, probes[0]!.pid].map((pid) => world.hostPid(record, pid)));
    expect(mappedPids.every((pid) => pid !== undefined), "every recorded namespace PID must map inside the verified host tree").toBe(true);
    const tree = processTree(rootPid!);
    expect(tree).toEqual(expect.arrayContaining(mappedPids));
    for (const pid of tree) {
      for (const file of ["environ", "cmdline"]) {
        const text = readFileSync(`/proc/${pid}/${file}`).toString("latin1");
        expect(text.includes(canary), `/proc/${pid}/${file}`).toBe(false);
      }
    }
    // Absent from the ACP frame that started the agent.
    expect(JSON.stringify(record.sessionNew)).not.toContain(canary);

    const done = await world.finish(report.sessionId!);
    expect(done.ended).toBe("closed");

    // Every relay frame, captured at the dev server: received, forwarded and sent. The channel is plaintext, so the
    // plugin's report (its events included) did cross the relay in the clear: the capture would show a leak.
    const relay = [...world.app.ingress.map((m) => m.raw), ...world.app.egress, ...world.app.traffic.map((t) => t.raw)];
    expect(relay.some((raw) => raw.includes("page 7: read ok"))).toBe(true);
    expect(relay.filter((raw) => raw.includes(canary))).toEqual([]);
    // The runner log, the plugin's log, the audit log, and every event the plugin received.
    expect(world.runner.stdout() + world.runner.stderr()).not.toContain(canary);
    const pluginLog = await readFile(path.join(p.dataDir, "plugin.log"), "utf8");
    expect(pluginLog).toContain("page 7: read ok");
    expect(pluginLog).not.toContain(canary);
    const audit = await readFile(p.audit, "utf8");
    expect(audit).toContain("mcp__stub__read");
    expect(audit).not.toContain(canary);
    const events = JSON.stringify([report.events, done.events]);
    expect(events).toContain("page 7: read ok");
    expect(events).not.toContain(canary);
  });
});
