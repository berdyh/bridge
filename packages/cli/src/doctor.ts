import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  CLAUDE_MEASURED_STACKS,
  confinedExecutionSupport,
  claudeContainmentSupport,
  createConsentStore,
  auditFilesOf,
  createPluginHost,
  doctorPaths,
  formatDoctorPaths,
  MEASURED_CLAUDE_STACK,
  runnerPaths,
  surfaceOf,
  surfaceSha256Of,
  type AcpAgentAdapter,
  type AgentAdapter,
  type ManifestEntry,
} from "@berdyh/bridge-runner";

import { adapterKindOf } from "./adapters.js";
import { AGENT_NAMES, agentLoginFileOf, agentLoginIsPresent, agentNameOfAdapter, type AgentName } from "./agent.js";
import { parse } from "./args.js";
import { RUNNER_NAME, RUNNER_LOCK_FILE, WORKER_LOCK_FILE, adaptersDirOf, aliasLauncherPathOf, appPathsOf, baseDirsOf, launcherPathOf, runnerLockPath, workerLockPath } from "./paths.js";
import { appConfigOf } from "./app-config.js";
import { type AppRecord, appsFilePath, printable, readAppList, readApps } from "./config.js";
import { type CliDeps, UsageError, adaptersOf, bridgeConfigDir, credentialStoreSettingOf, errorMessage, homeOf, keychainHint, keychainUsability, platformOf, runnerOf } from "./deps.js";
import { legacyErrorOf } from "./legacy.js";
import { hasOurMimeEntries, protocolHandlerFiles, protocolHandlerPaths, withOurMimeEntries } from "./protocol-handler.js";
import { readLock } from "./runner-lock.js";
import { type LauncherState, installPathsOf, isInside, launcherStateOf, pathWarningOf } from "./self.js";
import { checkForUpdate, updateLineOf } from "./update-check.js";
import { CLI_VERSION } from "./version.js";

export { RUNNER_NAME, baseDirsOf, launcherPathOf };

/**
 * Every path the runner and its service write, including the files inside its dirs, per
 * connected app (the ids `apps.json` lists, whether or not each `app.json` reads; an unreadable
 * `apps.json` lists none), and the `bridge://` handler's files on Linux. An app's parents
 * (`<config>/<app>` and the other two) are not listed: bridge does not own them.
 */
export async function manifestOf(deps: CliDeps): Promise<ManifestEntry[]> {
  return manifestFor(deps, (await readAppList(deps)).listed.map((a) => a.appId));
}

export function manifestFor(deps: CliDeps, appIds: readonly string[]): ManifestEntry[] {
  const entries = doctorPaths({
    app: RUNNER_NAME,
    platform: platformOf(deps),
    base: baseDirsOf(deps),
    appPaths: appIds.map((id) => appPathsOf(deps, id)),
  }).filter((e) => e.role !== "external");
  const config = bridgeConfigDir(deps);
  const inside: ManifestEntry[] = [
    { path: path.join(config, "config.json"), kind: "file", role: "config", description: "machine setup settings (config.json: setup.service)", removeOnUninstall: true },
    { path: appsFilePath(deps), kind: "file", role: "config", description: "connected apps, id to origin (apps.json)", removeOnUninstall: true },
    { path: path.join(config, "policy.json"), kind: "file", role: "config", description: "machine local policy, if you wrote one (policy.json)", removeOnUninstall: true },
  ];
  // install.sh's download folder; it removes what it downloads at exit, the folder stays until uninstall.
  const cache: ManifestEntry = { path: path.join(homeOf(deps), ".cache", "bridge-install"), kind: "dir", role: "install", description: "install.sh's download folder (bridge-install)", removeOnUninstall: true };
  const launcher = launcherPathOf(deps);
  const listed = entries.flatMap((e): ManifestEntry[] =>
    e.role === "launcher"
      ? [{ ...e, path: launcher }, { path: aliasLauncherPathOf(deps), kind: "symlink", role: "launcher", description: "launcher link on PATH, unambiguous name (bridge-runner)", removeOnUninstall: true }]
      : [e],
  );
  // Inside <data>/bridge, which is listed: uninstall takes it with that folder; named here so `--paths` shows it.
  const adapters: ManifestEntry = { path: adaptersDirOf(deps), kind: "dir", role: "install", description: "agent adapters installed by bridge (bridge agent install)", removeOnUninstall: true };
  return [...listed, ...inside, adapters, ...lockAndSessionPaths(deps, appIds), cache, ...protocolHandlerPaths(deps)];
}

/**
 * What `bridge run` adds for contained plugin sessions, beside the three `bridge/` folders the runner lists: the
 * machine-wide `runner.lock`, and per app its audit logs, consent records, session folders and `worker.lock`. Every
 * one is inside a folder already listed, so uninstall and `apps remove` take them with it; they are named here so
 * `doctor --paths` shows them and nothing is a surprise.
 */
function lockAndSessionPaths(deps: CliDeps, appIds: readonly string[]): ManifestEntry[] {
  const own = (file: string, kind: ManifestEntry["kind"], role: ManifestEntry["role"], what: string): ManifestEntry => ({ path: file, kind, role, description: what, removeOnUninstall: true });
  return [
    own(runnerLockPath(deps), "file", "state", `single-runner lock (${RUNNER_LOCK_FILE}): the pid of the running \`bridge run\``),
    ...appIds.flatMap((id) => {
      const a = appPathsOf(deps, id);
      return [
        own(a.auditDir, "dir", "state", `${id}: tool-call audit logs of contained plugin sessions`),
        own(a.consentDir, "dir", "config", `${id}: plugin consent records (not the plugin packages)`),
        own(a.sessionsDir, "dir", "state", `${id}: contained session folders (emptied when the runner starts)`),
        own(workerLockPath(a), "file", "state", `${id}: worker lock (${WORKER_LOCK_FILE}): the pid of the runner serving this app`),
      ];
    }),
  ];
}

/**
 * What the runner and the CLI write that `manifestFor` cannot name without reading the machine: for each installed plugin its
 * folder, data folder, consent record and audit logs (`<id>.jsonl` and its rotated `.1`), and, when `BRIDGE_CREDENTIAL_STORE`
 * selects the file store, the credential folder. All but the credential folder are inside folders `manifestFor` lists (uninstall
 * takes them with those); the credential folder is the person's chosen place, so uninstall deletes the items in it, never the folder.
 * Reads only; a host that cannot list adds no plugin (the full `doctor` reports that).
 */
export async function installedPathsOf(deps: CliDeps, apps: readonly Pick<AppRecord, "appId">[]): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  try {
    const setting = credentialStoreSettingOf(deps);
    if (setting.kind === "file") {
      entries.push({ path: setting.dir, kind: "dir", role: "config", description: "credential files (BRIDGE_CREDENTIAL_STORE): sign-in tokens and identity wrapping keys, unencrypted; uninstall deletes the items, not the folder", removeOnUninstall: false });
    }
  } catch { /* a malformed setting: doctor warns about it */ }
  if (apps.length === 0) return entries;
  try {
    const host = deps.pluginHost ?? createPluginHost({ apps: apps.map((a) => appPathsOf(deps, a.appId)), env: deps.env });
    const seen = new Set<string>();
    for (const plugin of await host.list()) {
      const id = plugin.manifest.id;
      if (seen.has(`${plugin.appId}/${id}`)) continue;
      seen.add(`${plugin.appId}/${id}`);
      const a = appPathsOf(deps, plugin.appId);
      const own = (file: string, kind: ManifestEntry["kind"], role: ManifestEntry["role"], what: string): ManifestEntry => ({ path: file, kind, role, description: `${plugin.appId}: plugin ${printable(id)}: ${what}`, removeOnUninstall: true });
      entries.push(
        own(path.dirname(plugin.installDir), "dir", "install", "installed package (a folder per version)"),
        own(plugin.dataDir, "dir", "install", "plugin data (its HOME and TMPDIR)"),
        own(path.join(a.consentDir, `${id}.consent.json`), "file", "config", "consent record"),
        ...auditFilesOf(a, id).map((file) => own(file, "file", "state", "tool-call audit log")),
      );
    }
  } catch { /* cannot list: the plugin lines are left out */ }
  return entries;
}

export interface AdapterReport {
  id: string;
  available: boolean;
  /** Where the adapter's command was found; absent when none was. */
  command?: string;
  source?: "bundled" | "path";
  /** The agent's login in bridge's own folder (`bridge agent login`); absent for an adapter that keeps none. */
  login?: { present: boolean; file: string };
  /** Whether this adapter can run contained plugin sessions here, and the pair it was measured on. */
  containment: AgentContainment;
}

/**
 * Contained sessions for one agent, as measured: the versions of the pair they were measured on, or why they are
 * refused. A statement about what was measured and is checked at runtime, never a guarantee.
 */
export type AgentContainment =
  | { supported: true; profile: string; adapter: string; binary: string; platformPackage: string }
  | { supported: false; reason: string };

/**
 * Asks the adapter whether it can run contained and, when it cannot, why. An adapter with no profile (codex) is "no
 * containment profile". For claude the reason is the version check's own (`claudeContainmentSupport`), read with the
 * adapter's resolved command; the adapter's answer decides whether it is supported.
 */
export function containmentOf(adapter: AgentAdapter): AgentContainment {
  let profile;
  try {
    profile = adapter.containment?.();
  } catch (error) {
    return { supported: false, reason: `cannot be checked (${errorMessage(error)})` };
  }
  if (profile !== undefined) {
    return { supported: true, profile: profile.id, adapter: profile.adapterVersion, binary: profile.binaryVersion, platformPackage: profile.platformPackageVersion };
  }
  if (adapter.id === "claude" && "resolved" in adapter && typeof adapter.resolved === "function") {
    try {
      const found = claudeContainmentSupport().resolve((adapter as AcpAgentAdapter).resolved());
      if ("unavailable" in found) return { supported: false, reason: printable(found.unavailable) };
    } catch (error) {
      return { supported: false, reason: `cannot be checked (${errorMessage(error)})` };
    }
  }
  return { supported: false, reason: "no containment profile" };
}

function containmentLine(c: AgentContainment): string {
  return c.supported
    ? `contained sessions: supported (running adapter ${printable(c.adapter)} / CLI ${printable(c.binary)}; measured on adapter ${MEASURED_CLAUDE_STACK.adapter} / CLI ${MEASURED_CLAUDE_STACK.binary}, accepted from those versions up, argv asserted at CI, detected at runtime)`
    : `contained sessions: refused: ${c.reason}`;
}

/** Each agent adapter's availability, which command it would run (an ACP adapter) and whether bridge holds a login for it. */
export async function adapterReports(deps: CliDeps): Promise<AdapterReport[]> {
  const reports: AdapterReport[] = [];
  for (const adapter of adaptersOf(deps)) {
    const availability = await adapter.availability().catch(() => ({ id: adapter.id, available: false }));
    const resolved = "resolved" in adapter && typeof adapter.resolved === "function" ? (adapter as AcpAgentAdapter).resolved() : undefined;
    const agent = agentNameOfAdapter(adapter.id);
    const login = agent ? { present: await agentLoginIsPresent(deps, agent).catch(() => false), file: agentLoginFileOf(deps, agent) } : undefined;
    reports.push({ id: adapter.id, available: availability.available, ...(resolved ? { command: resolved.command, source: resolved.source } : {}), ...(login ? { login } : {}), containment: containmentOf(adapter) });
  }
  return reports;
}

/** One installed plugin that can start an agent session, and whether its consent record still covers what is installed. */
export interface PluginConsentReport {
  appId: string;
  pluginId: string;
  version: string;
  consent: "ok" | "missing" | "unreadable" | "stale";
  /** Why contained sessions are refused; absent when the consent is ok. */
  problem?: string;
}

const REFUSED_UNTIL = "contained sessions refused until `bridge plugin add` is confirmed again";

/**
 * For every installed plugin whose manifest can start an agent session (it names an agent, an MCP server or a headless
 * tool; an agent-only plugin can ask for a contained session with no built-in tools): is there a consent record
 * that is readable (not behind a link), valid, and the approval of the manifest that is installed? A plugin that
 * asks for none of these has no agent sessions and is not listed. Reads only; a host that cannot list says so.
 */
export async function pluginConsentReports(deps: CliDeps, apps: readonly Pick<AppRecord, "appId">[]): Promise<{ reports: PluginConsentReport[]; error?: string }> {
  if (apps.length === 0) return { reports: [] };
  const reports: PluginConsentReport[] = [];
  try {
    const host = deps.pluginHost ?? createPluginHost({ apps: apps.map((a) => appPathsOf(deps, a.appId)), env: deps.env });
    for (const plugin of await host.list()) {
      const surface = surfaceOf(plugin.manifest);
      if (!surface.items.some((item) => item.kind === "agent" || item.kind === "mcpServer" || item.kind === "headlessTool")) continue;
      const base = { appId: plugin.appId, pluginId: plugin.manifest.id, version: plugin.version };
      try {
        const grant = await createConsentStore({ paths: appPathsOf(deps, plugin.appId) }).read(plugin.manifest.id);
        if (grant === undefined) reports.push({ ...base, consent: "missing", problem: `no valid consent record; ${REFUSED_UNTIL}` });
        else if (grant.surfaceSha256 !== surfaceSha256Of(surface)) reports.push({ ...base, consent: "stale", problem: `its consent record is for other permissions than the installed manifest asks for; ${REFUSED_UNTIL}` });
        else reports.push({ ...base, consent: "ok" });
      } catch {
        reports.push({ ...base, consent: "unreadable", problem: `its consent record or folder is behind a link or cannot be read; ${REFUSED_UNTIL}` });
      }
    }
  } catch (error) {
    return { reports, error: `cannot list the installed plugins (${errorMessage(error)})` };
  }
  return { reports };
}

export interface ServiceReport {
  name: string;
  file: string;
  installed: boolean;
  /** `active`, `inactive`, `failed`... (systemd), `loaded` or `not_loaded` (launchd), `unknown`; absent when not installed. */
  state?: string;
}

/** The OS user id of the launchd `gui/<uid>` domain. */
export function launchdUid(): number {
  return process.getuid?.() ?? 501;
}

export async function serviceReport(deps: CliDeps): Promise<ServiceReport> {
  const platform = platformOf(deps);
  const p = runnerPaths({ app: RUNNER_NAME, platform, base: baseDirsOf(deps) });
  const installed = await lstat(p.serviceFile).then(() => true, () => false);
  if (!installed) return { name: p.serviceName, file: p.serviceFile, installed };
  let state = "unknown";
  try {
    if (platform === "linux") {
      const r = await runnerOf(deps)("systemctl", ["--user", "is-active", p.serviceName]);
      state = r.stdout.trim() || "unknown";
    } else {
      const r = await runnerOf(deps)("launchctl", ["print", `gui/${launchdUid()}/${p.serviceName}`]);
      state = r.exitCode === 0 ? "loaded" : "not_loaded";
    }
  } catch {
    // no systemctl / launchctl: the state stays unknown
  }
  return { name: p.serviceName, file: p.serviceFile, installed, state };
}

export interface ProtocolHandlerReport {
  supported: boolean;
  desktopFile?: boolean;
  /** Whether `mimeapps.list` has both of our lines: `both`, `partial` (one) or `none`; `unknown` when it cannot be read. */
  mimeapps?: "both" | "partial" | "none" | "unknown";
}

export async function protocolHandlerReport(deps: CliDeps): Promise<ProtocolHandlerReport> {
  if (platformOf(deps) !== "linux") return { supported: false };
  const files = protocolHandlerFiles(deps);
  const desktopFile = await lstat(files.desktopFile).then((i) => i.isFile(), () => false);
  let mimeapps: ProtocolHandlerReport["mimeapps"];
  try {
    const text = await readFile(files.mimeapps, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    mimeapps = !hasOurMimeEntries(text) ? "none" : withOurMimeEntries(text) === text ? "both" : "partial";
  } catch {
    mimeapps = "unknown";
  }
  return { supported: true, desktopFile, mimeapps };
}

export interface LockReport {
  /** `runner` for the machine-wide lock, else the app id of a worker lock. */
  holder: string;
  file: string;
  /** What the file holds; locks that are absent are not reported. */
  lock: Exclude<Awaited<ReturnType<typeof readLock>>, { state: "absent" }>;
}

/** The lock files that exist (`runner.lock`, and each connected app's `worker.lock`), with the pid in each and whether it is alive. Reads only. */
export async function lockReports(deps: CliDeps, appIds: readonly string[]): Promise<LockReport[]> {
  const wanted = [{ holder: "runner", file: runnerLockPath(deps) }, ...appIds.map((id) => ({ holder: id, file: workerLockPath(appPathsOf(deps, id)) }))];
  const reports: LockReport[] = [];
  for (const { holder, file } of wanted) {
    const lock = await readLock(file);
    if (lock.state !== "absent") reports.push({ holder, file, lock });
  }
  return reports;
}

function lockLine(r: LockReport): string {
  const what = r.lock.state === "held" ? `held by pid ${r.lock.pid} since ${printable(r.lock.startedAt)} (${r.lock.alive ? "running" : "not running: a runner start replaces it"})` : `unreadable (${r.lock.detail})`;
  return `  ${r.holder === "runner" ? "runner.lock" : `worker.lock of ${r.holder}`}: ${what}`;
}

/** Where the procedure for rerunning the containment canary is written down. The canary needs the source checkout and a claude login, and it spends the subscription. */
export const CANARY_COMMAND = 'see docs/guides/operate-the-runner.md, section "The claude version floor"';

export interface ContainmentReport {
  /** The pairs the containment profile was measured on (the table in the runner). */
  measured: { adapter: string; sdk: string; platformPackage: string; binary: string; binarySha256: string; installed: boolean }[];
  /** What the claude adapter on this machine says. */
  claude: AgentContainment | { supported: false; reason: "no claude adapter" };
  canary: string;
  execution: ReturnType<typeof confinedExecutionSupport> & { agent: "claude"; adapterSupported: boolean };
}

/** `bridge doctor --containment`: per measured pair, the adapter and binary versions and whether the installed pair is it. */
export function containmentReport(deps: CliDeps): ContainmentReport {
  const adapter = adaptersOf(deps).find((a) => a.id === "claude");
  const claude = adapter ? containmentOf(adapter) : ({ supported: false, reason: "no claude adapter" } as const);
  const measured = CLAUDE_MEASURED_STACKS.map((stack) => ({
    adapter: stack.adapter,
    sdk: stack.sdk,
    platformPackage: stack.platformPackage,
    binary: stack.binary,
    binarySha256: stack.binarySha256,
    installed: claude.supported && claude.adapter === stack.adapter && claude.binary === stack.binary && claude.platformPackage === stack.platformPackage,
  }));
  return { measured, claude, canary: CANARY_COMMAND, execution: { ...confinedExecutionSupport(), agent: "claude", adapterSupported: Boolean(adapter?.execution?.()) } };
}

function containmentText(report: ContainmentReport): string {
  return [
    "contained sessions run on the versions below and newer ones (linux x64; an older adapter or CLI is refused, a newer one is accepted and logged):",
    ...report.measured.map((m) => `  adapter ${m.adapter} / SDK ${m.sdk} / platform package ${m.platformPackage} / CLI ${m.binary} (binary sha256 ${m.binarySha256.slice(0, 12)}...): ${m.installed ? "this is the installed pair" : "not the installed pair"}`),
    `confined-v1 execution (Linux x64, bundled Claude): ${report.execution.supported && report.execution.adapterSupported ? "available" : report.execution.hint ?? "bundled adapter unsupported or missing"}; scripts in a private workspace; exact consented HTTPS endpoints; broker secrets on fd3`,
    `installed claude: ${containmentLine(report.claude)}`,
    "A newer version is not measured. To measure a stack from the bridge source checkout (it needs a claude login and spends the subscription):",
    `  ${report.canary}`,
    "",
  ].join("\n");
}

/** Which credential store this environment selects; `file` and `invalid` carry the warning doctor prints. */
export type CredentialStoreReport = { kind: "keychain" } | { kind: "file"; dir: string; warning: string } | { kind: "invalid"; warning: string };

/**
 * `BRIDGE_CREDENTIAL_STORE=file:<dir>` keeps the runner's credentials as unencrypted files instead of in the OS keychain
 * (a machine with no Secret Service). It works, but it is the weaker store, so doctor says so loudly; with the variable
 * unset the report is `keychain` and doctor prints nothing about it. A malformed value is reported, not thrown: doctor must still run.
 */
export function credentialStoreReport(deps: CliDeps): CredentialStoreReport {
  try {
    const setting = credentialStoreSettingOf(deps);
    if (setting.kind === "keychain") return { kind: "keychain" };
    const dir = printable(setting.dir);
    return {
      kind: "file",
      dir,
      warning:
        `WARNING: BRIDGE_CREDENTIAL_STORE is set: the runner's credentials are kept as plain, unencrypted files in ${dir} (folder 0700, files 0600), not in the OS keychain. ` +
        "Anyone who can read that folder as you, or a backup of it, can act as this runner. Use it only on a machine with no Secret Service (a headless server, a container); " +
        "unset BRIDGE_CREDENTIAL_STORE to use the keychain.",
    };
  } catch (error) {
    return { kind: "invalid", warning: `WARNING: ${errorMessage(error)}; fix it, or unset it to use the OS keychain` };
  }
}

/** One file a session's refreshed agent login is written back to. */
export interface TokenWriteBackReport {
  agent: AgentName;
  file: string;
  /** Whether the file holds a usable login now. */
  present: boolean;
}

/**
 * Where tokens an agent refreshed inside a session are written back: bridge's own copy of each agent's login
 * (`<config>/bridge/agents/<agent>/`), a plain 0600 file whatever credential store is selected. The agents' own folders
 * (`~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`) are never staged from nor written back to.
 */
export async function tokenWriteBackReports(deps: CliDeps): Promise<TokenWriteBackReport[]> {
  return Promise.all(AGENT_NAMES.map(async (agent) => ({ agent, file: agentLoginFileOf(deps, agent), present: await agentLoginIsPresent(deps, agent).catch(() => false) })));
}

const WRITE_BACK_HEADING = "token write-back (a token an agent refreshes inside a session is written back to these plain files; ~/.claude and ~/.codex are not written):";

/**
 * The adapter and the login, reported separately: "available" alone cannot say "adapter found, no login". A claude
 * adapter that is missing says how to install it, and a codex one too when bridge holds a codex login; one under bridge's adapters folder says bridge installed it.
 */
function adapterLine(a: AdapterReport, deps: CliDeps): string {
  const adaptersDir = adaptersDirOf(deps);
  const label = (command: string): string =>
    a.source !== "bundled" ? `adapter on PATH: ${command}` : isInside(adaptersDir, command) ? `adapter installed by bridge: ${command}` : `bundled adapter (source checkout): ${command}`;
  // Claude's install is always named; codex's only when bridge holds a codex login (then it is the one thing missing).
  const kind = adapterKindOf(a.id);
  const named = kind !== undefined && (kind.agent === "claude" || a.login?.present === true) ? kind : undefined;
  const missing = named ? `no adapter installed; run \`${named.command}\` (${named.size} from the npm registry into ${adaptersDir})` : "no adapter found";
  const adapter = a.command ? `adapter found (${label(a.command)})` : missing;
  if (!a.login) return adapter;
  const agent = agentNameOfAdapter(a.id);
  return `${adapter}, ${a.login.present ? "login present" : `no login (run \`bridge agent login ${agent}\`)`}`;
}

const launcherStateName = (l: LauncherState): string => (l.kind === "ours" ? (l.dangling ? "dangling" : "current") : l.kind);

function launcherTextOf(link: string, l: LauncherState): string {
  return l.kind === "ours"
    ? `${link} -> ${l.target}${l.dangling ? " (missing: reinstall with `bridge self install`)" : ""}`
    : l.kind === "missing"
      ? `${link} (not installed; run \`bridge self install\`)`
      : `${link} (not a bridge launcher: ${l.detail})`;
}

const DOCTOR_USAGE = "usage: bridge doctor [--paths | --containment] [--json]";

/** `bridge doctor [--paths | --containment] [--json]`. */
export async function runDoctor(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, { paths: { type: "boolean" }, containment: { type: "boolean" }, json: { type: "boolean" } });
  if (positionals.length > 0 || (values.paths && values.containment)) throw new UsageError(DOCTOR_USAGE);
  if (values.containment) {
    const report = containmentReport(deps);
    deps.stdout(values.json ? `${JSON.stringify(report)}\n` : containmentText(report));
    return 0;
  }
  const apps = await readApps(deps);
  const legacyError = await legacyErrorOf(deps);
  const legacy = legacyError?.paths ?? [];
  const manifest = [...manifestFor(deps, apps.listed.map((a) => a.appId)), ...(await installedPathsOf(deps, apps.apps))];
  if (values.paths) {
    if (legacyError) deps.stderr(`bridge doctor: ${legacyError.message}\n`);
    deps.stdout(values.json ? `${JSON.stringify(manifest)}\n` : formatDoctorPaths(manifest));
    return 0;
  }
  const paths = installPathsOf(deps);
  const aliasLink = aliasLauncherPathOf(deps);
  const [adapters, service, handler, launcher, alias] = await Promise.all([adapterReports(deps), serviceReport(deps), protocolHandlerReport(deps), launcherStateOf(deps), launcherStateOf(deps, aliasLink)]);
  const plugins = await pluginConsentReports(deps, apps.apps);
  const update = await checkForUpdate(deps);
  const pathWarning = await pathWarningOf(deps).catch(() => undefined);
  const writeBack = await tokenWriteBackReports(deps);
  const storeSetting = credentialStoreReport(deps);
  // With the keychain selected, probe it: an unusable one is reported (and named in the JSON) with the way out.
  const keychain = storeSetting.kind === "keychain" ? await keychainUsability(deps) : ({ usable: true } as const);
  const credentialStore = keychain.usable ? storeSetting : { kind: "keychain" as const, usable: false as const, warning: `WARNING: ${keychainHint(keychain)}` };
  const locks = await lockReports(deps, apps.listed.map((a) => a.appId));
  const appRecords = await Promise.all(
    apps.apps.map(async (a) => {
      const p = appPathsOf(deps, a.appId);
      const config = await appConfigOf(deps, a.appId);
      // effort is read and validated, but nothing applies it yet: say so rather than let a setting do nothing silently.
      const warnings = [
        ...config.warnings,
        ...(config.agent?.effort !== undefined ? [`${p.configFile}: agent.effort is recorded but not applied yet (the runner has no hook for it)`] : []),
      ];
      return { appId: a.appId, name: a.name, origin: a.origin, dirs: { config: p.configDir, data: p.dataDir, state: p.stateDir }, ...(warnings.length > 0 && { warnings }) };
    }),
  );
  const launcherTarget = launcher.kind === "ours" ? launcher.target : undefined;
  const installDir = launcher.kind === "ours" ? path.join(paths.versionsDir, launcher.version) : undefined;
  if (values.json) {
    deps.stdout(
      `${JSON.stringify({
        version: CLI_VERSION,
        platform: platformOf(deps),
        node: process.version,
        install: {
          dir: installDir ?? null,
          versionsDir: paths.versionsDir,
          launcher: {
            path: paths.launcherLink,
            state: launcherStateName(launcher),
            target: launcherTarget ?? null,
            alias: { path: aliasLink, state: launcherStateName(alias), target: alias.kind === "ours" ? alias.target : null },
          },
        },
        service,
        update: update ?? null,
        pathWarning: pathWarning ?? null,
        credentialStore,
        tokenWriteBack: writeBack,
        adapters,
        locks,
        plugins: plugins.reports,
        ...(plugins.error ? { pluginsError: plugins.error } : {}),
        apps: appRecords,
        ...(apps.error ? { appsError: apps.error } : {}),
        legacy,
        ...(apps.broken.length > 0 ? { brokenApps: apps.broken } : {}),
        protocolHandler: handler,
        paths: manifest,
      })}\n`,
    );
    return 0;
  }
  const launcherText = launcherTextOf(paths.launcherLink, launcher);
  const aliasText = launcherTextOf(aliasLink, alias);
  deps.stdout(
    [
      `bridge ${CLI_VERSION} on ${platformOf(deps)}, node ${process.version}`,
      `config:   ${bridgeConfigDir(deps)}`,
      `launcher: ${launcherText}`,
      `          ${aliasText}`,
      ...(update !== undefined ? [updateLineOf(update)] : []),
      ...(pathWarning !== undefined ? [pathWarning] : []),
      `service:  ${service.installed ? `${service.name} installed (${service.state ?? "unknown"})` : `${service.name} not installed`}`,
      ...("warning" in credentialStore ? [credentialStore.warning] : []),
      ...(legacyError ? [`WARNING: ${legacyError.message}`] : []),
      WRITE_BACK_HEADING,
      ...writeBack.map((w) => `  ${w.agent}: ${printable(w.file)} (${w.present ? "login present" : "no login"})`),
      "agents:",
      ...adapters.flatMap((a) => [`  ${a.id}: ${adapterLine(a, deps)}`, `    ${containmentLine(a.containment)}`]),
      ...(plugins.reports.length > 0 ? ["plugins with contained sessions:", ...plugins.reports.map((r) => `  ${printable(r.pluginId)} ${printable(r.version)} (app ${r.appId}): ${r.consent === "ok" ? "consent record matches the installed manifest" : `WARNING: ${r.problem}`}`)] : []),
      ...(plugins.error ? [`WARNING: ${plugins.error}`] : []),
      ...(locks.length > 0 ? ["locks:", ...locks.map(lockLine)] : []),
      `apps:     ${apps.error ? `unreadable (${apps.error})` : appRecords.length === 0 && apps.broken.length === 0 ? "none (run `bridge connect <app-url>`)" : [...appRecords.map((a) => a.appId), ...apps.broken.map((b) => `${b.appId} (broken: ${b.error})`)].join(", ")}`,
      ...appRecords.flatMap((a) => (a.warnings ?? []).map((w) => `WARNING: ${w}`)),
      ...appRecords.flatMap((a) => [`  ${a.appId}: config ${a.dirs.config}`, `  ${" ".repeat(a.appId.length)}  data   ${a.dirs.data}`, `  ${" ".repeat(a.appId.length)}  state  ${a.dirs.state}`]),
      ...(handler.supported ? [`bridge:// handler: desktop entry ${handler.desktopFile ? "present" : "absent"}, mimeapps.list lines ${handler.mimeapps}`] : []),
      "Run `bridge doctor --paths` to list every path the runner writes.",
      "",
    ].join("\n"),
  );
  return 0;
}
