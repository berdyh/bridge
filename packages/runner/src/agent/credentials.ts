import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { acquireLoginLease, type LoginLease } from "./login-lease.js";
import type { AgentId } from "./types.js";

export interface StagedCredentials {
  env: Record<string, string>;
  staged: boolean;
  /** Verify/persist the latest staged login. Throws on any unverified result; retain staging and lease. */
  persistRefresh?: () => Promise<void>;
  /** Release only after persistRefresh AND agent cleanup. Failed cleanup must retain the lease. */
  release?: () => Promise<void>;
}

const NONE: StagedCredentials = { env: {}, staged: false };

export class CredentialPersistenceError extends Error {
  readonly code = "AGENT_LOGIN_PERSISTENCE_UNVERIFIED";
  constructor(reason: string) {
    super(`Agent credential persistence could not be verified: ${reason}; retain the private session folder and login lease for recovery`);
    this.name = "CredentialPersistenceError";
  }
}

export interface CredentialSources {
  homedir: string;
  env: Record<string, string | undefined>;
  /**
   * Explicit credential file per agent. The bridge CLI always sets both entries, to bridge's own
   * copies under `<config>/bridge/agents/<agent>/`. Staging and refresh need the entry: an agent
   * with none stages nothing (the home default `~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR`,
   * `$CODEX_HOME` is never staged from, nor written back to). When set, it is the only file read
   * and the only file a refresh is written back to: a missing or invalid file stages nothing.
   * A file that is a symlink, or that sits in a symlinked folder, is refused (it could point
   * outside bridge's folder). Only `exportAgentLogin` reads the home default, once, on request.
   */
  authFiles?: Partial<Record<AgentId, string>>;
}

/** Where an agent keeps its own login: the explicit `authFiles` entry, else the home default (a read-only location for `exportAgentLogin`). */
export function resolveAgentAuthFile(agent: AgentId, src: CredentialSources): string {
  const explicit = src.authFiles?.[agent];
  if (explicit) return explicit;
  if (agent === "codex-cli") {
    return path.join(src.env.CODEX_HOME || path.join(src.homedir, ".codex"), "auth.json");
  }
  return path.join(src.env.CLAUDE_CONFIG_DIR || path.join(src.homedir, ".claude"), ".credentials.json");
}

async function writePrivate(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { encoding: "utf8", mode: 0o600 });
}

/** Per-file mutex: write-backs to one credential file never interleave. */
const fileLocks = new Map<string, Promise<unknown>>();

async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  fileLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  }
}

/** Whether `p` exists and is a symlink itself (not what it points at). */
async function isSymlink(p: string): Promise<boolean> {
  return (await lstat(p).catch(() => undefined))?.isSymbolicLink() === true;
}

/**
 * Whether `file` may be read or refreshed as bridge's own login: neither it nor the two folders
 * bridge itself creates above it (`agents/<agent>/`) is a symlink, so a read or write-back never
 * lands outside bridge's folder. The CLI refuses the same levels before it writes. Folders above
 * those (the config dir, which dotfiles setups link) may be links.
 */
async function isConfined(file: string): Promise<boolean> {
  const dir = path.dirname(file);
  return !(await isSymlink(file)) && !(await isSymlink(dir)) && !(await isSymlink(path.dirname(dir)));
}

/**
 * The agents' own folders bridge never reads a staged login from nor writes: `~/.claude`,
 * `~/.codex`, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME` (as named). The CLI uses the same list.
 */
export function agentOwnDirs(src: Pick<CredentialSources, "homedir" | "env">): string[] {
  // Made absolute but not normalized: `..` is resolved against the real path by resolveProtectedDir.
  const dirs = [rawJoin(src.homedir, ".claude"), rawJoin(src.homedir, ".codex")];
  for (const value of [src.env.CLAUDE_CONFIG_DIR, src.env.CODEX_HOME]) if (value) dirs.push(rawAbsolute(value));
  return dirs;
}

/** `p` made absolute without collapsing `.` or `..` (path.resolve would, before any link is followed). */
const rawAbsolute = (p: string): string => (path.isAbsolute(p) ? p : `${process.cwd()}${path.sep}${p}`);
const rawJoin = (dir: string, name: string): string => `${rawAbsolute(dir).replace(/[\\/]+$/, "")}${path.sep}${name}`;

const MAX_LINK_HOPS = 40;

/**
 * Where a protected folder really is, or would be once created: every component resolved in order,
 * as the kernel does (`..` after a link goes up from the link's target), the last one included, and a dangling link followed through its readlink text (a missing target is
 * completed lexically below its nearest existing ancestor). `null` when it cannot be resolved (a
 * link loop past MAX_LINK_HOPS, an unreadable link, a non-folder in the way, `..` below a missing
 * component); a login step then refuses.
 *
 * Why this differs from the CLI's consent-plan `canonicalPath`: that one resolves a destination
 * bridge is about to write, so it refuses a dangling ancestor (bridge never writes through one)
 * and does not follow the last component (a link that is the target stays a link). A protected
 * folder is never written; it is resolved to know where it really is, so a dangling `~/.claude`
 * link must count as the place it points at, which is where the agent would create it.
 */
export async function resolveProtectedDir(p: string): Promise<string | null> {
  // POSIX order: component by component from the raw path, `..` taken against the real path
  // resolved so far (a link followed first), never collapsed lexically up front.
  const abs = rawAbsolute(p);
  const root = path.parse(abs).root;
  let pending = abs.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  let hops = 0;
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (name === ".") continue;
    if (name === "..") {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, name);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      // Missing from here on: complete it lexically, which needs no `..` left to undo.
      if (pending.includes("..")) return null;
      return path.join(next, ...pending);
    }
    if (info.isSymbolicLink()) {
      if (++hops > MAX_LINK_HOPS) return null;
      const target = await readlink(next).catch(() => undefined);
      if (target === undefined) return null;
      if (path.isAbsolute(target)) current = path.parse(target).root;
      pending = [...target.split(path.sep).filter(Boolean), ...pending];
      continue;
    }
    if (pending.length > 0 && !info.isDirectory()) return null;
    current = next;
  }
  return current;
}

/** A protected folder as named and where it really is (`null`: unresolvable). The same shape as a layout snapshot's dirs. */
export interface ProtectedDir {
  path: string;
  real: string | null;
}

/** `agentOwnDirs`, each with `resolveProtectedDir`. */
export function resolvedAgentOwnDirs(src: Pick<CredentialSources, "homedir" | "env">): Promise<ProtectedDir[]> {
  return Promise.all(agentOwnDirs(src).map(async (p) => ({ path: p, real: await resolveProtectedDir(p) })));
}

const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/**
 * Rule A for logins: the first of bridge's login folders (`dirs`, canonical) that is equal to,
 * inside, or contains a protected folder, with that folder; an unresolvable protected folder
 * overlaps everything. `undefined` when they are all apart. No carve-out for deliberate aliases.
 */
export function agentOwnDirOverlap(dirs: readonly string[], owns: readonly ProtectedDir[]): { dir: string; own: ProtectedDir } | undefined {
  for (const own of owns) {
    for (const dir of dirs) {
      if (own.real === null || own.real === dir || isInside(own.real, dir) || isInside(dir, own.real)) return { dir, own };
    }
  }
  return undefined;
}

/** Whether a login file at canonical `file` (in `<agents>/<agent>/`) is clear of every protected folder. */
async function apartFromAgentOwnDirs(file: string, src: Pick<CredentialSources, "homedir" | "env">): Promise<boolean> {
  const agentDir = path.dirname(file);
  return agentOwnDirOverlap([path.dirname(agentDir), agentDir], await resolvedAgentOwnDirs(src)) === undefined;
}

/** Where `file` really is: its folder resolved with realpath, its last component as named (never followed). */
async function canonicalFile(file: string): Promise<string | undefined> {
  const dir = await realpath(path.dirname(file)).catch(() => undefined);
  return dir === undefined ? undefined : path.join(dir, path.basename(file));
}

/**
 * Serialised write-back to the canonical login file bound at staging, never through a symlink.
 * The one check at write time: `source` is still confined and still resolves to `canonical`.
 * `compute` returns the verified latest login (the current string for a verified no-op), or
 * throws. A skipped/unreadable/stale write must never look like permission to discard staging.
 */
async function updatePrivate(
  source: string,
  canonical: string,
  compute: (current: string) => string,
): Promise<void> {
  await withFileLock(canonical, async () => {
    if (!(await isConfined(source)) || (await canonicalFile(source)) !== canonical) throw new CredentialPersistenceError("login path became unsafe or moved");
    const current = await readFile(canonical, "utf8").catch(() => undefined);
    if (current === undefined) throw new CredentialPersistenceError("canonical login is missing or unreadable");
    const next = compute(current);
    const verifyLatest = async () => {
      if (!(await isConfined(source)) || (await canonicalFile(source)) !== canonical || await readFile(canonical, "utf8").catch(() => undefined) !== next) {
        throw new CredentialPersistenceError("latest login could not be read back from its canonical path");
      }
    };
    if (next === current) { await verifyLatest(); return; }
    const tmp = `${canonical}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, next, { encoding: "utf8", mode: 0o600 });
      if (!(await isConfined(source)) || (await canonicalFile(source)) !== canonical) throw new CredentialPersistenceError("login path became unsafe or moved");
      await rename(tmp, canonical);
      await verifyLatest();
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

function parseObject(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  return parseObject(await readFile(file, "utf8").catch(() => undefined));
}

function validCodex(raw: string): boolean {
  try {
    const t = (JSON.parse(raw) as { tokens?: { access_token?: unknown } })?.tokens?.access_token;
    return typeof t === "string" && t.length > 0;
  } catch {
    return false;
  }
}

function validClaudeOauth(v: unknown): boolean {
  const t = v && typeof v === "object" ? (v as { accessToken?: unknown }).accessToken : undefined;
  return typeof t === "string" && t.length > 0;
}

/**
 * Stage only the agent's login file (`src.authFiles[agent]`, bridge's own copy; nothing is staged
 * without it, from a symlink, from a symlinked folder, or from a file that really lies inside an
 * agent's own folder, `agentOwnDirOverlap`) into the throwaway dir and point
 * the agent's config-dir env var at the copy. Codex: auth.json verbatim.
 * Claude: only the `claudeAiOauth` block (the file also holds unrelated MCP
 * tokens that must not enter the sandbox).
 */
export async function stageAgentCredentials(
  agent: AgentId,
  tempDir: string,
  src: CredentialSources,
): Promise<StagedCredentials> {
  // Only an explicit login file is staged: no home default, and no symlink out of its folder.
  const named = src.authFiles?.[agent];
  if (!named || !(await isConfined(named))) return NONE;
  // Bound here: where the login really is. One whose folders overlap an agent's own folder (an
  // ancestor such as the config dir linked there) is never staged, so never refreshed into.
  const source = await canonicalFile(named);
  if (source === undefined || !(await apartFromAgentOwnDirs(source, src))) return NONE;

  // Missing/invalid logins retain the existing unauthenticated behavior. Read again under the
  // lease: another app may finish rotating the login between this check and acquisition.
  if (!(await agentLoginPresent(agent, source))) return NONE;
  const lease = await acquireLoginLease(source);
  try {
    if (!(await isConfined(named)) || (await canonicalFile(named)) !== source) {
      await lease.release();
      return NONE;
    }
    const staged = await stageLeasedCredentials(agent, tempDir, named, source, lease);
    if (!staged.staged) await lease.release();
    return staged;
  } catch (error) {
    // Staging failed before any agent could receive the login. Avoid leaking an ordinary lease.
    await lease.release();
    throw error;
  }
}

async function stageLeasedCredentials(
  agent: AgentId,
  tempDir: string,
  named: string,
  source: string,
  lease: LoginLease,
): Promise<StagedCredentials> {
  if (agent === "codex-cli") {
    const raw = await readFile(source, "utf8").catch(() => undefined);
    if (!raw || !validCodex(raw)) return NONE;
    const home = path.join(tempDir, "codex-home");
    const staged = path.join(home, "auth.json");
    await writePrivate(staged, raw);
    return {
      env: { CODEX_HOME: home },
      staged: true,
      release: lease.release,
      persistRefresh: async () => {
        if (!(await isConfined(named)) || (await canonicalFile(named)) !== source) throw new CredentialPersistenceError("login path became unsafe or moved");
        await lease.assertOwned();
        const refreshed = await readFile(staged, "utf8").catch(() => undefined);
        if (!refreshed || !validCodex(refreshed)) throw new CredentialPersistenceError("staged login is missing, unreadable or invalid");
        await updatePrivate(named, source, (current) => {
          if (current === refreshed) return current;
          if (current !== raw) throw new CredentialPersistenceError("canonical login changed from the staged base");
          return refreshed;
        });
      },
    };
  }

  const oauth = (await readJsonObject(source))?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || !validClaudeOauth(oauth)) return NONE;
  const dir = path.join(tempDir, "claude-home");
  const staged = path.join(dir, ".credentials.json");
  const original = JSON.stringify(oauth);
  await writePrivate(staged, JSON.stringify({ claudeAiOauth: oauth }));
  return {
    env: { CLAUDE_CONFIG_DIR: dir },
    staged: true,
    release: lease.release,
    persistRefresh: async () => {
      if (!(await isConfined(named)) || (await canonicalFile(named)) !== source) throw new CredentialPersistenceError("login path became unsafe or moved");
      await lease.assertOwned();
      const refreshed = (await readJsonObject(staged))?.claudeAiOauth;
      if (!validClaudeOauth(refreshed)) throw new CredentialPersistenceError("staged login is missing, unreadable or invalid");
      await updatePrivate(named, source, (raw) => {
        const current = parseObject(raw);
        if (!current || !validClaudeOauth(current.claudeAiOauth)) throw new CredentialPersistenceError("canonical login is invalid");
        if (JSON.stringify(current.claudeAiOauth) === JSON.stringify(refreshed)) return raw;
        if (JSON.stringify(current.claudeAiOauth) !== original) throw new CredentialPersistenceError("canonical login changed from the staged base");
        return JSON.stringify({ ...current, claudeAiOauth: refreshed });
      });
    },
  };
}

/**
 * The minimal login bridge keeps for `agent`, read once from where the person's own agent keeps
 * it (`resolveAgentAuthFile(agent, src)`; pass no `authFiles` to read the home default). Codex:
 * `auth.json` verbatim. Claude: `{ "claudeAiOauth": ... }` only, so MCP tokens and anything else
 * in the file never leave it. `undefined` when the file is missing or holds no usable login.
 * Never writes `src`.
 */
export async function exportAgentLogin(agent: AgentId, src: CredentialSources): Promise<string | undefined> {
  const source = resolveAgentAuthFile(agent, src);
  if (agent === "codex-cli") {
    const raw = await readFile(source, "utf8").catch(() => undefined);
    return raw && validCodex(raw) ? raw : undefined;
  }
  const oauth = (await readJsonObject(source))?.claudeAiOauth;
  return validClaudeOauth(oauth) ? JSON.stringify({ claudeAiOauth: oauth }) : undefined;
}

/**
 * Whether `file` holds a usable login for `agent` (what `stageAgentCredentials` would stage: a
 * symlinked file or folder does not count; with `src`, neither does one that really lies inside
 * an agent's own folder).
 */
export async function agentLoginPresent(agent: AgentId, file: string, src?: Pick<CredentialSources, "homedir" | "env">): Promise<boolean> {
  if (!(await isConfined(file))) return false;
  if (src !== undefined) {
    const canonical = await canonicalFile(file);
    if (canonical === undefined || !(await apartFromAgentOwnDirs(canonical, src))) return false;
  }
  if (agent === "codex-cli") {
    const raw = await readFile(file, "utf8").catch(() => undefined);
    return raw !== undefined && validCodex(raw);
  }
  return validClaudeOauth((await readJsonObject(file))?.claudeAiOauth);
}
