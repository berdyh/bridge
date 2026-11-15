import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { type ManifestEntry, removeBound } from "@berdyh/bridge-runner";

import { parse } from "./args.js";
import { CHANGED_WHILE_WAITING, canonicalPath, writeFileAtomically } from "./consent-plan.js";
import { type CliDeps, UsageError, errorMessage, platformOf } from "./deps.js";
import { assertNoLegacyLayout } from "./legacy.js";
import { RUNNER_NAME, baseDirsOf, launcherPathOf } from "./paths.js";
import { openTerminalOf } from "./terminal.js";

/**
 * The `bridge://` handler (Linux). It is an UNTRUSTED LAUNCHER: any web page can fire a
 * `bridge://` link, so `handle-url` accepts exactly two shapes, runs only fixed commands, never
 * passes `--yes`, and the only part of the URL that reaches a command is a normalized origin
 * (`URL.origin`: ASCII, scheme and host only) that the terminal then shows before any prompt.
 */

export const HANDLER_DESKTOP_FILE = "bridge-url-handler.desktop";
export const HANDLER_MIME_TYPE = "x-scheme-handler/bridge";
/** Our `[Default Applications]` line in `mimeapps.list`; uninstall removes it only while it is ours. */
export const HANDLER_MIME_LINE = `${HANDLER_MIME_TYPE}=${HANDLER_DESKTOP_FILE}`;

const MAX_URL_LENGTH = 2048;

/** A `bridge://` URL the handler refuses. */
export class HandleUrlRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandleUrlRefused";
  }
}

export type HandledUrl = { kind: "run" } | { kind: "setup"; origin: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Letters, digits, hyphens and dots only: the URL parser also lets `$ ; ' = _` and more through a host. */
const PLAIN_HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * Parses a `bridge://` URL: exactly `bridge://run`, or `bridge://setup?url=<origin>` with that
 * single parameter, where the origin is https (http only for loopback) with no credentials, path,
 * query or fragment. Anything else throws `HandleUrlRefused`.
 */
export function parseBridgeUrl(raw: string): HandledUrl {
  if (typeof raw !== "string" || raw.length === 0) throw new HandleUrlRefused("empty URL");
  if (raw.length > MAX_URL_LENGTH) throw new HandleUrlRefused("URL too long");
  // Printable ASCII only: no whitespace, control characters, newlines or unicode. Non-ASCII hosts
  // must arrive as punycode, which is also what the user is then shown.
  if (!PRINTABLE_ASCII.test(raw)) throw new HandleUrlRefused("URL has characters that are not allowed");
  if (raw.includes("#")) throw new HandleUrlRefused("URL must not have a fragment");
  if (!raw.startsWith("bridge://")) throw new HandleUrlRefused("not a bridge:// URL");
  const rest = raw.slice("bridge://".length);
  if (rest === "run") return { kind: "run" };
  if (!rest.startsWith("setup?")) throw new HandleUrlRefused("unknown action (only run and setup are supported)");

  let entries: [string, string][];
  try {
    entries = [...new URLSearchParams(rest.slice("setup?".length)).entries()];
  } catch {
    throw new HandleUrlRefused("bad query");
  }
  if (entries.length !== 1 || entries[0]![0] !== "url") throw new HandleUrlRefused("setup takes exactly one parameter, url");
  const value = entries[0]![1];
  if (!PRINTABLE_ASCII.test(value)) throw new HandleUrlRefused("the url parameter has characters that are not allowed");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HandleUrlRefused("the url parameter is not a URL");
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (!loopback && !PLAIN_HOST.test(url.hostname)) throw new HandleUrlRefused("the app host has characters that are not allowed");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new HandleUrlRefused("the app URL must be https (http only on localhost)");
  }
  if (url.username !== "" || url.password !== "") throw new HandleUrlRefused("the app URL must not carry credentials");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new HandleUrlRefused("the app URL must be an origin (no path, query or fragment)");
  return { kind: "setup", origin: url.origin };
}

/** Raw input made safe to show: printable ASCII only, truncated. */
function printable(raw: string): string {
  const cut = raw.length > 60 ? `${raw.slice(0, 60)}...` : raw;
  return cut.replace(/[^\x20-\x7e]/g, "?");
}

/** The launcher the terminal commands and the desktop entry run. */
function launcherOf(deps: CliDeps): string {
  return launcherPathOf(deps);
}

export interface HandleUrlOptions {
  /**
   * What `bridge://run` does. Default: open a terminal running `bridge run`. The setup wiring
   * replaces it with "start the service if installed, else the terminal".
   */
  startRunner?: () => Promise<void>;
}

/** Opens a terminal running `bridge run` (never `--yes`, an argv array). */
export function terminalStartRunner(deps: CliDeps): () => Promise<void> {
  return () => openTerminalOf(deps)([launcherOf(deps), "run"]);
}

/** `bridge handle-url <url>` (hidden): what the desktop entry runs for a `bridge://` link. */
export async function runHandleUrl(args: string[], deps: CliDeps, options: HandleUrlOptions = {}): Promise<number> {
  const { positionals } = parse(args, {});
  if (positionals.length !== 1) throw new UsageError("usage: bridge handle-url <bridge://run | bridge://setup?url=<origin>>");
  const raw = positionals[0]!;
  let action: HandledUrl;
  try {
    action = parseBridgeUrl(raw);
  } catch (error) {
    if (!(error instanceof HandleUrlRefused)) throw error;
    deps.stderr(`bridge handle-url: refused ${printable(raw)}: ${error.message}\n`);
    return 2;
  }
  try {
    if (action.kind === "run") {
      deps.stdout("Starting the bridge runner.\n");
      await (options.startRunner ?? terminalStartRunner(deps))();
    } else {
      deps.stdout(`Setting up ${action.origin}\n`);
      // `--from-link`: a page fired this, so setup's one question defaults to no. Nothing else from the URL is passed.
      await openTerminalOf(deps)([launcherOf(deps), "setup", action.origin, "--from-link"]);
    }
  } catch (error) {
    deps.stderr(`bridge handle-url: ${errorMessage(error)}\n`);
    return 1;
  }
  return 0;
}

// --- install and uninstall -------------------------------------------------------------------

export interface ProtocolHandlerFiles {
  /** `<data>/applications/bridge-url-handler.desktop` */
  desktopFile: string;
  /** `<config>/mimeapps.list`, edited by the CLI itself, no xdg-mime */
  mimeapps: string;
}

export function protocolHandlerFiles(deps: CliDeps): ProtocolHandlerFiles {
  return {
    desktopFile: path.join(deps.dataDir, "applications", HANDLER_DESKTOP_FILE),
    mimeapps: path.join(deps.configDir, "mimeapps.list"),
  };
}

/**
 * The paths the handler writes, for `doctor --paths` and the uninstall manifest. Empty
 * off Linux. `mimeapps.list` belongs to the user: it is listed but never removed; uninstall
 * only drops our two entries from it (`uninstallProtocolHandler`).
 */
export function protocolHandlerPaths(deps: CliDeps): ManifestEntry[] {
  if (platformOf(deps) !== "linux") return [];
  const files = protocolHandlerFiles(deps);
  return [
    { path: files.desktopFile, kind: "file", role: "config", description: "bridge:// URL handler (desktop entry)", removeOnUninstall: true },
    {
      path: files.mimeapps,
      kind: "file",
      role: "external",
      description: `default applications; the CLI adds ${HANDLER_MIME_LINE} and ${HANDLER_ADDED_LINE}, uninstall removes only those`,
      removeOnUninstall: false,
    },
  ];
}

/** The desktop entry text. Refuses a launcher path the Exec key cannot carry safely. */
export function desktopEntryOf(launcher: string): string {
  if (!path.isAbsolute(launcher) || /[\u0000-\u001f\u007f"`$\\%]/.test(launcher)) {
    throw new Error(`the launcher path cannot be used in a desktop entry: ${printable(launcher)}`);
  }
  const exec = /[\s'<>~|&;*?#()]/.test(launcher) ? `"${launcher}"` : launcher;
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Bridge URL handler",
    "Comment=Opens the local bridge runner from a bridge:// link",
    `Exec=${exec} handle-url %u`,
    "Terminal=false",
    "NoDisplay=true",
    `MimeType=${HANDLER_MIME_TYPE};`,
    "",
  ].join("\n");
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function readIfExists(p: string): Promise<string | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // Strict UTF-8, BOM kept: a lossy decode would rewrite bytes we must not touch.
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${p} is not valid UTF-8; refusing to modify it`);
  }
}

interface DesktopPlan {
  path: string;
  exists: boolean;
}

/** Refuses a desktop-entry path that is a symlink or anything but a regular file: a write would follow it. */
async function resolveDesktop(file: string): Promise<DesktopPlan> {
  const resolved = await canonicalPath(file);
  try {
    const info = await lstat(resolved);
    if (!info.isFile()) throw new Error(`${resolved} exists but is not a regular file (a symlink or other); refusing to touch it`);
    return { path: resolved, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: resolved, exists: false };
    throw error;
  }
}

// --- mimeapps.list editing ---------------------------------------------------------------------
//
// The CLI edits `mimeapps.list` itself and never runs `xdg-mime`: its legacy KDE branch can write
// a second, undisclosed file (`profilerc`) whatever environment it is given. Two entries are
// written, because the freedesktop mime-apps spec says an implementation should keep the
// association in step with the default, and because xdg-desktop-portal's OpenURI (Chrome on a
// modern desktop) launches without an empty chooser only when GIO counts exactly one registered
// handler, which it does through `mimeinfo.cache` or `[Added Associations]`.

const DEFAULT_SECTION = "Default Applications";
const ADDED_SECTION = "Added Associations";
const MIME_KEY = `${HANDLER_MIME_TYPE}=`;
/** The `[Added Associations]` line we write: a `;`-list that may also carry other applications. */
export const HANDLER_ADDED_LINE = `${HANDLER_MIME_TYPE}=${HANDLER_DESKTOP_FILE};`;

interface MimeLine {
  /** The text without its terminator. */
  body: string;
  /** "\n", "\r\n", or "" for an unterminated last line. */
  eol: string;
  /** The section this line is in ("" before the first header); a header's own section name. */
  section: string;
  header: boolean;
}

function parseMimeapps(text: string): MimeLine[] {
  const lines: MimeLine[] = [];
  let section = "";
  for (const m of text.matchAll(/([^\n]*)(\n|$)/g)) {
    if (m[0] === "" ) break;
    let body = m[1]!;
    let eol = m[2]!;
    if (eol === "\n" && body.endsWith("\r")) {
      body = body.slice(0, -1);
      eol = "\r\n";
    }
    // GLib's key-file parser skips leading whitespace, so an indented header is a header.
    const header = /^\s*\[(.*)\]\s*$/.exec(body);
    if (header) section = header[1]!;
    lines.push({ body, eol, section, header: header !== null });
  }
  return lines;
}

function serializeMimeapps(lines: MimeLine[]): string {
  return lines.map((l) => l.body + l.eol).join("");
}

/** The file's own line ending (first terminated line), "\n" when it has none. */
function eolStyleOf(lines: MimeLine[]): string {
  return lines.find((l) => l.eol !== "")?.eol ?? "\n";
}

/** `key = value` with whitespace around both allowed; `undefined` for comments, blanks and headers. */
function keyValueOf(l: MimeLine): { key: string; value: string } | undefined {
  if (l.header) return undefined;
  const m = /^\s*([^=#\s][^=]*?)\s*=\s*(.*)$/.exec(l.body);
  return m ? { key: m[1]!, value: m[2]! } : undefined;
}

function isKeyLine(l: MimeLine, section: string): boolean {
  return l.section === section && keyValueOf(l)?.key === HANDLER_MIME_TYPE;
}

function valueOf(l: MimeLine): string {
  return keyValueOf(l)?.value ?? "";
}

/** Refuses a section that already has the bridge key twice: which one wins is not ours to guess. */
function assertNoDuplicateKeys(lines: MimeLine[]): void {
  for (const section of [DEFAULT_SECTION, ADDED_SECTION]) {
    if (lines.filter((l) => isKeyLine(l, section)).length > 1) {
      throw new Error(`mimeapps.list has ${HANDLER_MIME_TYPE} more than once under [${section}]; refusing to modify it`);
    }
  }
}

/** Whether a `[Default Applications]` value points at our desktop entry and nothing else. */
function isOurValue(value: string): boolean {
  return value.trim().replace(/;$/, "") === HANDLER_DESKTOP_FILE;
}

function hasOurToken(value: string): boolean {
  return value.split(";").some((t) => t.trim() === HANDLER_DESKTOP_FILE);
}

/** Inserts `body` as the first line of `section`, creating the section at the end if needed. */
function insertInSection(lines: MimeLine[], section: string, body: string): void {
  const eol = eolStyleOf(lines);
  const headerAt = lines.findIndex((l) => l.header && l.section === section);
  if (headerAt >= 0) {
    // A header that is the unterminated last line must be terminated to hold a line after it.
    if (lines[headerAt]!.eol === "") lines[headerAt]!.eol = eol;
    lines.splice(headerAt + 1, 0, { body, eol, section, header: false });
    return;
  }
  // Accepted behaviour: appending a missing section terminates an unterminated final line (one
  // added newline byte) so the new header starts on its own line.
  const last = lines[lines.length - 1];
  if (last !== undefined) {
    if (last.eol === "") last.eol = eol;
    if (last.body.trim() !== "") lines.push({ body: "", eol, section: last.section, header: false });
  }
  lines.push({ body: `[${section}]`, eol, section, header: true });
  lines.push({ body, eol, section, header: false });
}

/**
 * `mimeapps.list` with our two entries: `x-scheme-handler/bridge=<desktop file>` under
 * `[Default Applications]` (any existing value for that key is replaced) and our token merged
 * into the `;`-list under `[Added Associations]` (other applications are kept). Every other
 * byte, and every retained line's terminator, is preserved.
 */
export function withOurMimeEntries(text: string): string {
  const lines = parseMimeapps(text);
  assertNoDuplicateKeys(lines);
  const defaults = lines.filter((l) => isKeyLine(l, DEFAULT_SECTION));
  if (defaults.length > 0) {
    for (const l of defaults) l.body = `${MIME_KEY}${HANDLER_DESKTOP_FILE}`;
  } else {
    insertInSection(lines, DEFAULT_SECTION, `${MIME_KEY}${HANDLER_DESKTOP_FILE}`);
  }
  const added = lines.find((l) => isKeyLine(l, ADDED_SECTION));
  if (added === undefined) {
    insertInSection(lines, ADDED_SECTION, HANDLER_ADDED_LINE);
  } else if (!hasOurToken(valueOf(added))) {
    const value = valueOf(added);
    const sep = value.trim() === "" || value.endsWith(";") ? "" : ";";
    added.body = `${MIME_KEY}${value.trimEnd()}${sep}${HANDLER_DESKTOP_FILE};`;
  }
  return serializeMimeapps(lines);
}

/**
 * `mimeapps.list` without our entries, or `undefined` when there is nothing of ours to remove:
 * our `[Default Applications]` line only if its value is our desktop file, and our token in the
 * `[Added Associations]` list (the key's line only if the list becomes empty). Every other line
 * is kept byte for byte, with its own terminator.
 */
export function withoutOurMimeEntries(text: string): string | undefined {
  const lines = parseMimeapps(text);
  assertNoDuplicateKeys(lines);
  let changed = false;
  const kept: MimeLine[] = [];
  for (const l of lines) {
    if (isKeyLine(l, DEFAULT_SECTION) && isOurValue(valueOf(l))) {
      changed = true;
      continue;
    }
    if (isKeyLine(l, ADDED_SECTION) && hasOurToken(valueOf(l))) {
      changed = true;
      const rest = valueOf(l).split(";").filter((t) => t.trim() !== HANDLER_DESKTOP_FILE);
      if (rest.every((t) => t.trim() === "")) continue;
      l.body = `${MIME_KEY}${rest.join(";")}`;
    }
    kept.push(l);
  }
  return changed ? serializeMimeapps(kept) : undefined;
}

/** Whether `mimeapps.list` has either of our entries. */
export function hasOurMimeEntries(text: string): boolean {
  return withoutOurMimeEntries(text) !== undefined;
}

function hasBothMimeEntries(text: string): boolean {
  const lines = parseMimeapps(text);
  return (
    lines.some((l) => isKeyLine(l, DEFAULT_SECTION) && isOurValue(valueOf(l))) &&
    lines.some((l) => isKeyLine(l, ADDED_SECTION) && hasOurToken(valueOf(l)))
  );
}

/**
 * Where a write to `mimeapps.list` must land.
 *
 * TRUST MODEL and RULE: see `consent-plan.ts`. The plan here is the resolved desktop path, the
 * resolved mimeapps target, existence flags and the planned text. Resolution:
 *  1. p = canonicalPath(file) (its parent resolved; it must be a directory), then lstat(p):
 *  2. regular file -> target p;  ENOENT -> target p (create);
 *  3. symlink -> realpath(p) must succeed and be a regular file, else REFUSE. A dangling link
 *     (any number of hops) is never written through or created; the user fixes the link.
 * After the final recompute the write is temp file + rename beside the resolved target.
 */
async function mimeappsTargetOf(file: string): Promise<string> {
  const p = await canonicalPath(file);
  let info;
  try {
    info = await lstat(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return p;
    throw error;
  }
  if (info.isFile()) return p;
  if (!info.isSymbolicLink()) throw new Error(`${p} exists but is not a regular file or a symlink to one; refusing to touch it`);
  let real: string;
  try {
    real = await realpath(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${p} is a symlink whose target does not exist; fix the link and run the command again`);
    }
    throw error;
  }
  if (!(await stat(real)).isFile()) throw new Error(`${p} is a symlink to ${real}, which is not a regular file; refusing to touch it`);
  return real;
}

export type ProtocolOutcome = "done" | "cancelled" | "unsupported" | "nothing";

export interface ProtocolOptions {
  /** `--yes`: skip the question. The path list is still printed. */
  yes?: boolean;
  /** The caller (setup) already asked in its own consent that listed these paths. */
  consented?: boolean;
  /**
   * With `consented`: the exact uninstall plan (`protocolUninstallPlan`) the caller's consent
   * showed and the caller already recomputed once after it; the handler executes exactly it.
   */
  plan?: ProtocolUninstallPlan;
  /**
   * With `consented`: the install plan (`protocolInstallPlan`) whose lines (`protocolInstallLines`)
   * the caller's consent showed. The handler recomputes it once and executes only if it is the same.
   */
  installPlan?: ProtocolInstallPlan;
}

/** Prints the paths that will change and asks (unless the caller already did, or `--yes`). */
async function consent(deps: CliDeps, lines: string[], question: string, options: ProtocolOptions): Promise<boolean> {
  deps.stdout(`${lines.join("\n")}\n`);
  if (options.yes || options.consented) return true;
  return deps.confirm(question);
}

/** The `mimeapps.list` consent line: the path, and where the write really lands if it is a symlink. */
export function mimeappsLabel(file: string, target: string): string {
  return target === file ? file : `${file} -> ${target}`;
}

export interface ProtocolInstallPlan {
  desktop: DesktopPlan;
  target: string;
  mimeBefore: string | undefined;
  next: string;
  entry: string;
}

/**
 * What `installProtocolHandler` would write, fully resolved. Reads only; throws what the install
 * would refuse. For a caller's own consent (`bridge setup` asks once for the service and the handler).
 */
export async function protocolInstallPlan(deps: CliDeps): Promise<ProtocolInstallPlan> {
  return planInstall(protocolHandlerFiles(deps), desktopEntryOf(launcherOf(deps)));
}

/** The consent lines of an install plan: a header, then the paths it writes. */
export function protocolInstallLines(deps: CliDeps, planned: ProtocolInstallPlan): string[] {
  const files = protocolHandlerFiles(deps);
  return [
    "These paths will be written:",
    `  ${planned.desktop.path}  (desktop entry: runs \`bridge handle-url\` for bridge:// links)`,
    `  ${mimeappsLabel(files.mimeapps, planned.target)}  (edited by the CLI; these lines are added, other lines are kept)`,
    `    under [${DEFAULT_SECTION}]: ${HANDLER_MIME_LINE}`,
    `    under [${ADDED_SECTION}]: ${HANDLER_ADDED_LINE}  (merged into any existing list)`,
  ];
}

async function planInstall(files: ReturnType<typeof protocolHandlerFiles>, entry: string): Promise<ProtocolInstallPlan> {
  const desktop = await resolveDesktop(files.desktopFile);
  const target = await mimeappsTargetOf(files.mimeapps);
  const mimeBefore = await readIfExists(target); // refuses invalid UTF-8
  const next = withOurMimeEntries(mimeBefore ?? ""); // refuses duplicate keys
  return { desktop, target, mimeBefore, next, entry };
}

/** Registers `bridge://`: the desktop entry, then two entries in `mimeapps.list` (no xdg-mime). */
export async function installProtocolHandler(deps: CliDeps, options: ProtocolOptions = {}): Promise<ProtocolOutcome> {
  if (platformOf(deps) !== "linux") {
    deps.stdout("The bridge:// handler is Linux-only; on this platform copy the command from the page instead.\n");
    return "unsupported";
  }
  const files = protocolHandlerFiles(deps);
  const entry = desktopEntryOf(launcherOf(deps));
  // A caller that showed `installPlan` in its own consent already printed the lines and asked.
  const shown = options.consented === true && options.installPlan !== undefined;
  const planned = shown ? options.installPlan! : await planInstall(files, entry);
  // `consented` without a plan: the caller listed the paths in its own consent (setup); nothing is printed or asked here.
  const ok = shown || options.consented === true || (await consent(deps, protocolInstallLines(deps, planned), "Register the bridge:// handler?", options));
  if (!ok) {
    deps.stderr("bridge protocol install: cancelled\n");
    return "cancelled";
  }
  // The prompt can take minutes: recompute the whole plan and execute only if it is identical.
  const plan = await planInstall(files, entry);
  if (!isDeepStrictEqual(plan, planned)) throw new Error(CHANGED_WHILE_WAITING);
  const { target, mimeBefore, next } = plan;
  const desktopFile = plan.desktop.path;
  const existed = plan.desktop.exists;
  let wrote = false;
  try {
    await mkdir(path.dirname(desktopFile), { recursive: true });
    await writeFileAtomically(desktopFile, entry);
    await mkdir(path.dirname(target), { recursive: true });
    if (next !== mimeBefore) {
      await writeFileAtomically(target, next);
      wrote = true;
    }
    const after = await readIfExists(target);
    if (after === undefined || !hasBothMimeEntries(after)) {
      throw new Error(`${files.mimeapps} does not have the ${HANDLER_MIME_LINE} and ${HANDLER_ADDED_LINE} entries after writing`);
    }
  } catch (error) {
    // Leave nothing half-registered: drop the entry we just wrote (not one that was already there)
    // and put mimeapps.list back as it was. One this call created stays, without our lines: mimeapps.list
    // is never deleted.
    if (!existed) await removeBound(desktopFile, { force: true });
    try {
      if (wrote && mimeBefore !== undefined) await writeFileAtomically(target, mimeBefore);
      else if (wrote) await writeFileAtomically(target, withoutOurMimeEntries(next) ?? next);
    } catch {
      // best effort; the original error is the one to report
    }
    throw new Error(`could not register the handler: ${errorMessage(error)}`);
  }
  deps.stdout("Registered the bridge:// handler.\n");
  return "done";
}

export interface ProtocolUninstallPlan {
  desktop: DesktopPlan;
  target: string;
  /** mimeapps.list as it will be written, or undefined when it is not touched. */
  stripped: string | undefined;
}

/**
 * What `uninstallProtocolHandler` would do, fully resolved: the desktop entry (canonical path,
 * whether it exists), where the `mimeapps.list` write lands, and the text it would write. Reads
 * only; throws what the handler would refuse (a symlinked desktop entry, a dangling link, bad
 * UTF-8, duplicate keys). For a caller's consent (`bridge uninstall`).
 */
export async function protocolUninstallPlan(deps: CliDeps): Promise<ProtocolUninstallPlan> {
  return planUninstall(protocolHandlerFiles(deps));
}

async function planUninstall(files: ReturnType<typeof protocolHandlerFiles>): Promise<ProtocolUninstallPlan> {
  const desktop = await resolveDesktop(files.desktopFile);
  const target = await mimeappsTargetOf(files.mimeapps);
  const text = await readIfExists(target); // refuses invalid UTF-8
  const stripped = text === undefined ? undefined : withoutOurMimeEntries(text); // refuses duplicate keys
  return { desktop, target, stripped };
}

/** Removes the desktop entry and only our entries from `mimeapps.list`, each only while it is still ours. */
export async function uninstallProtocolHandler(deps: CliDeps, options: ProtocolOptions = {}): Promise<ProtocolOutcome> {
  if (platformOf(deps) !== "linux") {
    deps.stdout("The bridge:// handler is Linux-only; nothing to remove.\n");
    return "unsupported";
  }
  const files = protocolHandlerFiles(deps);
  const planned = options.consented && options.plan !== undefined ? options.plan : await planUninstall(files);
  if (!planned.desktop.exists && planned.stripped === undefined) {
    deps.stdout("The bridge:// handler is not installed; nothing to remove.\n");
    return "nothing";
  }
  const lines = ["These paths will be changed:"];
  if (planned.desktop.exists) lines.push(`  ${planned.desktop.path}  (removed)`);
  if (planned.stripped !== undefined) {
    lines.push(`  ${mimeappsLabel(files.mimeapps, planned.target)}  (only our entries are removed, each only while it is still ours)`);
    lines.push(`    ${HANDLER_MIME_LINE}  (under [${DEFAULT_SECTION}])`);
    lines.push(`    ${HANDLER_DESKTOP_FILE} in the ${HANDLER_MIME_TYPE} list (under [${ADDED_SECTION}])`);
  }
  if (!(await consent(deps, lines, "Remove the bridge:// handler?", options))) {
    deps.stderr("bridge protocol uninstall: cancelled\n");
    return "cancelled";
  }
  // The prompt can take minutes: recompute the whole plan (validating every fresh input) and
  // execute only if it is identical to what consent listed. A caller that passes its consented
  // plan (`bridge uninstall`) made that one recompute itself; execution is not re-gated.
  const plan = options.consented && options.plan !== undefined ? planned : await planUninstall(files);
  if (!isDeepStrictEqual(plan, planned)) throw new Error(CHANGED_WHILE_WAITING);
  if (plan.desktop.exists) await removeBound(plan.desktop.path, { force: true });
  if (plan.stripped !== undefined) {
    await writeFileAtomically(plan.target, plan.stripped);
    const after = await readIfExists(plan.target);
    if (after === undefined || hasOurMimeEntries(after)) throw new Error(`${files.mimeapps} still has our entries after writing`);
  }
  deps.stdout("Removed the bridge:// handler.\n");
  return "done";
}

/** `bridge protocol install|uninstall [--yes]`. */
export async function runProtocol(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, { yes: { type: "boolean" } });
  const sub = positionals[0];
  if ((sub !== "install" && sub !== "uninstall") || positionals.length !== 1) {
    throw new UsageError("usage: bridge protocol install|uninstall [--yes]");
  }
  if (sub === "install") await assertNoLegacyLayout(deps);
  const options = { yes: values.yes === true };
  const outcome = sub === "install" ? await installProtocolHandler(deps, options) : await uninstallProtocolHandler(deps, options);
  return outcome === "cancelled" ? 1 : 0;
}
