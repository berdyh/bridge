import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { BridgeDiscovery } from "@berdyh/bridge-protocol";
import { isAppFolderName, withFileLock } from "@berdyh/bridge-runner";

import { writeFileAtomically } from "./consent-plan.js";
import { bridgeConfigDir, errorMessage, type CliDeps } from "./deps.js";
import { appPathsOf } from "./paths.js";

/** The origin a local app is listed under in `apps.json`: a marker, never parsed as a URL. */
export const LOCAL_ORIGIN = "local";

/** One connected (hosted) app, as `connect` records it in the app's own `<config>/<app>/bridge/app.json` (`"version": 1` plus these fields; no `kind` field). */
export interface HostedAppRecord {
  appId: string;
  name: string;
  /** The URL the user gave to `connect`. */
  url: string;
  origin: string;
  relayUrl: string;
  /** The app's enroll page path from discovery (`BridgeDiscovery.enrollPage`); persisted by `connect`, read by `setup`. */
  enrollPage?: string;
  auth: BridgeDiscovery["auth"];
  protocol: BridgeDiscovery["protocol"];
  /** This runner's id for the app (`DeviceRecord.deviceId`); chosen here, never shared between apps. */
  runnerId: string;
  /** ISO 8601. */
  connectedAt: string;
}

/**
 * An app with no hosted server (`bridge apps add-local`): the same folders, plugins and sessions as any app, and no
 * link. It carries no relay, sign-in, protocol, runner id or enroll page, so no code path can reach for one.
 */
export interface LocalAppRecord {
  kind: "local";
  appId: string;
  name: string;
  origin: typeof LOCAL_ORIGIN;
  /** ISO 8601. */
  createdAt: string;
}

/** An app of either kind; narrow with `isLocalApp`. */
export type AppRecord = HostedAppRecord | LocalAppRecord;

export function isLocalApp(app: AppRecord): app is LocalAppRecord {
  return "kind" in app && app.kind === "local";
}

/** An entry of the machine-wide list: `apps.json` holds `id -> origin` only; the record lives in the app's `app.json`. */
export interface AppListEntry {
  appId: string;
  origin: string;
}

interface AppsFile {
  version: 2;
  apps: AppListEntry[];
}

export function appsFilePath(deps: CliDeps): string {
  return path.join(bridgeConfigDir(deps), "apps.json");
}

/** The keychain key of an app's tokens. One key per app; no app can read another's. */
export function tokenKey(appId: string): string {
  return `${appId}/pairing.tokens`;
}

/**
 * App ids become folder names (`<config>/<app>/bridge`) and keychain keys, so an id is lowercase letters, digits and '-',
 * starting with a letter; `bridge` is reserved.
 */
export function isSafeAppId(id: string): boolean {
  return isAppFolderName(id);
}

/** Server-supplied text goes to a terminal: drop control characters (escape sequences, newlines). */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "");
}

/** The fields only a hosted app has: a local record carrying one is neither kind, so it is refused. */
const RELAY_FIELDS = ["url", "relayUrl", "auth", "protocol", "enrollPage", "runnerId", "connectedAt"] as const;

function isRecord(v: unknown): v is AppRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.kind !== undefined) {
    return (
      r.kind === "local" && typeof r.appId === "string" && isSafeAppId(r.appId) && typeof r.name === "string" &&
      r.origin === LOCAL_ORIGIN && typeof r.createdAt === "string" && RELAY_FIELDS.every((f) => !(f in r))
    );
  }
  const auth = r.auth as Record<string, unknown> | undefined;
  return (
    typeof r.appId === "string" && isSafeAppId(r.appId) && typeof r.name === "string" && typeof r.origin === "string" && r.origin !== LOCAL_ORIGIN &&
    typeof r.relayUrl === "string" && typeof r.runnerId === "string" &&
    typeof auth === "object" && auth !== null &&
    typeof auth.clientId === "string" && typeof auth.tokenEndpoint === "string" && typeof auth.deviceAuthorizationEndpoint === "string"
  );
}

/** `apps.json` alone: the listed ids and origins, or why it cannot be read (then the list is empty). */
export interface AppListing {
  listed: AppListEntry[];
  error?: string;
}

/**
 * Reads `apps.json` and nothing else (never an `app.json`), so a layout or a manifest can be
 * built, and a reinstall or service change done, while one app's record is broken. A missing file
 * is an empty list; a version-1 file (full records inline, the older layout), bad JSON or an
 * invalid entry is an `error` and an empty list, never a silent drop (the next save would persist it).
 */
export async function readAppList(deps: CliDeps): Promise<AppListing> {
  const file = appsFilePath(deps);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { listed: [] };
    return { listed: [], error: `${file}: ${errorMessage(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { listed: [], error: `${file} is not valid JSON` };
  }
  const body = parsed as Partial<{ version: unknown; apps: unknown }> | null;
  if (body?.version !== 2) return { listed: [], error: `${file} is not a version 2 list (an older bridge layout; see \`bridge doctor\`)` };
  if (!Array.isArray(body.apps)) return { listed: [], error: `${file} has no apps list` };
  const listed: AppListEntry[] = [];
  for (const [i, entry] of body.apps.entries()) {
    const e = entry as { appId?: unknown; origin?: unknown } | null;
    if (typeof e?.appId !== "string" || !isSafeAppId(e.appId) || typeof e.origin !== "string") {
      const id = typeof e?.appId === "string" ? ` (${printable(e.appId).slice(0, 64)})` : "";
      return { listed: [], error: `${file}: app entry #${i + 1}${id} is not valid; fix or remove it` };
    }
    listed.push({ appId: e.appId, origin: e.origin });
  }
  return { listed };
}

/** One app's record from its own `app.json`; throws an error naming the file when it is missing, invalid or disagrees with the list. */
export async function readAppFile(deps: CliDeps, entry: AppListEntry): Promise<AppRecord> {
  const file = appPathsOf(deps, entry.appId).appFile;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const detail = (error as NodeJS.ErrnoException).code === "ENOENT" ? "is missing" : error instanceof SyntaxError ? "is not valid JSON" : `cannot be read (${errorMessage(error)})`;
    throw new Error(`${file} ${detail}; ${appsFilePath(deps)} lists ${entry.appId}: restore the file or run \`bridge apps remove ${entry.appId}\``);
  }
  const { version, ...record } = (parsed ?? {}) as { version?: unknown } & Record<string, unknown>;
  if (version !== 1 || !isRecord(record)) throw new Error(`${file} is not a valid app record (version 1); fix or restore it`);
  if (record.appId !== entry.appId || record.origin !== entry.origin) {
    throw new Error(`${file} says ${printable(record.appId)} at ${printable(record.origin)}, but ${appsFilePath(deps)} lists ${entry.appId} at ${printable(entry.origin)}; fix one of them`);
  }
  return record;
}

/** Everything about the connected apps, never throwing. */
export interface AppsRead extends AppListing {
  /** The apps whose `app.json` is valid. */
  apps: AppRecord[];
  /** Listed apps whose `app.json` is missing, invalid or disagrees with the list. */
  broken: { appId: string; file: string; error: string }[];
}

export async function readApps(deps: CliDeps): Promise<AppsRead> {
  const listing = await readAppList(deps);
  const apps: AppRecord[] = [];
  const broken: AppsRead["broken"] = [];
  for (const entry of listing.listed) {
    try {
      apps.push(await readAppFile(deps, entry));
    } catch (error) {
      broken.push({ appId: entry.appId, file: appPathsOf(deps, entry.appId).appFile, error: errorMessage(error) });
    }
  }
  return { ...listing, apps, broken };
}

/** The connected apps. An unreadable `apps.json`, or a listed id without a valid `app.json`, is a hard error naming the file. */
export async function loadApps(deps: CliDeps): Promise<AppRecord[]> {
  const read = await readApps(deps);
  if (read.error !== undefined) throw new Error(read.error);
  if (read.broken.length > 0) throw new Error(read.broken[0]!.error);
  return read.apps;
}

/**
 * The apps that have an `app.json` of their own (`<config>/<name>/bridge/app.json`), found by listing the
 * config dir: what `apps.json` would list. Offered when `apps.json` itself cannot be read. Reads only.
 */
export async function discoverAppFiles(deps: CliDeps): Promise<{ appId: string; file: string }[]> {
  const names = await readdir(deps.configDir).catch(() => [] as string[]);
  const found: { appId: string; file: string }[] = [];
  for (const name of names.sort()) {
    if (!isSafeAppId(name)) continue;
    const file = appPathsOf(deps, name).appFile;
    if (await lstat(file).then(() => true, () => false)) found.push({ appId: name, file });
  }
  return found;
}

/** A private file (0600), written by the consent plan's atomic writer: a fresh `wx` temp file, then a rename that replaces a link at `file` instead of writing through it. */
const writePrivateFile = (file: string, body: string): Promise<void> => writeFileAtomically(file, body, 0o600, { exactMode: true });

/**
 * Where a consented command writes `apps.json` and an app's `app.json`: the canonical paths its plan bound
 * (consent-plan.ts, Rule B; the caller has done its one recompute). Without them (test fixtures that seed
 * records; every command that writes these files passes its plan) the lexical paths are used.
 */
export interface BoundAppFiles {
  appsFile: string;
  appFile?: string;
}

async function saveList(deps: CliDeps, listed: AppListEntry[], bound?: BoundAppFiles): Promise<void> {
  const file = bound?.appsFile ?? appsFilePath(deps);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const body: AppsFile = { version: 2, apps: listed };
  await writePrivateFile(file, JSON.stringify(body, null, 2) + "\n");
}

/**
 * Adds or replaces (by `appId`) a record: its `app.json` first (atomic, 0600; `<config>/<app>` and
 * `bridge/` are created 0700 only when missing, an existing parent is never changed), then `apps.json`,
 * which is written only when the list does not already hold this id at this origin (`connect` has
 * refused a different origin for a connected id before it gets here).
 */
export async function upsertApp(deps: CliDeps, record: AppRecord, bound?: BoundAppFiles): Promise<void> {
  const paths = appPathsOf(deps, record.appId);
  const appFile = bound?.appFile ?? paths.appFile;
  const configDir = path.dirname(appFile);
  await withFileLock(appsFilePath(deps), async () => {
    const { listed, error } = await readAppList(deps);
    if (error !== undefined) throw new Error(error);
    const existing = listed.find((a) => a.appId === record.appId);
    const dir = await lstat(configDir).then((i) => i, () => undefined);
    if (dir?.isSymbolicLink() || (dir !== undefined && !dir.isDirectory())) {
      throw new Error(`${configDir} is not a real folder (a symlink or other); bridge keeps an app's files in a folder of its own and will not write through it`);
    }
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writePrivateFile(appFile, JSON.stringify({ version: 1, ...record }, null, 2) + "\n");
    // Written only when the list changes: a re-run that records the same app at the same origin leaves apps.json alone.
    if (existing?.origin !== record.origin) {
      await saveList(deps, [...listed.filter((a) => a.appId !== record.appId), { appId: record.appId, origin: record.origin }], bound);
    }
  });
}

/** Removes the app from `apps.json` only (the app's folders are `bridge apps remove`'s). */
export async function removeApp(deps: CliDeps, appId: string, bound?: BoundAppFiles): Promise<boolean> {
  return withFileLock(appsFilePath(deps), async () => {
    const { listed, error } = await readAppList(deps);
    if (error !== undefined) throw new Error(error);
    const rest = listed.filter((a) => a.appId !== appId);
    if (rest.length === listed.length) return false;
    await saveList(deps, rest, bound);
    return true;
  });
}

const localAppMessage = (appId: string): string => `${appId} is a local app: it has no relay, sign-in, browsers or enrollment`;

/**
 * Finds a hosted app by id, or the only one when `name` is omitted. Throws a readable error otherwise, and for a
 * local app's id (it has no relay, sign-in, browsers or enrollment, so what resolves an app for those commands refuses it).
 */
export async function resolveApp(deps: CliDeps, name: string | undefined): Promise<HostedAppRecord> {
  const apps = await loadApps(deps);
  const hosted = <T extends AppRecord>(app: T): Exclude<T, LocalAppRecord> => {
    if (isLocalApp(app)) throw new Error(localAppMessage(app.appId));
    return app as Exclude<T, LocalAppRecord>;
  };
  if (name === undefined) {
    const connected = apps.filter((a): a is HostedAppRecord => !isLocalApp(a));
    if (connected.length === 1) return connected[0]!;
    if (connected.length === 0 && apps.length > 0) throw new Error(`no app is connected to a hosted server; run \`bridge connect <app-url>\` (${apps.map((a) => a.appId).join(", ")}: local, no relay, sign-in, browsers or enrollment)`);
    throw new Error(apps.length === 0 ? "no app is connected; run `bridge connect <app-url>`" : "more than one app is connected; name one (see `bridge apps list`)");
  }
  const found = apps.find((a) => a.appId === name);
  if (found) return hosted(found);
  const matches = apps.filter((a) => a.name === name || (!isLocalApp(a) && a.origin === name));
  if (matches.length > 1) {
    throw new Error(`'${printable(name)}' matches more than one app (${matches.map((a) => a.appId).join(", ")}); use the app id`);
  }
  if (matches.length === 1) return hosted(matches[0]!);
  throw new Error(`no connected app '${printable(name)}' (see \`bridge apps list\`)`);
}
