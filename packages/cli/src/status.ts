import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  readEnrollWindow,
  runnerStatusPath,
  type LinkStatus,
  type RunnerStatusFile,
} from "@berdyh/bridge-runner";

import { parse } from "./args.js";
import { type AppRecord, isLocalApp, loadApps, printable } from "./config.js";
import { type CliDeps, UsageError, e2eeOf } from "./deps.js";
import { appPathsOf, runnerPathsOf } from "./paths.js";
import { e2eeAppOf } from "./enroll.js";
import { assertNoLegacyLayout } from "./legacy.js";

export { runnerPathsOf };

/** The default session working folder of an app: `<state>/<app>/bridge/work`. */
export function workDirOf(deps: CliDeps, appId: string): string {
  return appPathsOf(deps, appId).workDir;
}

export function statusFilePath(deps: CliDeps): string {
  return runnerStatusPath(runnerPathsOf(deps));
}

/** Writes `runner.json` atomically (temp file, then rename), owner-only. */
export async function writeRunnerStatus(deps: CliDeps, status: RunnerStatusFile): Promise<void> {
  const file = statusFilePath(deps);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Removes `runner.json`, but only if it still names this process (a newer runner's file stays). */
export async function removeRunnerStatus(deps: CliDeps, pid: number = process.pid): Promise<void> {
  const current = await readStatusFile(deps);
  if (current && current.pid !== pid) return;
  await rm(statusFilePath(deps), { force: true });
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const LINK_STATUSES: readonly string[] = ["connecting", "online", "reconnecting", "update_required", "replaced", "revoked", "auth_failed", "stopped", "local"];

async function readStatusFile(deps: CliDeps): Promise<RunnerStatusFile | undefined> {
  let parsed: Partial<RunnerStatusFile> | null;
  try {
    parsed = JSON.parse(await readFile(statusFilePath(deps), "utf8")) as Partial<RunnerStatusFile> | null;
  } catch {
    return undefined;
  }
  if (
    !parsed || parsed.version !== 1 || !Number.isInteger(parsed.pid) || typeof parsed.startedAt !== "string" ||
    typeof parsed.browsers !== "number" || typeof parsed.apps !== "object" || parsed.apps === null ||
    !Object.values(parsed.apps).every((s) => LINK_STATUSES.includes(s))
  ) return undefined;
  return parsed as RunnerStatusFile;
}

/** The status of the running `bridge run`, or undefined when there is none (no file, unreadable, or its pid is dead). */
export async function readRunnerStatus(deps: CliDeps): Promise<RunnerStatusFile | undefined> {
  const file = await readStatusFile(deps);
  return file && isPidAlive(file.pid) ? file : undefined;
}

export interface AppStatus {
  appId: string;
  name: string;
  origin: string;
  /** The link status, `local` for a local app the runner serves (it has no link), or `not_running` / `not_served` (the runner started before this app was connected). */
  link: LinkStatus | "local" | "not_running" | "not_served";
  trustedBrowsers: number;
  enrollWindowOpen: boolean;
}

export interface StatusReport {
  running: boolean;
  pid?: number;
  startedAt?: string;
  browsers?: number;
  idleSince?: string;
  apps: AppStatus[];
}

async function enrollWindowOpen(deps: CliDeps, app: Parameters<typeof e2eeAppOf>[0]): Promise<boolean> {
  const window = await readEnrollWindow(e2eeAppOf(app, deps)).catch(() => undefined);
  if (!window || window.consumed || window.state !== "open") return false;
  return Date.parse(window.expiresAt) > (deps.now?.() ?? Date.now()) && isPidAlive(window.ownerPid);
}

/**
 * What the running bridge says about `app`: its worker's entry counts only when its kind matches the app's current
 * record (`local` for a local record, anything else for a hosted one). The entry is keyed by app id alone, so an app
 * removed and recreated as the other kind under a live runner leaves an entry of the old kind: that is `not_served`.
 */
export function servedAs(runner: RunnerStatusFile, app: AppRecord): LinkStatus | "local" | "not_served" {
  const entry = runner.apps[app.appId];
  if (entry === undefined || (entry === "local") !== isLocalApp(app)) return "not_served";
  return entry;
}

export async function statusReport(deps: CliDeps): Promise<StatusReport> {
  const runner = await readRunnerStatus(deps);
  const apps = await loadApps(deps);
  const rows: AppStatus[] = [];
  for (const app of apps) {
    const link: AppStatus["link"] = runner ? servedAs(runner, app) : "not_running";
    // A local app has no identity, trust list or enroll window: nothing to ask the E2EE store.
    if (isLocalApp(app)) {
      rows.push({ appId: app.appId, name: printable(app.name), origin: printable(app.origin), link, trustedBrowsers: 0, enrollWindowOpen: false });
      continue;
    }
    const trusted = await e2eeOf(deps).listBrowsers(e2eeAppOf(app, deps)).then((list) => list.length, () => 0);
    rows.push({
      appId: app.appId,
      name: printable(app.name),
      origin: printable(app.origin),
      link,
      trustedBrowsers: trusted,
      enrollWindowOpen: await enrollWindowOpen(deps, app),
    });
  }
  return runner
    ? { running: true, pid: runner.pid, startedAt: runner.startedAt, browsers: runner.browsers, ...(runner.idleSince ? { idleSince: runner.idleSince } : {}), apps: rows }
    : { running: false, apps: rows };
}

/** Whether an enroll window of any kind is open for `app`: used by the idle timer (an open window is activity). */
export { enrollWindowOpen };

/**
 * A stamp of each app's `bridge/` config folder (one per app, joined) that changes whenever a file in it,
 * such as an enroll window, is created, rewritten or removed (the daemon writes by rename and removes by
 * unlink, both of which move the directory's mtime). The idle timer compares stamps to notice a window that
 * opened and closed between two looks. An app with no folder yet contributes `""`.
 */
export async function enrollDirStamp(deps: CliDeps, apps: readonly Pick<AppRecord, "appId">[]): Promise<string> {
  const stamps = await Promise.all(
    apps.map((app) =>
      stat(appPathsOf(deps, app.appId).configDir, { bigint: true }).then((s) => String(s.mtimeNs), () => ""),
    ),
  );
  return stamps.join("|");
}

/** `bridge status [--json]`: the runner and, per app, link status, trusted browsers and the enroll window. */
export async function runStatus(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: "boolean" } });
  if (positionals.length > 0) throw new UsageError("usage: bridge status [--json]");
  await assertNoLegacyLayout(deps);
  const report = await statusReport(deps);
  if (values.json) {
    deps.stdout(`${JSON.stringify(report)}\n`);
    return 0;
  }
  deps.stdout(report.running ? `bridge run is running (pid ${report.pid}, since ${report.startedAt}); ${report.browsers} browser(s) connected${report.idleSince ? `, idle since ${report.idleSince}` : ""}\n` : "bridge run is not running; start it with `bridge run`\n");
  if (report.apps.length === 0) deps.stdout("No apps connected. Run `bridge connect <app-url>` or `bridge apps add-local <app-id>`.\n");
  for (const a of report.apps) {
    deps.stdout(`${a.appId}\t${a.name}\t${a.link}\t${a.trustedBrowsers} trusted browser(s)\tenroll window ${a.enrollWindowOpen ? "open" : "closed"}\n`);
  }
  return 0;
}
