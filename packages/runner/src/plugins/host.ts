import { lstat, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { escapeControlChars, isPluginId, type JsonRpcMessage } from "@berdyh/bridge-protocol";
import type { AgentSessionBroker } from "../acp/contracts.js";
import { removeBound } from "../install/remove-bound.js";
import { compareSemver } from "../install/semver.js";
import { type ConsentedGrant, type ConsentOptions, type ConsentStore, type GrantItem, type GrantSurface, type InstalledPlugin, type InstallOptions, type PermissionSummary, type PluginHost, grantWidened, installAnswerProblem } from "./contracts.js";
import { auditFilesOf as realAuditFilesOf } from "../audit/index.js";
import { type AppPaths, assertAppFolderName } from "../paths.js";
import { type BoundConsentStore, createConsentStore, diffSurfaces, surfaceOf, surfaceSha256Of } from "./consent.js";
import { assertNoSymlinks, hashFileSet, readPluginPackage, resolveAppDataDir, validVersion } from "./package.js";
import { ManagedPlugin, type ProcessOptions } from "./process.js";
import { createExtensionRouter, type PluginLookup } from "./router.js";

export interface PluginHostOptions {
  /**
   * Per-app plugin folders (`appPathsOf(base, id)`): only these apps are scanned, installed into
   * or removed from. A plugin is installed into the folder of the app its manifest names, which
   * must be listed here; a plugin id lives under one app only.
   */
  apps: readonly Pick<AppPaths, "appId" | "pluginsDir" | "pluginDataDir" | "consentDir" | "auditDir">[];
  /** Node binary for plugin processes. Default `process.execPath`. */
  nodePath?: string;
  /** Parent environment to strip. Default `process.env`. */
  env?: Record<string, string | undefined>;
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
  startupTimeoutMs?: number;
  /** Optional call deadline. By default methods wait for completion or disconnect. */
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  healthyAfterMs?: number;
  log?: ProcessOptions["log"];
  /**
   * Every audit path of one plugin (`<auditDir>/<id>.jsonl` and its rotation), for the removal prompt and for
   * removal. The default is `audit/auditFilesOf`, the one place those names are made; a test may name them itself.
   */
  auditFilesOf?: (paths: Pick<AppPaths, "auditDir">, pluginId: string) => string[] | Promise<string[]>;
}

/** The host, plus what the session start needs from it: the consent that still matches an installed plugin. */
export interface PluginHostWithGrants extends PluginHost {
  /**
   * What the person consented to for the newest installed version of `pluginId`, or undefined when a contained
   * session must not start: no record, a record or consent folder behind a link, an unreadable record, a hash
   * that does not match its own surface, or a surface that differs from the installed manifest's (a hand-edited
   * record). The caller answers `consentMissing` (-32019) on undefined and puts the grant in the broker request.
   */
  grantOf(pluginId: string): Promise<ConsentedGrant | undefined>;
  revoke(pluginId: string, consent?: ConsentOptions): Promise<void>;
}

/** One grant item as a line of the consent screen. The text is the manifest's, so control characters are escaped. */
function describeItem(item: GrantItem): string {
  const text = (value: string) => escapeControlChars(value);
  switch (item.kind) {
    case "agent": return `agent ${text(item.value)}`;
    case "network": return `network access to ${text(item.value)}`;
    case "fs": return `filesystem access to ${text(item.value)}`;
    case "localUi": return `a local UI (port ${text(item.value)})`;
    case "execution": return `scripts in a private runner workspace; exact HTTPS network scope ${text(item.value)}`;
    case "headlessTool": return `headless tool ${text(item.value)}`;
    case "mcpServer": {
      const server = parseMcpItem(item.value);
      return server ? `MCP server ${text(server.name)}: ${text([server.entry, ...server.args].join(" "))}` : `MCP server ${text(item.value)}`;
    }
  }
}

function parseMcpItem(value: string): { name: string; entry: string; args: string[] } | undefined {
  try {
    const parsed = JSON.parse(value) as { name: string; entry: string; args?: string[] };
    return { name: parsed.name, entry: parsed.entry, args: parsed.args ?? [] };
  } catch {
    return undefined;
  }
}

/**
 * The items that make a grant "widened", for the refusal text: all server and tool items of a first install,
 * every item of an update that has no valid record to compare with, the added ones of an update that has one.
 */
function wideningItems(surface: GrantSurface, consented: GrantSurface | undefined, update: boolean): readonly GrantItem[] {
  if (consented === undefined) return update ? surface.items : surface.items.filter((item) => item.kind === "mcpServer" || item.kind === "headlessTool" || item.kind === "execution");
  return diffSurfaces(consented, surface).added;
}

/** A consent record counts for an installed plugin only when it is the approval of the manifest that is installed (what `grantOf` applies). */
const recordFits = (grant: ConsentedGrant | undefined, plugin: InstalledPlugin | undefined): grant is ConsentedGrant =>
  grant !== undefined && plugin !== undefined && grant.surfaceSha256 === surfaceSha256Of(surfaceOf(plugin.manifest));

interface Consenting {
  /** The surface the person approved before, when there is a valid record. */
  consented: GrantSurface | undefined;
  /** An earlier version of the plugin is installed: the prompt is an update or a refresh. */
  update: boolean;
  /** The "widened grant": no valid record for an installed plugin counts as widened, so only a terminal answer accepts it. */
  widened: boolean;
  /** The audit file the plugin's contained sessions write. */
  auditFile: string;
}

/** What the person is asked to approve for an install, an update or a refresh. */
function summary(plugin: InstalledPlugin, consenting?: Consenting): PermissionSummary {
  const { manifest, version } = plugin;
  const network = [...(manifest.permissions.network ?? [])];
  const fs = [...(manifest.permissions.fs ?? [])];
  const agents = [...(manifest.permissions.agents ?? [])];
  const localUi = !!manifest.permissions.localUi;
  const lines = [
    `Plugin ${manifest.id}@${version} for app ${manifest.app}`,
    `Network: ${network.join(", ") || "none declared"}`,
    `Filesystem: ${fs.join(", ") || "none declared"}`,
    `Agents: ${agents.join(", ") || "none"}`,
    `Local UI: ${localUi ? "127.0.0.1 on an automatic port" : "no"}`,
  ];
  if (manifest.permissions.execution) lines.push(`Execution: confined-v1; run scripts and read/write a private runner workspace/artifacts; HTTPS only ${manifest.permissions.execution.network.join(", ") || "none"}; external broker secret on fd3${manifest.permissions.execution.broker ? "; broker-only HTTP Unix service beneath consented $PLUGIN_DATA filesystem paths" : ""}`);
  const result: PermissionSummary = { pluginId: manifest.id, app: manifest.app, version, network, fs, agents, localUi, lines };
  if (consenting) {
    const surface = surfaceOf(manifest);
    const servers = surface.items.flatMap((item) => (item.kind === "mcpServer" ? [parseMcpItem(item.value)].filter((server) => server !== undefined) : []));
    const headless = surface.items.filter((item) => item.kind === "headlessTool").map((item) => item.value);
    result.mcpServers = servers.map((server) => ({ name: server.name, entry: server.entry, args: server.args }));
    result.headless = headless;
    result.surfaceSha256 = surfaceSha256Of(surface);
    result.widened = consenting.widened;
    if (consenting.update) result.diff = diffSurfaces(consenting.consented, surface);
    if (servers.length) {
      lines.push("MCP servers this plugin ships, started by bridge for its agent sessions:");
      for (const server of servers) lines.push(`  ${escapeControlChars(server.name)}: ${escapeControlChars([server.entry, ...server.args].join(" "))}`);
      lines.push(manifest.permissions.execution ? "Confined execution servers run outside the agent sandbox in a separate restricted profile; their secret stays in memory on fd3." : "These servers run as you, with everything you can read, including bridge's agent login for this machine.");
    }
    if (headless.length) {
      result.auditFile = consenting.auditFile;
      lines.push("Contained sessions of this plugin (background, or started for one of your pages) may use, without asking you:");
      for (const tool of headless) lines.push(`  ${escapeControlChars(tool)}`);
      lines.push(`Every tool call of those sessions is recorded in ${consenting.auditFile}`);
    }
    if (consenting.update) {
      const { added, removed } = result.diff!;
      lines.push(consenting.consented === undefined ? "No earlier approval of this plugin is recorded, so everything it asks for is new." : "Compared with what you approved before:");
      for (const item of added) lines.push(`  adds ${describeItem(item)}`);
      for (const item of removed) lines.push(`  removes ${describeItem(item)}`);
      if (!added.length && !removed.length) lines.push("  nothing changes in what it asks for");
    }
    if (result.widened) lines.push(consenting.update ? "This update asks for more than you approved before." : "This plugin asks for MCP servers or headless tools.");
  }
  lines.push("Network and filesystem permissions are declared and shown, but are not yet enforced. Only the environment and private paths are isolated.");
  return result;
}

/** The refusal for a widened grant that no person at a terminal answered. */
function widenedRefusal(items: readonly GrantItem[], update: boolean): string {
  const list = items.map(describeItem).join("; ");
  return `${update ? "This update" : "This install"} ${list ? `adds ${list}` : "has no valid recorded approval to compare with"}; run it in a terminal to confirm`;
}

/** The audit files of one plugin: `<id>.jsonl` and its rotations `<id>.jsonl.*`. */
const isAuditFileOf = (name: string, pluginId: string): boolean => name === `${pluginId}.jsonl` || name.startsWith(`${pluginId}.jsonl.`);

/** Where plugins live: one per listed app. */
interface Place {
  appId: string;
  /** `assertNoSymlinks` boundary: nothing at or below it may be a link. */
  boundary: string;
  root: string;
  dataRoot: string;
}

/** Installs snapshots without running scripts or resolving registry dependencies. */
export function createPluginHost(options: PluginHostOptions): PluginHostWithGrants {
  const seen = new Set<string>();
  for (const app of options.apps) {
    assertAppFolderName(app.appId);
    if (seen.has(app.appId)) throw new Error(`createPluginHost: app ${app.appId} is listed twice`);
    seen.add(app.appId);
    if (path.dirname(app.pluginsDir) !== path.dirname(app.pluginDataDir)) throw new Error(`createPluginHost: ${app.appId}: pluginsDir and pluginDataDir must share one parent`);
  }
  /** Failure-path cleanup: a bound removal; a refusal leaves the path behind and never masks the error being handled. */
  const cleanup = (target: string): Promise<void> => removeBound(target, { recursive: true, force: true }).catch(() => {});
  let places: Place[] = [];
  let baseReady: Promise<void> | undefined;
  /** Where an app's plugin folders really are now: `bridge/` resolved, the boundary below which nothing may be a link. */
  async function resolvePlace(app: PluginHostOptions["apps"][number]): Promise<Place> {
    const bridgeDir = await resolveAppDataDir(path.dirname(app.pluginsDir));
    return {
      appId: app.appId, boundary: bridgeDir.boundary,
      root: path.join(bridgeDir.baseDir, path.basename(app.pluginsDir)),
      dataRoot: path.join(bridgeDir.baseDir, path.basename(app.pluginDataDir)),
    };
  }
  /**
   * The consented place, resolved again: it must be exactly where the plan bound it (a parent retargeted
   * while the user decided moves `root`, `dataRoot` or the boundary) and link-free below the fresh boundary.
   */
  async function sameBoundPlace(place: Place, what: string): Promise<Place> {
    const app = options.apps.find((candidate) => candidate.appId === place.appId)!;
    const fresh = await resolvePlace(app);
    // The boundary is not compared: it moves legitimately once `bridge/` exists (it is the nearest existing ancestor until then).
    if (fresh.root !== place.root || fresh.dataRoot !== place.dataRoot) {
      throw new Error(`The plugin folders of ${place.appId} moved during confirmation (${place.root} is now ${fresh.root}); ${what} was not done, retry`);
    }
    await assertNoSymlinks(place.root, fresh.boundary);
    await assertNoSymlinks(place.dataRoot, fresh.boundary);
    return fresh;
  }
  /** Every place that holds a directory of this plugin id (valid or not): what `remove` deletes. */
  const homes = new Map<string, Place[]>();
  /** The place that holds this installed plugin: its app's folder, not merely a folder with the same id. */
  const placeOf = (plugin: InstalledPlugin): Place => places.find((p) => p.appId === plugin.appId)!;
  const rejected = new Map<string, PermissionSummary[]>();
  const installed = new Map<string, InstalledPlugin[]>();
  const processes = new Map<string, ManagedPlugin>();
  const brokers = new Map<string, AgentSessionBroker>();
  const sinks = new Set<(id: string, message: JsonRpcMessage) => void>();
  let loaded = false;
  let queue = Promise.resolve();
  function locked<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.then(() => {}, () => {});
    return result;
  }
  function newest(id: string): InstalledPlugin | undefined {
    return installed.get(id)?.at(-1);
  }
  /**
   * The consent that still fits the newest installed `pluginId`, read now. It takes no lifecycle lock (the
   * installed list is already loaded when it is called): a plugin's own session start during its startup or a
   * replacement runs under the lock of that very operation, and must not queue behind it.
   */
  async function grantRead(pluginId: string): Promise<ConsentedGrant | undefined> {
    const plugin = newest(pluginId);
    if (!plugin) return undefined;
    try {
      const grant = await storeOf(plugin.appId).read(pluginId);
      // A record edited by hand to match its own hash still has to match the manifest that is installed.
      return recordFits(grant, plugin) ? grant : undefined;
    } catch (error) {
      warn(pluginId, "The consent record cannot be used", { error: (error as Error).message });
      return undefined;
    }
  }
  function attach(plugin: InstalledPlugin): ManagedPlugin {
    const process = new ManagedPlugin(plugin, { ...options, pathBoundary: placeOf(plugin).boundary, broker: () => brokers.get(plugin.manifest.app), grantOf: (id) => id === plugin.manifest.id ? grantRead(id) : Promise.resolve(undefined) });
    process.onNotification((message) => { for (const sink of sinks) sink(plugin.manifest.id, message); });
    processes.set(plugin.manifest.id, process);
    return process;
  }
  const lookup: PluginLookup = (id) => {
    const plugin = newest(id);
    if (!plugin) return undefined;
    return { app: plugin.manifest.app, process: processes.get(id) ?? attach(plugin) };
  };
  lookup.subscribe = (sink) => {
    sinks.add(sink);
    for (const id of installed.keys()) {
      const plugin = newest(id)!;
      if (plugin.localUiUrl) sink(id, { jsonrpc: "2.0", method: "_bridge/localUi", params: { pluginId: id, url: plugin.localUiUrl } });
    }
    return () => { sinks.delete(sink); };
  };
  const router = createExtensionRouter(lookup);
  async function load(): Promise<void> {
    if (loaded) return;
    await (baseReady ??= (async () => {
      places = await Promise.all(options.apps.map(resolvePlace));
    })());
    function skip(id: string, version: string, error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const entries = rejected.get(id) ?? [];
      entries.push({
        pluginId: id, version, app: "unknown (invalid installed package)",
        network: [], fs: [], agents: [], localUi: false,
        lines: [`Invalid installed plugin ${id}@${version}: ${message}`, "Permissions and owning app cannot be trusted; this entry will not run."],
      });
      rejected.set(id, entries);
      try { options.log?.(id, "warn", "Skipping invalid installed plugin", { version, error: message }); }
      catch { /* Inventory must not depend on the logger. */ }
    }
    for (const place of places) {
      await assertNoSymlinks(place.root, place.boundary);
      await assertNoSymlinks(place.dataRoot, place.boundary);
      let ids: string[];
      try { ids = await readdir(place.root); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        continue;
      }
      for (const id of ids.sort()) {
        if (!isPluginId(id) || id === "bridge") continue;
        const versions: InstalledPlugin[] = [];
        homes.set(id, [...(homes.get(id) ?? []), place]);
        try {
          await assertNoSymlinks(path.join(place.root, id), place.boundary);
          for (const version of (await readdir(path.join(place.root, id))).sort()) {
            if (!validVersion(version)) continue;
            const installDir = path.join(place.root, id, version);
            try {
              await assertNoSymlinks(installDir, place.boundary);
              // The installed folder is read whole (bundled node_modules included): the file set the install saw.
              const pkg = await readPluginPackage(installDir, { installed: true });
              if (pkg.manifest.id !== id || pkg.version !== version) throw new Error("Installed plugin identity does not match its path");
              if (pkg.manifest.app !== place.appId) throw new Error(`Plugin belongs to app ${pkg.manifest.app}, not to ${place.appId}, whose folder holds it`);
              versions.push({ manifest: pkg.manifest, appId: place.appId, version, installDir, dataDir: path.join(place.dataRoot, id), status: "stopped" });
            } catch (error) { skip(id, version, error); }
          }
        } catch (error) { skip(id, "unreadable", error); }
        // With conflicting identities there is no trustworthy owning app to route to.
        if (new Set(versions.map((plugin) => plugin.manifest.app)).size > 1) {
          for (const plugin of versions) skip(id, plugin.version, new Error("Plugin versions belong to different apps"));
          continue;
        }
        if (versions.length) {
          versions.sort((a, b) => compareSemver(a.version.split("+")[0]!, b.version.split("+")[0]!));
          installed.set(id, versions);
        }
      }
    }
    loaded = true;
  }
  /** The place a plugin of `app` is installed into; refuses before anything is written. */
  function placeFor(app: string): Place {
    assertAppFolderName(app);
    const place = places.find((candidate) => candidate.appId === app);
    if (!place) throw new Error(`connect ${app} first: plugins install into the app's own folder`);
    return place;
  }
  const stores = new Map(options.apps.map((app) => [app.appId, createConsentStore({ paths: app })] as const));
  /** The consent store of an app the host serves. */
  const storeOf = (appId: string): BoundConsentStore => stores.get(appId)!;
  const appOf = (appId: string) => options.apps.find((candidate) => candidate.appId === appId)!;
  const auditFilesOf = options.auditFilesOf ?? realAuditFilesOf;
  const consentFileIn = (consentDir: string, pluginId: string) => path.join(consentDir, `${pluginId}.consent.json`);
  function warn(id: string, message: string, fields: Record<string, unknown>) {
    try { options.log?.(id, "warn", message, fields); }
    catch { /* A refresh or removal must not depend on the logger. */ }
  }
  /**
   * The audit files of a plugin in one app's audit folder, resolved like the plugin folders: the folder's
   * parent may be reached through a link that exists now, nothing at or below `bridge/` may be one. Every
   * path the audit log names must be a file of that one folder, so a removal cannot reach outside it.
   */
  async function auditPlan(appId: string, pluginId: string): Promise<{ dir: string; files: string[] }> {
    const app = appOf(appId);
    const resolved = await resolveAppDataDir(path.dirname(app.auditDir));
    const dir = path.join(resolved.baseDir, path.basename(app.auditDir));
    await assertNoSymlinks(dir, resolved.boundary);
    const files: string[] = [];
    for (const file of await auditFilesOf({ auditDir: dir }, pluginId)) {
      if (path.dirname(file) !== dir || !isAuditFileOf(path.basename(file), pluginId)) throw new Error(`Refusing an audit path outside the plugin's audit files: ${file}`);
      await assertNoSymlinks(file, resolved.boundary);
      // `auditFilesOf` names the files a plugin could have; only those that exist are shown and removed.
      // A link, even a dangling one, is refused above, so lstat sees every file that is there.
      if (await lstat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) files.push(file);
    }
    return { dir, files };
  }
  /** A refresh's file set can differ from the installed one only in content: compare like with like, bundled dependencies included. */
  async function installedFileSetHash(plugin: InstalledPlugin): Promise<string | undefined> {
    try { return hashFileSet((await readPluginPackage(plugin.installDir, { installed: true })).files); }
    catch { return undefined; }
  }
  const api: PluginHostWithGrants = {
    router,
    setBroker(appId, broker) { brokers.set(appId, broker); },
    async install(source, consent, installOptions: InstallOptions = {}) {
      // A contradiction in who answers is refused before anything is read.
      if (installOptions.terminal === true && installOptions.nonInteractive === true) throw new Error(installAnswerProblem(installOptions, undefined)!);
      // `--yes` on a published source must carry the pin of the downloaded artifact; the CLI checks the bytes against it.
      if (installOptions.nonInteractive === true && /^(https?:|npm:)/i.test(source) && !installOptions.pinnedHash) {
        throw new Error("A non-interactive install from a published source needs a pinned hash of the downloaded package (--sha256 or --integrity)");
      }
      const pkg = await readPluginPackage(path.resolve(source));
      const surface = surfaceOf(pkg.manifest);
      const contentHash = hashFileSet(pkg.files);
      interface Plan {
        kind: "install" | "replace" | "noop";
        place: Place;
        plugin: InstalledPlugin;
        /** The installed copy of this version, for a replace or a no-op. */
        same?: InstalledPlugin;
        /** An earlier version of this plugin is installed. */
        update: boolean;
        /** The canonical consent folder this call bound; every read, write and revoke of it acts there and refuses if it moved. */
        consentDir: string;
        /** The consent record as it is on disk now, valid or not (what a failed install restores). */
        recorded?: ConsentedGrant;
        /** The record, only when it is the approval of the newest installed manifest. */
        consented?: ConsentedGrant;
        /** The "widened grant" for this call. */
        widened: boolean;
      }
      /** Decides what the call does with the inventory as it is now (run under the lock, before and after the prompt). */
      async function plan(): Promise<Plan> {
        await load();
        const place = placeFor(pkg.manifest.app);
        const existing = installed.get(pkg.manifest.id) ?? [];
        if (existing.some((p) => p.manifest.app !== pkg.manifest.app || p.appId !== place.appId)) throw new Error("Plugin id already belongs to another app");
        if ((homes.get(pkg.manifest.id) ?? []).some((home) => home !== place)) throw new Error("Plugin id already belongs to another app");
        const same = existing.find((p) => p.version === pkg.version);
        if (same && installOptions.replace !== true) throw new Error(`Plugin version ${pkg.version} is already installed; install it again with --replace to refresh it`);
        if (rejected.has(pkg.manifest.id)) throw new Error("Remove the invalid installed plugin before reinstalling its id");
        // A consent folder or record behind a link refuses the install here, before the person is asked.
        const consentDir = await storeOf(place.appId).bind();
        const recorded = await storeOf(place.appId).read(pkg.manifest.id, consentDir);
        // Judged against the approval of what is installed (as `grantOf` does): a record that does not fit it is none.
        const consented = recordFits(recorded, existing.at(-1)) ? recorded : undefined;
        const plugin: InstalledPlugin = {
          manifest: pkg.manifest, appId: place.appId, version: pkg.version,
          installDir: path.join(place.root, pkg.manifest.id, pkg.version),
          dataDir: path.join(place.dataRoot, pkg.manifest.id), status: "stopped",
        };
        const update = existing.length > 0;
        const widened = (update && consented === undefined) || grantWidened(surface, consented?.surface);
        if (same) {
          // Identical content is a no-op only while its approval fits: a revoked, missing or mismatched record is
          // restored through the consent screen, never by a command that reports "nothing changed".
          const identical = (await installedFileSetHash(same)) === contentHash && consented !== undefined && !widened;
          return { kind: identical ? "noop" : "replace", place, plugin, same, update, consentDir, recorded, consented, widened };
        }
        return { kind: "install", place, plugin, update, consentDir, recorded, consented, widened };
      }
      const first = await locked(plan);
      if (first.kind === "noop") return structuredClone(first.same!);
      const problem = installAnswerProblem(installOptions, first.widened);
      if (problem) throw new Error(widenedRefusal(wideningItems(surface, first.consented?.surface, first.update), first.update));
      const shown = summary(first.plugin, { consented: first.consented?.surface, update: first.update, widened: first.widened, auditFile: path.join(appOf(first.place.appId).auditDir, `${pkg.manifest.id}.jsonl`) });
      shown.lines.splice(-1, 0, `Your answer is recorded in ${consentFileIn(first.consentDir, pkg.manifest.id)}; an update that asks for more is shown to you again.`);
      shown.paths = [{ action: "install", path: first.plugin.installDir }, { action: "data", path: first.plugin.dataDir }];
      if (await consent.confirm(shown) !== true) throw new Error("Plugin installation was not confirmed");
      return locked(async () => {
        // Other installs/removals, or a changed consent record, may have happened while consent was pending.
        const again = await plan();
        // The person answered for the consent folder shown to them; a parent retargeted meanwhile is another folder.
        if (again.consentDir !== first.consentDir) {
          throw new Error(`The consent folder moved during confirmation (${first.consentDir} is now ${again.consentDir}); the install was not done, retry`);
        }
        if (again.kind === "noop") return structuredClone(again.same!);
        if (again.kind !== first.kind || again.widened !== first.widened || (again.recorded?.surfaceSha256 ?? "") !== (first.recorded?.surfaceSha256 ?? "")) {
          throw new Error("The installed plugin or its recorded consent changed during confirmation; retry");
        }
        const { plugin, place, same: replaced } = again;
        const id = pkg.manifest.id;
        const existing = [...(installed.get(id) ?? [])];
        const fresh = await sameBoundPlace(place, "the install");
        // The roots alone are not enough: a link planted at plugins/<id>, at the version dir or at the plugin's
        // data dir while the user decided would carry the staging writes elsewhere. Refused before any write.
        await assertNoSymlinks(plugin.installDir, fresh.boundary);
        await assertNoSymlinks(plugin.dataDir, fresh.boundary);
        const parent = path.dirname(plugin.installDir);
        const token = randomUUID();
        const staging = path.join(parent, `.install-${token}`);
        const aside = path.join(parent, `.old-${token}`);
        const previous = newest(id);
        const oldProcess = processes.get(id);
        const wasActive = oldProcess !== undefined && oldProcess.status !== "stopped";
        const store = storeOf(place.appId);
        let createdParent = false;
        let createdData = false;
        let movedAside = false;
        let published = false;
        let wroteConsent = false;
        let oldStopped = false;
        try {
          // The missing parents (`<data>/<app>`, `bridge/`, `plugins/`, `<id>`) are created private, 0700, as the rest
          // of the layout is; an existing one keeps its mode.
          createdParent = await mkdir(parent, { recursive: true, mode: 0o700 }) !== undefined;
          await mkdir(staging);
          for (const [relative, data] of pkg.files) {
            const dest = path.join(staging, relative);
            await mkdir(path.dirname(dest), { recursive: true });
            await writeFile(dest, data, { flag: "wx", mode: 0o600 });
          }
          createdData = await mkdir(plugin.dataDir, { recursive: true, mode: 0o700 }) !== undefined;
          if (replaced) {
            // Staged swap: the running copy stops first, the old folder steps aside, the staged one takes its place.
            if (replaced === previous && oldProcess) { await oldProcess.stop(); processes.delete(id); oldStopped = true; }
            await rename(plugin.installDir, aside);
            movedAside = true;
          }
          await rename(staging, plugin.installDir);
          published = true;
          if (!(homes.get(id) ?? []).includes(place)) homes.set(id, [...(homes.get(id) ?? []), place]);
          const next = [...existing.filter((p) => p !== replaced), plugin];
          next.sort((a, b) => compareSemver(a.version.split("+")[0]!, b.version.split("+")[0]!));
          installed.set(id, next);
          // The record is written only now, after the person said yes and the files are in place, and only for the
          // version that runs: it is what a contained session start compares the installed manifest with.
          if (newest(id) === plugin) {
            await store.write({ pluginId: id, appId: place.appId, version: plugin.version, surface, surfaceSha256: surfaceSha256Of(surface), time: new Date().toISOString() }, first.consentDir);
            wroteConsent = true;
          }
          if (newest(id) !== previous) {
            if (!oldStopped && oldProcess) { await oldProcess.stop(); oldStopped = true; }
            processes.delete(id);
            if (wasActive) await attach(plugin).start();
          }
        } catch (error) {
          const current = processes.get(id);
          if (current && current !== oldProcess) { await current.stop(); processes.delete(id); }
          if (published) {
            if (existing.length) installed.set(id, existing);
            else { installed.delete(id); homes.delete(id); }
            await cleanup(plugin.installDir);
          }
          if (movedAside) {
            try { await rename(aside, plugin.installDir); }
            catch (restoreError) { warn(id, "Could not restore the previous version after a failed refresh", { aside, error: (restoreError as Error).message }); }
          }
          await cleanup(staging);
          if (createdParent) await cleanup(parent);
          if (createdData) await cleanup(plugin.dataDir);
          if (wroteConsent) {
            try { await (again.recorded ? store.write(again.recorded, first.consentDir) : store.revoke(id, first.consentDir)); }
            catch (restoreError) { warn(id, "Could not restore the previous consent record after a failed install", { error: (restoreError as Error).message }); }
          }
          if (wasActive && oldStopped && previous) {
            try { await attach(previous).start(); }
            catch { /* Preserve the original install error. */ }
          }
          throw error;
        }
        if (movedAside) {
          try { await removeBound(aside, { recursive: true, force: true }); }
          catch (cleanupError) { warn(id, "The previous copy of a refreshed plugin was left behind", { aside, error: (cleanupError as Error).message }); }
        }
        // After an upgrade the superseded versions go: the newest one runs, and their folders only take room.
        if (newest(id) === plugin) {
          const kept: InstalledPlugin[] = [];
          for (const old of installed.get(id)!.filter((p) => p !== plugin)) {
            try {
              await assertNoSymlinks(old.installDir, fresh.boundary);
              await removeBound(old.installDir, { recursive: true, force: true });
            } catch (pruneError) {
              kept.push(old);
              warn(id, "A superseded plugin version was not removed", { version: old.version, error: (pruneError as Error).message });
            }
          }
          installed.set(id, [...kept, plugin]);
        }
        return structuredClone(plugin);
      });
    },
    list() { return locked(async () => { await load(); return structuredClone([...installed.values()].flat()); }); },
    async remove(pluginId, consent, removeOptions = {}) {
      if (!isPluginId(pluginId) || pluginId === "bridge") throw new Error("Invalid plugin id");
      const keepData = removeOptions.keepData === true;
      const snapshot = await locked(async () => {
        await load();
        const versions = [...(installed.get(pluginId) ?? [])];
        const invalid = [...(rejected.get(pluginId) ?? [])];
        if (!versions.length && !invalid.length) return undefined;
        const dirs = await Promise.all((homes.get(pluginId) ?? []).map(async (place) => {
          const consentDir = await storeOf(place.appId).bind();
          return {
            place, installDir: path.join(place.root, pluginId), dataDir: path.join(place.dataRoot, pluginId),
            consentDir, consentFile: consentFileIn(consentDir, pluginId), audit: await auditPlan(place.appId, pluginId),
          };
        }));
        return { versions, invalid, dirs };
      });
      if (!snapshot) return;
      const { dirs } = snapshot;
      // What goes and what stays, in full, exactly as the removal below will act.
      const removing = dirs.flatMap((d) => [
        { action: "remove" as const, path: d.installDir },
        { action: "remove" as const, path: d.consentFile },
        ...(keepData ? [] : [{ action: "remove" as const, path: d.dataDir }, ...d.audit.files.map((file) => ({ action: "remove" as const, path: file }))]),
      ]);
      const kept = keepData ? dirs.flatMap((d) => [d.dataDir, ...d.audit.files]) : [];
      // No lifecycle lock is held while the user decides; approve every entry.
      for (const item of [...snapshot.versions.map((plugin) => summary(plugin)), ...snapshot.invalid]) {
        const lines = [...item.lines.slice(0, -1), "Removing this plugin also removes your recorded approval of it."];
        if (keepData) {
          lines.push("Kept (not removed):", ...kept.map((p) => `  ${p}`));
        } else {
          lines.push("Its data folder and audit files are removed too.");
        }
        lines.push(...item.lines.slice(-1));
        const auditDir = dirs[0]?.audit.dir;
        if (await consent.confirm({ ...item, lines, paths: removing, ...(auditDir ? { auditFile: path.join(auditDir, `${pluginId}.jsonl`) } : {}) }) !== true) {
          throw new Error("Plugin removal was not confirmed");
        }
      }
      return locked(async () => {
        const versions = installed.get(pluginId) ?? [];
        const invalid = rejected.get(pluginId) ?? [];
        if (versions.length !== snapshot.versions.length || versions.some((p, i) => p !== snapshot.versions[i]) ||
          invalid.length !== snapshot.invalid.length || invalid.some((p, i) => p !== snapshot.invalid[i])) {
          throw new Error("Plugin inventory changed during confirmation; retry removal");
        }
        // The consented plan, resolved again: a parent retargeted while the user decided refuses the removal.
        for (const d of dirs) {
          await sameBoundPlace(d.place, "the removal");
          await assertNoSymlinks(d.installDir, d.place.boundary);
          await assertNoSymlinks(d.dataDir, d.place.boundary);
          const audit = await auditPlan(d.place.appId, pluginId);
          if (audit.dir !== d.audit.dir || audit.files.length !== d.audit.files.length || audit.files.some((file, i) => file !== d.audit.files[i])) {
            throw new Error("The plugin's audit files changed during confirmation; retry removal");
          }
        }
        // The consent record goes first, so the plugin's headless approvals stop at once; a link in its path refuses
        // the removal before anything else is touched.
        for (const d of dirs) await storeOf(d.place.appId).revoke(pluginId, d.consentDir);
        await processes.get(pluginId)?.stop();
        // Every removal goes through removeBound: it resolves the folder again right before the syscall.
        for (const d of dirs) {
          await removeBound(d.installDir, { recursive: true, force: true });
          if (keepData) continue;
          await removeBound(d.dataDir, { recursive: true, force: true });
          for (const file of d.audit.files) await removeBound(file, { force: true });
        }
        processes.delete(pluginId);
        installed.delete(pluginId);
        rejected.delete(pluginId);
        homes.delete(pluginId);
      });
    },
    async revoke(pluginId, consent) {
      if (!isPluginId(pluginId) || pluginId === "bridge") throw new Error("Invalid plugin id");
      // The consent folder is bound before the person is asked, as install and remove do; the record goes only from there.
      const snapshot = await locked(async () => {
        await load();
        const dirs = await Promise.all((homes.get(pluginId) ?? []).map(async (place) => ({ place, consentDir: await storeOf(place.appId).bind() })));
        // One record per plugin: the person is asked once, about the newest installed version (or the invalid copy).
        const current = newest(pluginId);
        return { dirs, asked: current ? summary(current) : rejected.get(pluginId)?.[0] };
      });
      if (!snapshot.dirs.length) return;
      // No lifecycle lock is held while the user decides.
      if (consent && snapshot.asked && await consent.confirm(snapshot.asked) !== true) throw new Error("Revoking was not confirmed");
      await locked(async () => {
        for (const d of snapshot.dirs) await storeOf(d.place.appId).revoke(pluginId, d.consentDir);
      });
    },
    async grantOf(pluginId) {
      await locked(load);
      return grantRead(pluginId);
    },
    start(appId) {
      return locked(async () => {
        await load();
        const selected = [...installed.keys()].map((id) => newest(id)!)
          .filter((plugin) => appId === undefined || plugin.manifest.app === appId);
        const results = await Promise.allSettled(selected.map(async (plugin) => {
          await assertNoSymlinks(plugin.installDir, placeOf(plugin).boundary);
          await assertNoSymlinks(plugin.dataDir, placeOf(plugin).boundary);
          await (processes.get(plugin.manifest.id) ?? attach(plugin)).start();
        }));
        const failures = results.filter((r) => r.status === "rejected").map((r) => r.reason as Error);
        if (failures.length) throw new AggregateError(failures, failures.map((e) => e.message).join("; "));
      });
    },
    stopAll() { return locked(async () => { await Promise.all([...processes.values()].map((p) => p.stop())); }); },
  };
  return api;
}
