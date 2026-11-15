/**
 * What an ACP adapter needs to run one agent contained, independent of the agent: the shape a profile
 * module (claude: `claude.ts`) fills, the per-session empty cwd, and the `session/new` params built from a
 * `ContainmentRequest`. The generic adapter (`../adapters.ts`) calls these and knows nothing about claude.
 */
import { lstat, mkdir, rm, chmod } from "node:fs/promises";
import path from "node:path";

import { SESSION_SECRET_FILE_PLACEHOLDER, substituteArgPlaceholders } from "@berdyh/bridge-protocol";

import { redirectedComponent } from "../../sandbox/index.js";
import { ContainmentRefused, type ContainmentRefusalReason, type AgentProcess, type ContainmentProfile, type ContainmentRequest } from "../contracts.js";

import { isServerFileName, isSessionId } from "./secret.js";

/** The ACP adapter an `AcpAgentAdapter` resolved: where it is and where it came from. */
export interface ContainmentAdapterCommand {
  command: string;
  source: "bundled" | "path";
}

/** How a contained session of one agent is launched. Everything here was checked by the profile module. */
export interface ContainedLaunch {
  readonly profile: ContainmentProfile;
  /** The process to start in place of the resolved adapter command (the pin-checked adapter, run by the runner's Node). */
  readonly command: string;
  readonly args: readonly string[];
  /** Env the runner forces last (claude: `CLAUDE_CODE_EXECUTABLE` = the pin-checked binary). */
  readonly env: Record<string, string>;
  /** The `_meta` of `session/new` for a request. */
  sessionMeta(request: Pick<ContainmentRequest, "model">): Record<string, unknown>;
}

/** What makes an adapter able to run contained: decided for the adapter command in use, at the moment of the spawn. */
export interface AcpContainmentSupport {
  /** The launch for `adapter`, or the reason this adapter and binary cannot run contained (a detail for the local log; `reason` is set when the cause has a fixed code that may reach the caller). */
  resolve(adapter: ContainmentAdapterCommand | undefined): { launch: ContainedLaunch } | { unavailable: string; reason?: ContainmentRefusalReason };
}

/** The request after the adapter checked it: safe names, absolute command paths. */
export function checkContainmentRequest(request: ContainmentRequest, cwd: string): void {
  const bad = (detail: string): never => {
    throw new ContainmentRefused(detail);
  };
  if (!isSessionId(request.sessionId)) bad("the session id is not a runner-minted id");
  if (!path.isAbsolute(cwd) || path.resolve(cwd) !== cwd || path.basename(cwd) !== request.sessionId) bad("the session cwd is not <sessions dir>/<session id> in normal form");
  if (request.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.model)) bad("the model id is not a plain id");
  const seen = new Set<string>();
  for (const server of request.servers) {
    if (!isServerFileName(server.name)) bad("a server name is not a plain name");
    if (seen.has(server.name)) bad("a server is declared twice");
    seen.add(server.name);
    if (!path.isAbsolute(server.command)) bad("a server command is not an absolute path");
    if (!Array.isArray(server.args) || server.args.some((a) => typeof a !== "string")) bad("a server's args are not strings");
  }
  for (const name of request.allow) if (typeof name !== "string") bad("the approval set holds a non-string");
}

/** True when any argument of `server` holds the secret-file placeholder. */
export function usesSecretFile(server: { args: readonly string[] }): boolean {
  return server.args.some((a) => a.includes(SESSION_SECRET_FILE_PLACEHOLDER));
}

/**
 * The `session/new` params besides `cwd`: the declared servers (no `env` entry: the secret is a file) and the
 * profile's `_meta`. `secretFiles` maps a server name to its secret file; `${SESSION_SECRET_FILE}` becomes that
 * path (single pass). Other text in `args` is left as it is (`${PLUGIN_DATA}` was resolved by the host).
 */
export function sessionNewOf(
  request: ContainmentRequest,
  secretFiles: ReadonlyMap<string, string>,
  meta: Record<string, unknown>,
): NonNullable<AgentProcess["sessionNew"]> {
  const mcpServers = request.servers.map((server) => {
    const file = secretFiles.get(server.name);
    if (usesSecretFile(server) && file === undefined) throw new ContainmentRefused("a server asks for the secret file but the session has no secret");
    return {
      name: server.name,
      command: server.command,
      args: server.args.map((arg) => substituteArgPlaceholders(arg, { secretFile: file ?? "", pluginData: "${PLUGIN_DATA}" })),
      env: [] as [],
    };
  });
  return { mcpServers, _meta: meta };
}

/** The runner-owned tail of a session cwd that must be link-free: `bridge/sessions/<id>`. */
export const SESSION_DIR_LEVELS = 3;

/**
 * Creates the session's empty cwd, private (0700). Refuses when `cwd` is not an absolute path in normal form
 * (`path.resolve(cwd) === cwd`: the child must start in the very path that was verified), when it exists, when
 * any of `bridge`, `<sessions dir>` or the directory itself is a link (checked before and after creation, whatever
 * sandbox parent the adapter uses), or when the result is not an empty private directory. A
 * missing sessions dir is created 0700. Returns the verified `dir` (the cwd to start the child in) and a `remove`
 * that deletes only what this call created.
 */
export async function createEmptySessionDir(cwd: string): Promise<{ dir: string; remove(): Promise<void> }> {
  const dir = cwd;
  const refuse = (detail: string): never => {
    throw new ContainmentRefused(detail);
  };
  if (!path.isAbsolute(dir) || path.resolve(dir) !== dir) refuse("the session cwd is not an absolute path in normal form");
  if ((await redirectedComponent(dir, SESSION_DIR_LEVELS)) !== undefined) refuse("the session cwd or a runner-owned folder above it is a link");
  try {
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    return refuse(`cannot create the session cwd: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  // A failed removal must reach the adapter's cleanup gate. Swallowing it would
  // release staged-login protection while this session's files still exist.
  const remove = () => rm(dir, { recursive: true, force: true });
  try {
    await chmod(dir, 0o700);
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) refuse("the session cwd is not a plain directory");
    if ((await redirectedComponent(dir, SESSION_DIR_LEVELS)) !== undefined) refuse("the session cwd or a runner-owned folder above it is a link");
  } catch (error) {
    await remove();
    throw error instanceof ContainmentRefused ? error : new ContainmentRefused("cannot verify the session cwd");
  }
  return { dir, remove };
}
