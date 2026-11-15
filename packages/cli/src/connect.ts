import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DISCOVERY_PATH, validateDiscovery, type BridgeDiscovery } from "@berdyh/bridge-protocol";
import {
  acknowledgeStoredEnrollment,
  PairingError,
  pollForToken,
  saveTokens,
  startDeviceAuthorization,
  type PairingConfig,
} from "@berdyh/bridge-pairing";

import { RemoveRefused, removeBound, wrapKeyNameOf, type RunnerStatusFile } from "@berdyh/bridge-runner";

import { parse } from "./args.js";
import { type HostedAppRecord, appsFilePath, isLocalApp, isSafeAppId, loadApps, printable, tokenKey, upsertApp } from "./config.js";
import { ChangedWhileWaiting, type PathState, assertUnchanged, describePath, pathStates } from "./consent-plan.js";
import { type CliDeps, UsageError, credentialDirOf, credentialStoreWhere, credentialsOf, errorMessage, keychainHint, keychainUsability, openUrlOf, platformOf } from "./deps.js";
import { type LayoutSnapshot, assertAppDirsReal, assertLayout, layoutSnapshot } from "./layout-rule.js";
import { appPathsOf } from "./paths.js";
import { LegacyLayoutError, assertNoLegacyLayout } from "./legacy.js";
import { readRunnerStatus } from "./status.js";
import { CLI_VERSION } from "./version.js";

/** The pairing config of an app: used by `connect` and by `run` to refresh tokens. */
export function pairingConfigFor(app: Pick<HostedAppRecord, "auth">, deps: CliDeps): PairingConfig {
  return {
    clientId: app.auth.clientId,
    deviceAuthorizationUrl: app.auth.deviceAuthorizationEndpoint,
    tokenUrl: app.auth.tokenEndpoint,
    scope: app.auth.scope ?? "openid offline_access",
    device: { hostname: os.hostname(), os: platformOf(deps), runnerVersion: CLI_VERSION },
    fetch: (input, init) => deps.fetch(input, init),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
}

/** The `iss` claim of a JWT access token, or undefined for an opaque token. */
function issuerOf(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { iss?: unknown };
    return typeof claims.iss === "string" ? claims.iss : undefined;
  } catch {
    return undefined;
  }
}

/** The app URL: https, or http only for a loopback host (the dev server). */
export function appUrlOf(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`'${raw}' is not a URL`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new UsageError("the app URL must be https (or http on localhost)");
  }
  return url;
}

/** Why a connect or discovery step stopped; the code is what `--json` reports. */
export interface StepFailure {
  ok: false;
  code: "legacy_layout" | "unsafe_layout" | "changed_while_waiting" | "discovery_unreachable" | "discovery_invalid" | "app_id_not_allowed" | "origin_conflict" | "cancelled" | "consent_required" | "pairing_failed" | "token_issuer_mismatch" | "keychain_unusable";
  message: string;
}

/** A discovery document that was fetched from the app's own origin and checked. */
export interface Discovered {
  ok: true;
  url: URL;
  discovery: BridgeDiscovery;
}

/** How a command talks: text for people, JSON lines for agents (text then goes to stderr). */
export interface Voice {
  json: boolean;
  say: (text: string) => void;
  emit: (event: Record<string, unknown>) => void;
}

export function voiceOf(deps: CliDeps, json: boolean): Voice {
  return {
    json,
    say: json ? deps.stderr : deps.stdout,
    emit: (event) => {
      if (json) deps.stdout(`${JSON.stringify(event)}\n`);
    },
  };
}

/**
 * Reads `<origin>/.well-known/bridge.json` of the app URL and checks it (`validateDiscovery`: the
 * origin must be the URL's, every endpoint and `enrollPage` must stay on the allowed hosts and the
 * app origin) and that the app id is a safe file name. Reads only. No redirects are followed.
 */
export async function discoverApp(url: URL, deps: CliDeps): Promise<Discovered | StepFailure> {
  const discoveryUrl = new URL(DISCOVERY_PATH, url.origin).toString();
  let doc: unknown;
  try {
    const res = await deps.fetch(discoveryUrl, { redirect: "error", headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = await res.json();
  } catch (error) {
    return { ok: false, code: "discovery_unreachable", message: `could not read ${discoveryUrl}: ${(error as Error).message}` };
  }
  const checked = validateDiscovery(doc, { appUrl: url.toString() });
  if (!checked.ok) {
    return { ok: false, code: "discovery_invalid", message: `${discoveryUrl} is not a valid bridge.json:\n${checked.errors.map((e) => `  - ${e}`).join("\n")}` };
  }
  const discovery: BridgeDiscovery = checked.value;
  if (!isSafeAppId(discovery.app.id)) {
    return { ok: false, code: "app_id_not_allowed", message: `this app's id ${JSON.stringify(discovery.app.id)} cannot be a folder name (lowercase letters, digits and '-', starting with a letter, at most 63; 'bridge' is reserved); nothing was stored` };
  }
  return { ok: true, url, discovery };
}

/** What the runner writes to `revoked.json` when the relay itself said a runner id is revoked (run.ts). */
export interface RevokedMark {
  version: 1;
  runnerId: string;
  at: string;
  detail?: string;
}

/** The revoked mark of an app, or undefined when there is none or it is not readable. */
export async function readRevokedMark(deps: CliDeps, appId: string): Promise<RevokedMark | undefined> {
  try {
    const mark = JSON.parse(await readFile(appPathsOf(deps, appId).revokedFile, "utf8")) as Partial<RevokedMark> | null;
    if (mark?.version !== 1 || typeof mark.runnerId !== "string" || mark.runnerId.length === 0 || typeof mark.at !== "string") return undefined;
    return mark as RevokedMark;
  } catch {
    return undefined;
  }
}

/**
 * Whether the running runner started before the record's runner id was written (`connectedAt`, which a re-pair that keeps
 * the id leaves alone), so that what it reports is the word of an older runner id. One rule for every reader: a start or record time that does not parse is not stale.
 */
export function startedBeforeRecord(status: Pick<RunnerStatusFile, "startedAt">, connectedAt: string): boolean {
  return Date.parse(status.startedAt) < Date.parse(connectedAt);
}

/**
 * Whether the server refuses this app's stored runner id for good, so a connect must pick a new one. The relay's own
 * word, kept by the runner in `revoked.json`, counts when it names the record's runner id, whether or not a runner is
 * still up. Without such a mark the running runner's report counts, only when it started after the record was written
 * (it loaded this record's id; a runner that started earlier reports on an older id, which a connect has since replaced).
 * No runner and no mark, or a link in any other status, is not a revocation.
 */
export async function linkRevoked(deps: CliDeps, app: Pick<HostedAppRecord, "appId" | "connectedAt" | "runnerId">): Promise<boolean> {
  if ((await readRevokedMark(deps, app.appId))?.runnerId === app.runnerId) return true;
  const status = await readRunnerStatus(deps);
  return status?.apps[app.appId] === "revoked" && !startedBeforeRecord(status, app.connectedAt);
}

/** The E2EE files an earlier connection of an app left in its config `bridge/` dir. */
const STALE_STATE_FILES = ["trust.json", "identity.json", "enroll.json", "identity.key", "revoked.json"] as const;

/**
 * What an earlier connection of this app left behind when the app is not listed in `apps.json` (it was
 * removed from the list, or the list was lost) but its `bridge/` dir still holds E2EE state: that state
 * belongs to the earlier runner id (the identity is bound to it, and the trusted browsers trusted that
 * runner), and a connect that picks a new id must not inherit it.
 */
async function staleStateOf(deps: CliDeps, appId: string): Promise<{ files: string[]; previousRunnerId?: string }> {
  const dir = appPathsOf(deps, appId).configDir;
  const files: string[] = [];
  for (const name of STALE_STATE_FILES) {
    const file = path.join(dir, name);
    if (await lstat(file).then(() => true, () => false)) files.push(file);
  }
  let previousRunnerId: string | undefined;
  try {
    const old = JSON.parse(await readFile(appPathsOf(deps, appId).appFile, "utf8")) as { runnerId?: unknown };
    if (typeof old.runnerId === "string" && old.runnerId.length > 0) previousRunnerId = old.runnerId;
  } catch {
    // No readable earlier record: its runner id is unknown.
  }
  return { files, ...(previousRunnerId !== undefined ? { previousRunnerId } : {}) };
}

/** What a connect consents to (consent-plan.ts, Rule B): `apps.json` and `app.json` with their contents, the three dirs, the layout. */
interface ConnectPlan {
  files: PathState[];
  /**
   * Earlier E2EE state that is deleted (a new runner id); empty on a re-pair or a first connect. Discovered
   * anew by every computation, so a file that appears (or changes) during the device grant fails the recompute.
   */
  stale: PathState[];
  /** The earlier connection's runner id (its wrapping key's keychain name), when its record is readable. */
  previousRunnerId?: string;
  dirs: PathState[];
  layout: LayoutSnapshot;
}

export interface ConnectOptions {
  /** `--yes`: skip the question (the app and origin are still printed). */
  yes?: boolean;
  /** `--open`: open the device-grant page in the browser (its URL and code are printed too). */
  open?: boolean;
  /** `--json`: one JSON object per line on stdout; text goes to stderr. */
  json?: boolean;
  /** The command's name in messages. Default `bridge connect`. */
  label?: string;
  /** A discovery the caller already read and showed (`setup`): connect exactly this document, do not fetch again. */
  discovered?: Discovered;
}

/** `replacedRevoked`: the stored runner id was revoked and this connect replaced it with a new one. */
export type ConnectResult = { ok: true; app: HostedAppRecord; replacedRevoked?: true } | StepFailure;

/**
 * Pairs this machine with an app and records it: discovery, the question (`--yes` skips it), the
 * device grant (the page is opened with `open`; URL and code are always printed), the token check,
 * then the token in the keychain and the app in `apps.json`. In `--json` mode stdout carries
 * `need_approval`, `device_code {url, code}` and `connected` (or `error`) events.
 */
export async function connectApp(url: URL, deps: CliDeps, options: ConnectOptions = {}): Promise<ConnectResult> {
  const label = options.label ?? "bridge connect";
  const { say, emit } = voiceOf(deps, options.json === true);
  const fail = (failure: StepFailure): StepFailure => {
    deps.stderr(`${label}: ${failure.message}\n`);
    emit({ event: "error", code: failure.code, message: failure.message });
    return failure;
  };

  // Before anything is read from the network or written: an older layout is refused, never migrated.
  try {
    await assertNoLegacyLayout(deps);
  } catch (error) {
    if (error instanceof LegacyLayoutError) return fail({ ok: false, code: "legacy_layout", message: error.message });
    throw error;
  }
  // Before the question and the sign-in: a machine with no usable keychain would only fail after the person signed in.
  const keychain = await keychainUsability(deps);
  if (!keychain.usable) return fail({ ok: false, code: "keychain_unusable", message: `${keychainHint(keychain)}. Nothing was stored.` });
  const found = options.discovered ?? (await discoverApp(url, deps));
  if (!found.ok) return fail(found);
  const { discovery } = found;
  const appId = discovery.app.id;
  const listed = (await loadApps(deps)).find((a) => a.appId === appId);
  if (listed && listed.origin !== discovery.origin) {
    return fail({
      ok: false,
      code: "origin_conflict",
      message: `the app id '${listed.appId}' is already connected from ${listed.origin}, not ${discovery.origin}; run \`bridge apps remove ${listed.appId}\` first. Nothing was stored.`,
    });
  }
  // A local app's origin is `local`, never a server's, so the check above refused it: what is left is hosted.
  const existing = listed !== undefined && !isLocalApp(listed) ? listed : undefined;

  const name = printable(discovery.app.name);
  // Rule A (consent-plan.ts) before the question: the app's three bridge/ dirs may not alias one another, another app's or a
  // machine-wide dir, and may not be links (the runner would refuse to use one).
  try {
    await assertLayout(deps, "connect", [appId]);
    await assertAppDirsReal(deps, appId);
  } catch (error) {
    return fail({ ok: false, code: "unsafe_layout", message: errorMessage(error) });
  }
  const paths = appPathsOf(deps, appId);
  // A listed app keeps its runner id (a re-pair), so its state stays valid; an unlisted one gets a new id and
  // must not inherit what an earlier connection left in its folder. So does a listed app whose link the runner
  // reports as revoked (the server refuses that id for good): it is a new machine to the server, and the state
  // of the revoked id (trusted browsers, identity, wrapping key) goes with it. Looked at once, before the plan.
  const revoked = existing !== undefined && (await linkRevoked(deps, existing));
  const newId = existing === undefined || revoked;
  const planNow = async (): Promise<ConnectPlan> => {
    const stale: { files: string[]; previousRunnerId?: string } = newId ? await staleStateOf(deps, appId) : { files: [] };
    if (revoked) stale.previousRunnerId = existing!.runnerId;
    return {
      files: await pathStates([appsFilePath(deps), paths.appFile], { hash: true }),
      stale: await pathStates(stale.files, { hash: true }),
      ...(stale.previousRunnerId !== undefined ? { previousRunnerId: stale.previousRunnerId } : {}),
      dirs: await pathStates([paths.configDir, paths.dataDir, paths.stateDir]),
      layout: await layoutSnapshot(deps, [appId]),
    };
  };
  const plan = await planNow();
  // A stale file that cannot be resolved cannot be bound for its removal: refuse before the question (fail closed).
  const unresolvable = plan.stale.find((s) => s.kind === "unresolvable");
  if (unresolvable !== undefined) {
    return fail({ ok: false, code: "unsafe_layout", message: `${unresolvable.path} cannot be resolved (${unresolvable.error}); nothing was changed` });
  }
  say(`App:     ${name} (${appId})\nOrigin:  ${discovery.origin}\nSign-in: ${discovery.auth.issuer}\n`);
  if (revoked) say(`The runner reports this machine as revoked by ${name}. It will be connected again as a new machine (a new runner id).\n`);
  // The path list is printed before the question, with or without --yes, as every consent does.
  const where = credentialStoreWhere(deps);
  const credentialDir = credentialDirOf(deps);
  const parentNote = "its parent is created only when missing and never changed";
  say(
    `These paths will be written:\n` +
      `  ${describePath(plan.files[0]!)}  (the machine-wide list of connected apps: id and origin)\n` +
      `  ${describePath(plan.files[1]!)}  (the app record; the sign-in token goes to ${where})\n` +
      `  ${describePath(plan.dirs[0]!)}  (dir: trust list, identity and enrollment state; ${parentNote})\n` +
      `  ${describePath(plan.dirs[1]!)}  (dir: plugins and their data, created when the runner first needs it; ${parentNote})\n` +
      `  ${describePath(plan.dirs[2]!)}  (dir: the work folder and session sandboxes, created when the runner first needs it; ${parentNote})\n` +
      (credentialDir !== undefined ? `  ${printable(credentialDir)}  (dir: the credential files, unencrypted: the sign-in token and the identity's wrapping key; created 0700 when missing, BRIDGE_CREDENTIAL_STORE)\n` : ""),
  );
  if (plan.stale.length > 0) {
    say(
      `This app was connected before and its folder still holds that connection's state. It belonged to another runner id, so these will be DELETED` +
        `${plan.previousRunnerId !== undefined ? ` (and the identity's wrapping key in ${where})` : ""}:\n` +
        plan.stale.map((p) => `  ${describePath(p)}\n`).join("") +
        (plan.previousRunnerId === undefined ? `The identity's wrapping key in ${where} is not removed: the earlier record is unreadable, so its runner id is unknown; delete it by hand.\n` : ""),
    );
  }
  emit({
    event: "need_approval",
    what: `connect to ${name} at ${discovery.origin}`,
    paths: [appsFilePath(deps), paths.appFile, paths.configDir, paths.dataDir, paths.stateDir, ...(credentialDir !== undefined ? [credentialDir] : [])],
    ...(plan.stale.length > 0 ? { deletes: plan.stale.map((s) => s.canonical) } : {}),
  });
  if (!options.yes && !(await deps.confirm(`Connect this machine to ${name} at ${discovery.origin}?`))) {
    return fail({ ok: false, code: "cancelled", message: "cancelled" });
  }

  const runnerId = revoked ? randomUUID() : (existing?.runnerId ?? randomUUID());
  const keptRunnerId = existing !== undefined && runnerId === existing.runnerId;
  const record: HostedAppRecord = {
    appId,
    name,
    url: found.url.toString(),
    origin: discovery.origin,
    relayUrl: discovery.relayUrl,
    // `validateDiscovery` checked it is a path on the app's own origin.
    ...(discovery.enrollPage !== undefined ? { enrollPage: discovery.enrollPage } : {}),
    auth: discovery.auth,
    protocol: discovery.protocol,
    // Re-pairing keeps the runner id so the server sees one device, not two; a revoked one is refused for good, so it is replaced.
    runnerId,
    // When this runner id was first recorded: a runner that started before it holds an older id (`startedBeforeRecord`). A re-pair
    // that keeps the id keeps the time, so a runner already online on it is not taken for stale.
    connectedAt: keptRunnerId ? existing!.connectedAt : (deps.now ? new Date(deps.now()) : new Date()).toISOString(),
  };

  const config = pairingConfigFor(record, deps);
  try {
    const auth = await startDeviceAuthorization(config);
    const grantUrl = printable(auth.verificationUriComplete ?? auth.verificationUri);
    const code = printable(auth.userCode);
    emit({ event: "device_code", url: grantUrl, code });
    if (options.open) {
      say(`\nOpening ${grantUrl} (or enter the code ${code} there). Waiting for approval...\n`);
      await openUrlOf(deps)(grantUrl).catch((error: unknown) => {
        say(`Could not open a browser (${(error as Error).message}). Open the link yourself.\n`);
      });
    } else {
      say(`\nOpen ${grantUrl} and enter the code:\n\n    ${code}\n\nWaiting for approval...\n`);
    }
    const tokens = await pollForToken(config, auth);
    const iss = issuerOf(tokens.accessToken);
    if (iss !== undefined && iss !== discovery.auth.issuer) {
      return fail({ ok: false, code: "token_issuer_mismatch", message: `the token was issued by ${iss}, not ${discovery.auth.issuer}; nothing was stored` });
    }
    // Rule B (consent-plan.ts): the one recompute, after the device grant and before the first write (the
    // keychain), so a path retargeted while the person approved in the browser is caught. Nothing runs if it differs.
    try {
      assertUnchanged(plan, await planNow(), label);
    } catch (error) {
      if (error instanceof ChangedWhileWaiting) return fail({ ok: false, code: "changed_while_waiting", message: error.message });
      throw error;
    }
    await saveTokens(credentialsOf(deps), tokens, tokenKey(record.appId));
    // App-hosted enrollment retains encrypted delivery only until the runner
    // confirms protected storage. OAuth returns no receipt and stays unchanged.
    await acknowledgeStoredEnrollment(config, credentialsOf(deps), tokens, { key: tokenKey(record.appId) });
    // The earlier connection's trust list, identity, enrollment window and key file, each at its bound canonical
    // path (Rule B: every removal goes through removeBound), then its wrapping key in the keychain under the old runner id.
    for (const state of plan.stale) await removeBound(state.canonical, { force: true });
    if (plan.previousRunnerId !== undefined) await credentialsOf(deps).delete(wrapKeyNameOf({ appId, runnerId: plan.previousRunnerId }));
  } catch (error) {
    if (error instanceof PairingError) {
      return fail({ ok: false, code: "pairing_failed", message: `pairing failed (${error.code}): ${error.message}` });
    }
    if (error instanceof RemoveRefused) {
      return fail({ ok: false, code: "changed_while_waiting", message: `${error.message}; the sign-in token is stored but ${appId} was not recorded, run the command again` });
    }
    throw error;
  }

  // At the bound canonical destinations of the plan the one recompute above confirmed.
  await upsertApp(deps, record, { appsFile: plan.files[0]!.canonical, appFile: plan.files[1]!.canonical });
  emit({ event: "connected", app: { appId: record.appId, name: record.name, origin: record.origin } });
  return { ok: true, app: record, ...(revoked ? { replacedRevoked: true as const } : {}) };
}

/** `bridge connect <app-url> [--yes] [--open] [--json]`. */
export async function runConnect(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, { yes: { type: "boolean" }, open: { type: "boolean" }, json: { type: "boolean" } });
  if (positionals.length !== 1) throw new UsageError("usage: bridge connect <app-url> [--yes] [--open] [--json]");
  const url = appUrlOf(positionals[0]!);
  const result = await connectApp(url, deps, { yes: values.yes === true, open: values.open === true, json: values.json === true });
  if (!result.ok) return 1;
  const say = voiceOf(deps, values.json === true).say;
  // A runner that is still up holds the revoked id (it was started with the old record): it must be started again.
  const running = result.replacedRevoked ? await readRunnerStatus(deps) : undefined;
  if (running !== undefined) {
    say(`\nConnected to ${result.app.name} as a new machine. The running bridge (pid ${running.pid}) still holds the revoked identity: stop it and start it again, or run \`bridge setup ${printable(result.app.url)}\`, which restarts the service.\n`);
  } else {
    say(`\nConnected to ${result.app.name}. Start the runner with \`bridge run\`.\n`);
  }
  return 0;
}
