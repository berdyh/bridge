import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { compareSemver, parseSemver } from "@berdyh/bridge-runner";

import { type CliDeps, homeOf } from "./deps.js";
import { getHttps } from "./plugin-source.js";
import { BRIDGE_PACKAGE } from "./self.js";
import { CLI_VERSION } from "./version.js";

/** `BRIDGE_UPDATE_CHECK=0` turns the check off (CI stages and the unit tests set it). */
export const UPDATE_CHECK_ENV = "BRIDGE_UPDATE_CHECK";
/** One bounded request: a slow registry costs `bridge doctor` and a runner start no more than this. */
export const UPDATE_CHECK_TIMEOUT_MS = 3_000;
/** The dist-tag manifest of one version is a few KiB; anything past this is not one. */
export const UPDATE_CHECK_MAX_BYTES = 64 * 1024;

export interface UpdateNotice {
  latest: string;
  /** The command that installs it; the notice only names it, the person runs it. */
  command: string;
}

/** Whether the check is off: `BRIDGE_UPDATE_CHECK=0`, or npm's own offline setting (`npm_config_offline=true`). */
function disabled(deps: Pick<CliDeps, "env">): boolean {
  const offline = deps.env.npm_config_offline ?? deps.env.NPM_CONFIG_OFFLINE;
  return deps.env[UPDATE_CHECK_ENV] === "0" || offline === "true";
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
/** A user npmrc is a few lines; a bigger file is not read. */
const MAX_NPMRC_BYTES = 256 * 1024;

/** `promise`, or its rejection with the signal's reason as soon as `signal` aborts (a pending read must not outlive the deadline). */
function raced<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The user config npm reads: `npm_config_userconfig` / `NPM_CONFIG_USERCONFIG`, else `~/.npmrc`. */
function userconfigOf(deps: CliDeps): string {
  const named = (deps.env.npm_config_userconfig ?? deps.env.NPM_CONFIG_USERCONFIG ?? "").trim();
  if (named === "") return path.join(homeOf(deps), ".npmrc");
  return named === "~" || named.startsWith("~/") ? path.join(homeOf(deps), named.slice(1)) : path.resolve(named);
}

/** The text of a regular file within the deadline, or "" (absent, not a regular file after following links, too big, unreadable). It never opens a FIFO or a device. */
async function regularFileText(file: string, signal: AbortSignal): Promise<string> {
  try {
    const info = await raced(stat(file), signal);
    if (!info.isFile() || info.size > MAX_NPMRC_BYTES) return "";
    return await raced(readFile(file, { encoding: "utf8", signal }), signal);
  } catch {
    if (signal.aborted) throw signal.reason;
    return "";
  }
}

/** The last `key=value` line of an npmrc whose key is `key` (ini: the last one wins). */
function npmrcValue(text: string, key: string): string {
  let value = "";
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^=;#\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && match[1] === key) value = match[2]!.replace(/^["']|["']$/g, "");
  }
  return value;
}

/**
 * The registry the check asks, read without running `npm` (npm writes logs and its cache, runs its own update notifier,
 * and a child cannot be stopped at the deadline), in npm's own order: a scoped `@berdyh:registry` (environment, then the
 * user config) wins for the bridge package; then `npm_config_registry` / `NPM_CONFIG_REGISTRY`; then the `registry=` line of the user
 * config (`npm_config_userconfig` / `NPM_CONFIG_USERCONFIG`, default `~/.npmrc`); then the public registry. Project and global
 * npmrc files are not read. Every file read is bounded by `signal` and opens regular files only (a link to one is followed; a FIFO, a directory or a link to one is not). Only https is accepted;
 * anything else throws, and the check says nothing.
 */
async function registryOfCheck(deps: CliDeps, signal: AbortSignal): Promise<URL> {
  const scope = `${BRIDGE_PACKAGE.split("/")[0]}:registry`;
  const env = (name: string): string => (deps.env[name] ?? deps.env[name.toUpperCase()] ?? "").trim();
  let text = env(`npm_config_${scope}`);
  if (text === "") {
    const npmrc = await regularFileText(userconfigOf(deps), signal);
    text = npmrcValue(npmrc, scope) || env("npm_config_registry") || npmrcValue(npmrc, "registry");
  }
  if (text === "" || text === "undefined") text = DEFAULT_REGISTRY;
  const registry = new URL(text);
  if (registry.protocol !== "https:") throw new Error("The npm registry must use https");
  if (!registry.pathname.endsWith("/")) registry.pathname += "/";
  return registry;
}

/**
 * Whether the npm registry has a newer `@berdyh/bridge` than this CLI. One `GET <registry>/@berdyh%2fbridge/latest` (the
 * dist-tag manifest, no tarball), 3 s, 64 KiB, https only, no token, through the registry npm's own precedence names from the environment and the user npmrc (no `npm` is run; the config read is inside the same 3 s).
 * Never throws and never writes: a refused registry, a 404, a timeout, an unreadable answer, a prerelease or a
 * version that is not newer all give `undefined`, silently. It never installs anything; the command it returns is the person's to run.
 */
export async function checkForUpdate(deps: CliDeps, options: { signal?: AbortSignal } = {}): Promise<UpdateNotice | undefined> {
  try {
    if (disabled(deps) || options.signal?.aborted) return undefined;
    // One deadline for the whole check, redirect hops and the body read included, from one start; the caller's signal ends it earlier.
    const deadline = new AbortController();
    const stop = (): void => deadline.abort(new Error("The update check was stopped"));
    const timer = setTimeout(stop, UPDATE_CHECK_TIMEOUT_MS);
    options.signal?.addEventListener("abort", stop, { once: true });
    let body: Buffer;
    try {
      const registry = await registryOfCheck(deps, deadline.signal);
      body = await getHttps(deps, new URL(`${BRIDGE_PACKAGE.replace("/", "%2f")}/latest`, registry), {
        limit: UPDATE_CHECK_MAX_BYTES,
        what: "update check",
        accept: "application/json",
        timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
        signal: deadline.signal,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    }
    const version = (JSON.parse(body.toString("utf8")) as { version?: unknown } | null)?.version;
    if (typeof version !== "string") return undefined;
    const latest = parseSemver(version);
    if (latest === null || latest.prerelease.length > 0) return undefined;
    if (compareSemver(version, CLI_VERSION) <= 0) return undefined;
    return { latest: version, command: `bridge self install --version ${version}` };
  } catch {
    return undefined;
  }
}

/** The notice as `bridge doctor` prints it (the `update:` line, padded like its neighbours). */
export function updateLineOf(notice: UpdateNotice): string {
  return `update:   bridge ${notice.latest} is available (this is ${CLI_VERSION}); install it with \`${notice.command}\``;
}

/** The notice as `bridge run` prints it. */
export function updateInfoOf(notice: UpdateNotice): string {
  return `bridge run: info: bridge ${notice.latest} is available (this is ${CLI_VERSION}); install it with \`${notice.command}\`\n`;
}
