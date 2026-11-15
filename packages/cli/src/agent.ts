import { randomBytes } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { type AgentId, type ProtectedDir, agentLoginPresent, agentOwnDirOverlap, exportAgentLogin, resolveAgentAuthFile, resolvedAgentOwnDirs } from "@berdyh/bridge-runner";

import { runAdapterInstall } from "./adapters.js";
import { parse } from "./args.js";
import { CHANGED_WHILE_WAITING, type PathState, describePath, pathState, pathStates } from "./consent-plan.js";
import { aliasedLayoutMessage } from "./layout-rule.js";
import { agentDirOf } from "./paths.js";
import { type CliDeps, UsageError, bridgeConfigDir, errorMessage, homeOf, isTTYOf, platformOf, spawnInteractiveOf, spawnQuietOf } from "./deps.js";

/** The agents whose login bridge keeps in its own folder. */
export const AGENT_NAMES = ["claude", "codex"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/** `claude -> "claude-code"`, `codex -> "codex-cli"`. */
export const AGENT_IDS: Record<AgentName, AgentId> = { claude: "claude-code", codex: "codex-cli" };

const USAGE = "usage: bridge agent login <claude|codex> [--copy | --login] [--yes] | bridge agent logout <claude|codex> | bridge agent install <claude|codex> [--yes] | bridge agent status [--json]";

/** The agent an adapter belongs to (`createDefaultAgentAdapters` ids), if it is one that keeps a login. */
export function agentNameOfAdapter(adapterId: string): AgentName | undefined {
  return (AGENT_NAMES as readonly string[]).includes(adapterId) ? (adapterId as AgentName) : undefined;
}

export { agentDirOf };

/**
 * Whether the agent's own command (`claude`, `codex`) is on `PATH` (the injected env's): the agent is installed on this
 * machine, so `bridge setup` offers bridge's adapter and a sign-in for it. Its own sign-in runs this command.
 */
export function agentOnPath(deps: CliDeps, agent: AgentName): boolean {
  for (const dir of (deps.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, agent);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return true;
    } catch {
      // not here
    }
  }
  return false;
}

/** The login file inside `agentDirOf`: claude's `.credentials.json`, codex's `auth.json`. The only login the runner stages. */
export function agentLoginFileOf(deps: CliDeps, agent: AgentName): string {
  return path.join(agentDirOf(deps, agent), agent === "claude" ? ".credentials.json" : "auth.json");
}

/** The agents' dir (parent of each agent's folder), listed by `setup --plan`. */
export function agentsDirOf(deps: CliDeps): string {
  return path.join(bridgeConfigDir(deps), "agents");
}

/**
 * bridge's note of how the login in an agent's folder was made, next to it: `bridge-login.json`,
 * `{"source": "copy" | "login", "at": <ISO time>}`. Only a `login` (the agent's own sign-in, run by
 * bridge) is bridge's own grant to sign out; a `copy` shares the person's own sign-in. The runner
 * never stages it (it stages only the login file).
 */
export const LOGIN_SIDECAR = "bridge-login.json";
export type LoginSource = "copy" | "login";

export function loginSidecarOf(deps: CliDeps, agent: AgentName): string {
  return path.join(agentDirOf(deps, agent), LOGIN_SIDECAR);
}

/** The source a sidecar names; undefined when there is none, it is not a regular file, or it names no known source. */
export async function loginSourceAt(file: string): Promise<LoginSource | undefined> {
  const info = await lstat(file).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as { source?: unknown } | null;
    return value?.source === "copy" || value?.source === "login" ? value.source : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the sidecar into the agent's (canonical) folder, after the login it describes landed. */
async function writeLoginSource(dir: string, source: LoginSource): Promise<void> {
  await writeLoginFile(path.join(dir, LOGIN_SIDECAR), `${JSON.stringify({ source, at: new Date().toISOString() })}\n`);
}

/** One top-level entry of an agent's folder in bridge: its name and kind (a symlink is never followed). */
export interface AgentDirEntry {
  name: string;
  kind: "file" | "dir" | "symlink" | "other";
}

/**
 * The top level of the agent's folder in bridge (names and kinds, sorted), or `[]` when it is not a
 * real folder. The agent's own login writes whatever it keeps there (claude: its login, settings and
 * folders such as `backups/`), so the plan binds the whole listing rather than a list of file names,
 * and any top-level symlink is refused: the agent would write through it.
 */
async function agentDirEntriesOf(dir: PathState): Promise<AgentDirEntry[]> {
  if (dir.kind !== "dir") return [];
  const entries = await readdir(dir.canonical, { withFileTypes: true });
  return entries
    .map((e) => ({ name: e.name, kind: e.isSymbolicLink() ? "symlink" : e.isDirectory() ? "dir" : e.isFile() ? "file" : "other" }) as AgentDirEntry)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** What staging would stage: the runner's `agentLoginPresent` with bridge's sources (no symlinks, apart from the agents' own folders). */
export async function agentLoginIsPresent(deps: CliDeps, agent: AgentName): Promise<boolean> {
  return agentLoginPresent(AGENT_IDS[agent], agentLoginFileOf(deps, agent), { homedir: homeOf(deps), env: deps.env });
}

/**
 * How a login step ended: `done` (a usable login is in bridge's folder), `declined` (the person
 * said no), `missing` (nothing to copy: no login at the source; not an error of bridge's) or
 * `failed` (an operational failure, said why).
 */
export type LoginOutcome = "done" | "declined" | "missing" | "failed";

/** `yes` answers the question; otherwise the person is asked, and an empty answer means `fallback`. */
const asked = (deps: CliDeps, question: string, yes: boolean, fallback: "yes" | "no" = "no"): Promise<boolean> =>
  yes ? Promise.resolve(true) : deps.confirm(question, { default: fallback });

/** Atomic private write: 0700 dir, temp file 0600, rename. */
async function writeLoginFile(file: string, contents: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, contents, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * What a login step consents to (consent-plan.ts, Rule B): the agents folder, the agent's folder and
 * the login files it writes, each as a `PathState` (canonical path and kind). Computed before the
 * question and once more after it; the step writes only if the two are equal, and then only to the
 * bound canonical paths.
 */
export interface LoginPlan {
  /** The agents folder, the agent's folder, then the login file. */
  states: PathState[];
  /** The agent's folder's top level, names and kinds (`agentDirEntriesOf`). */
  entries: AgentDirEntry[];
  /** The sidecar (`bridge-login.json`) with its hash: an edit during the question changes the plan. */
  sidecar: PathState;
  /** The protected folders (runner `resolvedAgentOwnDirs`), bound too: a retarget during the question changes the plan. */
  owns: ProtectedDir[];
  /** `--copy` only: the source login's canonical path and kind (where a link leads), not its contents. */
  source?: PathState;
}

export async function loginPlanOf(deps: CliDeps, agent: AgentName, files: string[], source?: string): Promise<LoginPlan> {
  const states = await pathStates([agentsDirOf(deps), agentDirOf(deps, agent), ...files]);
  const plan: LoginPlan = {
    states,
    entries: await agentDirEntriesOf(states[1]!),
    sidecar: await pathState(loginSidecarOf(deps, agent), { hash: true }),
    owns: await resolvedAgentOwnDirs({ homedir: homeOf(deps), env: deps.env }),
  };
  if (source !== undefined) plan.source = await pathState(source);
  return plan;
}

/**
 * Why the plan may not be written, if so: something unresolvable, a folder that is a symlink or not
 * a folder, a login file that is a symlink or not a regular file, any symlink at the top of the
 * agent's folder, or Rule A: the agents folder or
 * the agent's folder is equal to, inside, or contains a protected folder (an ancestor such as the
 * config dir may be a symlink, but not into those; an unresolvable protected folder is refused).
 */
export function loginPlanProblem(agent: AgentName, plan: LoginPlan): string | undefined {
  const [agentsDir, agentDir, ...files] = plan.states as [PathState, PathState, ...PathState[]];
  for (const s of [agentsDir, agentDir]) {
    if (s.kind === "missing" || s.kind === "dir") continue;
    if (s.kind === "symlink") return `${s.path} is a symlink; bridge keeps its logins in real folders of its own and will not write through it. Remove the link and run \`bridge agent login ${agent}\` again.`;
    return `${describePath(s)} is not a folder bridge can keep a login in; run \`bridge agent login ${agent}\` once it is.`;
  }
  for (const s of files) {
    if (s.kind === "missing" || s.kind === "file") continue;
    if (s.kind === "symlink") return `${s.path} is a symlink; the ${agent} login would write through it. Remove it and run \`bridge agent login ${agent}\` again.`;
    return `${describePath(s)} is not a regular file; the ${agent} login would write through it. Remove it and run \`bridge agent login ${agent}\` again.`;
  }
  const link = plan.entries.find((e) => e.kind === "symlink");
  if (link !== undefined) {
    return `${path.join(agentDir.path, link.name)} is a symlink in bridge's ${agent} folder; ${agent} writes whatever it keeps there and would write through it. Remove it and run \`bridge agent login ${agent}\` again.`;
  }
  const overlap = agentOwnDirOverlap([agentsDir.canonical, agentDir.canonical], plan.owns);
  if (overlap !== undefined) {
    const named = overlap.dir === agentsDir.canonical ? agentsDir.path : agentDir.path;
    const own = `${overlap.own.path} (really ${overlap.own.real ?? "unresolvable: a link loop or a broken link"})`;
    return `${aliasedLayoutMessage([`${named} (really ${overlap.dir})`, own], `keep a ${agent} login in`)}. bridge never writes an agent's own folder: point bridge's config dir somewhere apart.`;
  }
  return undefined;
}

/** Rule B: the plan recomputed once after consent; a message when it changed (then nothing is written). */
async function changedAfterConsent(deps: CliDeps, agent: AgentName, files: string[], consented: LoginPlan, source?: string): Promise<string | undefined> {
  const now = await loginPlanOf(deps, agent, files, source);
  return isDeepStrictEqual(consented, now) ? undefined : `${agentDirOf(deps, agent)}: ${CHANGED_WHILE_WAITING}`;
}

/** The agent's own sign-out, redirected to bridge's folder like its login (`loginCommandOf`). */
export function logoutCommandOf(deps: CliDeps, agent: AgentName, dir: string): { command: string; args: string[]; env: Record<string, string> } {
  const login = loginCommandOf(deps, agent, dir);
  return { ...login, args: agent === "claude" ? ["auth", "logout"] : ["logout"] };
}

/** How long a sign-out with no terminal may take before it counts as failed. */
export const LOGOUT_TIMEOUT_MS = 30_000;

export type SignOutResult = { ok: true } | { ok: false; reason: "failed" | "missing"; detail: string };

/**
 * Runs the agent's own sign-out with its config folder set to bridge's (canonical) `dir`, with no
 * terminal: stdin closed, killed after `LOGOUT_TIMEOUT_MS`. `missing`: the agent's command is not
 * installed. Never claims more than that the command succeeded.
 */
export async function signOutQuietly(deps: CliDeps, agent: AgentName, dir: string): Promise<SignOutResult> {
  const { command, args, env } = logoutCommandOf(deps, agent, dir);
  const shown = [command, ...args].join(" ");
  try {
    const r = await spawnQuietOf(deps)(command, args, { env, timeoutMs: LOGOUT_TIMEOUT_MS });
    if (r.timedOut) return { ok: false, reason: "failed", detail: `\`${shown}\` did not finish within ${LOGOUT_TIMEOUT_MS / 1000} s` };
    if (r.exitCode !== 0) return { ok: false, reason: "failed", detail: `\`${shown}\` exited with ${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").slice(-2).join(" ")}` : ""}` };
    return { ok: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: "missing", detail: `\`${command}\` is not installed here` };
    return { ok: false, reason: "failed", detail: `could not run \`${shown}\`: ${errorMessage(error)}` };
  }
}

/** Whether the login in bridge's folder is one bridge made with the agent's own sign-in (and is still there). */
async function loginSourcedPresent(deps: CliDeps, agent: AgentName, plan: LoginPlan): Promise<boolean> {
  return (await loginSourceAt(plan.sidecar.canonical)) === "login" && (await agentLoginIsPresent(deps, agent));
}

/**
 * Before a copy or a login replaces a login bridge made with the agent's own sign-in, that one is
 * signed out (it is bridge's own grant). A message when that failed: then nothing is replaced.
 */
async function signOutBeforeReplacing(deps: CliDeps, agent: AgentName, plan: LoginPlan, was: boolean): Promise<string | undefined> {
  if (!was) return undefined;
  const r = await signOutQuietly(deps, agent, plan.states[1]!.canonical);
  if (r.ok) return undefined;
  return `signing out the ${agent} login bridge made before failed (${r.detail}); nothing was replaced. Run \`bridge agent logout ${agent}\` in a terminal, then this again.`;
}

const replacingLine = (deps: CliDeps, agent: AgentName, dir: string): string => {
  const { command, args } = logoutCommandOf(deps, agent, dir);
  return `bridge signs out the ${agent} login it made there first (\`${[command, ...args].join(" ")}\` with its config folder ${dir}; your own ${agent} sign-in is not touched); if that fails, nothing is replaced.\n`;
};

/**
 * Copies the person's current login into bridge's own folder, once. Prints the destination and the
 * shared-grant warning before it asks; `yes` answers that question (a path consent, not one of the
 * human-only steps). Reads the source, never writes it. Without `yes` it needs a terminal.
 */
export async function copyLogin(deps: CliDeps, agent: AgentName, options: { yes?: boolean; defaultYes?: boolean } = {}): Promise<LoginOutcome> {
  const id = AGENT_IDS[agent];
  const source = resolveAgentAuthFile(id, { homedir: homeOf(deps), env: deps.env });
  const dest = agentLoginFileOf(deps, agent);
  const plan = await loginPlanOf(deps, agent, [dest], source);
  const problem = loginPlanProblem(agent, plan);
  if (problem !== undefined) {
    deps.stderr(`bridge agent: ${problem}\n`);
    return "failed";
  }
  // Read here only to know there is something to copy; the copy itself is read after consent.
  if ((await exportAgentLogin(id, { homedir: homeOf(deps), env: deps.env })) === undefined) {
    deps.stderr(
      `bridge agent: no ${agent} login found at ${source}.\n` +
        (platformOf(deps) === "darwin" && agent === "claude"
          ? "On macOS Claude Code may keep the login in the Keychain, which cannot be copied here: use `bridge agent login claude --login`.\n"
          : `Sign in with ${agent} first, or use \`bridge agent login ${agent} --login\`.\n`),
    );
    return "missing";
  }
  deps.stdout(
    `This copies your current ${agent} login into bridge's own folder, once. Both copies share one grant: if either side refreshes and the provider rotates the token, the other may be signed out (your terminal agent included).\n` +
      `  from: ${source} (read only)\n  to:   ${describePath(plan.states[2]!)}${(await agentLoginPresent(id, dest)) ? " (replaces the login already there)" : ""}\n`,
  );
  const replacesOwn = await loginSourcedPresent(deps, agent, plan);
  if (replacesOwn) deps.stdout(replacingLine(deps, agent, plan.states[1]!.canonical));
  if (options.yes !== true && !isTTYOf(deps)) {
    throw new UsageError(`copying a login needs a terminal to ask in; pass --yes once the person agreed to the paths above`);
  }
  if (!(await asked(deps, `Copy your ${agent} login into bridge's folder?`, options.yes === true, options.defaultYes ? "yes" : "no"))) return "declined";
  // Rule B: once more after consent, right before the first write; then only the bound canonical path is written.
  const late = await changedAfterConsent(deps, agent, [dest], plan, source);
  if (late !== undefined) {
    deps.stderr(`bridge agent: ${late}\n`);
    return "failed";
  }
  const notReplaced = await signOutBeforeReplacing(deps, agent, plan, replacesOwn);
  if (notReplaced !== undefined) {
    deps.stderr(`bridge agent: ${notReplaced}\n`);
    return "failed";
  }
  // The source path is bound (plan.source), its contents are not: a login refreshed or switched while the question was open is still "your current login".
  const login = await exportAgentLogin(id, { homedir: homeOf(deps), env: deps.env });
  if (login === undefined) {
    deps.stderr(`bridge agent: the ${agent} login at ${source} went away while waiting for confirmation; nothing was copied.\n`);
    return "missing";
  }
  try {
    await writeLoginFile(plan.states[2]!.canonical, login);
    await writeLoginSource(plan.states[1]!.canonical, "copy");
  } catch (error) {
    deps.stderr(`bridge agent: could not write ${dest}: ${errorMessage(error)}\n`);
    return "failed";
  }
  deps.stdout(`Copied the ${agent} login to ${dest}.\n`);
  return "done";
}

/** The command and env of an agent's own login, redirected to bridge's folder. */
function loginCommandOf(deps: CliDeps, agent: AgentName, dir: string): { command: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(deps.env)) if (v !== undefined) env[k] = v;
  return agent === "claude"
    ? { command: "claude", args: ["auth", "login"], env: { ...env, CLAUDE_CONFIG_DIR: dir } }
    : { command: "codex", args: ["login"], env: { ...env, CODEX_HOME: dir } };
}

/**
 * Runs the agent's own login with its config dir pointed at bridge's folder (the person's own
 * agent is never redirected: only this child is). Needs a terminal; `yes` answers the path consent.
 * Afterwards the login must be present in bridge's folder.
 */
export async function loginInBridgeFolder(deps: CliDeps, agent: AgentName, options: { yes?: boolean; defaultYes?: boolean; /** The caller (`setup`) listed this sign-in in its own consent: no description, no question. */ consented?: boolean } = {}): Promise<LoginOutcome> {
  if (!isTTYOf(deps)) throw new UsageError(`${agent} login is interactive and needs a terminal; run \`bridge agent login ${agent} --login\` in one`);
  const file = agentLoginFileOf(deps, agent);
  const files = [file];
  const plan = await loginPlanOf(deps, agent, files);
  const problem = loginPlanProblem(agent, plan);
  if (problem !== undefined) {
    deps.stderr(`bridge agent: ${problem}\n`);
    return "failed";
  }
  const dir = plan.states[1]!.canonical;
  const { command, args, env } = loginCommandOf(deps, agent, dir);
  const keeps = agent === "claude" ? "its login, settings and folders such as backups/" : "its login and settings";
  if (options.consented !== true) deps.stdout(
    `This runs \`${[command, ...args].join(" ")}\` with its config folder set to bridge's own: ${describePath(plan.states[1]!)}. ` +
      `${agent} writes whatever it keeps there (${keeps}) inside that folder and nothing outside it; your own ~/.${agent} is not touched.\n`,
  );
  const replacesOwn = await loginSourcedPresent(deps, agent, plan);
  if (replacesOwn) deps.stdout(replacingLine(deps, agent, dir));
  if (!(await asked(deps, `Sign in to ${agent} for bridge now?`, options.yes === true || options.consented === true, options.defaultYes ? "yes" : "no"))) return "declined";
  // Rule B: once more after consent, right before the first write; then only the bound canonical folder is used.
  const late = await changedAfterConsent(deps, agent, files, plan);
  if (late !== undefined) {
    deps.stderr(`bridge agent: ${late}\n`);
    return "failed";
  }
  const notReplaced = await signOutBeforeReplacing(deps, agent, plan, replacesOwn);
  if (notReplaced !== undefined) {
    deps.stderr(`bridge agent: ${notReplaced}\n`);
    return "failed";
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  let code: number;
  try {
    code = await spawnInteractiveOf(deps)(command, args, { env });
  } catch (error) {
    deps.stderr(`bridge agent: could not run \`${command}\`: ${errorMessage(error)}\n`);
    return "failed";
  }
  if (code !== 0) {
    deps.stderr(`bridge agent: \`${[command, ...args].join(" ")}\` exited with ${code}.\n`);
    return "failed";
  }
  if (!(await agentLoginPresent(AGENT_IDS[agent], file, { homedir: homeOf(deps), env: deps.env }))) {
    deps.stderr(
      `bridge agent: the login did not land in ${file}; on macOS Claude Code may have stored it in the Keychain, which bridge's sandbox cannot stage (open check, see the hand-in)\n`,
    );
    return "failed";
  }
  try {
    await writeLoginSource(dir, "login");
  } catch (error) {
    deps.stderr(`bridge agent: the login is in ${file}, but its note ${LOGIN_SIDECAR} could not be written (${errorMessage(error)}); bridge uninstall will not sign it out\n`);
    return "failed";
  }
  deps.stdout(`Signed in: the ${agent} login is in ${file}.\n`);
  return "done";
}

/**
 * The two questions, in this order: copy the current login (with its path and warning), then the
 * agent's own login. A "done" to the first skips the second. With no current login to copy
 * (`missing`: said where it looked) the first question has no answer to give, so the second is
 * still asked. Takes no `yes`: `--yes` never answers the choice between copying and signing in
 * (only an explicit `--copy --yes` or `--login --yes` consents to that one path). Needs a terminal.
 * Declining both, or having nothing to copy and declining the login, is not a failure.
 * Both questions default to yes (copying is the default, the separate sign-in
 * the alternative); an explicit `--copy` or `--login` alone keeps a "no" default.
 */
export async function offerAgentLogin(deps: CliDeps, agent: AgentName): Promise<LoginOutcome | "skipped"> {
  const copied = await copyLogin(deps, agent, { defaultYes: true });
  if (copied === "done") return "done";
  if (copied === "failed") return "failed"; // already said why (e.g. a symlinked folder); the login would hit the same wall
  const login = await loginInBridgeFolder(deps, agent, { defaultYes: true });
  if (login === "done") return "done";
  if (login === "declined") {
    deps.stdout(`No ${agent} login for bridge yet. Later: \`bridge agent login ${agent}\`.\n`);
    return "skipped";
  }
  return "failed";
}

/**
 * `bridge agent logout <agent>`: signs out the login bridge made with the agent's own sign-in
 * (`claude auth logout` / `codex logout` with its config folder set to bridge's). Interactive on a
 * terminal, else with stdin closed and a timeout. A copied login, or one with no note of how it was
 * made, is refused: it may share the person's own sign-in, which this would sign out too.
 */
export async function logoutAgent(deps: CliDeps, agent: AgentName): Promise<number> {
  const plan = await loginPlanOf(deps, agent, [agentLoginFileOf(deps, agent)]);
  const problem = loginPlanProblem(agent, plan);
  if (problem !== undefined) {
    deps.stderr(`bridge agent: ${problem}\n`);
    return 1;
  }
  const folder = plan.states[1]!;
  if (folder.kind === "missing" || !(await agentLoginIsPresent(deps, agent))) {
    deps.stdout(`No ${agent} login in bridge's folder (${folder.path}); nothing to sign out.\n`);
    return 0;
  }
  const source = await loginSourceAt(plan.sidecar.canonical);
  if (source !== "login") {
    deps.stderr(
      source === "copy"
        ? `bridge agent: the ${agent} login in ${folder.path} is a copy of your own ${agent} sign-in; signing it out would sign out yours too, so bridge does not. \`bridge uninstall\` deletes the copy.\n`
        : `bridge agent: there is no note (${LOGIN_SIDECAR}) of how the ${agent} login in ${folder.path} was made; it may be a copy of your own sign-in, so bridge does not sign it out.\n`,
    );
    return 1;
  }
  const { command, args, env } = logoutCommandOf(deps, agent, folder.canonical);
  const shown = [command, ...args].join(" ");
  deps.stdout(`Signing out the ${agent} login bridge made: \`${shown}\` with its config folder ${folder.canonical} (your own ${agent} sign-in is not touched).\n`);
  if (isTTYOf(deps)) {
    let code: number;
    try {
      code = await spawnInteractiveOf(deps)(command, args, { env });
    } catch (error) {
      deps.stderr(`bridge agent: could not run \`${command}\`: ${errorMessage(error)}\n`);
      return 1;
    }
    if (code !== 0) {
      deps.stderr(`bridge agent: \`${shown}\` exited with ${code}.\n`);
      return 1;
    }
  } else {
    const r = await signOutQuietly(deps, agent, folder.canonical);
    if (!r.ok) {
      deps.stderr(`bridge agent: ${r.detail}.\n`);
      return 1;
    }
  }
  deps.stdout(`\`${shown}\` finished.\n`);
  return 0;
}

function agentOf(name: string | undefined): AgentName {
  if (name === "claude" || name === "codex") return name;
  throw new UsageError(USAGE);
}

/** `bridge agent login <claude|codex> [--copy | --login] [--yes]`, `bridge agent install <claude|codex> [--yes]` and `bridge agent status [--json]`. */
export async function runAgent(args: string[], deps: CliDeps): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "status") {
    const { values, positionals } = parse(rest, { json: { type: "boolean" } });
    if (positionals.length > 0) throw new UsageError(USAGE);
    for (const agent of AGENT_NAMES) {
      const present = await agentLoginIsPresent(deps, agent);
      const file = agentLoginFileOf(deps, agent);
      deps.stdout(values.json ? `${JSON.stringify({ agent, present, file })}\n` : `${agent}: ${present ? "present" : "absent"} (${file})\n`);
    }
    return 0;
  }
  if (sub === "install") return runAdapterInstall(rest, deps);
  if (sub === "logout") {
    const { positionals } = parse(rest, {});
    if (positionals.length !== 1) throw new UsageError(USAGE);
    return logoutAgent(deps, agentOf(positionals[0]));
  }
  if (sub !== "login") throw new UsageError(USAGE);
  const { values, positionals } = parse(rest, { copy: { type: "boolean" }, login: { type: "boolean" }, yes: { type: "boolean" } });
  if (positionals.length !== 1) throw new UsageError(USAGE);
  const agent = agentOf(positionals[0]);
  if (values.copy && values.login) throw new UsageError("--copy and --login exclude each other");
  const yes = values.yes === true;
  if (values.copy) return outcomeCode(await copyLogin(deps, agent, { yes }));
  if (values.login) return outcomeCode(await loginInBridgeFolder(deps, agent, { yes }));
  // `--yes` alone answers nothing here: it never picks between copying and signing in.
  if (!isTTYOf(deps)) throw new UsageError(`without a terminal, choose how: bridge agent login ${agent} --copy (copy your current login) or --login (sign in again)`);
  const result = await offerAgentLogin(deps, agent);
  return result === "failed" ? 1 : 0;
}

/** An explicit `--copy`/`--login` that could not do what was asked (nothing to copy, or a failure) exits 1; a "no" exits 0. */
const outcomeCode = (outcome: LoginOutcome): number => (outcome === "failed" || outcome === "missing" ? 1 : 0);
