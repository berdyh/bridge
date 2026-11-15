import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  type LocalPolicyConfig,
  type PermissionMode,
  SESSION_BUDGET_CEILING,
  type SessionBudget,
  type SessionBudgetCeiling,
  narrowSessionBudget,
  validateSessionBudgetCeiling,
} from "@berdyh/bridge-runner";

import { AGENT_NAMES, type AgentName } from "./agent.js";
import type { CliDeps } from "./deps.js";
import { appPathsOf } from "./paths.js";
import { isInside } from "./self.js";

/**
 * An app's own settings, from `<config>/<app>/bridge/config.json`. They override the machine
 * defaults (`<config>/bridge/config.json`, `policy.json`) key by key; the machine files are never
 * copied into an app folder. Unknown keys are ignored; a value that is not valid is ignored with a
 * warning (`bridge doctor` shows them), and a file that cannot be read means the machine defaults.
 */
export interface AppAgentConfig {
  /** The agent this app's sessions use when the browser names none. */
  default?: AgentName;
  /**
   * The model of this app's sessions when a plugin names none. The caller hands it to the policy as
   * `LocalPolicyConfig.agentModel`, so a `models` allow-list is checked against it; setting it on the session
   * is the proxy's. `effort` is recorded and validated only (see `bridge doctor`).
   */
  model?: string;
  effort?: string;
}

/** A per-app policy: it can only NARROW the machine policy (`effectivePolicyOf`). */
export interface AppPolicyOverride {
  allowedCwds?: string[];
  agents?: string[];
  mode?: PermissionMode;
  /** `false` turns the automatic approval of contained plugin sessions off for this app; `true` never turns it on. */
  pluginApprovals?: boolean;
  /** Models plugins may name for this app's sessions; intersected with the machine list. */
  models?: string[];
  /** A budget ceiling for this app's contained sessions; it can only lower the machine's. */
  sessionBudget?: SessionBudgetCeiling;
}

export interface AppConfig {
  agent?: AppAgentConfig;
  policy?: AppPolicyOverride;
  /** What was ignored and why; shown by `bridge doctor`. */
  warnings: string[];
}

const MODES: readonly PermissionMode[] = ["ask", "read-only", "accept-edits", "bypass"];
const MAX_TEXT = 200;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_TEXT && !/[\u0000-\u001f\u007f]/.test(v);

/** Parses the content of an app's `config.json` (already JSON-decoded). Pure. */
export function parseAppConfig(parsed: unknown, file: string): AppConfig {
  const warnings: string[] = [];
  const ignore = (what: string, why: string): void => void warnings.push(`${file}: ${what} ${why}; ignored`);
  if (!isObject(parsed)) return { warnings: parsed === undefined ? [] : [`${file}: not a JSON object; the machine defaults apply`] };
  const out: AppConfig = { warnings };

  if (parsed.agent !== undefined) {
    if (!isObject(parsed.agent)) ignore("agent", "is not an object");
    else {
      const agent: AppAgentConfig = {};
      const a = parsed.agent;
      if (a.default !== undefined) {
        if (typeof a.default === "string" && (AGENT_NAMES as readonly string[]).includes(a.default)) agent.default = a.default as AgentName;
        else ignore("agent.default", `is not a known agent (${AGENT_NAMES.join(", ")})`);
      }
      for (const key of ["model", "effort"] as const) {
        if (a[key] === undefined) continue;
        if (isText(a[key])) agent[key] = a[key] as string;
        else ignore(`agent.${key}`, "is not a short text");
      }
      if (Object.keys(agent).length > 0) out.agent = agent;
    }
  }

  if (parsed.policy !== undefined) {
    if (!isObject(parsed.policy)) ignore("policy", "is not an object");
    else {
      const policy: AppPolicyOverride = {};
      const p = parsed.policy;
      for (const key of ["allowedCwds", "agents"] as const) {
        if (p[key] === undefined) continue;
        if (Array.isArray(p[key]) && (p[key] as unknown[]).every((x) => typeof x === "string")) policy[key] = p[key] as string[];
        else ignore(`policy.${key}`, "is not a list of strings");
      }
      if (p.mode !== undefined) {
        if (typeof p.mode === "string" && (MODES as readonly string[]).includes(p.mode)) policy.mode = p.mode as PermissionMode;
        else ignore("policy.mode", `is not one of ${MODES.join(", ")}`);
      }
      if (p.pluginApprovals !== undefined) {
        if (typeof p.pluginApprovals === "boolean") policy.pluginApprovals = p.pluginApprovals;
        else ignore("policy.pluginApprovals", "is not true or false");
      }
      if (p.models !== undefined) {
        if (Array.isArray(p.models) && p.models.every(isText)) policy.models = p.models as string[];
        else ignore("policy.models", "is not a list of short texts");
      }
      if (p.sessionBudget !== undefined) {
        if (!isObject(p.sessionBudget)) ignore("policy.sessionBudget", "is not an object {wallClockMs?, maxToolCalls?}");
        else {
          // Field by field: a fault in one (unknown key, a value outside 1..ceiling) leaves the others in force.
          const budget: { wallClockMs?: number; maxToolCalls?: number } = {};
          for (const key of Object.keys(p.sessionBudget)) {
            if (key !== "wallClockMs" && key !== "maxToolCalls") ignore("policy.sessionBudget", "has a key that is not wallClockMs or maxToolCalls");
          }
          for (const field of ["wallClockMs", "maxToolCalls"] as const) {
            const value = p.sessionBudget[field];
            if (value === undefined) continue;
            const faults = validateSessionBudgetCeiling({ [field]: value }, "policy.sessionBudget");
            if (faults.length === 0) budget[field] = value as number;
            else for (const fault of faults) warnings.push(`${file}: ${fault}; ignored`);
          }
          if (Object.keys(budget).length > 0) policy.sessionBudget = budget;
        }
      }
      if (Object.keys(policy).length > 0) out.policy = policy;
    }
  }
  return out;
}

/** The app's overrides, read from its own `config.json`. Never throws. */
export async function appConfigOf(deps: CliDeps, appId: string): Promise<AppConfig> {
  const file = appPathsOf(deps, appId).configFile;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { warnings: code === "ENOENT" ? [] : [`${file}: cannot be read (${code ?? "error"}); the machine defaults apply`] };
  }
  try {
    return parseAppConfig(JSON.parse(text), file);
  } catch {
    return { warnings: [`${file}: is not valid JSON; the machine defaults apply`] };
  }
}

/**
 * How much a mode approves without a person: `ask` nothing, `read-only` reads inside the home dir,
 * `accept-edits` those and edits, `bypass` everything. Each set contains the one before it, so the
 * modes are ordered by it, and a per-app mode may not rank above the machine's.
 */
export const MODE_RANK: Readonly<Record<PermissionMode, number>> = { ask: 0, "read-only": 1, "accept-edits": 2, bypass: 3 };

/** An agent list no agent id is on: the policy reads an empty list as "all", so "none" needs a name nobody has. */
const NO_AGENT = "(no agent is allowed)";
/** The same for models: a `models` list nobody is on, since an empty list reads as "any model". */
const NO_MODEL = "(no model is allowed)";

export interface EffectivePolicy {
  config: LocalPolicyConfig;
  warnings: string[];
  /**
   * The budget ceiling an app's contained sessions get: the runner's ceiling, narrowed by `policy.json`, then by
   * the app's `config.json` (`narrowSessionBudget` twice). Whole, never partial. `config.sessionBudget` carries
   * the same numbers, so a policy built from `config` returns this value in its verdict.
   */
  sessionBudget: SessionBudget;
}

/**
 * The policy of one app: the machine policy narrowed by the app's override, never widened.
 *  - `allowedCwds`: an entry is kept only when it is the app's own work dir, or when the machine policy
 *    itself would admit it as a session cwd (`admits`: the caller asks the same `createLocalPolicy` the
 *    runner builds from the machine config, with its protected paths, home and this app's folders, so
 *    whatever the machine policy refuses, an invalid root, a protected path on the way, a link leading
 *    out, an override cannot admit). Anything else is dropped with a warning. `resolve` maps a path to
 *    where it really is (the caller passes `resolveProtectedDir`: links followed, a dangling one through
 *    its target); `undefined` means it cannot be resolved and the entry is dropped. The work dir is admitted whole or not at all (the policy keeps no root below it), so
 *    an entry strictly inside it, or anywhere else in the app's state dir, is dropped with a warning
 *    rather than kept and then admitting no session.
 *  - `agents`: intersected with the machine list (an empty machine list means every agent, an unreadable one none);
 *    an empty result allows none. An empty app list says nothing (as in the machine policy, it means every agent).
 *  - `mode`: equal or stricter than the machine's (`MODE_RANK`); a looser one keeps the machine's.
 *  - `pluginApprovals`: an app's `false` turns the automatic approval of contained plugin sessions off; its `true`
 *    cannot turn on what the machine turned off.
 *  - `models`: intersected with the machine list (an empty machine list means every model, an unreadable one none);
 *    an empty result allows none. An empty app list says nothing.
 *  - `sessionBudget`: per field `min(runner ceiling, machine, app)`; an app value wider than the machine's is
 *    ignored with a warning.
 *  `protectedPaths`, `allowedTools` and the rest stay the machine's: an app cannot unprotect a path.
 */
export async function effectivePolicyOf(
  machine: LocalPolicyConfig,
  app: AppPolicyOverride | undefined,
  context: { workDir: string; stateDir?: string; resolve?: (p: string) => string | undefined; admits: (cwd: string) => Promise<boolean> },
): Promise<EffectivePolicy> {
  const warnings: string[] = [];
  const config: LocalPolicyConfig = { ...machine };
  const machineBudget = narrowSessionBudget(SESSION_BUDGET_CEILING, machine.sessionBudget);
  if (!app) return { config, warnings, sessionBudget: machineBudget };
  const resolve = context.resolve ?? ((p: string): string => path.resolve(p));
  const resolvedWork = resolve(context.workDir);
  const resolvedState = context.stateDir !== undefined ? resolve(context.stateDir) : undefined;

  if (app.allowedCwds !== undefined) {
    const kept: string[] = [];
    for (const entry of app.allowedCwds) if (await keep(entry)) kept.push(entry);
    config.allowedCwds = kept;
  }
  async function keep(entry: string): Promise<boolean> {
    const real = path.isAbsolute(entry) ? resolve(entry) : undefined;
    if (real === undefined) {
      warnings.push(`policy.allowedCwds: ${JSON.stringify(entry)} is not an absolute path that can be resolved; dropped`);
      return false;
    }
    if (resolvedWork !== undefined && real === resolvedWork) return true;
    // Under the work folder, or elsewhere in the app's state folder: the policy admits only the work folder itself there.
    const insideApp = [resolvedWork, resolvedState].some((dir) => dir !== undefined && isInside(dir, real));
    if (insideApp || (resolvedState !== undefined && real === resolvedState)) {
      warnings.push(`policy.allowedCwds: ${JSON.stringify(entry)} is inside this app's own folders, where only the work folder itself (${context.workDir}) can be a root; dropped`);
      return false;
    }
    // Narrowing, by the machine policy's own answer: a cwd it refuses is never a root the app may add.
    if (await context.admits(entry)) return true;
    warnings.push(`policy.allowedCwds: ${JSON.stringify(entry)} is not a folder the machine policy admits a session in, nor this app's work folder; dropped`);
    return false;
  }

  if (app.agents !== undefined && app.agents.length > 0) {
    // A machine list that cannot be read (not a list of strings) reads as a list nobody is on, never as "every agent".
    const machineAgents = machine.agents ?? [];
    const kept = !isTextList(machineAgents) ? [] : machineAgents.length === 0 ? [...app.agents] : app.agents.filter((a) => machineAgents.includes(a));
    config.agents = kept.length > 0 ? kept : [NO_AGENT];
    if (kept.length < app.agents.length) warnings.push(`policy.agents: ${app.agents.filter((a) => !kept.includes(a)).join(", ")} not allowed by the machine policy; dropped`);
  }

  if (app.mode !== undefined) {
    const machineMode = machine.mode ?? "ask";
    if (MODE_RANK[app.mode] <= MODE_RANK[machineMode]) config.mode = app.mode;
    else warnings.push(`policy.mode: "${app.mode}" is looser than the machine's "${machineMode}"; the machine's mode stays`);
  }

  if (app.pluginApprovals === false) config.pluginApprovals = false;
  else if (app.pluginApprovals === true && machine.pluginApprovals !== undefined && machine.pluginApprovals !== true) {
    warnings.push("policy.pluginApprovals: true is looser than the machine's setting; the machine's stays");
  }

  if (app.models !== undefined && app.models.length > 0) {
    // Absent means every model; present but not a list of strings reads as a list nobody is on, as the policy reads it.
    const machineModels: unknown = machine.models === undefined ? [] : machine.models;
    const kept = !isTextList(machineModels) ? [] : machineModels.length === 0 ? [...app.models] : app.models.filter((m) => machineModels.includes(m));
    config.models = kept.length > 0 ? kept : [NO_MODEL];
    if (kept.length < app.models.length) warnings.push(`policy.models: ${app.models.filter((m) => !kept.includes(m)).map((m) => JSON.stringify(m)).join(", ")} not allowed by the machine policy; dropped`);
  }

  const sessionBudget = narrowSessionBudget(machineBudget, app.sessionBudget);
  for (const field of ["wallClockMs", "maxToolCalls"] as const) {
    const value = app.sessionBudget?.[field];
    if (value !== undefined && value > machineBudget[field]) warnings.push(`policy.sessionBudget.${field}: ${value} is above the machine's ceiling ${machineBudget[field]}; the machine's stays`);
  }
  config.sessionBudget = sessionBudget;
  return { config, warnings, sessionBudget };
}

/** The adapters with the app's default agent first (`pickAdapter` takes the first available one); the others keep their order. */
export function orderAdapters<T extends { id: string }>(adapters: readonly T[], preferred: AgentName | undefined): T[] {
  if (preferred === undefined) return [...adapters];
  return [...adapters.filter((a) => a.id === preferred), ...adapters.filter((a) => a.id !== preferred)];
}
