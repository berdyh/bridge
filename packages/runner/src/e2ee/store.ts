import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { base64UrlDecode, base64UrlEncode, generateRawKeyPair, keyIdOf, loadKeyPair, type KeyPair } from "@berdyh/bridge-crypto";
import { isBase64Url } from "@berdyh/bridge-protocol";

import { assertAppFolderName, type AppPaths } from "../paths.js";
import type { E2eeApp, TrustedBrowser } from "./contracts.js";
import { assertPrivateFile, readTextFile, withFileLock, writeFileAtomic, writeFileExclusive } from "./fsutil.js";

/**
 * Per-app E2EE state, all under the app's own bridge config folder (`app.paths.configDir`,
 * `<config>/<app>/bridge`):
 *
 *   <configDir>/trust.json        trusted browsers
 *   <configDir>/identity.json     this runner's long-term X25519 key (raw, secret sealed, 0600)
 *   <configDir>/identity.key      its wrapping key, unless `app.secrets` holds it
 *   <configDir>/enroll.json       the open enrollment window, if any
 *
 * One connection per app folder, so a trust list, key and window never reach another app.
 */

export class TrustListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustListError";
  }
}

/** A file-name-safe form of an app id (the id comes from a remote `bridge.json`). */
function safeName(appId: string): string {
  if (appId.length === 0) throw new Error("appId is empty");
  return encodeURIComponent(appId).replace(/\./g, "%2E");
}

/** `<configDir>/<kind>.json` of the app's own bridge config folder (one connection per app folder). */
export function statePath(app: E2eeApp, kind: "trust" | "identity" | "enroll"): string {
  return path.join(layoutOf(app).configDir, `${kind}.json`);
}

/**
 * `app.paths` must be this app's own: its `appId` is `app.appId` and its `configDir` is
 * `<...>/<appId>/bridge`, so `{ appId: "alpha", paths: appPathsOf(base, "beta") }` can neither read
 * nor remove beta's state.
 */
function layoutOf(app: E2eeApp): Pick<AppPaths, "appId" | "configDir"> {
  const { paths } = app;
  if (paths === undefined) throw new Error("E2eeApp: paths is not set");
  assertAppFolderName(app.appId);
  const configDir = path.resolve(paths.configDir);
  if (paths.appId !== app.appId || path.basename(configDir) !== "bridge" || path.basename(path.dirname(configDir)) !== app.appId) {
    throw new Error(`E2eeApp: paths belong to another app than ${JSON.stringify(app.appId)}`);
  }
  return { appId: paths.appId, configDir };
}

/**
 * The `bridge/` config folder and the state files in it must not be
 * symlinks (a link would move trust, identity or windows into another app's folder, or create
 * files at its target). `<config>/<app>` above it may be a link (the app's own business).
 * Checked before every read, write, lock and removal; a missing folder or file is fine. With
 * `leaves`, those files (and their `.lock`) are checked too; a removal checks the folder only,
 * because `rm` takes a link itself away and never its target.
 */
async function guardState(app: E2eeApp, leaves: readonly string[] = []): Promise<void> {
  const paths = layoutOf(app);
  const refuse = (target: string): never => {
    throw new Error(`Refusing symlink in bridge state path: ${target}`);
  };
  let dirStat;
  try {
    dirStat = await fs.lstat(paths.configDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (dirStat.isSymbolicLink()) refuse(paths.configDir);
  if (!dirStat.isDirectory()) throw new Error(`Bridge state folder is not a directory: ${paths.configDir}`);
  for (const leaf of leaves) {
    try {
      if ((await fs.lstat(leaf)).isSymbolicLink()) refuse(leaf);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Reads one state file after `guardState`; the open itself refuses a link planted since. */
async function readState(app: E2eeApp, file: string): Promise<string | undefined> {
  await guardState(app, [file]);
  return readTextFile(file, { noFollow: true });
}

/** `withFileLock` after `guardState` of the dir, the file, its lock file and `more`. */
async function lockState<T>(app: E2eeApp, file: string, fn: () => Promise<T>, more: readonly string[] = []): Promise<T> {
  await guardState(app, [file, `${file}.lock`, ...more]);
  return withFileLock(file, fn);
}

/** Fires in-process listeners when a state file changed; a cross-process change is found by polling. */
const listeners = new Map<string, Set<() => void>>();

export function notifyChanged(file: string): void {
  for (const listener of [...(listeners.get(file) ?? [])]) listener();
}

/** Resolves on the next in-process change of `file`, after `ms`, or when `signal` aborts. */
export function waitForChange(file: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let set = listeners.get(file);
    if (!set) listeners.set(file, (set = new Set()));
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      if (set.size === 0 && listeners.get(file) === set) listeners.delete(file);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    set.add(done);
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
}

// --- trust list -----------------------------------------------------------------

type TrustFile = { v: 1; browsers: TrustedBrowser[] };

async function parseTrustEntry(value: unknown): Promise<TrustedBrowser> {
  const v = value as Partial<TrustedBrowser> | null;
  if (
    !v || typeof v !== "object" || !isBase64Url(v.browserKeyId) || !isBase64Url(v.publicKey) ||
    typeof v.label !== "string" || typeof v.enrolledAt !== "string" || typeof v.lastSeen !== "string"
  ) throw new TrustListError("trust list entry is malformed");
  // The id is derived from the key. An entry whose id does not match its key is tampered with.
  let id: string;
  try {
    id = await keyIdOf(base64UrlDecode(v.publicKey));
  } catch {
    throw new TrustListError("trust list entry is malformed");
  }
  if (id !== v.browserKeyId) throw new TrustListError("trust list entry does not match its key");
  return { browserKeyId: v.browserKeyId, publicKey: v.publicKey, label: v.label, enrolledAt: v.enrolledAt, lastSeen: v.lastSeen };
}

/** The trust list; empty when the file does not exist. Throws on a corrupt file (fail closed). */
export async function readTrustList(app: E2eeApp): Promise<TrustedBrowser[]> {
  const text = await readState(app, statePath(app, "trust"));
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TrustListError("trust list is not valid JSON");
  }
  const file = parsed as Partial<TrustFile> | null;
  if (!file || typeof file !== "object" || file.v !== 1 || !Array.isArray(file.browsers)) throw new TrustListError("trust list has an unknown format");
  return Promise.all(file.browsers.map(parseTrustEntry));
}

/** Read-modify-write under the lock. `fn` returns the new list, or undefined to leave it alone. */
export async function mutateTrustList<T>(
  app: E2eeApp,
  fn: (list: TrustedBrowser[]) => { list?: TrustedBrowser[]; result: T },
): Promise<T> {
  const file = statePath(app, "trust");
  return lockState(app, file, async () => {
    const { list, result } = fn(await readTrustList(app));
    if (list) await guardState(app, [file]);
    if (list) await writeFileAtomic(file, `${JSON.stringify({ v: 1, browsers: list } satisfies TrustFile, null, 2)}\n`);
    return result;
  });
}

export async function findTrusted(app: E2eeApp, browserKeyId: string): Promise<TrustedBrowser | undefined> {
  return (await readTrustList(app)).find((entry) => entry.browserKeyId === browserKeyId);
}

/** Adds a browser, or refreshes the label and key of an existing entry (re-enrollment). */
export async function upsertTrusted(app: E2eeApp, entry: TrustedBrowser): Promise<void> {
  await mutateTrustList(app, (list) => ({
    list: [...list.filter((existing) => existing.browserKeyId !== entry.browserKeyId), entry],
    result: undefined,
  }));
}

/** Records `lastSeen`, at most once per `minIntervalMs` per browser, to keep the file quiet. */
export async function touchLastSeen(app: E2eeApp, browserKeyId: string, now: Date, minIntervalMs = 5 * 60 * 1000): Promise<void> {
  await mutateTrustList(app, (list) => {
    const entry = list.find((candidate) => candidate.browserKeyId === browserKeyId);
    if (!entry) return { result: undefined };
    const last = Date.parse(entry.lastSeen);
    if (Number.isFinite(last) && now.getTime() - last < minIntervalMs) return { result: undefined };
    return { list: list.map((candidate) => (candidate === entry ? { ...entry, lastSeen: now.toISOString() } : candidate)), result: undefined };
  });
}

// --- the runner's identity key --------------------------------------------------

/**
 * The identity file holds the `raw` stored key, its secret sealed with AES-256-GCM under a
 * per-app wrapping key (`app.secrets`, or a separate 0600 key file). The AAD binds the
 * ciphertext to the app, the runner and the public key, so a file copied to another
 * connection, or with its public half swapped, does not open.
 */
type IdentityFile = { v: 2; kind: "raw"; alg: "aes-256-gcm"; publicKey: string; iv: string; ciphertext: string };
/** The first format, with the secret in the clear. Read once and rewritten as `IdentityFile`. */
type LegacyIdentityFile = { v: 1; kind: "raw"; publicKey: string; secretKey: string };

const WRAP_KEY_BYTES = 32;
const wrapKeyName = (app: Pick<E2eeApp, "appId" | "runnerId">): string => `bridge/e2ee-identity-key/${safeName(app.appId)}/${safeName(app.runnerId)}`;

/**
 * The keychain entry of an app connection's identity wrapping key. `bridge uninstall` deletes it
 * (with the app's tokens) before it removes any file, so a failed keychain step leaves every
 * file a second run needs. `removeAppState` deletes it too.
 */
export function wrapKeyNameOf(app: Pick<E2eeApp, "appId" | "runnerId">): string {
  return wrapKeyName(app);
}
const wrapKeyFile = (app: E2eeApp): string => path.join(layoutOf(app).configDir, "identity.key");
const identityAad = (app: E2eeApp, publicKey: string): Buffer =>
  Buffer.from(JSON.stringify(["bridge runner identity v2", app.appId, app.runnerId, publicKey]), "utf8");

/** The wrapping key; created when `create` and missing. Callers hold the identity file's lock. */
async function wrapKey(app: E2eeApp, create: boolean): Promise<Buffer | undefined> {
  const decode = (text: string): Buffer => {
    if (!isBase64Url(text)) throw new Error("identity wrapping key is malformed");
    const key = Buffer.from(base64UrlDecode(text));
    if (key.length !== WRAP_KEY_BYTES) throw new Error("identity wrapping key is malformed");
    return key;
  };
  if (app.secrets) {
    const stored = await app.secrets.get(wrapKeyName(app));
    if (stored !== null && stored !== undefined) return decode(stored);
    if (!create) return undefined;
    const fresh = randomBytes(WRAP_KEY_BYTES);
    await app.secrets.set(wrapKeyName(app), base64UrlEncode(fresh));
    return fresh;
  }
  const file = wrapKeyFile(app);
  const text = await readState(app, file);
  if (text !== undefined) {
    await assertPrivateFile(file);
    return decode(text.trim());
  }
  if (!create) return undefined;
  const fresh = randomBytes(WRAP_KEY_BYTES);
  await guardState(app, [file]);
  await writeFileExclusive(file, `${base64UrlEncode(fresh)}\n`);
  return decode((await readState(app, file))?.trim() ?? "");
}

function sealSecret(app: E2eeApp, key: Buffer, publicKey: string, secret: Uint8Array): { iv: string; ciphertext: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(identityAad(app, publicKey));
  const body = Buffer.concat([cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
  return { iv: base64UrlEncode(iv), ciphertext: base64UrlEncode(body) };
}

function openSecret(app: E2eeApp, key: Buffer, file: IdentityFile): Buffer {
  const body = Buffer.from(base64UrlDecode(file.ciphertext));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(base64UrlDecode(file.iv)));
  decipher.setAAD(identityAad(app, file.publicKey));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
}

async function writeIdentity(app: E2eeApp, file: string, key: Buffer, publicKey: Uint8Array, secretKey: Uint8Array, exclusive: boolean): Promise<void> {
  const encodedPublic = base64UrlEncode(publicKey);
  const record: IdentityFile = { v: 2, kind: "raw", alg: "aes-256-gcm", publicKey: encodedPublic, ...sealSecret(app, key, encodedPublic, secretKey) };
  const text = `${JSON.stringify(record)}\n`;
  await guardState(app, [file]);
  if (exclusive) await writeFileExclusive(file, text);
  else await writeFileAtomic(file, text);
}

async function readIdentity(app: E2eeApp, file: string): Promise<KeyPair | undefined> {
  const text = await readState(app, file);
  if (text === undefined) return undefined;
  await assertPrivateFile(file);
  const parsed = JSON.parse(text) as { v?: unknown; kind?: unknown; alg?: unknown; publicKey?: unknown; secretKey?: unknown; iv?: unknown; ciphertext?: unknown };
  if (parsed.kind !== "raw" || !isBase64Url(parsed.publicKey)) throw new Error("identity key file is malformed");
  let secretKey: Uint8Array;
  if (parsed.v === 1 && isBase64Url(parsed.secretKey)) {
    // Written by the first version, secret in the clear: seal it now, keep the same identity.
    secretKey = base64UrlDecode(parsed.secretKey);
    const key = await wrapKey(app, true);
    try {
      await writeIdentity(app, file, key!, base64UrlDecode(parsed.publicKey), secretKey, false);
    } finally {
      key!.fill(0);
    }
  } else if (parsed.v === 2 && parsed.alg === "aes-256-gcm" && isBase64Url(parsed.iv) && isBase64Url(parsed.ciphertext)) {
    // A missing key is an error, never a reason to make a new identity that browsers do not know.
    const key = await wrapKey(app, false);
    if (!key) throw new Error("the key that protects the runner identity is missing");
    try {
      secretKey = openSecret(app, key, parsed as unknown as IdentityFile);
    } catch {
      throw new Error("the runner identity key cannot be decrypted (wrong key or modified file)");
    } finally {
      key.fill(0);
    }
  } else {
    throw new Error("identity key file is malformed");
  }
  try {
    return await loadKeyPair({ kind: "raw", publicKey: base64UrlDecode(parsed.publicKey), secretKey });
  } finally {
    secretKey.fill(0);
  }
}

/**
 * This runner's long-term identity for `app`, created on first use with
 * `generateRawKeyPair` and persisted as the `raw` stored kind, encrypted at rest (see
 * `IdentityFile`) in a 0600 file. Creation, and the upgrade of a first-version
 * plaintext file, run under the file's lock, so racing processes agree on one key and
 * one wrapping key. The caller owns the returned handle and destroys it when done.
 */
export async function loadRunnerIdentity(app: E2eeApp): Promise<KeyPair> {
  const file = statePath(app, "identity");
  return lockState(app, file, async () => {
    const existing = await readIdentity(app, file);
    if (existing) return existing;
    const fresh = await generateRawKeyPair();
    const key = await wrapKey(app, true);
    try {
      await writeIdentity(app, file, key!, fresh.publicKey, fresh.secretKey, true);
    } finally {
      fresh.secretKey.fill(0);
      key!.fill(0);
    }
    const stored = await readIdentity(app, file);
    if (!stored) throw new Error("identity key file disappeared");
    return stored;
  }, [wrapKeyFile(app)]);
}

/**
 * Forgets everything E2EE the runner keeps for one app connection: the identity file, its
 * wrapping key (the `app.secrets` entry, or the 0600 key file), the trust list and any open
 * enrollment window. Each file goes under its own lock, the identity first so no process can
 * re-create a key in between. Missing pieces are fine; the call is idempotent.
 */
export async function removeAppState(app: E2eeApp): Promise<void> {
  const enroll = statePath(app, "enroll");
  const trust = statePath(app, "trust");
  const identity = statePath(app, "identity");
  await guardState(app);
  // Nested in the order the daemon already takes them (enrollment decision -> trust list; the
  // identity is taken on its own), and all held until everything is gone, so no concurrent
  // handshake or enrollment can recreate a piece in between.
  await withFileLock(enroll, () => withFileLock(trust, () => withFileLock(identity, async () => {
    await guardState(app);
    await fs.rm(enroll, { force: true });
    await fs.rm(trust, { force: true });
    await fs.rm(identity, { force: true });
    if (app.secrets?.delete) await app.secrets.delete(wrapKeyName(app));
    await fs.rm(wrapKeyFile(app), { force: true });
  })));
  notifyChanged(enroll);
  notifyChanged(trust);
}

// --- the enrollment window -----------------------------------------------------

/** What the browser asked the local user to trust; set by the daemon, answered by `bridge enroll`. */
export interface PendingEnrollment {
  attemptId: string;
  enrollId: string;
  label: string;
  /** Raw X25519 public key, base64url. */
  publicKey: string;
  keyId: string;
}

export interface EnrollmentDecision {
  attemptId: string;
  accepted: boolean;
  /**
   * Set by the daemon in the same locked step that adds the browser to the trust list
   * and consumes the code, i.e. only when it could still send `pake/done`.
   */
  delivered?: boolean;
  /** The trust entry's `enrolledAt`, set together with `delivered`. */
  enrolledAt?: string;
}

/** The open enrollment window of one app: the single piece of state `enroll` and the daemon share. */
export interface EnrollWindow {
  v: 1;
  /** Chosen at random by the runner; not derived from the code (an offline-guess oracle otherwise). */
  codeId: string;
  /** Normalized 8-character code. The daemon needs it as the SPAKE2 password. */
  code: string;
  expiresAt: string;
  /** Replies the runner may still send; charged when `pake/reply` is sent. */
  attemptsLeft: number;
  /** `locked`: the attempts are used up and a new code is needed. */
  state: "open" | "locked";
  /** Set when a browser's enrollment succeeded; the code is then dead (single use). */
  consumed?: boolean;
  ownerPid: number;
  pending?: PendingEnrollment;
  decision?: EnrollmentDecision;
}

export async function readEnrollWindow(app: E2eeApp): Promise<EnrollWindow | undefined> {
  const text = await readState(app, statePath(app, "enroll"));
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<EnrollWindow> | null;
    if (
      !parsed || typeof parsed !== "object" || parsed.v !== 1 || typeof parsed.codeId !== "string" || typeof parsed.code !== "string" ||
      typeof parsed.expiresAt !== "string" || typeof parsed.attemptsLeft !== "number" || (parsed.state !== "open" && parsed.state !== "locked")
    ) return undefined;
    return parsed as EnrollWindow;
  } catch {
    return undefined;
  }
}

/**
 * Read-modify-write of the window under the lock, then wakes in-process waiters.
 * `fn` returns the new window, `null` to delete it, or undefined to leave it as is.
 */
export async function mutateEnrollWindow<T>(
  app: E2eeApp,
  fn: (window: EnrollWindow | undefined) => { window?: EnrollWindow | null; result: T } | Promise<{ window?: EnrollWindow | null; result: T }>,
): Promise<T> {
  const file = statePath(app, "enroll");
  const result = await lockState(app, file, async () => {
    const { window, result: value } = await fn(await readEnrollWindow(app));
    await guardState(app, window ? [file] : []);
    if (window === null) await fs.rm(file, { force: true });
    else if (window) await writeFileAtomic(file, `${JSON.stringify(window)}\n`);
    return { value, changed: window !== undefined };
  });
  if (result.changed) notifyChanged(file);
  return result.value;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
