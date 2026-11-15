import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { clearTokens } from "@berdyh/bridge-pairing";
import { RemoveRefused, planPaths, removeBound, runnerStatusPath, uninstallService, wrapKeyNameOf, type ManifestEntry, type ServicePlan } from "@berdyh/bridge-runner";

import { type AgentName, type LoginPlan, type LoginSource, AGENT_NAMES, agentLoginFileOf, agentLoginIsPresent, loginPlanOf, loginPlanProblem, loginSourceAt, logoutCommandOf, signOutQuietly } from "./agent.js";
import { parse } from "./args.js";
import { type LayoutSnapshot, aliasedLayoutMessage, appDirsOf, assertNotABase, layoutOf, layoutSnapshot } from "./layout-rule.js";
import { legacyErrorOf } from "./legacy.js";
import { removeAppFolders } from "./app-removal.js";
import { appPathsOf } from "./paths.js";
import { type PathState, assertUnchanged, describePath, pathState, pathStates } from "./consent-plan.js";
import { type AppRecord, type AppsRead, appsFilePath, discoverAppFiles, isLocalApp, readApps, removeApp, tokenKey } from "./config.js";
import { type CliDeps, UsageError, bridgeConfigDir, credentialStoreWhere, credentialsOf, errorMessage, homeOf, platformOf, runnerOf } from "./deps.js";
import { baseDirsOf, launchdUid, manifestFor } from "./doctor.js";
import {
  type ProtocolUninstallPlan,
  mimeappsLabel,
  protocolHandlerFiles,
  protocolHandlerPaths,
  protocolUninstallPlan,
  uninstallProtocolHandler,
} from "./protocol-handler.js";
import { type LauncherState, installPathsOf, isInside, launcherLinksOf, launcherStateOf } from "./self.js";
import { resolveServicePlan, servicePlanOf, serviceFs } from "./service.js";

export interface UninstallRun {
  /** `--yes`: skip the question. The manifest is still printed. */
  yes?: boolean;
}

export interface UninstallResult {
  /** `refused`: an aliased layout (rule A), nothing was changed. */
  outcome: "removed" | "cancelled" | "refused";
  /** The manifest paths that were removed (those that existed). */
  removed: string[];
  /** What could not be removed or undone; the exit code is 1 when there is any. */
  failures: string[];
}

/** Whether the process in `runner.json` is still alive (a foreground `bridge run`). */
async function runningRunnerPid(deps: CliDeps): Promise<number | undefined> {
  try {
    const status = JSON.parse(await readFile(runnerStatusPath(installPathsOf(deps)), "utf8")) as { pid?: unknown };
    if (typeof status.pid !== "number" || !Number.isInteger(status.pid) || status.pid <= 0) return undefined;
    process.kill(status.pid, 0);
    return status.pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? -1 : undefined;
  }
}

/**
 * The main pid of the installed background service, when it runs: `systemctl --user show -p
 * MainPID --value` (Linux) or the `pid = N` of `launchctl print` (macOS). Undefined when the
 * service file is not there, it is not running, or the command fails.
 */
async function serviceMainPid(deps: CliDeps): Promise<number | undefined> {
  const paths = installPathsOf(deps);
  if (!(await lstat(paths.serviceFile).then(() => true, () => false))) return undefined;
  try {
    if (platformOf(deps) === "linux") {
      const r = await runnerOf(deps)("systemctl", ["--user", "show", "-p", "MainPID", "--value", paths.serviceName]);
      const pid = r.exitCode === 0 ? Number(r.stdout.trim()) : NaN;
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    }
    const r = await runnerOf(deps)("launchctl", ["print", `gui/${launchdUid()}/${paths.serviceName}`]);
    const m = r.exitCode === 0 ? /^\s*pid = (\d+)\s*$/m.exec(r.stdout) : null;
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The manifest entries uninstall removes by itself: owned by us, not handled by the service or
 * handler uninstall or the launcher check, and not inside another such entry (removing the outer
 * dir covers it, and a nested path is never reached through whatever sits in the outer dir).
 */
export function removableEntries(entries: readonly ManifestEntry[], deps: CliDeps): ManifestEntry[] {
  const handler = new Set(protocolHandlerPaths(deps).map((e) => e.path));
  const own = entries.filter((e) => e.removeOnUninstall && e.role !== "service" && e.role !== "launcher" && e.role !== "external" && !handler.has(e.path));
  return own.filter((e) => !own.some((o) => o !== e && isInside(o.path, e.path)));
}

/** A removal that cannot be resolved is refused. */
function resolvable(s: PathState): void {
  if (s.kind === "unresolvable") throw new Error(`${s.path} cannot be resolved (${s.error}); left alone`);
}

/** The service files uninstall removes (not its dirs), resolved; or why they cannot be. */
async function serviceRemovalOf(deps: CliDeps): Promise<{ exec: ServicePlan; states: PathState[] } | { error: string }> {
  try {
    const { exec, states } = await resolveServicePlan(servicePlanOf(deps), "uninstall");
    const removed = new Set(planPaths(exec).filter((p) => !exec.dirs.includes(p)));
    return { exec, states: states.filter((s) => removed.has(s.canonical)) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function handlerPlanOf(deps: CliDeps): Promise<ProtocolUninstallPlan | { error: string } | undefined> {
  if (platformOf(deps) !== "linux") return undefined;
  try {
    return await protocolUninstallPlan(deps);
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

/**
 * The connected apps as the consent showed them: `apps.json` (kind, hash), the ids it lists, the
 * records read from each app's `app.json`, and the listed apps without a usable record, in two kinds.
 * This is the one classification both the consent and the execution read.
 *  - `absent`: nothing at all at the canonical `app.json` (`pathState(...).kind === "missing"`): a half
 *    removal, by bridge (which deletes the keychain items first and `app.json` last of the app's files) or
 *    by hand. Its folders are removed by its id's paths alone and its `apps.json` entry pruned, so a retry
 *    always finishes; only its token can be named.
 *  - `broken`: there is something at `app.json` that is not a valid record (unreadable, corrupt, the
 *    wrong kind, a dangling link). Its runner id, which names the identity's wrapping key, is unknown,
 *    so its config dir and `apps.json` are kept for the person to fix.
 */
interface AppsBinding {
  file: PathState;
  listed: string[];
  apps: AppRecord[];
  absent: string[];
  broken: AppsRead["broken"];
  error?: string;
}

async function appsBindingOf(deps: CliDeps): Promise<AppsBinding> {
  const file = await pathState(appsFilePath(deps), { hash: true });
  const { listed, apps, broken: unusable, error } = await readApps(deps);
  const absent: string[] = [];
  const broken: AppsRead["broken"] = [];
  for (const b of unusable) {
    if ((await pathState(appPathsOf(deps, b.appId).appFile)).kind === "missing") absent.push(b.appId);
    else broken.push(b);
  }
  return { file, listed: listed.map((a) => a.appId), apps, absent, broken, ...(error !== undefined && { error }) };
}

/** The launcher's state without `dangling`, which says nothing about what is removed. */
function launcherKey(l: LauncherState): LauncherState | { kind: "ours"; target: string } {
  return l.kind === "ours" ? { kind: l.kind, target: l.target } : l;
}

/**
 * Everything `bridge uninstall` consents to, fully resolved (see consent-plan.ts): per step the
 * canonical paths, kinds and contents it acts on. The plan is recomputed once after consent and
 * nothing runs if it differs (rule B); the steps are not re-gated, and each removal re-resolves
 * its parent through `removeBound`.
 */
interface UninstallPlan {
  /** The fully resolved base dirs (rule A); never changed by any step. */
  layout: LayoutSnapshot;
  apps: AppsBinding;
  service: Awaited<ReturnType<typeof serviceRemovalOf>>;
  /** The apps' parents (`<config>/<app>` and the other two): removed only when empty, and only as a real folder. */
  parents: PathState[];
  handler: Awaited<ReturnType<typeof handlerPlanOf>>;
  /** Each launcher link (`bridge`, `bridge-runner`), by path: what it was when bound and its place. */
  launchers: { link: string; state: ReturnType<typeof launcherKey>; at: PathState }[];
  entries: PathState[];
  /** The agents' logins in bridge's folder that uninstall deletes, with how each was made (the sidecar, hashed). */
  logins: LoginBinding[];
}

/**
 * One agent's login in bridge's folder, as uninstall binds it: the whole login plan (the folder's
 * kind and canonical path, its top-level entries, the sidecar with its hash, the protected agent
 * folders), what the sidecar says, and why it cannot be trusted if so. A folder that is a symlink
 * (into ~/.claude, say), holds a top-level symlink or overlaps an agent's own folder is never signed
 * out: `problem` says why, and `source` is then undefined whatever the sidecar claims.
 */
interface LoginBinding {
  agent: AgentName;
  plan: LoginPlan;
  dir: PathState;
  source: LoginSource | undefined;
  problem?: string;
}

/** The agents with a login (or a folder that cannot be trusted) in bridge's folder; none when `<config>/bridge` is kept anyway. */
async function loginBindingsOf(deps: CliDeps, binding: AppsBinding): Promise<LoginBinding[]> {
  if (keepsConfig(binding)) return [];
  const out: LoginBinding[] = [];
  for (const agent of AGENT_NAMES) {
    const plan = await loginPlanOf(deps, agent, [agentLoginFileOf(deps, agent)]);
    const dir = plan.states[1]!;
    if (dir.kind === "missing") continue;
    const problem = loginPlanProblem(agent, plan);
    if (problem !== undefined) {
      out.push({ agent, plan, dir, source: undefined, problem });
      continue;
    }
    if (!(await agentLoginIsPresent(deps, agent).catch(() => false))) continue;
    out.push({ agent, plan, dir, source: await loginSourceAt(plan.sidecar.canonical) });
  }
  return out;
}

/** Whether `p` is at or inside `dir`. */
function atOrInside(dir: string, p: string): boolean {
  return path.resolve(p) === path.resolve(dir) || isInside(dir, p);
}

/** Where the credentials live, for a message: `credentialStoreWhere`, or a neutral phrase when the setting is invalid (a message must not throw). */
function storeNameOf(deps: CliDeps): string {
  try {
    return credentialStoreWhere(deps);
  } catch {
    return "the credential store";
  }
}

/** Entries at or inside `<config>/bridge`: kept when the apps' credential items could not be forgotten. */
function inConfig(deps: CliDeps, p: string): boolean {
  return atOrInside(bridgeConfigDir(deps), p);
}

/**
 * Whether the keychain items of some app cannot all be forgotten before anything is removed:
 * `apps.json` is unreadable, or a listed app's `app.json` is broken (its runner id, which names the
 * identity's wrapping key, is unknown). `<config>/bridge` (with `apps.json`) is then kept for a second run.
 * An absent record (a half removal) is not broken: it keeps nothing.
 */
function keepsConfig(binding: AppsBinding): boolean {
  return binding.error !== undefined || binding.broken.length > 0;
}

/** The `bridge/` config dir of each app whose record is broken: kept with its `app.json`, whatever else is removed. */
function brokenConfigDirs(deps: CliDeps, binding: AppsBinding): string[] {
  return binding.broken.map((b) => appPathsOf(deps, b.appId).configDir);
}

async function uninstallPlanOf(deps: CliDeps, binding: AppsBinding, manifest: ManifestEntry[]): Promise<UninstallPlan> {
  const kept = brokenConfigDirs(deps, binding);
  const entries = removableEntries(manifest, deps).filter((e) => !(keepsConfig(binding) && inConfig(deps, e.path)) && !kept.some((d) => atOrInside(d, e.path)));
  return {
    layout: await layoutSnapshot(deps),
    apps: binding,
    service: await serviceRemovalOf(deps),
    parents: await pathStates(binding.listed.flatMap((id) => {
      const p = appPathsOf(deps, id).parents;
      return [p.config, p.data, p.state];
    })),
    handler: await handlerPlanOf(deps),
    // The link itself is bound (its place, kind and text), not whether its target still exists:
    // removing the versions dir changes that and nothing about what is removed.
    launchers: await Promise.all(
      launcherLinksOf(deps).map(async (link) => ({ link, state: launcherKey(await launcherStateOf(deps, link)), at: { ...(await pathState(link)), target: undefined } })),
    ),
    entries: await pathStates(entries.map((e) => e.path)),
    logins: await loginBindingsOf(deps, binding),
  };
}

/** The consent lines of the handler's two files, from its resolved plan. */
function handlerLines(deps: CliDeps, handler: UninstallPlan["handler"]): string[] {
  if (handler === undefined) return [];
  const files = protocolHandlerFiles(deps);
  if ("error" in handler) {
    return [`  ${files.desktopFile}, ${files.mimeapps}  (the bridge:// handler; it will be left alone: ${handler.error})`];
  }
  const lines: string[] = [];
  if (handler.desktop.exists) lines.push(`  ${handler.desktop.path}  (file: bridge:// URL handler (desktop entry))`);
  if (handler.stripped !== undefined) {
    lines.push(`  ${mimeappsLabel(files.mimeapps, handler.target)}  (edited: only our bridge:// lines are removed, every other line is kept)`);
  }
  // A mimeapps.list with no bridge:// lines (or none at all) is not touched, so it is not listed as removed.
  return lines;
}

/**
 * Removes exactly the manifest (`doctor --paths`): after one consent that lists every path, it
 * stops and removes the service, forgets each app's credentials and keys, takes the `bridge://`
 * handler out (only our lines in `mimeapps.list`), removes the launcher link if it points into
 * our versions dir, then the install, config and state dirs. Nothing outside the manifest is
 * touched; a symlink in the manifest is unlinked and its target left alone. Every step acts on
 * the canonical paths the consent showed. An aliased layout is refused before the question
 * (rule A); the plan is recomputed once after it and nothing runs if it changed (rule B). Every
 * removal goes through removeBound, and one it refuses stops the uninstall. The order keeps a
 * retry possible after any failure (an index entry is removed only after everything it lists is
 * gone): every app's keychain items first, and if one fails no file or folder is removed; then per
 * app its folders with its `app.json` last; then `apps.json` and the machine-level paths (the
 * handler, the launcher, bridge's own dirs) only once every app has finished. An app that did not
 * finish keeps its `app.json` and its `apps.json` entry; the finished ones leave `apps.json`.
 */
export async function uninstall(deps: CliDeps, run: UninstallRun = {}): Promise<UninstallResult> {
  // An older layout is not in this manifest: refuse and list it rather than leave it behind.
  const legacy = await legacyErrorOf(deps);
  if (legacy) {
    deps.stderr(`bridge uninstall: ${legacy.message}; nothing was changed\n`);
    return { outcome: "refused", removed: [], failures: [legacy.message] };
  }
  // The plan is the one snapshot everything reads: the consent text (removed, kept, half removed, broken) and
  // the execution come from it, and the one recompute after the question compares it whole, the apps'
  // classification included. No earlier read of the apps feeds the text.
  const planNow = async (): Promise<UninstallPlan> => {
    const binding = await appsBindingOf(deps);
    return uninstallPlanOf(deps, binding, manifestFor(deps, binding.listed));
  };
  const plan = await planNow();
  const binding = plan.apps;
  const { apps, error: appsError } = binding;
  const manifest = manifestFor(deps, binding.listed);
  const handlerFiles = new Set(protocolHandlerPaths(deps).map((e) => e.path));
  const removable = removableEntries(manifest, deps);

  // Rule A: an aliased or overlapping layout is refused whole, before the question.
  const layout = await layoutOf(deps);
  if (layout.overlap !== undefined) {
    const message = aliasedLayoutMessage(layout.overlap, "remove");
    deps.stderr(
      `bridge uninstall: ${message}.\nRemove these by hand (each is a bridge path; check where each really leads first):\n${[
        ...removable.map((e) => e.path),
        ...launcherLinksOf(deps),
        ...servicePlanOf(deps).files.map((f) => f.path),
        ...protocolHandlerPaths(deps).filter((e) => e.removeOnUninstall).map((e) => e.path),
      ]
        .map((p) => `  ${p}`)
        .join("\n")}\nand the bridge lines in ${protocolHandlerFiles(deps).mimeapps}, and the apps' items in ${storeNameOf(deps)}.\n`,
    );
    return { outcome: "refused", removed: [], failures: [message] };
  }

  const bridgeDir = bridgeConfigDir(deps);
  const entryState = new Map(plan.entries.map((s) => [s.path, s]));
  const failures: string[] = [];

  const lines: string[] = [];
  const insideLink: string[] = [];
  for (const e of manifest) {
    if (handlerFiles.has(e.path) || e.role === "external") continue;
    if (e.role === "launcher") {
      const bound = plan.launchers.find((l) => l.link === e.path);
      if (bound?.state.kind === "ours") {
        // The plan binds the link, not whether its target exists (see uninstallPlanOf): the label
        // reads that once more, for display only, so a live launcher is not shown as dangling.
        const shown = await launcherStateOf(deps, bound.link);
        const target = shown.kind === "ours" && !shown.dangling ? shown.target : null;
        lines.push(`  ${describePath({ ...bound.at, target })}  (${e.description}; removed because it points into ${installPathsOf(deps).versionsDir})`);
      }
      continue;
    }
    if (keepsConfig(binding) && inConfig(deps, e.path)) continue;
    if (brokenConfigDirs(deps, binding).some((d) => atOrInside(d, e.path))) continue;
    if (!e.removeOnUninstall) continue;
    // Only what is there is listed (as the handler's files are): an absent entry is nothing to remove. A bound entry
    // answers from the plan; one inside it (removed with it) is looked at for display only.
    const state = entryState.get(e.path);
    // One inside an entry that is a link: the link is unlinked as a leaf, and what it leads to stays.
    if (state === undefined && plan.entries.some((o) => o.kind === "symlink" && isInside(o.path, e.path))) {
      if (await lstat(e.path).then(() => true, () => false)) insideLink.push(`  ${e.path}  (inside a link; left alone)`);
      continue;
    }
    if (state ? state.kind === "missing" : !(await lstat(e.path).then(() => true, () => false))) continue;
    lines.push(`  ${state ? describePath(state) : e.path}  (${e.kind}: ${e.description})`);
  }
  lines.push(...handlerLines(deps, plan.handler));
  deps.stdout(lines.length > 0 ? `These paths will be removed:\n${lines.join("\n")}\n` : "These paths will be removed: none (no file or folder of bridge's is here).\n");
  if (insideLink.length > 0) deps.stdout(`Not removed, only the link they sit behind is:\n${insideLink.join("\n")}\n`);
  if (plan.parents.length > 0) {
    deps.stdout(`Removed only if empty (each is an app's own folder; bridge never removes anything else in it, and a link stays):\n${plan.parents.map((s) => `  ${describePath(s)}`).join("\n")}\n`);
  }
  for (const l of plan.launchers) {
    if (l.state.kind === "foreign") deps.stdout(`Left alone: ${l.link} is not a bridge launcher (${l.state.detail}).\n`);
  }
  deps.stdout("Left alone: your coding agents' own login files (bridge never wrote them).\n");
  deps.stdout(`Left alone: ${path.join(homeOf(deps), ".npm")} (npm's cache).\n`);
  // A shared or system folder is never removed, even an empty one bridge setup created.
  const base = baseDirsOf(deps);
  deps.stdout(`Left alone: the shared folders bridge's files sit in (${[base.config, base.data, base.state, base.bin, path.join(homeOf(deps), ".cache")].join(", ")} and the like), even ones bridge setup created; only bridge's own entries inside them go.\n`);
  for (const l of plan.logins) {
    const { command, args } = logoutCommandOf(deps, l.agent, l.dir.canonical);
    if (l.source === "login") {
      deps.stdout(`Also: bridge signs out the ${l.agent} login it made (\`${[command, ...args].join(" ")}\` with its config folder ${l.dir.canonical}; your own ${l.agent} sign-in is not touched). If that fails, bridge's login folder is kept so you can retry.\n`);
    } else if (l.source === "copy") {
      deps.stdout(`Deleted here only: your copied ${l.agent} login. It shares your own sign-in, which is kept, so bridge does not sign it out.\n`);
    } else if (l.problem !== undefined) {
      deps.stderr(`bridge uninstall: there is no note bridge can trust of how the ${l.agent} login in ${l.dir.path} was made (${l.problem}), so bridge does not sign it out; only bridge's own entry is removed (a link as the link itself).\n`);
    } else {
      deps.stderr(`bridge uninstall: there is no note (bridge-login.json) of how the ${l.agent} login in ${l.dir.path} was made, so bridge does not sign it out (it may be a copy of your own sign-in); it is deleted here only.\n`);
    }
  }
  const withCredentials = apps.filter((a) => !isLocalApp(a));
  if (withCredentials.length > 0) deps.stdout(`Also deleted from ${credentialStoreWhere(deps)}: the tokens and key wrapping keys of ${withCredentials.map((a) => a.appId).join(", ")}.\n`);
  if (appsError !== undefined) {
    const found = await discoverAppFiles(deps);
    deps.stderr(
      `bridge uninstall: ${appsError}; the credentials of the apps it lists cannot be removed from ${credentialStoreWhere(deps)}, so ${bridgeConfigDir(deps)} is kept: fix or restore apps.json and run bridge uninstall again.\n` +
        (found.length > 0 ? `Apps with their own folder (not listed above, so not removed): ${found.map((f) => `${f.appId} (${f.file})`).join(", ")}; \`bridge apps remove <app>\` removes one once apps.json lists it.\n` : ""),
    );
  }
  if (binding.absent.length > 0) {
    deps.stdout(`Half removed (listed, but their app.json is gone): ${binding.absent.join(", ")}. Their folders above and their sign-in tokens are removed; the identity's wrapping key cannot be named without app.json (its runner id is unknown), and a half removal by bridge already deleted it (credential items go first).\n`);
  }
  for (const b of binding.broken) {
    deps.stderr(`bridge uninstall: ${b.error}; ${b.appId}'s tokens are removed but its identity's wrapping key cannot be named without it, so ${appPathsOf(deps, b.appId).configDir} and ${bridgeConfigDir(deps)} are kept: fix or restore the file and run bridge uninstall again, or \`bridge apps remove ${b.appId}\`.\n`);
  }
  const pid = await runningRunnerPid(deps);
  if (pid !== undefined) {
    // The service's own runner is stopped by uninstall (the service step runs first); only another one is left running.
    if (pid > 0 && pid === (await serviceMainPid(deps))) deps.stdout(`The runner (pid ${pid}) runs under the background service, which uninstall stops first.\n`);
    else deps.stderr(`bridge uninstall: a runner is still running${pid > 0 ? ` (pid ${pid})` : ""}; uninstall removes its files but does not stop a runner you started by hand.\n`);
  }
  if (!run.yes && !(await deps.confirm("Remove all of these and uninstall bridge?"))) {
    deps.stderr("bridge uninstall: cancelled\n");
    return { outcome: "cancelled", removed: [], failures: [] };
  }

  // Rule B (consent-plan.ts): the one recompute after consent. If anything differs, nothing runs.
  try {
    assertUnchanged(plan, await planNow());
  } catch (error) {
    deps.stderr(`bridge uninstall: ${errorMessage(error)}\n`);
    return { outcome: "refused", removed: [], failures: [errorMessage(error)] };
  }

  // Execution runs on the bound canonical paths and is not re-gated: what changes while the
  // service commands or the keychain run is the accepted window. Every removal goes through
  // removeBound; one it refuses (a folder that no longer resolves where it was bound) stops
  // the uninstall and names what was left.
  const removed: string[] = [];
  let stopped = false;
  const attempt = async (what: string, body: () => Promise<void>): Promise<boolean> => {
    if (stopped) return false;
    try {
      await body();
      return true;
    } catch (error) {
      if (error instanceof RemoveRefused) {
        stopped = true;
        failures.push(`${what}: ${error.message}; stopped here, nothing more was changed`);
      } else {
        failures.push(`${what}: ${errorMessage(error)}`);
      }
      return false;
    }
  };
  const remove = async (shown: string, bound: string, recursive: boolean): Promise<void> => {
    await assertNotABase(deps, shown, bound);
    await removeBound(bound, { recursive, force: true });
    removed.push(shown);
  };

  // 1. The service: stopped and disabled first, so nothing restarts the runner while it is dismantled.
  await attempt("service", async () => {
    const consented = plan.service;
    if ("error" in consented) throw new Error(consented.error);
    if (consented.states.every((s) => s.kind === "missing")) return;
    let result;
    try {
      result = await uninstallService(consented.exec, { fs: serviceFs, confirm: () => true, run: runnerOf(deps) });
    } catch (error) {
      if (error instanceof RemoveRefused) throw error;
      await uninstallService(consented.exec, { fs: serviceFs, confirm: () => true });
      throw new Error(`removed its files, but could not stop it (${errorMessage(error)})`);
    }
    removed.push(...result.removed);
    if (result.deactivation && !result.deactivation.ok) {
      failures.push(`service: \`${result.deactivation.failed?.command.join(" ")}\` failed: ${result.deactivation.failed?.stderr.trim()}; the files are removed, stop it yourself if it still runs`);
    }
    if (result.reload && !result.reload.ok) {
      failures.push(`service: \`${result.reload.failed?.command.join(" ")}\` failed: ${result.reload.failed?.stderr.trim()}; the files are removed, run it yourself`);
    }
  });

  // The order keeps a retry possible after any failure: an index entry is removed only after everything it
  // lists is gone. (1) every app's keychain items; (2) per app, its folders with its app.json last
  // (`removeAppFolders`); (3) apps.json and the machine-level paths, only once every app has finished.

  // 2. Each app's keychain items (tokens and identity wrapping key), before any file or folder: if one
  //    fails, nothing is removed, so apps.json and every app.json that names a key stay for the retry.
  //    An app whose record is broken gets its token cleared only: without its runner id the wrapping key
  //    cannot be named (its config dir and apps.json are kept, as the consent said).
  const failedKeychain: string[] = [];
  for (const app of apps) {
    if (!(await attempt(`app ${app.appId}`, () => forgetCredentials(deps, app)))) failedKeychain.push(app.appId);
  }
  // A half-removed app (its app.json absent) likewise gets its token cleared by its id.
  for (const id of [...binding.broken.map((b) => b.appId), ...binding.absent]) {
    if (!(await attempt(`app ${id}`, () => clearTokens(credentialsOf(deps), tokenKey(id))))) failedKeychain.push(id);
  }
  if (failedKeychain.length > 0) {
    if (!stopped) failures.push(`the credential items of ${failedKeychain.join(", ")} could not be removed from ${storeNameOf(deps)}, so every file and folder is kept (none was removed): run bridge uninstall again`);
    stopped = true;
  }

  // 2a. The agents' logins bridge made with their own sign-in: signed out (with the agent's own command, its config
  //     folder set to bridge's) before any of bridge's files is removed. A copy, or a login with no note of how it was
  //     made, is never signed out (it may share the person's own sign-in). A sign-out that fails keeps bridge's login
  //     folder, <config>/bridge and what a retry needs (the launcher, bridge's own folders) for the retry.
  let keptForSignOut = false;
  if (!stopped) {
    for (const l of plan.logins) {
      if (l.source !== "login" || l.problem !== undefined || l.dir.kind !== "dir") continue;
      const r = await signOutQuietly(deps, l.agent, l.dir.canonical);
      if (r.ok) {
        // What ran, not what the provider did with the grant: the agent's own sign-out, nothing more is claimed.
        const { command, args } = logoutCommandOf(deps, l.agent, l.dir.canonical);
        deps.stdout(`Signed out the ${l.agent} login bridge made (${[command, ...args].join(" ")}).\n`);
        continue;
      }
      if (r.reason === "missing") {
        failures.push(`${l.agent} sign-out: ${r.detail}, so bridge could not sign out the login it made; its files are removed, but the grant stays live; revoke it in your ${l.agent === "claude" ? "Anthropic" : "OpenAI"} account`);
        continue;
      }
      keptForSignOut = true;
      failures.push(`${l.agent} sign-out: ${r.detail}; ${l.dir.path} and ${bridgeDir} are kept: run \`bridge agent logout ${l.agent}\` in a terminal, then \`bridge uninstall\` again`);
    }
  }

  // 3. Per app: its bridge/ dirs and empty parents, its app.json last. An app that fails keeps its app.json
  //    and its apps.json entry; the others go on.
  const finished = new Set<string>();
  const appDirSet = new Set(binding.listed.flatMap((id) => appDirsOf(deps, id)));
  const parentState = new Map(plan.parents.map((s) => [s.path, s]));
  for (const id of binding.listed) {
    const p = appPathsOf(deps, id);
    const folders = {
      appId: id,
      ...(entryState.has(p.configDir) ? { config: entryState.get(p.configDir)! } : {}),
      data: entryState.get(p.dataDir) ?? { path: p.dataDir, canonical: p.dataDir, kind: "missing" as const },
      state: entryState.get(p.stateDir) ?? { path: p.stateDir, canonical: p.stateDir, kind: "missing" as const },
      parents: { config: parentState.get(p.parents.config)!, data: parentState.get(p.parents.data)!, state: parentState.get(p.parents.state)! },
    };
    // A parent that holds the app's own files or is a link stays, as the consent said.
    if (await attempt(`app ${id}`, async () => void (await removeAppFolders(deps, folders, (shown) => removed.push(shown))))) finished.add(id);
  }
  // A broken record's config dir is kept by the plan (the consent said so); its other folders count as for any app.
  const allFinished = binding.listed.every((id) => finished.has(id));

  // 4. The machine-level paths, apps.json among them, last and only once every app has finished: a retry
  //    after any failure above still finds every unfinished app, and the launcher to run it with.
  // With apps.json unreadable or a record broken, <config>/bridge (and that app's config dir) are not in the plan.
  if (!stopped && keepsConfig(binding)) {
    failures.push(`${bridgeDir}: kept, so that bridge uninstall can remove the remaining apps' credentials from ${storeNameOf(deps)} when it runs again`);
    for (const dir of brokenConfigDirs(deps, binding)) failures.push(`${dir}: kept, its app.json names the identity's wrapping key a second run must forget`);
  }
  const keepMachine = !allFinished || keptForSignOut;
  if (!stopped && keepMachine) {
    // apps.json stays for the retry, so the apps that did finish (folders and app.json gone) leave it now, at its
    // bound path: the retry then lists only what is left. When every app finishes, apps.json goes whole below instead.
    for (const id of finished) {
      if (!entryState.has(appPathsOf(deps, id).configDir)) continue; // a broken record is kept, and so is its entry
      await attempt(`${appsFilePath(deps)} (${id})`, async () => void (await removeApp(deps, id, { appsFile: binding.file.canonical })));
    }
    if (!allFinished) failures.push(`${bridgeDir}, the launcher and bridge's own folders: kept, so that bridge uninstall can finish the remaining apps when it runs again`);
    else failures.push(`the launcher and bridge's own folders: kept too, so that \`bridge agent logout\` and \`bridge uninstall\` can run again`);
  }
  if (!keepMachine) {
    // The bridge:// handler: its own uninstall, executing exactly the plan shown.
    await attempt("bridge:// handler", async () => {
      const consented = plan.handler;
      if (consented === undefined) return;
      if ("error" in consented) throw new Error(consented.error);
      const outcome = await uninstallProtocolHandler(deps, { consented: true, plan: consented });
      if (outcome === "cancelled") throw new Error("cancelled");
    });
    // The launcher link, only while it pointed into our versions dir, at its canonical place.
    for (const l of plan.launchers) {
      await attempt(l.link === launcherLinksOf(deps)[0] ? "launcher" : "launcher alias", async () => {
        if (l.state.kind !== "ours") return;
        resolvable(l.at);
        await remove(l.link, l.at.canonical, false);
      });
    }
    // The install, config and state dirs and what the manifest lists inside them (the apps' own dirs are done).
    // With apps.json unreadable or a record broken, <config>/bridge is not in the plan: it stays for a second run.
    for (const entry of plan.entries) {
      if (appDirSet.has(entry.path)) continue;
      await attempt(entry.path, async () => {
        resolvable(entry);
        if (entry.kind === "missing") return;
        await remove(entry.path, entry.canonical, true);
      });
    }
  }

  if (failures.length === 0) deps.stdout("Uninstalled bridge.\n");
  else deps.stderr(`bridge uninstall: finished with problems:\n${failures.map((f) => `  ${f}`).join("\n")}\n`);
  return { outcome: "removed", removed, failures };
}

/** Forgets one app's keychain items: its tokens and its identity wrapping key. Touches no file. */
async function forgetCredentials(deps: CliDeps, app: AppRecord): Promise<void> {
  // A local app has no tokens and no identity: nothing was ever put in the keychain for it.
  if (isLocalApp(app)) return;
  const store = credentialsOf(deps);
  await clearTokens(store, tokenKey(app.appId));
  await store.delete(wrapKeyNameOf(app));
}

/** `bridge uninstall [--yes]`. */
export async function runUninstall(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, { yes: { type: "boolean" } });
  if (positionals.length > 0) throw new UsageError("usage: bridge uninstall [--yes]");
  const result = await uninstall(deps, { yes: values.yes === true });
  return result.outcome !== "removed" || result.failures.length > 0 ? 1 : 0;
}
