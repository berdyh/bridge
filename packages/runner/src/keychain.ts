import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { CredentialStore } from "@berdyh/bridge-pairing";

import type { CommandRunner, Platform } from "./contracts.js";
import { isSanitized } from "./keychain-sanitized.js";

export class KeychainError extends Error {
  constructor(
    message: string,
    readonly cause_?: unknown,
  ) {
    super(message);
    this.name = "KeychainError";
  }
}

export interface KeychainOptions {
  platform: Platform;
  run: CommandRunner;
  /** Keychain service / secret-tool "service" attribute, e.g. "berdyh-<app>". */
  service: string;
  /** Human label shown by keychain UIs (Linux only). */
  label?: string;
}

/**
 * CredentialStore over the OS keychain, driven through its CLI.
 * Linux: libsecret `secret-tool` (secret goes over stdin). macOS: `security -i`
 * reads its commands from stdin, so the secret never appears in argv (`ps`).
 */
export function createKeychainCredentialStore(opts: KeychainOptions): CredentialStore {
  return opts.platform === "linux" ? linuxStore(opts) : macStore(opts);
}

async function exec(
  opts: KeychainOptions,
  command: string,
  args: string[],
  stdin?: string,
  /** macOS: the process may have printed the stored value or echoed the secret, so a failure keeps neither text nor cause. */
  outputFree = false,
) {
  try {
    return await opts.run(command, args, stdin === undefined ? undefined : { stdin });
  } catch (error) {
    // Only the facade's own sanitized typed error (marked in keychain-access.ts) carries fixed text.
    if (outputFree && isSanitized(error)) throw error;
    // Anything else, a KeychainError built by the runner included, may quote what the child printed.
    if (outputFree) throw new KeychainError(`could not run ${command}`);
    throw new KeychainError(`could not run ${command}: ${(error as Error).message}`, error);
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A lone surrogate would reach the store CLI as U+FFFD: a different key or secret. Refuse before dispatch. */
function requireWellFormed(...texts: string[]): void {
  if (texts.some((t) => LONE_SURROGATE.test(t))) throw new KeychainError("key, service or value is not well-formed Unicode text");
}

function linuxStore(opts: KeychainOptions): CredentialStore {
  const attrs = (key: string) => ["service", opts.service, "account", key];
  return {
    async get(key) {
      requireWellFormed(key, opts.service);
      const r = await exec(opts, "secret-tool", ["lookup", ...attrs(key)]);
      if (r.exitCode === 0) return r.stdout;
      // secret-tool exits 1 with no output when the item does not exist.
      if (r.exitCode === 1 && r.stderr.trim() === "") return null;
      throw new KeychainError(`secret-tool lookup failed (${r.exitCode}): ${r.stderr.trim()}`);
    },
    async set(key, value) {
      requireWellFormed(key, value, opts.service, opts.label ?? "");
      const label = opts.label ?? `${opts.service} ${key}`;
      const r = await exec(
        opts,
        "secret-tool",
        ["store", `--label=${label}`, ...attrs(key)],
        value,
      );
      if (r.exitCode !== 0) {
        throw new KeychainError(`secret-tool store failed (${r.exitCode}): ${r.stderr.trim()}`);
      }
    },
    async delete(key) {
      requireWellFormed(key, opts.service);
      const r = await exec(opts, "secret-tool", ["clear", ...attrs(key)]);
      if (r.exitCode !== 0 && r.stderr.trim() !== "") {
        throw new KeychainError(`secret-tool clear failed (${r.exitCode}): ${r.stderr.trim()}`);
      }
    },
  };
}

/**
 * Quote one token for `security -i`'s parser: double quotes, with backslash and
 * double quote escaped. Line breaks and NUL cannot be represented, so reject.
 */
function securityQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new KeychainError("value contains a line break or NUL; cannot store it via security -i");
  }
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

const MAC_NOT_FOUND = 44; // errSecItemNotFound
/**
 * `security -i` reads commands through a 4096-byte buffer (measured on macOS 26.5.1): a longer
 * line is split, its head may store a truncated secret and its tail runs as a separate command.
 * 4095 bytes plus the newline is the longest line that runs as one command with no stderr.
 */
export const MAC_SECURITY_LINE_MAX = 4095;

/**
 * The part of a `find-generic-password -g` stderr that cannot hold the stored value: everything before
 * the first `password:` line (the value, even a multi-line one, and the attributes follow it). A failed
 * or killed process may have printed the value, so only this part may be read as a diagnosis or quoted.
 */
export function macDiagnostic(stderr: string): string {
  const at = /^password:/m.exec(stderr);
  return at === null ? stderr : stderr.slice(0, at.index);
}

/**
 * Value of the `password:` line `security find-generic-password -g` prints on stderr:
 * `password: ` (empty), `password: "<raw text>"`, or `password: 0x<HEX>  "<escaped>"` for data
 * that is not plain printable text. `-w` prints either raw text or bare hex with no marker,
 * so a stored `deadbeef` and a non-ASCII value hex-dumped as `deadbeef` cannot be told apart.
 */
export function parseMacPasswordLine(stderr: string): string {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith("password:"));
  if (line === undefined) throw new KeychainError("security find printed no password line");
  const rest = line.slice("password:".length);
  if (rest === "" || rest === " ") return "";
  const hex = /^ 0x([0-9A-Fa-f]*)(?: *| +".*")$/.exec(rest);
  if (hex) {
    if (hex[1]!.length % 2 !== 0) throw new KeychainError("security find printed odd-length hex");
    try {
      // ignoreBOM: a stored value that starts with U+FEFF keeps it.
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(hex[1]!, "hex"));
    } catch (error) {
      throw new KeychainError("keychain item is not UTF-8 text");
    }
  }
  if (rest.length >= 3 && rest.startsWith(' "') && rest.endsWith('"')) return rest.slice(2, -1);
  throw new KeychainError("security find printed an unrecognized password line");
}

function macStore(opts: KeychainOptions): CredentialStore {
  const base = (key: string) => ["-a", key, "-s", opts.service];
  return {
    async get(key) {
      requireWellFormed(key, opts.service);
      const r = await exec(opts, "security", ["find-generic-password", ...base(key), "-g"], undefined, true);
      if (r.exitCode === 0) return parseMacPasswordLine(r.stderr);
      // -g prints the value on stderr, and a killed process may have printed it before a nonzero exit:
      // never read it as a diagnosis and never put any of this stderr into the error.
      if (r.exitCode === MAC_NOT_FOUND || /could not be found/i.test(macDiagnostic(r.stderr))) return null;
      throw new KeychainError(`security find failed (${r.exitCode})`);
    },
    async set(key, value) {
      requireWellFormed(key, value, opts.service);
      const line = [
        "add-generic-password",
        "-U",
        "-a",
        securityQuote(key),
        "-s",
        securityQuote(opts.service),
        "-w",
        securityQuote(value),
      ].join(" ");
      if (Buffer.byteLength(line) > MAC_SECURITY_LINE_MAX) {
        throw new KeychainError(`key, service and value are too long for security -i (${MAC_SECURITY_LINE_MAX}-byte command line)`);
      }
      const r = await exec(opts, "security", ["-i"], `${line}\n`, true);
      // In interactive mode a failing command may not change the exit status,
      // so any stderr output also counts as failure.
      if (r.exitCode !== 0 || r.stderr.trim() !== "") {
        // Never quote it: `security -i` was fed the secret on stdin, and its output is not proven free of it.
        throw new KeychainError(`security add failed (${r.exitCode})`);
      }
    },
    async delete(key) {
      requireWellFormed(key, opts.service);
      const r = await exec(opts, "security", ["delete-generic-password", ...base(key)], undefined, true);
      if (r.exitCode !== 0 && r.exitCode !== MAC_NOT_FOUND) {
        throw new KeychainError(`security delete failed (${r.exitCode})`);
      }
    },
  };
}

const FILE_SUFFIX = ".secret";
/** Longest encoded key we accept, so the file name stays under the usual 255-byte limit. */
const MAX_ENCODED_KEY = 200;

/** A key as a file name: percent-encoded, with `.` encoded too so no key is `.`, `..` or a hidden file. */
function fileNameOf(key: string): string {
  const encoded = encodeURIComponent(key).replace(/\./g, "%2E");
  if (key === "" || encoded.length > MAX_ENCODED_KEY) {
    throw new KeychainError(`credential key is empty or too long for the file store: '${key.slice(0, 40)}'`);
  }
  return encoded + FILE_SUFFIX;
}

const ownUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/**
 * CredentialStore over plain files in one directory, for a machine with no OS keychain (a headless
 * server, a container). The directory must be a real directory (never a symlink) that only its owner
 * can reach (mode 0700, created so when missing); each credential is a file of mode 0600. Anything
 * looser, a symlink, or a directory or file owned by someone else is refused with a message, never
 * repaired and never followed. Writes go to a fresh temporary file and are renamed over the target, so
 * a reader sees the old or the new value and an existing link at the target is replaced, not followed.
 * The secrets are NOT encrypted: that is the point of the weaker store, and `bridge doctor` is to warn about it.
 */
export function createFileCredentialStore(opts: { dir: string }): CredentialStore {
  if (!path.isAbsolute(opts.dir)) throw new KeychainError(`the file credential store directory must be an absolute path: '${opts.dir}'`);
  // Normalised first: lstat on a path with a trailing slash or dot follows a symlink, so the check below
  // would inspect its target; the bare, normalised path makes lstat see the link itself.
  const dir = path.resolve(opts.dir);

  /** Checks the directory (creating it 0700 when missing) and returns nothing; throws when it is unsafe. */
  async function ensureDir(create: boolean): Promise<boolean> {
    let st = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw new KeychainError(`cannot inspect the credential directory ${dir}: ${error.message}`, error);
    });
    if (st === undefined) {
      if (!create) return false;
      await mkdir(dir, { recursive: true, mode: 0o700 }).catch((error: Error) => {
        throw new KeychainError(`cannot create the credential directory ${dir}: ${error.message}`, error);
      });
      // A restrictive umask can only have removed bits; make the directory exactly 0700.
      await chmod(dir, 0o700).catch((error: Error) => {
        throw new KeychainError(`cannot set the credential directory ${dir} to mode 700: ${error.message}`, error);
      });
      st = await lstat(dir);
    }
    if (st.isSymbolicLink()) throw new KeychainError(`the credential directory ${dir} is a symbolic link; refusing to use it`);
    if (!st.isDirectory()) throw new KeychainError(`the credential directory ${dir} is not a directory`);
    const uid = ownUid();
    if (uid !== undefined && st.uid !== uid) throw new KeychainError(`the credential directory ${dir} is owned by another user; refusing to use it`);
    if ((st.mode & 0o077) !== 0) {
      throw new KeychainError(`the credential directory ${dir} is accessible to others (mode ${(st.mode & 0o777).toString(8)}); run \`chmod 700 ${dir}\``);
    }
    return true;
  }

  return {
    async get(key) {
      const file = path.join(dir, fileNameOf(key));
      if (!(await ensureDir(false))) return null;
      let handle;
      try {
        // O_NOFOLLOW: a link planted at the target fails (ELOOP) instead of being read through.
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return null;
        if (code === "ELOOP") throw new KeychainError(`the credential file ${file} is a symbolic link; refusing to read it`);
        throw new KeychainError(`cannot read the credential file ${file}: ${(error as Error).message}`, error);
      }
      try {
        const st = await handle.stat();
        if (!st.isFile()) throw new KeychainError(`the credential file ${file} is not a regular file`);
        const uid = ownUid();
        if (uid !== undefined && st.uid !== uid) throw new KeychainError(`the credential file ${file} is owned by another user; refusing to read it`);
        if ((st.mode & 0o077) !== 0) {
          throw new KeychainError(`the credential file ${file} is accessible to others (mode ${(st.mode & 0o777).toString(8)}); run \`chmod 600 ${file}\``);
        }
        return await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    },
    async set(key, value) {
      const target = path.join(dir, fileNameOf(key));
      await ensureDir(true);
      const temp = path.join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
      let handle;
      try {
        handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.chmod(0o600); // a restrictive umask can only have removed bits; make it exactly 0600
        await handle.writeFile(value, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temp, target);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temp).catch(() => undefined);
        if (error instanceof KeychainError) throw error;
        throw new KeychainError(`cannot write the credential file ${target}: ${(error as Error).message}`, error);
      }
    },
    async delete(key) {
      const file = path.join(dir, fileNameOf(key));
      if (!(await ensureDir(false))) return;
      try {
        await unlink(file); // removes a link itself, never what it points at
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new KeychainError(`cannot delete the credential file ${file}: ${(error as Error).message}`, error);
      }
    },
  };
}
