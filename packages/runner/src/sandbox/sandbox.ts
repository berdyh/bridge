import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";

export interface EnvPolicy {
  /** Parent-env keys copied through (in addition to the defaults). */
  allow?: string[];
  /** Key patterns (`*` wildcard, case-insensitive) always stripped. Deny wins over allow. */
  deny?: string[];
}

export const DEFAULT_ENV_ALLOW = ["PATH", "SHELL", "TERM", "USER", "LOGNAME", "LANG", "LC_ALL"];

export const DEFAULT_ENV_DENY = [
  "*_KEY",
  "*_KEY_*",
  "*TOKEN*",
  "*SECRET*",
  "*PASSWORD*",
  "*CREDENTIAL*",
  "DATABASE_URL",
  "*_DSN",
  "AWS_*",
  "SSH_*",
];

/** Set by the sandbox itself; a policy can never override them. */
export const SANDBOX_KEYS = new Set([
  "HOME",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
]);

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** Build the child's env: sandbox dirs, then allowlisted parent keys minus the denylist. */
export function buildAgentEnv(
  tempDir: string,
  parentEnv: Record<string, string | undefined>,
  policy: EnvPolicy = {},
): Record<string, string> {
  const deny = [...DEFAULT_ENV_DENY, ...(policy.deny ?? [])].map(globToRegExp);
  const env: Record<string, string> = {
    NO_COLOR: "1",
    HOME: path.join(tempDir, "home"),
    TMPDIR: tempDir,
    XDG_CONFIG_HOME: path.join(tempDir, "xdg-config"),
    XDG_CACHE_HOME: path.join(tempDir, "xdg-cache"),
    XDG_DATA_HOME: path.join(tempDir, "xdg-data"),
  };
  for (const key of [...DEFAULT_ENV_ALLOW, ...(policy.allow ?? [])]) {
    if (SANDBOX_KEYS.has(key)) continue;
    const value = parentEnv[key];
    if (value === undefined) continue;
    if (deny.some((re) => re.test(key))) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Env keys a contained spawn never carries, whatever `envPolicy.allow` says. They are the only inputs to the
 * claude command line that an app's `config.json` or the service environment can change after CI asserted the
 * argv: `CLAUDE_MODEL_CONFIG` adds a `--settings` file, `MAX_THINKING_TOKENS` a `--thinking*` flag,
 * `NODE_OPTIONS` code for the adapter, `DEBUG_CLAUDE_AGENT_SDK` a `--debug*` flag.
 */
export const CONTAINED_ENV_DENY: readonly string[] = ["CLAUDE_MODEL_CONFIG", "MAX_THINKING_TOKENS", "NODE_OPTIONS", "DEBUG_CLAUDE_AGENT_SDK"];

/**
 * `buildAgentEnv` for a contained spawn: the same sandbox dirs and allow-list, with `CONTAINED_ENV_DENY` stripped
 * even when the policy allows them, the staged credential vars next, and `containmentEnv` (the runner's own
 * values, for example the pin-checked `CLAUDE_CODE_EXECUTABLE`) last, so nothing before it can override it.
 */
export function buildContainedAgentEnv(
  tempDir: string,
  parentEnv: Record<string, string | undefined>,
  policy: EnvPolicy | undefined,
  stagedEnv: Record<string, string>,
  containmentEnv: Record<string, string>,
): Record<string, string> {
  const base = buildAgentEnv(tempDir, parentEnv, { ...policy, deny: [...(policy?.deny ?? []), ...CONTAINED_ENV_DENY] });
  const env = { ...base, ...stagedEnv, ...containmentEnv };
  for (const key of Object.keys(env)) {
    if (CONTAINED_ENV_DENY.some((denied) => denied.toLowerCase() === key.toLowerCase())) delete env[key];
  }
  return env;
}

export async function prepareRunDirs(tempDir: string): Promise<void> {
  await Promise.all(
    ["home", "xdg-config", "xdg-cache", "xdg-data"].map((d) =>
      mkdir(path.join(tempDir, d), { recursive: true }),
    ),
  );
}

/**
 * Creates `dir` (and missing parents) private to the user, mode 0700, and makes sure `dir`
 * itself is 0700 even when it already existed. Used for the per-app work and sandbox-parent
 * folders under the runner's state dir.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/**
 * The per-app tail that must not be redirected: `bridge/<work|tmp>`, two levels (the app's own
 * `<state>/<app>` parent may be a link).
 */
export const APP_DIR_LEVELS = 2;
const PER_APP_LEVELS = APP_DIR_LEVELS;

/**
 * The first symlink among the last `levels` components of `dir` (`bridge` and `work` or
 * `tmp` for the default), or `undefined` when none of them is one. Components that do not exist
 * yet (ENOENT only) are fine; they will be created as real directories. Anything above them (the state dir
 * and its parents) is the trust anchor and may be reached through links, as `~/.local` often is.
 * Any other lstat failure counts as a redirect: fail closed.
 */
export async function redirectedComponent(dir: string, levels = PER_APP_LEVELS): Promise<string | undefined> {
  const abs = path.resolve(dir);
  const parts = abs.split(path.sep).filter((c) => c !== "");
  const prefixes: string[] = [];
  for (let i = Math.max(1, parts.length - levels + 1); i <= parts.length; i++) {
    prefixes.push(path.parse(abs).root + parts.slice(0, i).join(path.sep));
  }
  for (const prefix of prefixes) {
    try {
      if ((await lstat(prefix)).isSymbolicLink()) return prefix;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return prefix;
    }
  }
  return undefined;
}

/**
 * `ensurePrivateDir` for a per-app folder (`<state>/<app>/bridge/<work|tmp>`, `levels` 2): refuses
 * to create or use it when `bridge` or the folder itself is a symlink, so a planted link cannot move an app's sandboxes
 * (or work folder) to another place such as `/tmp`, another app's folder or the state dir. Checked
 * before and after creation. Missing parents are created 0700; an existing parent's mode is
 * never changed (bridge does not own `<state>/<app>`).
 */
export async function ensurePrivateAppDir(dir: string, levels = PER_APP_LEVELS): Promise<void> {
  const before = await redirectedComponent(dir, levels);
  if (before !== undefined) throw new Error(`refusing a redirected per-app folder: ${before} is a symlink`);
  await ensurePrivateDir(dir);
  const after = await redirectedComponent(dir, levels);
  if (after !== undefined) throw new Error(`refusing a redirected per-app folder: ${after} is a symlink`);
}
