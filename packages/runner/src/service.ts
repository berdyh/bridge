import path from "node:path";

import type { CommandRunner, Platform } from "./contracts.js";
import { type BaseDirs, runnerPaths } from "./paths.js";

export interface ServiceFile {
  path: string;
  contents: string;
  mode: number;
}

export interface ServiceLink {
  path: string;
  /** What the link points at. Created by `activate`, not by the fs writer. */
  target: string;
}

export interface ServicePlan {
  platform: Platform;
  serviceName: string;
  /** Directories the install creates (the log's parent; the service fails to start without it). */
  dirs: string[];
  /** Files the install writes, in order. */
  files: ServiceFile[];
  /** Symlinks the activation commands create (`systemctl --user enable`). */
  links: ServiceLink[];
  /** Commands that activate / deactivate it (data only; never run by planService). */
  activate: string[][];
  deactivate: string[][];
  /** Run after the files are removed (systemd daemon-reload). */
  afterRemove: string[][];
}

/** Every path install/activation writes: this is what confirm() sees and what doctor lists. */
export function planPaths(plan: ServicePlan): string[] {
  return [...plan.dirs, ...plan.files.map((f) => f.path), ...plan.links.map((l) => l.path)];
}

export interface ServiceSpec {
  app: string;
  platform: Platform;
  base: BaseDirs;
  /** Absolute path of the launcher to run (resolves newest version at start). */
  launcher: string;
  args?: string[];
  /** macOS user id for the launchd gui/<uid> domain (default 501). */
  uid?: number;
  /**
   * Environment baked into the service, captured at install time. Services get
   * a minimal PATH, so pass the PATH that finds node and the agent CLIs
   * (see `captureServiceEnv`).
   */
  env?: Record<string, string>;
}

/** The slice of the installing shell's environment a service needs. */
export function captureServiceEnv(env: Record<string, string | undefined>): Record<string, string> {
  return env.PATH ? { PATH: env.PATH } : {};
}

function envEntries(spec: ServiceSpec): [string, string][] {
  const entries = Object.entries(spec.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid environment variable name: ${k}`);
    if (/[\r\n\0]/.test(v)) throw new Error(`environment variable ${k} contains a line break`);
  }
  return entries;
}

export function systemdUnit(spec: ServiceSpec): string {
  const p = runnerPaths(spec);
  const exec = [spec.launcher, ...(spec.args ?? ["serve"])].map(systemdQuote).join(" ");
  return [
    "[Unit]",
    `Description=${spec.app} local agent runner`,
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    ...envEntries(spec).map(([k, v]) => `Environment="${systemdEscape(`${k}=${v}`)}"`),
    "Restart=on-failure",
    "RestartSec=5",
    `StandardOutput=append:${systemdSpecifier(p.logFile)}`,
    `StandardError=append:${systemdSpecifier(p.logFile)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** `%` starts a specifier in unit files; `%%` is a literal percent. */
function systemdSpecifier(value: string): string {
  return value.replace(/%/g, "%%");
}

function systemdEscape(value: string): string {
  return systemdSpecifier(value.replace(/([\\"])/g, "\\$1"));
}

/** ExecStart words: `%` and `$` are expanded by systemd, so both are escaped. */
function systemdQuote(arg: string): string {
  const escaped = arg.replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_@+=:,./-]+$/.test(arg)
    ? escaped
    : `"${systemdSpecifier(escaped.replace(/(["\\])/g, "\\$1"))}"`;
}

export function launchdPlist(spec: ServiceSpec): string {
  const p = runnerPaths(spec);
  const argv = [spec.launcher, ...(spec.args ?? ["serve"])]
    .map((a) => `    <string>${xml(a)}</string>`)
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${xml(p.serviceName)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    argv,
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    // Restart only after a crash: the runner's idle exit (status 0) must stay stopped.
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    ...plistEnv(spec),
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(p.logFile)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(p.logFile)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

function plistEnv(spec: ServiceSpec): string[] {
  const entries = envEntries(spec);
  if (entries.length === 0) return [];
  return [
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...entries.flatMap(([k, v]) => [`    <key>${xml(k)}</key>`, `    <string>${xml(v)}</string>`]),
    `  </dict>`,
  ];
}

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function planService(spec: ServiceSpec): ServicePlan {
  const p = runnerPaths(spec);
  if (!path.isAbsolute(spec.launcher)) throw new Error("launcher must be an absolute path");
  if (spec.platform === "linux") {
    return {
      platform: "linux",
      serviceName: p.serviceName,
      dirs: [p.stateDir],
      files: [{ path: p.serviceFile, contents: systemdUnit(spec), mode: 0o644 }],
      // `systemctl --user enable` creates this symlink.
      links: [
        {
          path: path.join(path.dirname(p.serviceFile), "default.target.wants", p.serviceName),
          target: p.serviceFile,
        },
      ],
      activate: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", p.serviceName],
      ],
      deactivate: [["systemctl", "--user", "disable", "--now", p.serviceName]],
      afterRemove: [["systemctl", "--user", "daemon-reload"]],
    };
  }
  const domain = `gui/${spec.uid ?? 501}`;
  return {
    platform: "darwin",
    serviceName: p.serviceName,
    dirs: [p.stateDir],
    files: [{ path: p.serviceFile, contents: launchdPlist(spec), mode: 0o644 }],
    links: [],
    activate: [["launchctl", "bootstrap", domain, p.serviceFile]],
    deactivate: [["launchctl", "bootout", `${domain}/${p.serviceName}`]],
    afterRemove: [],
  };
}

/** The fs surface the writer needs; inject node:fs/promises or a fake. */
export interface ServiceFs {
  mkdir(dir: string, opts: { recursive: true; mode?: number }): Promise<unknown>;
  writeFile(file: string, contents: string, opts: { mode: number }): Promise<void>;
  rm(file: string, opts: { force: true }): Promise<void>;
}

/** Called with the full list of paths before ANY write, activation or removal. */
export type ConfirmFn = (paths: readonly string[]) => boolean | Promise<boolean>;

export interface CommandFailure {
  command: string[];
  stderr: string;
}

/**
 * Creates the dirs, writes the files, then (only when `run` is given)
 * activates. One confirm() call, made first with `planPaths(plan)`, covers all
 * of it, including the symlink activation creates.
 */
export async function installService(
  plan: ServicePlan,
  deps: { fs: ServiceFs; confirm: ConfirmFn; run?: CommandRunner },
): Promise<{ written: string[]; activation?: { ok: boolean; failed?: CommandFailure } }> {
  if (!(await deps.confirm(planPaths(plan)))) return { written: [] };
  const written: string[] = [];
  for (const dir of plan.dirs) {
    await deps.fs.mkdir(dir, { recursive: true, mode: 0o700 });
    written.push(dir);
  }
  for (const file of plan.files) {
    await deps.fs.mkdir(path.dirname(file.path), { recursive: true });
    await deps.fs.writeFile(file.path, file.contents, { mode: file.mode });
    written.push(file.path);
  }
  if (!deps.run) return { written };
  return { written, activation: await runServiceCommands(plan.activate, deps.run) };
}

/**
 * Sequenced removal: deactivate (so nothing is orphaned and the wants symlink
 * goes away), remove exactly the plan's files and links, then reload. Never
 * removes directories (the state dir belongs to the runner). A failing
 * deactivate (e.g. never enabled) is reported but does not stop removal.
 */
export async function uninstallService(
  plan: ServicePlan,
  deps: { fs: ServiceFs; confirm: ConfirmFn; run?: CommandRunner },
): Promise<{ removed: string[]; deactivation?: { ok: boolean; failed?: CommandFailure }; reload?: { ok: boolean; failed?: CommandFailure } }> {
  if (!(await deps.confirm(planPaths(plan)))) return { removed: [] };
  const deactivation = deps.run ? await runServiceCommands(plan.deactivate, deps.run) : undefined;
  const removed = [...plan.links.map((l) => l.path), ...plan.files.map((f) => f.path)];
  for (const p of removed) await deps.fs.rm(p, { force: true });
  const reload = deps.run ? await runServiceCommands(plan.afterRemove, deps.run) : undefined;
  return { removed, ...(deactivation && { deactivation }), ...(reload && { reload }) };
}

/** Runs commands through an injected runner, stopping at the first failure. */
export async function runServiceCommands(
  commands: readonly string[][],
  run: CommandRunner,
): Promise<{ ok: boolean; failed?: CommandFailure }> {
  for (const command of commands) {
    const [bin, ...args] = command;
    if (!bin) continue;
    const r = await run(bin, args);
    if (r.exitCode !== 0) return { ok: false, failed: { command, stderr: r.stderr } };
  }
  return { ok: true };
}
