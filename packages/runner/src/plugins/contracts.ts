/**
 * Contracts of the runner's plugin host. A plugin is an npm package with a
 * `bridge-plugin.json` manifest, spawned as its own Node process with a stripped
 * env and its own HOME, TMPDIR and data dir (`../sandbox`), speaking JSON-RPC over
 * stdio (`PLUGIN_RPC` in bridge-protocol). Network and extra fs permissions are
 * declared and shown to the user but NOT enforced yet; the env/path sandbox is.
 */
import type { JsonRpcMessage, PluginManifest, Unsubscribe } from "@berdyh/bridge-protocol";

import type { AgentSessionBroker, ExtensionRouter } from "../acp/contracts.js";
import type { AppPaths } from "../paths.js";

export type PluginStatus = "stopped" | "starting" | "running" | "crashed" | "backoff";

export interface InstalledPlugin {
  manifest: PluginManifest;
  /** The app whose folder holds the plugin (`<data>/<app>/bridge/plugins/...`); equal to `manifest.app`. */
  appId: string;
  /** From the package's package.json. */
  version: string;
  /** `<data>/<app>/bridge/plugins/<id>/<version>/` */
  installDir: string;
  /** The plugin's data dir; its HOME and TMPDIR live inside it. */
  dataDir: string;
  status: PluginStatus;
  /** Set once the plugin called `localUi.listen()`. */
  localUiUrl?: string;
}

/** What the user is asked to approve before anything is written. */
export interface PermissionSummary {
  pluginId: string;
  version: string;
  app: string;
  network: string[];
  fs: string[];
  agents: string[];
  localUi: boolean;
  /** MCP servers the plugin ships (name, entry, args), for the consent screen. Optional. */
  mcpServers?: { name: string; entry: string; args: string[] }[];
  /** The headless tool set (`mcp__<server>__<tool>`) the user approves for unattended sessions. Optional. */
  headless?: string[];
  /** SHA-256 (hex) of the canonical grant surface (`GrantSurface`). Optional. */
  surfaceSha256?: string;
  /**
   * The "widened grant", as `grantWidened` computes it: a first install that asks for `mcpServers` or a
   * `headless` set, or an update or replace whose surface has an item the consented one lacks. A plain first
   * install (agents, network, fs, `localUi` only) is NOT widened, and neither is an unchanged or narrower
   * update. Optional: absent reads as widened, so `--yes` cannot approve it.
   */
  widened?: boolean;
  /** Against the consented surface, on an update or a replace. */
  diff?: GrantDiff;
  /** The audit file the plugin's sessions write, for the removal prompt. */
  auditFile?: string;
  /** Plain-language lines for the prompt, including that network and fs limits are not yet enforced. */
  lines: string[];
  /**
   * Every path the step writes (`install`, `data`) or removes (`remove`), in full. Kept apart from `lines`
   * (manifest-derived text a front end may shorten) so a front end prints each one on its own line, uncut.
   */
  paths?: { action: "install" | "data" | "remove"; path: string }[];
}

export interface ConsentOptions {
  /** Must resolve true before any file is written or deleted. */
  confirm(summary: PermissionSummary): Promise<boolean>;
}

/**
 * The digest of the **downloaded artifact** (the tarball bytes), as the person pinned it. It is
 * never a digest of `bridge-plugin.json`: the consented surface covers the manifest, not the entry
 * code that runs with the session secret path, so a pin on the manifest would let a swapped artifact
 * with the same manifest through a `--yes` install.
 *
 *  - `sha256`: for an `https://` source (`--sha256`), `digest` is the 64 lowercase hex characters.
 *  - `sha512`: for an `npm:` source (`--integrity sha512-...`), `digest` is the base64 part of the SRI
 *    string, as the registry writes `dist.integrity` (standard alphabet, padded, 88 characters).
 *
 * The registry's own `dist.integrity` alone is not a pin: it comes from the same place as the
 * tarball. The CLI verifies the pin over the downloaded bytes before the host sees the package; the host
 * only requires that a pin is present for a non-interactive published install.
 */
export type PackagePin = { algorithm: "sha256"; digest: string } | { algorithm: "sha512"; digest: string };

/** Options of `PluginHost.install` beyond the consent callback. */
export interface InstallOptions {
  /** Install over an already installed version of the same plugin (refresh in place). */
  replace?: boolean;
  /**
   * The confirm answer is not a person's (`--yes`): it may approve only a grant that is not widened (see
   * `grantWidened`), which includes a first install that asks for no `mcpServers` and no `headless` set.
   * A widened grant still needs a person (see `terminal`). Absent reads as false; `true` together with
   * `terminal: true` is a contradiction the host rejects (`installAnswerProblem`).
   */
  nonInteractive?: boolean;
  /**
   * The pin of the downloaded artifact that a `--yes` published install carries (see `PackagePin`). Not
   * a hash of the manifest. Absent on a `--link` install and on an interactive one.
   */
  pinnedHash?: PackagePin;
  /**
   * The confirm answer comes from a person at a terminal (a TTY). Set by the CLI, never by a plugin.
   * Fail-closed: absent reads as `false` (no person), and only `terminal === true` can approve a widened
   * grant: a first install with `mcpServers` or `headless`, or an update that adds something (see
   * `grantWidened`). See `installAnswerProblem`.
   */
  terminal?: boolean;
}

/**
 * The "widened grant", defined once; `PermissionSummary.widened` is its result and `installAnswerProblem`
 * reads it. `consented` is the surface a person approved before, or undefined on a first install. Pure.
 *  - First install (`consented` undefined): widened exactly when the surface holds an `mcpServer` or a
 *    `headlessTool` item. A plain plugin (agents, network, fs, `localUi`) is not widened, so `--yes` may
 *    approve it as before.
 *  - Update or replace: widened exactly when the surface has an item (same kind and value) that the
 *    consented one lacks. A changed server entry or argument is a different item, so it widens; an
 *    unchanged, narrower or reordered surface does not.
 */
export function grantWidened(surface: GrantSurface, consented: GrantSurface | undefined): boolean {
  if (consented === undefined) return surface.items.some((item) => item.kind === "mcpServer" || item.kind === "headlessTool" || item.kind === "execution");
  const had = new Set(consented.items.map((item) => JSON.stringify([item.kind, item.value])));
  return surface.items.some((item) => !had.has(JSON.stringify([item.kind, item.value])));
}

/**
 * The one rule for who may answer the consent prompt, for the host to call before it writes anything.
 * Returns why the answer cannot count, or undefined. Pure.
 *  - `terminal: true` with `nonInteractive: true` is contradictory: refused.
 *  - A grant that is `widened` (`grantWidened`) needs `terminal === true`; `widened` undefined reads as
 *    widened (`PermissionSummary.widened`), so a caller that cannot say it did not widen is not trusted.
 *  - A grant that is not widened (`widened === false`: unchanged, narrower, or a first install with no
 *    `mcpServers` and no `headless`) may be answered by `nonInteractive`, by a person, or by neither flag set
 *    (a library caller), as before.
 */
export function installAnswerProblem(options: Pick<InstallOptions, "nonInteractive" | "terminal"> | undefined, widened: boolean | undefined): string | undefined {
  const terminal = options?.terminal === true;
  if (terminal && options?.nonInteractive === true) return "The install is marked both interactive (terminal) and non-interactive";
  if (widened !== false && !terminal) return "This grant is new or wider than the one consented to, and only a person at a terminal can approve it";
  return undefined;
}

/** Options of `PluginHost.remove` beyond the consent callback. */
export interface RemoveOptions {
  /** Keep the plugin's data folder and audit files; the install dirs and the consent record go. */
  keepData?: boolean;
}

/** What a grant item is: a thing the user approves. */
export type GrantItemKind = "agent" | "network" | "fs" | "localUi" | "mcpServer" | "headlessTool" | "execution";

/**
 * One approved thing. `value` is canonical text: an agent id, a host, a path, `auto` or a port, the
 * `mcp__<server>__<tool>` name, or for an `mcpServer` the JSON `{"name","entry","args"}` (a changed
 * entry or args is a different item, so it widens).
 */
export interface GrantItem {
  kind: GrantItemKind;
  value: string;
}

/** What a manifest asks for, canonical: items sorted by kind then value, no duplicates. */
export interface GrantSurface {
  items: readonly GrantItem[];
}

/** A surface compared with the consented one. */
export interface GrantDiff {
  added: GrantItem[];
  removed: GrantItem[];
  unchanged: GrantItem[];
}

/** What a person approved for one installed plugin, as stored in the consent record. */
export interface ConsentedGrant {
  pluginId: string;
  appId: string;
  version: string;
  surface: GrantSurface;
  /** SHA-256 (hex) of the canonical JSON of `surface`. A record whose hash differs from its surface is stale. */
  surfaceSha256: string;
  /** ISO 8601 time of the confirmation. */
  time: string;
}

/**
 * The consent records of one app, in `AppPaths.consentDir` (one file per plugin, 0600, dir 0700; not
 * the plugin packages in `pluginsDir`).
 */
export interface ConsentStore {
  /** The current grant, or undefined for none or a revoked one. Throws when the record is behind a link or unreadable. */
  read(pluginId: string): Promise<ConsentedGrant | undefined>;
  /** Writes the record, after the person confirmed. */
  write(grant: ConsentedGrant): Promise<void>;
  /** Deletes the record: the plugin's headless approvals stop at once. Idempotent. */
  revoke(pluginId: string): Promise<void>;
}

/** Where a consent store keeps its records. */
export type ConsentStoreOptions = { paths: Pick<AppPaths, "appId" | "consentDir"> };

/** One running plugin process, as the host manages it. */
export interface PluginProcess {
  readonly pluginId: string;
  readonly status: PluginStatus;
  readonly restarts: number;
  /** Calls a registered method (`plugin/call`). Rejects with `{code, message}` on plugin errors or a crash. */
  call(method: string, params: unknown, caller: { appId: string; browserKeyId: string }): Promise<unknown>;
  /** Notifications the plugin pushes (its own methods and `_bridge/localUi`). */
  onNotification(handler: (message: JsonRpcMessage) => void): Unsubscribe;
  /** Stops the process and resolves after exit. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Installs, runs and removes plugins under injected per-app folders (never the
 * real `~/.local` in tests).
 *
 * Invariants: no file is written before `confirm` resolves true; install validates
 * the manifest with `validatePluginManifest`; removal deletes exactly the plugin's
 * install dir and data dir; a crash restarts the process with backoff; a plugin
 * never receives another app's credentials.
 */
export interface PluginHost {
  /** Installs from a local directory or tarball. */
  install(source: string, consent: ConsentOptions, options?: InstallOptions): Promise<InstalledPlugin>;
  list(): Promise<InstalledPlugin[]>;
  remove(pluginId: string, consent: ConsentOptions, options?: RemoveOptions): Promise<void>;
  /**
   * Withdraws the consent of an installed plugin without removing it: its headless approvals stop at
   * once and its next contained session start fails with `consentMissing`. With `consent`, the host binds
   * the consent folder first, asks, and refuses if the folder resolves elsewhere by the time it acts;
   * without it nothing is asked.
   */
  revoke(pluginId: string, consent?: ConsentOptions): Promise<void>;
  /** Starts every installed plugin of `appId` (or all). */
  start(appId?: string): Promise<void>;
  stopAll(): Promise<void>;
  /** The `ExtensionRouter` the proxies use. */
  readonly router: ExtensionRouter;
  /** Sets where `host/startAgentSession` requests go. */
  setBroker(appId: string, broker: AgentSessionBroker): void;
}
