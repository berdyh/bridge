import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  captureServiceEnv,
  installService,
  planPaths,
  planService,
  RemoveRefused,
  removeBound,
  uninstallService,
  type ServiceFs,
  type ServicePlan,
} from "@berdyh/bridge-runner";

import { parse } from "./args.js";
import { aliasedLayoutMessage, layoutOf, layoutSnapshot } from "./layout-rule.js";
import { ChangedWhileWaiting, type PathState, assertUnchanged, describePath, pathStates, writeFileAtomically } from "./consent-plan.js";
import { type CliDeps, type SetupConfig, UsageError, platformOf, runnerOf } from "./deps.js";
import { assertNoLegacyLayout } from "./legacy.js";
import { launchdUid } from "./doctor.js";
import { RUNNER_NAME, baseDirsOf, launcherPathOf } from "./paths.js";

/**
 * The real file system, for the service writer. It is handed canonical paths (`resolveServicePlan`);
 * a write is a temp file renamed over the target, so it never writes through a symlink.
 */
export const serviceFs: ServiceFs = {
  mkdir: (dir, opts) => mkdir(dir, opts),
  writeFile: (file, contents, opts) => writeFileAtomically(file, contents, opts.mode),
  rm: (file, opts) => removeBound(file, opts),
};

/** A service plan bound for consent: the plan with every path canonical, and the states it was made from. */
export interface ResolvedServicePlan {
  exec: ServicePlan;
  states: PathState[];
}

/**
 * Resolves every path of the service plan (see `consent-plan.ts`): the plan to execute uses the
 * canonical paths, and `states` (kinds, symlink targets, the current file contents' hashes) is
 * what the consent binds. An install refuses a service file that is a symlink or not a regular
 * file (the write would land somewhere never shown); an uninstall only unlinks, so a symlink
 * there is removed as the link itself.
 */
export async function resolveServicePlan(plan: ServicePlan, action: "install" | "uninstall"): Promise<ResolvedServicePlan> {
  const states = await pathStates(planPaths(plan), { hash: true });
  for (const s of states) {
    if (s.kind === "unresolvable") throw new Error(`${s.path} cannot be resolved (${s.error}); refusing to touch it`);
  }
  if (action === "install") {
    for (const f of plan.files) {
      const s = states.find((x) => x.path === f.path)!;
      if (s.kind !== "missing" && s.kind !== "file") {
        throw new Error(`${describePath(s)} is not a regular file; refusing to write the service through it, move it away and run this again`);
      }
    }
  }
  const canon = (p: string): string => states.find((s) => s.path === p)!.canonical;
  return {
    exec: { ...plan, dirs: plan.dirs.map(canon), files: plan.files.map((f) => ({ ...f, path: canon(f.path) })), links: plan.links.map((l) => ({ ...l, path: canon(l.path) })) },
    states,
  };
}

/**
 * PATH and the XDG roots (when set), so the service reads the same per-app config, data and state
 * folders as this CLI; `BRIDGE_CREDENTIAL_STORE` (when set), so the service opens the same credential
 * store the CLI that configured it used (`credentialStoreSettingOf` in deps.ts); and `CLAUDE_CONFIG_DIR` and `CODEX_HOME` (when set), kept only so the service's
 * runner protects the same agent folders as this CLI (`protectedPathsOf` in run.ts reads them from its
 * env). Logins are read from bridge's own folder (`~/.config/bridge/agents`), never from these, and the
 * sandbox overrides both keys for agent children (`SANDBOX_KEYS` in the runner's sandbox.ts).
 */
function serviceEnvOf(deps: CliDeps): Record<string, string> {
  const env = captureServiceEnv(deps.env);
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "BRIDGE_CREDENTIAL_STORE"]) {
    const value = deps.env[name];
    if (value) env[name] = value;
  }
  return env;
}

/** The service plan for this machine: what `service install|uninstall` and `uninstall` act on. */
export function servicePlanOf(deps: CliDeps): ServicePlan {
  const base = baseDirsOf(deps);
  return planService({
    app: RUNNER_NAME,
    platform: platformOf(deps),
    base,
    launcher: launcherPathOf(deps),
    args: ["run"],
    env: serviceEnvOf(deps),
    uid: launchdUid(),
  });
}

/**
 * The default answer of the "run the runner as a background service?" question: `"yes"` (shown
 * as `[Y/n]`) unless the setting `setup.service` is `"ask"`, which asks with no default.
 */
export function servicePromptDefault(config: SetupConfig): "yes" | "ask" {
  return config.service === "ask" ? "ask" : "yes";
}

/** For a caller with its own consent (`bridge setup`). */
export interface ServiceHooks {
  /**
   * Replaces the path list, the `need_approval` event and the question: gets the resolved paths and
   * their printable lines, and answers. The plan is still recomputed once after it (rule B).
   */
  ask?: (paths: readonly string[], lines: readonly string[]) => Promise<boolean>;
}

/**
 * `bridge service install|uninstall [--no-activate] [--yes] [--json]`. It lists the paths and
 * asks before any write (`--yes` answers, and still prints them). With `--json` stdout carries
 * JSON lines only, `{"event":"need_approval","what","paths"}` before the question and
 * `{"event":"service","action","ok","service","paths","activated"?,"error"?}` at the end; the
 * human text goes to stderr.
 */
export async function runService(args: string[], deps: CliDeps, hooks: ServiceHooks = {}): Promise<number> {
  const { values, positionals } = parse(args, { "no-activate": { type: "boolean" }, yes: { type: "boolean" }, json: { type: "boolean" } });
  const sub = positionals[0];
  if ((sub !== "install" && sub !== "uninstall") || positionals.length !== 1) {
    throw new UsageError("usage: bridge service install|uninstall [--no-activate] [--yes] [--json]");
  }
  if (sub === "install") await assertNoLegacyLayout(deps);
  const json = values.json === true;
  const say = json ? deps.stderr : deps.stdout;
  const emit = (event: Record<string, unknown>): void => {
    if (json) deps.stdout(`${JSON.stringify(event)}\n`);
  };
  const plan = servicePlanOf(deps);
  const end = (ok: boolean, extra: Record<string, unknown> = {}): number => {
    emit({ event: "service", action: sub, ok, service: plan.serviceName, ...extra });
    return ok ? 0 : 1;
  };
  // Rule A (consent-plan.ts): an aliased layout is refused before the question, as uninstall does.
  const layout = await layoutOf(deps);
  if (layout.overlap !== undefined) {
    const message = aliasedLayoutMessage(layout.overlap, sub === "install" ? "install into" : "remove");
    deps.stderr(`bridge service ${sub}: ${message}\n`);
    return end(false, { error: message, paths: [] });
  }
  const consented = await resolveServicePlan(plan, sub);
  // The layout bound with it: the bases and the launcher ExecStart runs, resolved.
  const consentedLayout = await layoutSnapshot(deps);
  const confirm = async (paths: readonly string[]): Promise<boolean> => {
    const lines = consented.states.map((s) => `  ${describePath(s)}`);
    if (hooks.ask) {
      if (!(await hooks.ask(paths, lines))) return false;
    } else {
      emit({ event: "need_approval", what: `service ${sub}`, paths });
      say(`${sub === "install" ? "These paths will be written" : "These paths will be removed"}:\n${lines.join("\n")}\n`);
      if (values.yes !== true && !(await deps.confirm(`${sub === "install" ? "Install" : "Remove"} the ${plan.serviceName} service?`))) return false;
    }
    // The one recompute after consent (rule B): a plan that was valid when shown and now refuses
    // to resolve has changed. The service commands run after it are the accepted window.
    const now = await resolveServicePlan(plan, sub).catch(() => undefined);
    assertUnchanged({ plan: consented, layout: consentedLayout }, { plan: now, layout: await layoutSnapshot(deps) }, `service ${sub}`);
    return true;
  };
  const run = values["no-activate"] ? undefined : runnerOf(deps);
  const common = { fs: serviceFs, confirm, ...(run ? { run } : {}) };
  const refused = (error: unknown): number => {
    if (!(error instanceof ChangedWhileWaiting) && !(error instanceof RemoveRefused)) throw error;
    deps.stderr(`bridge service ${sub}: ${error.message}\n`);
    return end(false, { error: error.message, paths: [] });
  };
  if (sub === "install") {
    let result;
    try {
      result = await installService(consented.exec, common);
    } catch (error) {
      return refused(error);
    }
    if (result.written.length === 0) {
      deps.stderr("bridge service install: cancelled\n");
      return end(false, { error: "cancelled", paths: [] });
    }
    if (result.activation && !result.activation.ok) {
      const failed = `\`${result.activation.failed?.command.join(" ")}\` failed: ${result.activation.failed?.stderr.trim()}`;
      deps.stderr(`bridge service install: written, but ${failed}\n`);
      return end(false, { paths: result.written, activated: false, error: failed });
    }
    say(`Installed ${plan.serviceName}.\n`);
    return end(true, { paths: result.written, activated: result.activation !== undefined });
  }
  let result;
  try {
    result = await uninstallService(consented.exec, common);
  } catch (error) {
    return refused(error);
  }
  if (result.removed.length === 0) {
    deps.stderr("bridge service uninstall: cancelled\n");
    return end(false, { error: "cancelled", paths: [] });
  }
  // The files are gone either way; a deactivation or reload that failed is still a failure.
  const failed = [result.deactivation, result.reload]
    .filter((r) => r !== undefined && !r.ok)
    .map((r) => `\`${r!.failed?.command.join(" ")}\` failed: ${r!.failed?.stderr.trim()}`);
  if (failed.length > 0) {
    const error = failed.join("; ");
    deps.stderr(`bridge service uninstall: removed, but ${error}\n`);
    return end(false, { paths: result.removed, error });
  }
  say(`Removed ${plan.serviceName}.\n`);
  return end(true, { paths: result.removed });
}

export { planPaths };
