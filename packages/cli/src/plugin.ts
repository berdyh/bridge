import { lstat } from "node:fs/promises";
import path from "node:path";

import { isPluginId, type ConfinedExecution } from "@berdyh/bridge-protocol";
import {
  type AuditRecord, type ConsentOptions, type InstallOptions, type InstalledPlugin, type PermissionSummary, type PluginHost,
  createPluginHost, readAudit,
} from "@berdyh/bridge-runner";

import { parse } from "./args.js";
import { type AppRecord, loadApps, printable } from "./config.js";
import { type CliDeps, UsageError, isTTYOf, platformOf, runnerOf } from "./deps.js";
import { launchdUid, serviceReport } from "./doctor.js";
import { assertLayout } from "./layout-rule.js";
import { assertNoLegacyLayout } from "./legacy.js";
import { appPathsOf } from "./paths.js";
import { resolveSource } from "./plugin-source.js";
import { startService } from "./setup.js";

/** A consent line is manifest-derived text for a terminal: strip control characters, cap the length. */
const MAX_LINE = 400;
export function printableLine(line: string): string {
  const clean = printable(line);
  return clean.length > MAX_LINE ? `${clean.slice(0, MAX_LINE)}...` : clean;
}

const PATH_LABEL = { install: "Install into", data: "Plugin data in", remove: "Remove" } as const;

/**
 * What a plugin consent prints: the manifest-derived lines (capped), then every path it writes or removes on
 * its own line, in full (control characters stripped, never cut: a consent must show the whole destination).
 */
export function consentText(summary: PermissionSummary): string {
  const lines = summary.lines.map((l) => `${printableLine(l)}\n`);
  const paths = (summary.paths ?? []).map((p) => `${PATH_LABEL[p.action]} ${printable(p.path)}\n`);
  return [...lines, ...paths].join("");
}

/** The host's `log` option: one call per line, from the host itself or forwarded from a plugin's `log` call or stderr. */
export type PluginLog = NonNullable<Parameters<typeof createPluginHost>[0]["log"]>;

const MAX_LOG = 2000;
const capped = (text: string): string => (text.length > MAX_LOG ? `${text.slice(0, MAX_LOG)}...` : text);

/**
 * The runner's stderr line for a plugin host log call, in the shape of the per-app log (`[who] level: message {fields}`).
 * The host does not say which app a plugin belongs to, so the tag names the plugin. Plugin text is untrusted: control
 * characters are stripped and the length is capped. The host passes only a refused start's code and reason, never the
 * start params, so nothing here can carry the session secret from the host; a plugin's own text is its own.
 */
export function pluginLogOf(deps: Pick<CliDeps, "stderr">): PluginLog {
  return (pluginId, level, message, fields) => {
    if (level === "debug") return;
    const json = fields === undefined ? undefined : JSON.stringify(fields);
    deps.stderr(`[plugin ${printable(pluginId)}] ${printable(level).slice(0, 16)}: ${capped(printable(message))}${json ? ` ${capped(printable(json))}` : ""}\n`);
  };
}

/**
 * The plugin host over the connected apps' own folders (`<data>/<app>/bridge/plugins`); a plugin installs only into its manifest's app.
 * `bridge run` passes a `log`; the one-shot `plugin` commands pass none (they report through their output and exit code, and a
 * log line on stderr would change what a script reading `plugin list` sees).
 */
export function pluginHostFor(deps: CliDeps, apps: readonly Pick<AppRecord, "appId">[], log?: PluginLog): PluginHost {
  return deps.pluginHost ?? createPluginHost({ apps: apps.map((a) => appPathsOf(deps, a.appId)), env: deps.env, ...(log ? { log } : {}) });
}

export const PLUGIN_USAGE =
  "usage: bridge plugin add <path | https://...tgz --sha256 <hex> | npm:<name>@<version> [--integrity sha512-...]> [--replace] [--yes] [--no-restart]" +
  " | list [--json] | remove <id> [--keep-data] [--yes] [--no-restart] | revoke <id> [--yes] [--no-restart] | audit <id> [--limit <n>] [--json]";

/**
 * One entry of `bridge plugin list --json` (stable: new fields may be added, none renamed or removed). The grants summary is
 * what the manifest declares and the user approved at install, shaped like the consent summary: host names, fs paths, agent
 * ids, whether a localhost UI is asked for, the names of the MCP servers it ships and the tools a headless session may call.
 */
export interface PluginListEntry {
  id: string;
  version: string;
  app: string;
  grants: { network: string[]; fs: string[]; agents: string[]; localUi: boolean; mcpServers: string[]; headlessTools: string[]; execution?: ConfinedExecution };
}

/** The `--json` entry of an installed plugin; arrays are always present (empty when nothing is declared). */
export function pluginJsonOf(p: InstalledPlugin): PluginListEntry {
  const g = p.manifest.permissions;
  return {
    id: p.manifest.id,
    version: p.version,
    app: p.appId,
    grants: {
      network: [...(g.network ?? [])],
      fs: [...(g.fs ?? [])],
      agents: [...(g.agents ?? [])],
      localUi: g.localUi !== undefined,
      mcpServers: Object.keys(g.mcpServers ?? {}),
      headlessTools: [...(g.headless?.tools ?? [])],
      ...(g.execution ? { execution: { profile: g.execution.profile, network: [...g.execution.network] } } : {}),
    },
  };
}

/** The flags each subcommand takes; any other is a usage error rather than a silent no-op. */
const FLAGS_OF: Record<string, readonly string[]> = {
  add: ["yes", "sha256", "integrity", "replace", "no-restart"],
  list: ["json"],
  remove: ["yes", "keep-data", "no-restart"],
  revoke: ["yes", "no-restart"],
  audit: ["limit", "json"],
};

/**
 * Whether the installed service is running now. systemd: `active`. launchd: `launchctl print` succeeds for a job that is
 * merely loaded, so its own `state = running` line decides; a loaded job that is not running is left alone.
 */
async function serviceRunning(deps: CliDeps): Promise<boolean> {
  const service = await serviceReport(deps).catch(() => undefined);
  if (!service?.installed) return false;
  if (platformOf(deps) !== "darwin") return service.state === "active";
  if (service.state !== "loaded") return false;
  const printed = await runnerOf(deps)("launchctl", ["print", `gui/${launchdUid()}/${service.name}`]).catch(() => undefined);
  return printed?.exitCode === 0 && /^\s*state = running\s*$/m.test(printed.stdout);
}

const RESTART_EFFECT = "open agent sessions of every app end; browsers reconnect.";

/**
 * Consent before consequences: a change that will restart the running service says so before its question, on every
 * subcommand that asks (add, remove, revoke), and only when approving causes a restart (not with `--no-restart`, not without
 * a running service). The later "Restarting the bridge service" line reports the act itself, after a yes.
 */
async function noticeRestart(deps: CliDeps, noRestart: boolean): Promise<void> {
  if (!noRestart && (await serviceRunning(deps))) deps.stdout(`Approving restarts the bridge service: ${RESTART_EFFECT}\n`);
}

/**
 * A change to the plugins takes effect on the next start of the runner. When the background service is
 * installed and running, restart it (open agent sessions of every app end; browsers reconnect). Returns the exit
 * code: a restart that failed is reported, since the change is made but not live.
 */
async function applyToService(deps: CliDeps, noRestart: boolean): Promise<{ restarted: boolean; code: number }> {
  if (noRestart) return { restarted: false, code: 0 };
  if (!(await serviceRunning(deps))) return { restarted: false, code: 0 };
  deps.stdout(`Restarting the bridge service: ${RESTART_EFFECT}\n`);
  const result = await startService(deps, true);
  if (result.ok) return { restarted: true, code: 0 };
  deps.stderr(`bridge plugin: the change is made, but the bridge service did not restart: ${printable(result.error)}\n`);
  return { restarted: false, code: 1 };
}

const LATER = "Restart `bridge run` (or the bridge service) to load it.";

export interface AuditReader {
  readAudit(file: string, options: { limit: number }): Promise<AuditRecord[]>;
}

/** `bridge plugin audit <id>`: the newest tool-call records of the plugin's contained sessions, from whichever app holds its log. */
export async function runPluginAudit(
  deps: CliDeps, apps: readonly Pick<AppRecord, "appId">[], id: string, options: { limit: number; json: boolean }, reader: AuditReader = { readAudit },
): Promise<number> {
  let found = false;
  for (const app of apps) {
    const file = path.join(appPathsOf(deps, app.appId).auditDir, `${id}.jsonl`);
    if (!(await lstat(file).then(() => true, () => false))) continue;
    found = true;
    const records = await reader.readAudit(file, { limit: options.limit });
    if (options.json) deps.stdout(`${JSON.stringify({ pluginId: id, appId: app.appId, file, records })}\n`);
    else {
      deps.stdout(`Audit of ${printable(id)} for app ${printable(app.appId)} (${printable(file)})\n`);
      if (records.length === 0) deps.stdout("No records.\n");
      // "none" means a record that says no permission request was made; no decision yet (a frame before its request) is "-".
      for (const r of records) {
        deps.stdout(`${printable(r.time)}\t${printable(r.decision ?? "-")}\t${printable(r.toolName ?? "(unnamed call)")}\t${printable(r.status ?? "")}\tsession ${printable(r.sessionId)}\n`);
      }
    }
  }
  if (!found) deps.stdout(options.json ? `${JSON.stringify({ pluginId: id, appId: null, file: null, records: [] })}\n` : `No audit records for ${printable(id)}.\n`);
  return 0;
}

/** `bridge plugin add|list|remove|revoke|audit`. Nothing is written before the user confirms. */
export async function runPlugin(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, {
    yes: { type: "boolean" }, sha256: { type: "string" }, integrity: { type: "string" }, replace: { type: "boolean" },
    "no-restart": { type: "boolean" }, "keep-data": { type: "boolean" }, limit: { type: "string" }, json: { type: "boolean" },
  });
  const [sub, arg] = positionals;
  if (sub === undefined || FLAGS_OF[sub] === undefined) throw new UsageError(PLUGIN_USAGE);
  for (const [flag, value] of Object.entries(values)) {
    if (value !== undefined && !FLAGS_OF[sub]!.includes(flag)) throw new UsageError(`--${flag} does not apply to \`plugin ${sub}\`; ${PLUGIN_USAGE}`);
  }
  if (positionals.length !== (sub === "list" ? 1 : 2) || (sub !== "list" && arg === undefined)) throw new UsageError(PLUGIN_USAGE);
  const yes = values.yes === true;
  const noRestart = values["no-restart"] === true;
  let limit = 50;
  if (sub === "audit" && values.limit !== undefined) {
    limit = /^\d+$/.test(values.limit) ? Number(values.limit) : 0;
    if (limit < 1 || limit > 10_000) throw new UsageError("--limit is a whole number from 1 to 10000");
  }
  await assertNoLegacyLayout(deps);
  const apps = await loadApps(deps);
  // Rule A (consent-plan.ts) before any plan, as run, connect and apps remove do: an app's bridge/ dir that resolves
  // into another app's would carry this app's plugin into that app's folder.
  if (sub !== "list" && sub !== "audit") await assertLayout(deps, "change plugins in", apps.map((a) => a.appId));
  if (sub === "audit") {
    if (!isPluginId(arg)) throw new UsageError("not a plugin id");
    return runPluginAudit(deps, apps, arg, { limit, json: values.json === true });
  }
  const host = pluginHostFor(deps, apps);
  if (sub === "list") {
    const plugins = await host.list();
    if (values.json) {
      deps.stdout(`${JSON.stringify(plugins.map(pluginJsonOf))}\n`);
      return 0;
    }
    if (plugins.length === 0) deps.stdout("No plugins installed.\n");
    for (const p of plugins) deps.stdout(`${p.manifest.id}\t${p.version}\tapp ${p.appId}\n`);
    return 0;
  }
  if (sub === "add") {
    // The host asks only for an install that changes something: an identical `--replace` of an approved plugin returns
    // without asking; one whose approval was revoked or does not fit asks, and a yes restores it.
    let asked = false;
    const consent: ConsentOptions = {
      async confirm(summary) {
        asked = true;
        deps.stdout(consentText(summary));
        await noticeRestart(deps, noRestart);
        return yes || deps.confirm("Allow this?");
      },
    };
    const source = await resolveSource(deps, arg!, {
      nonInteractive: yes, ...(values.sha256 !== undefined ? { sha256: values.sha256 } : {}), ...(values.integrity !== undefined ? { integrity: values.integrity } : {}),
    });
    let plugin;
    try {
      if (source.verified) deps.stdout(`${source.verified}\n`);
      await source.recheck();
      // `--yes` is "not a person" and answers only a grant that is not widened; a person at a terminal
      // (stdin and stdout both TTYs, no `--yes`) is the only answer the host takes for a widened one.
      const options: InstallOptions = {
        ...(values.replace === true ? { replace: true } : {}),
        ...(yes ? { nonInteractive: true } : {}),
        ...(!yes && isTTYOf(deps) ? { terminal: true } : {}),
        ...(source.pinnedHash ? { pinnedHash: source.pinnedHash } : {}),
      };
      plugin = await host.install(source.path, consent, options);
    } finally {
      await source.cleanup();
    }
    if (!asked) {
      // An identical `--replace` changed nothing: no restart, so no app's open sessions end.
      deps.stdout(`Nothing changed: ${plugin.manifest.id}@${plugin.version} is already installed with identical content.\n`);
      return 0;
    }
    const change = await applyToService(deps, noRestart);
    deps.stdout(`Installed ${plugin.manifest.id}@${plugin.version} for app ${plugin.manifest.app}.${change.restarted ? "" : ` ${LATER}`}\n`);
    return change.code;
  }
  if (sub === "remove") {
    const keepData = values["keep-data"] === true;
    let asked = false;
    await host.remove(arg!, {
      async confirm(summary) {
        asked = true;
        // The removal list (every install and data folder that goes) is printed before the question, with or without --yes.
        deps.stdout(consentText(summary));
        await noticeRestart(deps, noRestart);
        const what = `Remove plugin ${printableLine(summary.pluginId)}@${printableLine(summary.version)}`;
        return yes || deps.confirm(keepData ? `${what}? Its data and audit files stay.` : `${what} and its data?`);
      },
    }, keepData ? { keepData: true } : {});
    // The host asks about every copy it removes, an invalid one included, and returns without asking for an id it does not hold:
    // nothing was removed, so no restart and no "Removed".
    if (!asked) throw new Error(`Plugin ${printable(arg!)} is not installed`);
    const change = await applyToService(deps, noRestart);
    deps.stdout(`Removed ${printable(arg!)}.${change.restarted ? "" : ` ${LATER}`}\n`);
    return change.code;
  }
  // revoke
  const installed = (await host.list()).find((p) => p.manifest.id === arg);
  if (!installed) throw new Error(`No plugin ${printable(arg!)} is installed`);
  deps.stdout(`Revoking the consent of ${printableLine(installed.manifest.id)}@${printableLine(installed.version)}: its background sessions stop at once, and its next contained session fails until you install it again and confirm.\n`);
  // The host binds the consent folder before this question and refuses if it moved while the answer was awaited.
  await host.revoke(arg!, {
    async confirm() {
      await noticeRestart(deps, noRestart);
      return yes || deps.confirm("Revoke this consent?");
    },
  });
  const change = await applyToService(deps, noRestart);
  deps.stdout(`Revoked ${printable(arg!)}.${change.restarted ? "" : ` ${LATER}`}\n`);
  return change.code;
}
