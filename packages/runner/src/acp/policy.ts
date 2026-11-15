import { CONFINED_BUILTINS } from "./confined.js";
import { lstat, readlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { ensurePrivateAppDir, redirectedComponent } from "../sandbox/index.js";

import { parseMcpToolName } from "@berdyh/bridge-protocol";

import {
  type ContainedSessionVerdict,
  type LocalPolicy,
  type PermissionMode,
  type PermissionRequestInfo,
  type PolicyDecision,
  SESSION_BUDGET_CEILING,
  type SessionBudgetCeiling,
  narrowSessionBudget,
  validateSessionBudgetCeiling,
} from "./contracts.js";

/** Local policy settings, read from the runner's own config file, never from a browser. */
export interface LocalPolicyConfig {
  mode?: PermissionMode;
  /** Agents sessions may use; empty or absent means all installed ones. */
  agents?: string[];
  /**
   * Directories sessions may start in. Absent means the app's work folder when `workDirOf` is
   * set, else the user's home. A configured list is used as written (it may include the home dir).
   */
  allowedCwds?: string[];
  /**
   * The per-app work folder (`appPathsOf(base, id).workDir`, `<state>/<app>/bridge/work`), set by
   * the caller in code (it is a function, so `policy.json` cannot carry it). It needs
   * `appStateDirOf` too: `createLocalPolicy` throws without it. When set:
   * - without `allowedCwds`, a session of `appId` may start only inside `workDirOf(appId)`
   *   (instead of anywhere under the home dir), and the folder is created 0700 on demand;
   * - the `read-only` and `accept-edits` shortcuts work for a session started inside
   *   `workDirOf(appId)` even though that folder lies inside a protected runner dir; every
   *   other path under the runner's dirs (trust lists, `runner.json`, the `tmp` dirs, the
   *   other apps' folders) stays protected. A session of another app gets no shortcut there.
   * When unset, behaviour is unchanged.
   */
  workDirOf?: (appId: string) => string;
  /**
   * The app's bridge state folder (`appPathsOf(base, id).stateDir`, `<state>/<app>/bridge`). When
   * set it is the trust anchor of the work-folder confinement for a
   * session of `appId`, `workDirOf(appId)` must be exactly `<it>/work`, and `bridge` and `work`
   * must be real directories (the app's parent `<state>/<app>` may be a link). A session cwd or
   * configured root that reaches the folder (by pathname, any symlink on the way, or real path)
   * is admitted only inside the session's own work folder. Other apps' folders are protected
   * through `protectedPaths`: the policy cannot know them. With it set, `protectedPaths` also
   * bounds admission: a session cwd or configured root inside (or reaching, by link) any
   * `protectedPaths` root is admitted only inside the session's own work folder, so a broad
   * `allowedCwds` (the home dir) never lets one app start in another app's folders. Required
   * whenever `workDirOf` is set.
   */
  appStateDirOf?: (appId: string) => string;
  /**
   * Tool names approved without asking (`PermissionRequestInfo.toolName`, exact and
   * case-sensitive). A request with no `toolName` never matches. A contained plugin session ignores it.
   */
  allowedTools?: string[];
  /**
   * Kill switch for the automatic approval of a contained plugin session's tools (the install-time
   * consented headless set). Only `true` or absent leaves it on; `false`, or any other value (it comes
   * from JSON), turns it off, with a warning for the latter. With it off every permission request of a
   * contained session is rejected. An app's `config.json` may only turn it off (`effectivePolicyOf`).
   */
  pluginApprovals?: boolean;
  /**
   * Models a plugin may name for its sessions, exact match. Empty or absent means any model. A
   * value that is not a list of strings is reported and read as a list nobody is on. With a list, a
   * contained session that names no model is refused too, unless `agentModel` supplies one.
   */
  models?: string[];
  /**
   * The app's `agent.model` (its `config.json`), set by the caller in code for this app's policy. A
   * contained session that names no model uses it, so it is checked against `models` like a named one.
   */
  agentModel?: string;
  /**
   * The budget ceiling of a contained session (`policy.json` `sessionBudget`, or the app's value already
   * narrowed by `effectivePolicyOf`). Per field it may only lower `SESSION_BUDGET_CEILING`: a value above
   * it, or one that is not a positive integer, is reported and ignored.
   */
  sessionBudget?: SessionBudgetCeiling;
  /**
   * Whether the audit log of a plugin has failed a write (`FileAuditLog.failed`), set by the caller in
   * code. While it answers anything but `false` every permission request of a contained session of that plugin
   * is cancelled: a call that cannot be audited is not approved. Absent means no audit log is wired, which is
   * not a healthy one: every permission request of a contained session is cancelled.
   */
  auditFailed?: (pluginId: string) => boolean;
  /** The user's home, for the `allowedCwds` default. Default `os.homedir()`. */
  homedir?: string;
  /**
   * Extra locations the `read-only` and `accept-edits` shortcuts never approve (the caller's
   * actual config/data/state dirs when they are not the XDG defaults). Always protected,
   * relative to `homedir`: the bridge dirs under the XDG defaults, the systemd user unit dir,
   * LaunchAgents, `.ssh`, `.gnupg`, `.aws`, `.config/gh`, `.claude`, `.codex`, `.config/bridge/agents`, `.netrc` and
   * the shell rc files. With `appStateDirOf` set, these roots also bound session admission (see
   * `appStateDirOf`).
   */
  protectedPaths?: string[];
  /** Receives a warning for each configured root that is dropped. Default `console.warn`. */
  warn?: (message: string) => void;
}

/** Home-relative locations whose reads and edits are never auto-approved by a mode shortcut. */
const PROTECTED_HOME_RELATIVE = [
  ".config/bridge",
  ".local/share/bridge",
  ".local/state/bridge",
  ".config/bridge/agents",
  ".config/systemd",
  ".local/share/systemd",
  ".config/environment.d",
  "Library/LaunchAgents",
  ".ssh",
  ".gnupg",
  ".aws",
  ".config/gh",
  ".claude",
  ".codex",
  ".netrc",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".zlogout",
  ".config/fish",
];

const READ_KINDS = new Set(["read", "search", "think"]);
const EDIT_KINDS = new Set(["edit"]);
/** Kinds that change files or run code. `read-only` mode refuses these without asking. */
const WRITE_KINDS = new Set(["edit", "delete", "move", "execute"]);

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const MAX_LINK_HOPS = 40;
const MAX_PATH_CHARS = 4096;
const MAX_PATH_PARTS = 256;
const MAX_CANDIDATES = 64;
const MAX_WALK_STEPS = 8192;

const splitParts = (p: string): string[] => p.split("/").filter((c) => c !== "" && c !== ".");

/**
 * Walks `parts` from the real directory `start`, one component at a time, with filesystem
 * semantics: a symlink is followed where it stands, `..` is the parent of the real directory
 * reached so far (never a lexical rewrite), and once a component does not exist the rest is
 * appended literally. `undefined` (the caller asks) when anything is ambiguous: a `..` after a
 * missing component, too many links or steps, or an lstat error other than ENOENT. Every
 * accumulated path seen on the way (symlink pathnames included) is pushed to `visited`.
 */
async function walk(start: string, parts: string[], visited?: string[]): Promise<string | undefined> {
  // A stack in reverse order: O(1) pops and pushes, no rebuilding of the remaining path.
  const stack = [...parts].reverse();
  let current = start;
  let missing = false;
  let hops = 0;
  let steps = 0;
  while (stack.length > 0) {
    if (++steps > MAX_WALK_STEPS) return undefined;
    const part = stack.pop()!;
    if (part === ".") continue;
    if (part === "..") {
      if (missing) return undefined;
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    visited?.push(next);
    if (missing) {
      current = next;
      continue;
    }
    let st;
    try {
      st = await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      missing = true;
      current = next;
      continue;
    }
    if (!st.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return undefined;
    let target: string;
    try {
      target = await readlink(next);
    } catch {
      return undefined;
    }
    if (target.includes("\\")) return undefined;
    if (path.isAbsolute(target)) current = path.parse(target).root;
    const targetParts = splitParts(target);
    for (let i = targetParts.length - 1; i >= 0; i--) stack.push(targetParts[i]!);
  }
  return current;
}

/** The real path of an absolute `p`; `undefined` when ambiguous or over budget. */
async function resolveStrict(p: string): Promise<string | undefined> {
  if (!path.isAbsolute(p) || p.length > MAX_PATH_CHARS || p.includes("\\")) return undefined;
  const parts = splitParts(p);
  if (parts.length > MAX_PATH_PARTS) return undefined;
  return walk(path.parse(p).root, parts);
}

/** `resolveStrict`, or the lexical path for trusted configured roots that cannot be resolved. */
async function canonical(p: string): Promise<string> {
  return (await resolveStrict(p)) ?? path.resolve(p);
}

function allowOnce(info: PermissionRequestInfo): PolicyDecision | undefined {
  // Never `allow_always`: a local rule approves this one call, not the next.
  const option = info.options.find((o) => o.kind === "allow_once");
  return option ? { action: "select", optionId: option.optionId } : undefined;
}

function rejectOnce(info: PermissionRequestInfo): PolicyDecision {
  const option = info.options.find((o) => o.kind === "reject_once");
  return option ? { action: "select", optionId: option.optionId } : { action: "cancel" };
}

/**
 * The decision for a contained plugin session: `allow_once` only for a tool in the session's
 * own approval set (`origin.allow`, set by the proxy from the consented headless set), with the kill switch
 * on and calls left in the budget. Everything else is rejected, or cancelled when no reject option is
 * offered; it is never asked of a browser. The machine `allowedTools` and `mode` are not consulted, so
 * neither widens it. A failed audit log cancels everything.
 */
function decideContained(
  info: PermissionRequestInfo,
  origin: Extract<PermissionRequestInfo["origin"], { kind: "plugin" }>,
  switches: { pluginApprovals: boolean; auditFailed: ((pluginId: string) => boolean) | undefined },
): PolicyDecision {
  // Approved only while the plugin's audit log is known to be healthy: no check wired is not "healthy".
  let healthy = false;
  try {
    healthy = switches.auditFailed !== undefined && switches.auditFailed(origin.pluginId) === false; // anything but an exact `false` (a throw too) is a failure
  } catch {
    healthy = false;
  }
  if (!healthy) return { action: "cancel" };
  const tool = info.toolName;
  const inSet = tool !== undefined && (parseMcpToolName(tool) !== undefined || (origin.execution === "confined-v1" && CONFINED_BUILTINS.has(tool))) && (origin.allow ?? []).includes(tool);
  const callsLeft = origin.callsLeft;
  const hasCalls = typeof callsLeft === "number" && Number.isInteger(callsLeft) && callsLeft >= 1; // a whole number of calls; 0.5 is not a call
  if (inSet && switches.pluginApprovals && hasCalls) {
    const option = info.options.find((o) => o.kind === "allow_once");
    if (option) return { action: "select", optionId: option.optionId };
  }
  return rejectOnce(info);
}

const PATH_KEYS = new Set([
  "path", "paths", "file", "files", "file_path", "filepath", "filePath", "notebook_path", "notebookPath",
  "cwd", "dir", "directory", "uri", "target", "destination", "source", "old_path", "new_path", "oldPath", "newPath",
]);
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Keys whose values are file contents, patches, patterns or prose, never paths: skipped whole
 * (the key, its value and everything under it), and not counted. The names are those of the
 * Claude Code and Codex tool inputs (edit and write payloads, notebook edits, searches).
 */
const CONTENT_KEYS = new Set([
  "content", "text", "old_string", "new_string", "oldText", "newText", "old_str", "new_str", "oldString", "newString",
  "lines", "pattern", "query", "output", "stdout", "stderr", "description", "prompt", "new_source", "newSource",
  "file_text", "fileText", "insert_text", "body", "data", "diff", "patch", "unified_diff", "input_text", "message",
]);
/** Total values and keys visited in one rawInput; beyond it the scan gives up and the shortcut asks. */
const MAX_SCAN_NODES = 2048;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Candidate path strings in a tool call's raw input (arrays at any position, depth cap 8).
 * Best-effort defence in depth: a string with no whitespace or control characters (any position,
 * and object keys) is a candidate, and so is the value of a path-like key, which may hold spaces.
 * Other long or multi-line strings and content keys are skipped. The walk is lazy and stops at a
 * node budget. `undefined` when the input is too big or deep to be sure we saw everything.
 */
function rawCandidates(value: unknown): string[] | undefined {
  const found = new Set<string>();
  let nodes = 0;
  const add = (v: string, pathKey: boolean): boolean => {
    if (v === "") return true;
    const tooLong = v.length > MAX_PATH_CHARS;
    if (pathKey) {
      if (tooLong || CONTROL.test(v)) return false;
    } else if (tooLong || SPACE_OR_CONTROL.test(v)) {
      return true;
    }
    found.add(v);
    return found.size <= MAX_CANDIDATES;
  };
  const visit = (v: unknown, key: string | undefined, depth: number): boolean => {
    if (++nodes > MAX_SCAN_NODES || depth > 8) return false;
    if (typeof v === "string") return add(v, key !== undefined && PATH_KEYS.has(key));
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (!visit(v[i], key, depth + 1)) return false;
      return true;
    }
    if (v !== null && typeof v === "object") {
      for (const k in v) {
        if (!Object.hasOwn(v, k)) continue;
        if (++nodes > MAX_SCAN_NODES) return false;
        if (CONTENT_KEYS.has(k)) continue;
        if (!add(k, false) || !visit((v as Record<string, unknown>)[k], k, depth + 1)) return false;
      }
    }
    return true;
  };
  return visit(value, undefined, 0) ? [...found] : undefined;
}

const lower = (p: string): string => p.toLowerCase();

/** `inside` for the protected-path test: case-insensitive on every platform (conservative). */
function insideFold(root: string, target: string): boolean {
  return inside(lower(root), lower(target));
}

interface Resolved {
  real: string;
  /** Every accumulated path seen during the symlink walk. */
  visited: string[];
  /** The candidate's lexical absolute forms (`~` expanded, relative to the cwd), unresolved. */
  lexical: string[];
}

interface Bases {
  cwdRaw: string;
  cwdReal: string;
  homeRaw: string;
  homeReal: string;
}

/** URLs that are never local files. Any other scheme is checked as a relative path. */
const REMOTE_URL = /^(?:https?|wss?):/i;

/**
 * Resolves one candidate, or `undefined` (the caller asks), or `null` (a remote URL: not a
 * path). `file:` URIs go through `fileURLToPath`. `~` is the home dir, relative paths start at
 * the session directory; a backslash, a control character or an over-budget path asks.
 */
async function resolveCandidate(raw: string, b: Bases): Promise<Resolved | undefined | null> {
  if (raw.includes("\\") || raw.length > MAX_PATH_CHARS || /[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  if (REMOTE_URL.test(raw)) return null;
  let text = raw;
  if (/^file:/i.test(text)) {
    try {
      text = fileURLToPath(text);
    } catch {
      return undefined;
    }
    if (text.includes("\\") || text.length > MAX_PATH_CHARS) return undefined;
  }
  const parts = splitParts(text);
  if (parts.length > MAX_PATH_PARTS) return undefined;
  const visited: string[] = [];
  let real: string | undefined;
  let lexical: string[];
  if (text === "~" || text.startsWith("~/")) {
    const rest = parts.slice(1);
    real = await walk(path.parse(b.homeReal).root, [...splitParts(b.homeReal), ...rest], visited);
    lexical = [path.resolve(b.homeRaw, ...rest), path.resolve(b.homeReal, ...rest)];
  } else if (text.startsWith("~")) {
    return undefined; // ~user
  } else if (path.isAbsolute(text)) {
    real = await walk(path.parse(text).root, parts, visited);
    lexical = [path.resolve(text)];
  } else {
    real = await walk(b.cwdReal, parts, visited);
    lexical = [path.resolve(b.cwdRaw, text), path.resolve(b.cwdReal, text)];
  }
  return real === undefined ? undefined : { real, visited, lexical };
}

/** The session app's own work folder: as configured and as really located. */
interface OwnWork {
  raw: string;
  real: string;
  /** How many trailing components of `raw` must be real directories (see `ensurePrivateAppDir`). */
  levels: number;
}

/**
 * The directories carved out of the protected roots for this session: the app's own work folder
 * (as configured and as resolved), when the session's real cwd is inside it. Empty when there is
 * no usable own work folder or the session started elsewhere.
 */
async function carvedOut(appId: string, cwdReal: string, ownOf: (appId: string) => Promise<OwnWork | undefined>): Promise<string[]> {
  const own = await ownOf(appId);
  return own && inside(own.real, cwdReal) ? [...new Set([own.raw, own.real])] : [];
}

/**
 * Whether every file the tool names is inside the session's directory and clear of the
 * protected locations. Fail-closed: anything ambiguous, over budget or unresolvable answers
 * false, as does a session started in the home directory itself, and a request that names no
 * path. A candidate is protected if its lexical form, any path seen while following its
 * symlinks, or its final real path lies inside a protected root, or if the lexical form or the
 * final path is a parent of one (a recursive search of `~/.config` would reach `~/.config/gh`).
 * The trusted scope of a request is the adapter's `kind` and `locations`; the `rawInput` scan is
 * best-effort. Accepted residuals: hardlinks, check-then-use races, trusting the ACP `kind`, and
 * a request whose `rawInput` touches files the adapter does not report in `locations`.
 */
async function locationsInside(
  info: PermissionRequestInfo,
  homeRaw: string,
  homeReal: string,
  protectedRoots: string[],
  allowEmpty: boolean,
  ownOf: (appId: string) => Promise<OwnWork | undefined>,
): Promise<boolean> {
  if (!path.isAbsolute(info.cwd)) return false;
  const cwdResolved = await resolveCandidate(info.cwd, { cwdRaw: info.cwd, cwdReal: info.cwd, homeRaw, homeReal });
  if (!cwdResolved) return false;
  const cwdReal = cwdResolved.real;
  if (lower(cwdReal) === lower(homeReal) || lower(cwdReal) === lower(homeRaw)) return false;
  // The app's work folder is carved out of the protected roots, but only for a session that
  // started inside it: its pathname and its real path, so a symlinked state dir still matches.
  const carved = await carvedOut(info.appId, cwdReal, ownOf);
  // Carve-out membership is exact (case-sensitive): matching more would grant more, the opposite
  // of the protected side. Only a protected root that encloses the carved dir is forgiven.
  const hit = (prot: string, target: string): boolean =>
    insideFold(prot, target) && !carved.some((c) => inside(c, target) && insideFold(prot, c));
  // A walk also records the ancestors of what it resolves, so a carved folder's own parents
  // (`<state>/bridge`, `apps/<id>`) show up as "seen". They are not accessed: forgive them, and
  // only them. Everything after a symlink jump is a separate entry and is still checked.
  const hitSeen = (prot: string, seen: string): boolean => hit(prot, seen) && !carved.some((c) => inside(seen, c));
  // A session started inside a protected location gets no shortcut at all, empty request or not.
  for (const prot of protectedRoots) {
    for (const lex of cwdResolved.lexical) if (hit(prot, lex)) return false;
    if (hit(prot, cwdReal)) return false;
    for (const seen of cwdResolved.visited) if (hitSeen(prot, seen)) return false;
  }
  const raw = rawCandidates(info.rawInput);
  if (raw === undefined) return false;
  const locations = info.locations ?? [];
  if (locations.length + raw.length > MAX_CANDIDATES) return false;
  if (locations.length + raw.length === 0) return allowEmpty;
  const bases: Bases = { cwdRaw: path.resolve(info.cwd), cwdReal, homeRaw, homeReal };
  const resolved: Resolved[] = [];
  for (const loc of locations) {
    if (!path.isAbsolute(loc.path)) return false;
    const r = await resolveCandidate(loc.path, bases);
    if (!r) return false;
    resolved.push(r);
  }
  for (const candidate of raw) {
    const r = await resolveCandidate(candidate, bases);
    if (r === undefined) return false;
    if (r !== null) resolved.push(r);
  }
  for (const r of resolved) {
    if (!inside(cwdReal, r.real)) return false;
    for (const prot of protectedRoots) {
      for (const lex of r.lexical) if (hit(prot, lex) || insideFold(lex, prot)) return false;
      if (hit(prot, r.real) || insideFold(r.real, prot)) return false;
      for (const seen of r.visited) if (hitSeen(prot, seen)) return false;
    }
  }
  return true;
}

/**
 * The runner's policy. Mode rules, in this order for every permission request:
 *  1. `allowedTools` (exact `toolName`): `allow_once`; with no such option, ask.
 *  2. `ask` (default): ask.
 *  3. `read-only`: read and search calls that name files inside the session directory, and
 *     think calls, are allowed (never for the runner's own dirs, credential dirs and shell rc
 *     files, nor when the session directory is the home directory itself: those ask);
 *     edit, delete, move and execute calls are rejected without asking; the rest ask.
 *  4. `accept-edits`: as read-only for reads; edits inside the session directory are
 *     allowed; everything else asks.
 *  5. `bypass`: `allow_once` for everything. It exists only in local config.
 * "Ask" means the browser is asked (or, for a brokered session, the attached channel).
 *
 * A contained plugin session (`origin.contained`) skips all of the above (`decideContained`): `allow_once`
 * for a tool in `origin.allow` only, otherwise `reject_once` or `cancel`, never `ask`, whatever the mode
 * and `allowedTools` say. `allowContainedSession` admits it by agent and model and hands back its budget.
 */
export function createLocalPolicy(config: LocalPolicyConfig): LocalPolicy {
  const mode: PermissionMode = config.mode ?? "ask";
  const agents = config.agents && config.agents.length > 0 ? new Set(config.agents) : undefined;
  const allowedTools = config.allowedTools ? [...config.allowedTools] : undefined;
  const home = path.resolve(config.homedir ?? os.homedir());
  // path.resolve folds `..` lexically, which the kernel does not (`link/..`), so a root with a
  // dot segment is dropped before any normalization. Dropping every root admits nothing.
  const configuredRoots = config.allowedCwds
    ?.filter((r) => {
      if (path.isAbsolute(r) && !r.includes("\\") && !r.split("/").some((c) => c === ".." || c === ".")) return true;
      (config.warn ?? console.warn)(`ignoring allowed directory ${JSON.stringify(r)}: it must be an absolute path without "." or ".." segments`);
      return false;
    })
    .map((r) => path.resolve(r));
  const warn = (message: string): void => (config.warn ?? console.warn)(message);
  const pluginApprovals = config.pluginApprovals === undefined || config.pluginApprovals === true;
  if (!pluginApprovals && config.pluginApprovals !== false) warn(`ignoring pluginApprovals ${JSON.stringify(config.pluginApprovals)}: it must be true or false; plugin approvals stay off`);
  const modelsValid = config.models === undefined || (Array.isArray(config.models) && config.models.every((m) => typeof m === "string"));
  if (!modelsValid) warn("ignoring models: it must be a list of strings; no model is allowed");
  // Empty or absent: any model. Invalid: a list nobody is on (fail closed).
  const models = !modelsValid ? new Set<string>() : config.models && config.models.length > 0 ? new Set(config.models) : undefined;
  const budgetFaults = config.sessionBudget === undefined ? [] : validateSessionBudgetCeiling(config.sessionBudget, "sessionBudget");
  for (const fault of budgetFaults) warn(`${fault}; the runner's ceiling applies to it`);
  // `narrowSessionBudget` never widens and ignores a field that is not a positive integer, whatever the faults.
  const sessionBudget = narrowSessionBudget(SESSION_BUDGET_CEILING, typeof config.sessionBudget === "object" && config.sessionBudget !== null ? config.sessionBudget : undefined);
  const workDirOf = config.workDirOf;
  const appStateDirOf = config.appStateDirOf;
  const homeReal = canonical(home);
  if (workDirOf && !appStateDirOf) throw new Error("createLocalPolicy: workDirOf needs appStateDirOf, the trust anchor of the work-folder confinement");

  /**
   * The one resolver for the app's own work folder, used by admission and the carve-out. Its
   * tail `work` (under the app's state folder) must be exactly that and link-free (ENOENT is fine, any other lstat
   * error fails closed), and the state dir must resolve; then the real dir is the state's real
   * path plus the tail. `undefined` otherwise. No lexical fallback: this is a trust input.
   */
  const ownWorkOf = async (appId: string): Promise<OwnWork | undefined> => {
    if (!workDirOf) return undefined;
    let raw: string;
    try {
      raw = path.resolve(workDirOf(appId));
    } catch {
      return undefined;
    }
    let lex: string;
    try {
      lex = path.resolve(appStateDirOf!(appId));
    } catch {
      return undefined;
    }
    const expected = ["work"];
    const levels = 2; // `bridge` and `work`: the app's own parent may be a link, these may not
    if (!inside(lex, raw)) return undefined;
    const tail = path.relative(lex, raw).split(path.sep);
    if (tail.length !== expected.length || tail.some((part, i) => part !== expected[i])) return undefined;
    if ((await redirectedComponent(raw, levels)) !== undefined) return undefined;
    const stateReal = await resolveStrict(lex);
    return stateReal === undefined ? undefined : { raw, real: path.join(stateReal, ...tail), levels };
  };

  /** The state dir's lexical and real forms; `real` is undefined when it cannot be resolved. */
  const stateOf = async (appId: string): Promise<{ lex: string; real: string | undefined } | undefined> => {
    if (!appStateDirOf) return undefined;
    let lex: string;
    try {
      lex = path.resolve(appStateDirOf(appId));
    } catch {
      return undefined;
    }
    return { lex, real: await resolveStrict(lex) };
  };
  let protectedRoots: Promise<string[]> | undefined;
  const protectedOf = (): Promise<string[]> =>
    (protectedRoots ??= (async () => {
      const raw = [...PROTECTED_HOME_RELATIVE.map((rel) => path.join(home, rel)), ...(config.protectedPaths ?? []).map((p) => path.resolve(p))];
      // Both the pathnames as configured and their real paths: a protected file may be a symlink.
      return [...new Set([...raw, ...(await Promise.all(raw.map(canonical)))])];
    })());
  let configProtected: Promise<string[]> | undefined;
  /** `config.protectedPaths`, as configured and as really located (the caller's roots only). */
  const configProtectedOf = (): Promise<string[]> =>
    (configProtected ??= (async () => {
      const raw = (config.protectedPaths ?? []).map((p) => path.resolve(p));
      return [...new Set([...raw, ...(await Promise.all(raw.map(canonical)))])];
    })());
  /** The state dir's lexical and real paths: always protected, bar the app's own work folder. */
  const stateRootsOf = async (appId: string): Promise<string[]> => {
    const state = await stateOf(appId);
    return state ? [...new Set([state.lex, ...(state.real !== undefined ? [state.real] : [])])] : [];
  };
  const protectedFor = async (appId: string): Promise<string[]> => [...new Set([...(await protectedOf()), ...(await stateRootsOf(appId))])];

  return {
    mode,
    ...(allowedTools ? { allowedTools } : {}),
    async allowContainedSession({ appId, agentId, model }): Promise<ContainedSessionVerdict> {
      // The cwd is not an input and `allowedCwds` is not consulted: the runner chooses `<sessionsDir>/<id>`.
      // The machine `allowedTools` and `mode` are not inputs either.
      try {
        workDirOf?.(appId); // another app's id throws, as for `allowSession`; here it is a refusal
      } catch {
        return { allowed: false, reason: `the policy does not belong to app ${JSON.stringify(appId)}` };
      }
      if (agents && !agents.has(agentId)) return { allowed: false, reason: `agent ${JSON.stringify(agentId)} is not allowed by the policy` };
      if (models) {
        const effective = model ?? config.agentModel;
        if (effective === undefined) return { allowed: false, reason: "no model is named and the policy allows only listed models" };
        if (!models.has(effective)) return { allowed: false, reason: `model ${JSON.stringify(effective)} is not allowed by the policy` };
      }
      return { allowed: true, budget: sessionBudget };
    },
    async allowSession({ appId, agentId, cwd, model }) {
      if (agents && !agents.has(agentId)) return false;
      if (models && model !== undefined && !models.has(model)) return false;
      if (!path.isAbsolute(cwd)) return false;
      workDirOf?.(appId); // an invalid app id throws, as it always has
      const homeRealResolved = await homeReal;
      const resolveFull = (p: string): Promise<Resolved | undefined | null> =>
        resolveCandidate(p, { cwdRaw: p, cwdReal: p, homeRaw: home, homeReal: homeRealResolved });
      const cwdResolved = await resolveFull(cwd);
      if (!cwdResolved) return false;
      const target = cwdResolved.real;
      const state = await stateOf(appId);
      // With a per-app state folder the policy cannot know the other apps' folders, so the
      // configured protected roots (lexical and real) are admission anchors too: a session of one
      // app never starts in, nor is rooted in, another app's folders. The own work folder stays
      // carved out below.
      const extraAnchors = appStateDirOf ? await configProtectedOf() : [];
      // A path reaches the state dir if its pathname, any link walked on the way, or its real
      // path is inside it (lexical or real state dir, case-folded).
      const touchesState = (lexical: string[], visited: string[], real: string | undefined): boolean => {
        if (!state) return false;
        const anchors = [state.lex, ...(state.real !== undefined ? [state.real] : []), ...extraAnchors];
        const all = [...lexical, ...visited, ...(real !== undefined ? [real] : [])];
        return anchors.some((a) => all.some((t) => insideFold(a, t)));
      };
      const own = await ownWorkOf(appId);
      if (touchesState(cwdResolved.lexical, cwdResolved.visited, target)) {
        if (!own || !inside(own.real, target)) return false;
      }
      let roots: string[];
      if (configuredRoots) {
        roots = [];
        for (const root of configuredRoots) {
          const r = await resolveFull(root);
          const real = r ? r.real : undefined;
          if (touchesState(r ? r.lexical : [root], r ? r.visited : [], real)) {
            // Under the state dir only the session's own work folder is a root.
            if (own && real !== undefined && real === own.real) roots.push(own.real);
            else (config.warn ?? console.warn)(`ignoring allowed directory ${JSON.stringify(root)}: it touches the app's bridge state folder or a protected path`);
          } else {
            roots.push(real ?? path.resolve(root));
          }
        }
      } else if (workDirOf) {
        if (!own) return false;
        roots = [own.real];
      } else {
        roots = [home];
      }
      for (const root of roots) {
        const rootReal = root === own?.real ? root : await canonical(root);
        if (!inside(rootReal, target)) continue;
        if (own && root === own.real) {
          // The own work folder is the admission root: it exists from the first session on.
          try {
            await ensurePrivateAppDir(own.raw, own.levels);
          } catch {
            return false;
          }
        }
        return true;
      }
      return false;
    },
    async decidePermission(info) {
      // A contained plugin session has its own decision: the machine rules below do not reach it.
      if (info.origin.kind === "plugin" && info.origin.contained === true) {
        return decideContained(info, info.origin, { pluginApprovals, auditFailed: config.auditFailed });
      }
      // Signs of a contained session (an approval set or a call budget) without the flag: fail closed, never the machine's rules.
      if (info.origin.kind === "plugin" && ((info.origin.allow?.length ?? 0) > 0 || info.origin.callsLeft !== undefined)) return rejectOnce(info);
      if (allowedTools && info.toolName !== undefined && allowedTools.includes(info.toolName)) {
        const decision = allowOnce(info);
        if (decision) return decision;
        return { action: "ask" };
      }
      switch (mode) {
        case "ask":
          return { action: "ask" };
        case "bypass":
          return allowOnce(info) ?? { action: "ask" };
        case "read-only":
        case "accept-edits": {
          const kind = info.toolKind ?? "";
          // A read or search that names no file could be reading anywhere: ask.
          const named = (info.locations?.length ?? 0) > 0;
          const prot = await protectedFor(info.appId);
          if (READ_KINDS.has(kind) && (named || kind === "think") && (await locationsInside(info, home, await homeReal, prot, kind === "think", ownWorkOf))) {
            return allowOnce(info) ?? { action: "ask" };
          }
          if (mode === "accept-edits" && EDIT_KINDS.has(kind) && named && (await locationsInside(info, home, await homeReal, prot, kind === "think", ownWorkOf))) {
            return allowOnce(info) ?? { action: "ask" };
          }
          if (mode === "read-only" && WRITE_KINDS.has(kind)) return rejectOnce(info);
          return { action: "ask" };
        }
      }
    },
  };
}
