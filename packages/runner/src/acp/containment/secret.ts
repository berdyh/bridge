/**
 * The session secret as a file: never in an env map, an argv, an ACP frame or a log. The plugin's
 * MCP server gets the file's path through `${SESSION_SECRET_FILE}` and reads it itself.
 *
 * Layout: `<app tmp>/bridge-acp-secrets-<session id>/<server>`, a sibling of the session's sandbox
 * (`<app tmp>/bridge-acp-<random>`), so it lies outside every directory the child's env names (`HOME`,
 * `TMPDIR`, the XDG dirs, `CLAUDE_CONFIG_DIR`) and outside the session's cwd. The directory is created
 * with a plain `mkdir` (it fails if the name exists: the session id is a fresh random UUID) at 0700, each file
 * with `O_EXCL | O_NOFOLLOW` at 0600.
 */
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";

import { ContainmentRefused } from "../contracts.js";

/** A declared server's name as the manifest allows it (`MCP_SERVER_NAME` in the protocol package): a safe file name. */
const SERVER_FILE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** A session id the runner minted (a UUID); it becomes part of a directory name, so nothing else is accepted. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

export function isServerFileName(name: string): boolean {
  return SERVER_FILE_NAME.test(name);
}

/** The directory of a session's secret files inside the app's tmp dir. */
export function secretDirOf(appTmp: string, sessionId: string): string {
  if (!isSessionId(sessionId)) throw new ContainmentRefused("the session id is not a safe directory name");
  return path.join(appTmp, `bridge-acp-secrets-${sessionId}`);
}

/** True when `child` is `parent` or lies below it. Lexical: both are absolute paths the runner built. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || !(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel));
}

export interface SessionSecretFiles {
  /** The secret directory (removed by `remove`). */
  readonly dir: string;
  /** Server name to the file that holds the secret for it. */
  readonly files: ReadonlyMap<string, string>;
  /** Removes the directory and its files. Idempotent, never throws. */
  remove(): Promise<void>;
}

/**
 * Writes `secret` once per server in `servers` into a new private directory. Refuses (ContainmentRefused)
 * when the directory lies inside one of `keepOut` (the child's HOME, TMPDIR, XDG dirs, config dir and cwd),
 * when it already exists or is not a plain directory afterwards, or when a server name is not a safe file
 * name. On any failure the directory is removed before the error leaves. The caller zeroes `secret`.
 */
export async function writeSessionSecrets(
  appTmp: string,
  sessionId: string,
  servers: readonly string[],
  secret: Uint8Array,
  keepOut: readonly string[],
): Promise<SessionSecretFiles> {
  const dir = secretDirOf(appTmp, sessionId);
  const absolute = path.resolve(dir);
  for (const out of keepOut) {
    if (isInside(absolute, path.resolve(out))) throw new ContainmentRefused("the secret directory would lie inside a directory the agent's env names");
  }
  for (const name of servers) {
    if (!isServerFileName(name)) throw new ContainmentRefused("a server name is not a safe secret file name");
  }
  if (new Set(servers).size !== servers.length) throw new ContainmentRefused("a server is declared twice");

  const remove = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  // Not recursive: it fails if the name exists, so a planted directory or link is never reused (and never removed).
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    throw new ContainmentRefused(`cannot create the session secret directory: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  try {
    await chmod(dir, 0o700);
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new ContainmentRefused("the secret directory is not a private directory");
    const files = new Map<string, string>();
    for (const name of servers) {
      const file = path.join(dir, name);
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.chmod(0o600);
        await handle.write(secret, 0, secret.length, 0);
      } finally {
        await handle.close();
      }
      files.set(name, file);
    }
    return { dir, files, remove };
  } catch (error) {
    await remove();
    if (error instanceof ContainmentRefused) throw error;
    throw new ContainmentRefused(`cannot write the session secret file: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
}
