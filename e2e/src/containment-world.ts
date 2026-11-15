/**
 * The world of the containment suites: one app deployment, one machine whose `bridge` runs the contained-session stub as its
 * bundled claude adapter (`containment-cli.mjs`, `containment-stack.ts`), the e2e MCP plugin installed through the
 * consent screen at a (scripted) terminal, a running runner, and a page that calls the plugin's methods.
 */
import { cp, lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ClientApp, ClientConnection } from "@agentclientprotocol/sdk";

import { buildStubStack, type StubStack } from "./containment-stack.js";
import { Machine, SAMPLE_PLUGIN_DIR, type BridgeProcess, type Finished } from "./machine.js";
import { HeadlessPage, enrollBrowser } from "./page.js";
import { collectingApp, connectApp, deployApp, headlessClient, type AppDeployment } from "./world.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONTAINMENT_CLI = path.join(here, "containment-cli.mjs");
/** The real CLI behind the scripted terminal (`fixtures/bridge-cli.mjs`): the CLI's own adapters, no stub. */
export const SEAMS_CLI = path.join(here, "..", "fixtures", "bridge-cli.mjs");
export const MCP_PLUGIN_DIR = path.resolve(here, "..", "fixtures", "mcp-plugin");
export const PLUGIN_ID = "mcpplug";
export const APP_ID = "mcp-app";

/**
 * The 54 built-in tool names the claude containment profile sends as `disallowedTools`, written out here on purpose:
 * the suite states the measured profile independently of the runner's constant, so a change to that constant fails it.
 */
export const P1_DISALLOWED_TOOLS = [
  "Agent", "Artifact", "AskUserQuestion", "Bash", "ClaudeDesign", "CronCreate", "CronDelete", "CronList", "Edit", "EndConversation",
  "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree", "Glob", "Grep", "ListAgents", "ListMcpResourcesTool", "LSP", "Monitor",
  "NotebookEdit", "OfferChromeSetup", "PowerShell", "Projects", "propose_skills", "ProposeGoal", "PushNotification", "Read",
  "ReadMcpResourceDirTool", "ReadMcpResourceTool", "ReadNotifications", "RemoteTrigger", "ReportFindings", "ScheduleWakeup", "SendFeedback",
  "SendMessage", "SendUserFile", "SendUserMessage", "ShareOnboardingGuide", "ShowOnboardingRolePicker", "Skill", "SubagentHandback",
  "TaskCreate", "TaskGet", "TaskList", "TaskStop", "TaskUpdate", "TodoWrite", "ToolSearch", "WaitForMcpServers", "WebFetch", "WebSearch",
  "Workflow", "Write",
];

/** `_meta.claudeCode.options` of the claude containment profile with no model, as measured (both extraArgs). */
export const P1_OPTIONS = {
  tools: [],
  settingSources: [],
  strictMcpConfig: true,
  persistSession: false,
  allowDangerouslySkipPermissions: false,
  allowedTools: [],
  disallowedTools: P1_DISALLOWED_TOOLS,
  extraArgs: { restricted: null, "disable-slash-commands": null },
};

/** What a stub process recorded (`containment-stub-agent.mjs`). */
export interface StubRecord {
  id: string;
  role: "claude" | "codex";
  pid: number;
  ppid: number;
  pidNamespace?: string;
  processStart?: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  sessionNew?: { cwd: string; mcpServers: { name: string; command: string; args: string[]; env: unknown }[]; _meta?: unknown };
  cwdEntries?: string[];
  advertised?: string[];
  seen?: string[];
  tools?: string[];
  configDir?: { dir: string; names: string[]; loginKeys: string[] | null } | null;
  mcpChildren: number[];
  prompts: string[];
}

/** What the plugin's `_mcpplug/run` answers. */
export interface RunReport {
  started: boolean;
  error?: { code: number | null; message: string; data?: unknown };
  sessionId?: string;
  prompts?: ({ ok: true; stopReason: string; text: string } | { ok: false; error: { code: number | null; message: string } })[];
  events?: { type: string; id?: string; toolName?: string; status?: string; rawInput?: unknown; result?: unknown; text?: string }[];
  ended?: string | null;
}

export interface AuditLine {
  time: string;
  appId?: string;
  pluginId: string;
  sessionId: string;
  trigger?: { kind: string };
  servers?: string[];
  toolCallId: string;
  toolName?: string;
  status?: string;
  decision?: string;
  argsSha256?: string;
}

/** A prompt the stub runs as a script (see the stub's header). */
export const steps = (...list: Record<string, unknown>[]): string => JSON.stringify({ steps: list });

/** The contained request every item starts from: `builtins: "none"`, the one server, `read` allowed, headless. */
export const containedRequest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agent: "claude",
  tools: { builtins: "none", allow: ["mcp__stub__read"] },
  mcpServers: ["stub"],
  headless: true,
  ...over,
});

/**
 * The e2e plugin as an installable folder at `dest`: the fixture files, `manifest` applied to its manifest, and the
 * built SDK and protocol copied in from the sample plugin's build (the installed package has no node_modules).
 */
export async function assemblePlugin(dest: string, options: { manifest?: (m: Record<string, unknown>) => Record<string, unknown>; version?: string } = {}): Promise<string> {
  await mkdir(dest, { recursive: true });
  for (const name of ["plugin.mjs", "mcp.mjs"]) await cp(path.join(MCP_PLUGIN_DIR, name), path.join(dest, name));
  const manifest = JSON.parse(await readFile(path.join(MCP_PLUGIN_DIR, "bridge-plugin.json"), "utf8")) as Record<string, unknown>;
  await writeFile(path.join(dest, "bridge-plugin.json"), JSON.stringify(options.manifest ? options.manifest(manifest) : manifest, null, 2));
  const pkg = JSON.parse(await readFile(path.join(MCP_PLUGIN_DIR, "package.json"), "utf8")) as Record<string, unknown>;
  await writeFile(path.join(dest, "package.json"), JSON.stringify({ ...pkg, ...(options.version ? { version: options.version } : {}) }, null, 2));
  await cp(path.join(SAMPLE_PLUGIN_DIR, "dist", "sdk"), path.join(dest, "sdk"), { recursive: true });
  await cp(path.join(SAMPLE_PLUGIN_DIR, "dist", "protocol"), path.join(dest, "protocol"), { recursive: true });
  return dest;
}

/** Every file named `name` under `dir`. */
export async function findFiles(dir: string, test: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string): Promise<void> => {
    const info = await lstat(p).catch(() => undefined);
    if (!info || info.isSymbolicLink()) return;
    if (info.isDirectory()) for (const n of await readdir(p)) await walk(path.join(p, n));
    else if (test(path.basename(p))) out.push(p);
  };
  await walk(dir);
  return out.sort();
}

export class ContainedWorld {
  runner!: BridgeProcess;
  connection!: ClientConnection;
  private page: HeadlessPage | undefined;
  private closeClient: (() => void) | undefined;
  /** Opens a new ACP connection from the same page to the runner; it becomes `connection` (the page holds one at a time). */
  acp!: (app?: ClientApp) => Promise<ClientConnection>;

  private constructor(
    private readonly deployment: AppDeployment | undefined,
    readonly machine: Machine,
    private readonly stubStack: StubStack | undefined,
    readonly e2ee: boolean,
  ) {}

  /** The app deployment (worlds with a hosted app only). */
  get app(): AppDeployment {
    if (!this.deployment) throw new Error("this world has a local app: there is no app deployment");
    return this.deployment;
  }

  /** Whether the app is a local one (`create({ local: true })`): no deployment, relay, page or client. */
  get local(): boolean {
    return this.deployment === undefined;
  }

  /** The stub install (stub worlds only). */
  get stack(): StubStack {
    if (!this.stubStack) throw new Error("this world runs the real bundled adapter: no stub install");
    return this.stubStack;
  }

  /**
   * The env every CLI process of this world gets: the stub install; or, with the real adapter, an empty
   * `BRIDGE_CLAUDE_ADAPTER` (the machine points it at the PATH stub, and an override is never "bundled").
   */
  get cliEnv(): Record<string, string> {
    return this.stubStack ? { E2E_STUB_CLAUDE: this.stubStack.claudeBin, E2E_STUB_CODEX: this.stubStack.codexBin } : { BRIDGE_CLAUDE_ADAPTER: "" };
  }

  /** The CLI entry of this world: the stub seam, or the plain scripted terminal (real adapter). */
  private get entry(): string {
    return this.stubStack ? CONTAINMENT_CLI : SEAMS_CLI;
  }

  /**
   * Deploys the app, makes the machine, connects, installs the plugin at a terminal (answering the consent), runs
   * `beforeRun`, starts the runner and opens the page. `e2ee: true` enrolls the page (a real enrolled browser).
   * `local: true` (the local-app suite): no app is deployed or connected; `bridge apps add-local mcp-app --yes` creates the
   * app instead, the runner is started and waited for by its own "started" line, and no page or client is opened.
   * `realLogin` (a run against a real claude login only): no stub; the runner uses the CLI's bundled
   * adapter and real claude, signed in with a copy of that login file (bridge's own login copy, never `~/.claude`).
   */
  static async create(options: { e2ee: boolean; local?: boolean; realLogin?: string; beforeRun?: (world: ContainedWorld) => Promise<void> }): Promise<ContainedWorld> {
    const app = options.local ? undefined : await deployApp(APP_ID, options.e2ee ? { enrollPage: "/enroll" } : {});
    const machine = await Machine.create();
    const stack = options.realLogin === undefined ? await buildStubStack(machine.root) : undefined;
    if (options.realLogin !== undefined) await writeFile(machine.claudeLogin, await readFile(options.realLogin), { mode: 0o600 });
    const world = new ContainedWorld(app, machine, stack, options.e2ee);
    try {
      if (app) await connectApp(machine, app);
      else {
        const created = await world.cli(["apps", "add-local", APP_ID, "--yes"]);
        if (created.code !== 0) throw new Error(`apps add-local failed (${created.code}):\n${created.stdout}\n${created.stderr}`);
      }
      const added = await world.addPlugin(await assemblePlugin(path.join(machine.root, "mcp-plugin")));
      if (added.code !== 0) throw new Error(`plugin add failed (${added.code}):\n${added.stdout}\n${added.stderr}`);
      await options.beforeRun?.(world);
      await world.startRunner();
      return world;
    } catch (error) {
      await world.dispose();
      throw error;
    }
  }

  /** `bridge <args>` through this world's CLI entry, answering prompts (a terminal when `tty`). */
  cli(args: string[], options: { tty?: boolean; input?: string; env?: Record<string, string> } = {}): Promise<Finished> {
    return this.machine.exec(args, options.input ?? "", { ...this.cliEnv, ...options.env }, { entry: this.entry, tty: options.tty === true });
  }

  /** `bridge plugin add <dir> [extra]` at a terminal, answering `y` to the consent when it is asked. */
  async addPlugin(dir: string, extra: string[] = [], answer = "y"): Promise<Finished> {
    const proc = this.machine.start(["plugin", "add", dir, ...extra], this.cliEnv, { entry: this.entry, tty: true });
    const asked = proc.waitFor(/Allow this\? \[y\/N\]/, { stream: "stderr", timeoutMs: 30_000 }).then(
      () => proc.write(`${answer}\n`),
      () => undefined,
    );
    const done = await proc.exited;
    await asked;
    return done;
  }

  async startRunner(): Promise<void> {
    // The real adapter's world runs the plain `main.js`: the CLI's own adapters, nothing replaced.
    this.runner = this.machine.start(["run"], { ...this.cliEnv, BRIDGE_E2EE: this.e2ee ? "1" : "0" }, this.stubStack ? { entry: CONTAINMENT_CLI } : {});
    if (this.local) {
      // No relay link to wait for: the runner says it is up, and there is no page or client to open.
      await this.runner.waitFor(/Bridge runner started/, { stream: "stderr" });
      return;
    }
    await this.runner.waitFor(new RegExp(`\\[${APP_ID}\\] online`));
    await this.openClient();
  }

  async restartRunner(): Promise<void> {
    this.closeClient?.();
    this.page = undefined;
    await this.runner.stop();
    await this.startRunner();
  }

  private async openClient(): Promise<void> {
    if (this.e2ee) {
      const page = this.page ?? (await HeadlessPage.open(this.app));
      const runnerId = (await page.waitForState(this.page ? "ready" : "online_not_enrolled")).runner!.runnerId;
      if (!this.page) await enrollBrowser(this.machine, page, APP_ID);
      this.page = page;
      this.acp = async (app) => (this.connection = await page.bridge.acp(app ?? collectingApp([]), runnerId));
      await this.acp();
      this.closeClient = () => page.close();
    } else {
      const headless = await headlessClient(this.app, { e2ee: false });
      const online = await headless.runner();
      this.acp = async (app) => (this.connection = await headless.bridge.acp(app ?? collectingApp([]), online.runnerId));
      await this.acp();
      this.closeClient = () => headless.bridge.close();
    }
  }

  /**
   * `_mcpplug/run`: the plugin starts a session with `request`, sends `prompts`, and reports what it got. `spawned` is
   * every stub process started during the call (none when the start was refused before a spawn).
   */
  async run(request: Record<string, unknown>, prompts: string[] = [], extra: { hold?: boolean; onBehalf?: boolean; secretFrom?: string } = {}): Promise<RunReport & { spawned: StubRecord[] }> {
    const before = new Set((await this.records()).map((r) => r.id));
    const report = (await this.connection.agent.request(`_${PLUGIN_ID}/run`, { request, prompts, ...extra })) as RunReport;
    return { ...report, spawned: (await this.records()).filter((r) => !before.has(r.id)) };
  }

  /** The one stub process `report` started (its cwd's name is the runner's id of the session, which the audit uses). */
  static only(report: { spawned: StubRecord[] }): StubRecord {
    if (report.spawned.length !== 1) throw new Error(`expected one stub spawn, saw ${report.spawned.length}`);
    return report.spawned[0]!;
  }

  /** `_mcpplug/finish`: closes a held session. */
  finish(sessionId: string): Promise<{ events: RunReport["events"]; ended: string | null }> {
    return this.connection.agent.request(`_${PLUGIN_ID}/finish`, { sessionId }) as Promise<{ events: RunReport["events"]; ended: string | null }>;
  }

  /** Every stub process's record, oldest first (none in a real-adapter world). */
  async records(): Promise<StubRecord[]> {
    if (!this.stubStack) return [];
    const files = (await readdir(this.stack.records)).filter((f) => /^spawn-[0-9a-f-]{36}\.json$/.test(f));
    const all = await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(this.stack.records, f), "utf8")) as StubRecord & { startedAt: string }));
    return all.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  }

  /** A stub process's record as it is now (it is rewritten after each step). */
  async recordNow(id: string): Promise<StubRecord> {
    return JSON.parse(await readFile(path.join(this.stack.records, `spawn-${id}.json`), "utf8")) as StubRecord;
  }

  /**
   * Map a fixture's namespace-local PID to a host PID only inside its verified live tree.
   * The root must match namespace inode, NSpid and start ticks; PID reuse cannot turn a
   * completed fixture into an observation of an unrelated host process. No signals are sent.
   */
  async hostPid(record: StubRecord, localPid = record.pid): Promise<number | undefined> {
    if (process.platform !== "linux" || !record.pidNamespace || !record.processStart) return undefined;
    const processes = (await Promise.all((await readdir("/proc")).filter((n) => /^\d+$/.test(n)).map(async (name) => {
      try {
        const [raw, status, namespace] = await Promise.all([
          readFile(`/proc/${name}/stat`, "utf8"), readFile(`/proc/${name}/status`, "utf8"), readlink(`/proc/${name}/ns/pid`),
        ]);
        const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
        const nspid = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
        return { pid: Number(name), parent: Number(fields[1]), started: fields[19], namespace, localPid: nspid?.at(-1) };
      } catch { return undefined; }
    }))).filter((p) => p !== undefined);
    const roots = processes.filter((p) => p.namespace === record.pidNamespace && p.localPid === record.pid && p.started === record.processStart);
    if (roots.length !== 1) return undefined;
    const tree = new Set([roots[0]!.pid]);
    for (let previous = -1; previous !== tree.size;) {
      previous = tree.size;
      for (const p of processes) if (tree.has(p.parent)) tree.add(p.pid);
    }
    const matches = processes.filter((p) => tree.has(p.pid) && p.namespace === record.pidNamespace && p.localPid === localPid);
    return matches.length === 1 ? matches[0]!.pid : undefined;
  }

  /** Sets what the stub advertises after `session/new` (`undefined`: the model's own list). */
  async stubBehaviour(behaviour: { commands?: string[] } | undefined): Promise<void> {
    await writeFile(path.join(this.stack.records, "behaviour.json"), JSON.stringify(behaviour ?? {}));
  }

  /** `bridge plugin audit mcpplug --json`: the records the person finds. */
  async audit(): Promise<AuditLine[]> {
    const out = await this.cli(["plugin", "audit", PLUGIN_ID, "--json", "--limit", "10000"]);
    if (out.code !== 0) throw new Error(`plugin audit failed: ${out.stderr}`);
    return (JSON.parse(out.stdout) as { records: AuditLine[] }).records;
  }

  /** The audit records of the session `record`'s stub ran (the cwd's name and the audit's `sessionId` are the same runner id, which is also the plugin's `report.sessionId`). */
  async auditOf(record: StubRecord): Promise<AuditLine[]> {
    return this.auditOfSession(path.basename(record.cwd));
  }

  /** The audit records of the session with this id: the plugin's own `sessionId`, which is the runner's. */
  async auditOfSession(sessionId: string): Promise<AuditLine[]> {
    return (await this.audit()).filter((r) => r.sessionId === sessionId);
  }

  /** The e2e plugin's data dir (`<data>/<app>/bridge/plugin-data/<id>`): where `plugin.log` is, and where `autorun.json` goes. */
  get pluginDataDir(): string {
    return path.join(this.machine.dataDir, APP_ID, "bridge", "plugin-data", PLUGIN_ID);
  }

  /** The app's state folder (`<state>/<app>/bridge`; the machine's state base is `~/.local/state`). */
  get appStateDir(): string {
    return path.join(this.machine.home, ".local", "state", APP_ID, "bridge");
  }

  /** The app's own `config.json` (`<config>/<app>/bridge/config.json`). */
  get appConfigFile(): string {
    return path.join(this.machine.configDir, APP_ID, "bridge", "config.json");
  }

  async dispose(): Promise<void> {
    this.closeClient?.();
    await this.machine.dispose();
    await this.deployment?.close();
  }
}

/** The error code of a JSON-RPC rejection from the client (`connection.agent.request`). */
export async function rpcCode(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: number }).code;
  }
}
