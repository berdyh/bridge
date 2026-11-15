import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { isatty } from "node:tty";

import type { CredentialStore } from "@berdyh/bridge-pairing";
import type { AgentAdapter, CommandRunner, EnrollPrompt, Platform, LocalPolicy, PluginHost } from "@berdyh/bridge-runner";
import {
  createDefaultAgentAdapters,
  createFileCredentialStore,
  createKeychainCredentialStore,
  enroll as runnerEnroll,
  listBrowsers as runnerListBrowsers,
  revokeBrowser as runnerRevokeBrowser,
} from "@berdyh/bridge-runner";

import { adapterOptionsOf } from "./adapters.js";
import { nodeRun } from "./exec.js";
import { appPathsOf } from "./paths.js";

/** The runner-side E2EE operations the CLI calls; the runner package implements them. Injectable so tests need no runner. */
export interface E2eeOps {
  enroll: typeof runnerEnroll;
  listBrowsers: typeof runnerListBrowsers;
  revokeBrowser: typeof runnerRevokeBrowser;
}

/** Limits on concurrent agent sessions (see `run`). */
export interface SessionCaps {
  perChannel: number;
  perApp: number;
}

export const DEFAULT_SESSION_CAPS: SessionCaps = { perChannel: 4, perApp: 16 };

/** Minimal WebSocket surface the runner uses (the global `WebSocket` of Node >= 22 satisfies it). */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

/** Opens a relay socket. The default passes the bearer token as an `authorization` header only. */
export type SocketFactory = (url: string, init: { protocols: string[]; headers: Record<string, string> }) => RelaySocket;

/**
 * The user's setup settings, from `<config>/bridge/config.json` (`{"setup": {"service": "ask"}}`), which an app's own `config.json` may override.
 * `service`: `default-yes` offers the background service as `[Y/n]` (the default), `ask` asks
 * every time with no default.
 */
export interface SetupConfig {
  service: "default-yes" | "ask";
}

export const DEFAULT_SETUP_CONFIG: SetupConfig = { service: "default-yes" };

/** What an empty answer to a `confirm` question means. */
export interface ConfirmOptions {
  default?: "yes" | "no" | "none";
}

/** Something to tell the user outside the terminal (a desktop notification). */
export interface Notification {
  title: string;
  body: string;
}

/**
 * The `bridge` CLI: one runner per machine, holding one connection per app server.
 * Commands: `connect <app-url>`, `run`, `enroll <app>`, `browsers list|revoke`,
 * `apps list|remove`, `plugin add|list|remove`, `doctor --paths`,
 * `service install|uninstall`. Every path and every side effect comes from
 * `CliDeps`, so tests inject temp dirs and a fake keychain.
 */
export interface CliDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /**
   * Asks a yes/no question on the terminal. Tests answer without a TTY. `options.default` is what an
   * empty answer means and how the prompt is drawn: `"no"` (the default) `[y/N]`, `"yes"` `[Y/n]`,
   * `"none"` `[y/n]` (asks again until the answer is y or n).
   */
  confirm: (question: string, options?: ConfirmOptions) => Promise<boolean>;
  env: Record<string, string | undefined>;
  /** Base config dir (`<config>/bridge/apps.json`, and each app's own `<config>/<app>/bridge/`); default `$XDG_CONFIG_HOME` or `~/.config`. */
  configDir: string;
  /** Base data dir (versions, plugins); default `$XDG_DATA_HOME` or `~/.local/share`. */
  dataDir: string;
  fetch: typeof fetch;

  // Optional seams. Each has a real default that is created lazily, never at import time.
  /** The user's home dir (bin dir, state dir, agent logins). Default `$HOME`. */
  homeDir?: string;
  /** Per-app credential storage. Default: the OS keychain through `run`. */
  credentials?: CredentialStore;
  /** Runs external commands (keychain, service activation). Default: `child_process.spawn`. */
  run?: CommandRunner;
  platform?: Platform;
  /** Sleep used by pairing polls and reconnect backoff. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** 0..1 random source for backoff jitter. */
  random?: () => number;
  e2ee?: E2eeOps;
  socket?: SocketFactory;
  /** Agent adapters for `run`. Default: the claude and codex adapters. */
  adapters?: AgentAdapter[];
  /** Local policy for `run`. Default: built from `<config>/bridge/policy.json`. */
  policy?: LocalPolicy;
  defaultCwd?: string;
  sessionCaps?: SessionCaps;
  /** Ends `run`. The real process wires SIGINT/SIGTERM to it. */
  signal?: AbortSignal;
  /** Grace before a browser that went away loses its session (default `PEER_GONE_GRACE_MS`). */
  peerGoneGraceMs?: number;
  /** Reconnect backoff bounds in ms. */
  backoff?: { baseMs: number; maxMs: number };
  /** The plugin host `run` and `plugin` use. Default: a real one over `dataDir`. */
  pluginHost?: PluginHost;
  /** Path of the launcher link `service install` points at. Default `<home>/.local/bin/bridge`. */
  launcher?: string;

  /** Whether stdin and stdout are a terminal (prompts are possible). Default (`isTTYOf`): both are TTYs. */
  isTTY?: boolean;
  /**
   * Reads stdin to EOF as text, giving up once more than `maxBytes` bytes have arrived (what it returns
   * is then longer than `maxBytes`, and the caller refuses it). Default (`readStdinOf`): `process.stdin`.
   * Tests inject the text, so they never touch the real stdin.
   */
  readStdin?: (maxBytes: number) => Promise<string>;
  /**
   * Opens an http(s) URL in the user's browser. Default (`openUrlOf`): `xdg-open` / `open`
   * through `run`. Tests never open a real browser: the harness records the URLs.
   */
  openUrl?: (url: string) => Promise<void>;
  /** The `setup.service` setting. Default (`setupConfigOf`): read from `<config>/bridge/config.json`. */
  setupConfig?: SetupConfig;
  /**
   * Runs a command in a new terminal window. No default here: `openTerminalOf(deps)` in
   * `terminal.ts` supplies one, like `runnerOf`.
   */
  openTerminal?: (command: string[]) => Promise<void>;
  /** Shows a desktop notification. No default here: `notifyOf(deps)` in `notify.ts`. */
  notify?: (notification: Notification) => Promise<void>;
  /**
   * Runs a command on the person's own terminal (stdio inherited) and resolves with its exit code:
   * the agent's own login flow in `bridge agent login --login`. Default (`spawnInteractiveOf`): a
   * real child process. Tests record the call; they never run a real agent.
   */
  spawnInteractive?: (command: string, args: string[], options: { env: Record<string, string> }) => Promise<number>;
  /**
   * Runs a command with no terminal (stdin closed, output captured) under `env`, killed after
   * `timeoutMs`: the agent's own sign-out during `bridge uninstall`. Rejects when the command cannot
   * start (`code` ENOENT when it is not installed). Default (`spawnQuietOf`): a real child process.
   */
  spawnQuiet?: (command: string, args: string[], options: { env: Record<string, string>; timeoutMs: number }) => Promise<QuietResult>;
}

/** How a `spawnQuiet` command ended: its exit code (1 when killed by a signal), whether the timeout killed it, its stderr. */
export interface QuietResult {
  exitCode: number;
  timedOut: boolean;
  stderr: string;
}

/** Per stream: whether its reader went away (EPIPE), and what to do then. One `error` listener each. */
const pipeStates = new WeakMap<NodeJS.WritableStream, { closed: boolean; onClosed?: () => void }>();

/**
 * A writer for stdout or stderr that tolerates the reader going away (`bridge status | head -1`).
 * A write to a closed pipe fails with EPIPE as an `error` event on the stream, which unhandled
 * crashes the process. Here EPIPE marks the stream closed, later writes are dropped, and
 * `onClosed` (if any) runs once. The command is never stopped by it: it goes on to the end and
 * exits with its own code, so a half-done uninstall cannot follow from a closed pipe. Other
 * stream errors still throw.
 * The listener is added once per stream, however many writers are made for it.
 */
export function guardedWriter(stream: NodeJS.WritableStream, options: { onClosed?: () => void } = {}): (text: string) => void {
  let state = pipeStates.get(stream);
  if (state === undefined) {
    const created: { closed: boolean; onClosed?: () => void } = { closed: false };
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
      if (created.closed) return;
      created.closed = true;
      created.onClosed?.();
    });
    pipeStates.set(stream, created);
    state = created;
  }
  if (options.onClosed !== undefined) state.onClosed = options.onClosed;
  const current = state;
  return (text) => {
    if (!current.closed) stream.write(text);
  };
}

/** The deps of the real process, from its environment. Nothing is created on disk here. */
export function createDefaultDeps(env: Record<string, string | undefined> = process.env): CliDeps {
  const home = env.HOME ?? homedir();
  return {
    // No exit on EPIPE: a command whose reader went away (`bridge uninstall --yes | head -1`) still
    // finishes every step and returns its own exit code; only its output is dropped.
    stdout: guardedWriter(process.stdout),
    stderr: guardedWriter(process.stderr),
    confirm: async (question, options) => {
      const fallback = options?.default ?? "no";
      const marker = fallback === "yes" ? "[Y/n]" : fallback === "no" ? "[y/N]" : "[y/n]";
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        // With no default an empty or unclear answer asks again (a few times), then counts as no.
        for (let attempt = 0; attempt < (fallback === "none" ? 3 : 1); attempt++) {
          const answer = (await rl.question(`${question} ${marker} `)).trim();
          if (/^y(es)?$/i.test(answer)) return true;
          if (/^no?$/i.test(answer)) return false;
          if (answer === "" && fallback !== "none") return fallback === "yes";
        }
        return false;
      } finally {
        rl.close();
      }
    },
    env,
    configDir: env.XDG_CONFIG_HOME || join(home, ".config"),
    dataDir: env.XDG_DATA_HOME || join(home, ".local", "share"),
    fetch: globalThis.fetch,
  };
}

export function homeOf(deps: CliDeps): string {
  return deps.homeDir ?? deps.env.HOME ?? homedir();
}

export function platformOf(deps: CliDeps): Platform {
  return deps.platform ?? (process.platform === "darwin" ? "darwin" : "linux");
}

export function runnerOf(deps: CliDeps): CommandRunner {
  return deps.run ?? nodeRun;
}

/** Which credential store the environment selects: the OS keychain (default) or plain files in `dir`. */
export type CredentialStoreSetting = { kind: "keychain" } | { kind: "file"; dir: string };

/**
 * `BRIDGE_CREDENTIAL_STORE`: unset or empty is the OS keychain; `file:<absolute dir>` keeps the
 * credentials as files in that directory (for a machine with no Secret Service). Anything else is a
 * usage error, never a silent fall back to the keychain.
 */
export function credentialStoreSettingOf(deps: Pick<CliDeps, "env">): CredentialStoreSetting {
  const value = deps.env.BRIDGE_CREDENTIAL_STORE;
  if (value === undefined || value === "") return { kind: "keychain" };
  const dir = value.startsWith("file:") ? value.slice("file:".length) : undefined;
  if (dir === undefined || !path.isAbsolute(dir)) {
    throw new UsageError("BRIDGE_CREDENTIAL_STORE must be file:<absolute directory> (or unset for the OS keychain)");
  }
  return { kind: "file", dir };
}

/**
 * Where the credentials live, as a phrase for consent and status lines: the credential files when `BRIDGE_CREDENTIAL_STORE`
 * selects them, else the OS keychain. A bad value throws (a usage error), before any question.
 */
export function credentialStoreWhere(deps: Pick<CliDeps, "env">): string {
  return credentialStoreSettingOf(deps).kind === "file" ? "the credential files (BRIDGE_CREDENTIAL_STORE)" : "the OS keychain";
}

/** The folder the credential files live in under `BRIDGE_CREDENTIAL_STORE=file:<dir>`; none for the keychain. A bad value throws, as `credentialStoreSettingOf` does. */
export function credentialDirOf(deps: Pick<CliDeps, "env">): string | undefined {
  const setting = credentialStoreSettingOf(deps);
  return setting.kind === "file" ? setting.dir : undefined;
}

/** How long the keychain probe may take (a locked keyring may be waiting for the person to unlock it). */
const KEYCHAIN_PROBE_MS = 5000;

/** A tool's own words, safe for a terminal line: control characters dropped (config.ts's `printable` would be a cycle). */
const plain = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

/** Whether the OS keychain can be used here: `usable: false` carries what the probe saw. */
export type KeychainUsability = { usable: true } | { usable: false; reason: string; timedOut?: true };

/**
 * A cheap probe of the OS keychain, for a machine that may have none (a headless Linux server, a container). It applies
 * only where the keychain is what will be used: the variable unset, Linux (macOS ships its keychain), no injected store.
 * It reads one item that does not exist (`secret-tool lookup`): a working Secret Service answers "not found" (exit 1, no
 * output), so nothing is stored by the check; no `secret-tool`, or nothing owning `org.freedesktop.secrets`, shows as an
 * error. A probe that does not finish in time is "not verified", not usable: it may be a locked keyring waiting for an unlock, and the
 * sign-in must not be asked on a keychain that has not answered.
 */
export async function keychainUsability(deps: CliDeps): Promise<KeychainUsability> {
  if (deps.credentials || credentialStoreSettingOf(deps).kind !== "keychain" || platformOf(deps) !== "linux") return { usable: true };
  try {
    const r = await runnerOf(deps)("secret-tool", ["lookup", "service", "berdyh-bridge", "account", "bridge-keychain-probe"], { timeoutMs: KEYCHAIN_PROBE_MS });
    if (r.exitCode === 0 || (r.exitCode === 1 && r.stderr.trim() === "")) return { usable: true };
    const said = r.stderr.trim().split("\n")[0]!.slice(0, 200);
    return { usable: false, reason: said === "" ? `secret-tool exited ${r.exitCode}` : plain(said).startsWith("secret-tool") ? plain(said) : `secret-tool: ${plain(said)}` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") return { usable: false, timedOut: true, reason: "secret-tool lookup did not finish" };
    if (code === "ENOENT") return { usable: false, reason: "secret-tool is not installed" };
    return { usable: false, reason: `secret-tool could not run: ${plain(errorMessage(error)).slice(0, 200)}` };
  }
}

/** The hint printed wherever an unusable keychain is reported: what was seen and the one way out. */
export function keychainHint(problem: Extract<KeychainUsability, { usable: false }>): string {
  const env = "set BRIDGE_CREDENTIAL_STORE=file:<absolute directory> (the credentials are then kept as plain files in a 0700 folder) and run the command again";
  if (problem.timedOut) {
    return `the OS keychain did not answer within ${KEYCHAIN_PROBE_MS / 1000} s (${problem.reason}); it may be locked: unlock it and retry, or, on a machine with no Secret Service (a headless server, a container), ${env}`;
  }
  const reason = problem.reason;
  return (
    `the OS keychain is not usable here (${reason}). On a machine with no Secret Service (a headless server, a container) ` +
    env
  );
}

export function credentialsOf(deps: CliDeps): CredentialStore {
  if (deps.credentials) return deps.credentials;
  const setting = credentialStoreSettingOf(deps);
  if (setting.kind === "file") return createFileCredentialStore({ dir: setting.dir });
  return createKeychainCredentialStore({ platform: platformOf(deps), run: runnerOf(deps), service: "berdyh-bridge", label: "bridge runner credentials" });
}

export function e2eeOf(deps: CliDeps): E2eeOps {
  return deps.e2ee ?? { enroll: runnerEnroll, listBrowsers: runnerListBrowsers, revokeBrowser: runnerRevokeBrowser };
}

export function adaptersOf(deps: CliDeps): AgentAdapter[] {
  return deps.adapters ?? createDefaultAgentAdapters(adapterOptionsOf(deps));
}

/** Runs `command` with the terminal inherited; rejects when it cannot start, else resolves with its exit code. */
export function spawnInteractiveOf(deps: CliDeps): NonNullable<CliDeps["spawnInteractive"]> {
  if (deps.spawnInteractive) return deps.spawnInteractive;
  return (command, args, options) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, { env: options.env, stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
}

export function spawnQuietOf(deps: CliDeps): NonNullable<CliDeps["spawnQuiet"]> {
  if (deps.spawnQuiet) return deps.spawnQuiet;
  return (command, args, options) =>
    new Promise<QuietResult>((resolve, reject) => {
      const child = spawn(command, args, { env: options.env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      child.stderr?.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-4000)));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? (signal ? 1 : 0), timedOut, stderr });
      });
    });
}

/** `deps.readStdin`, else a reader of `process.stdin` that stops once it has more than `maxBytes` bytes. */
export function readStdinOf(deps: CliDeps): NonNullable<CliDeps["readStdin"]> {
  return deps.readStdin ?? readProcessStdin;
}

async function readProcessStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    chunks.push(buffer);
    size += buffer.length;
    if (size > maxBytes) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Whether prompts are possible: `deps.isTTY`, else whether stdin and stdout are both terminals. */
export function isTTYOf(deps: CliDeps): boolean {
  return deps.isTTY ?? (isatty(0) && isatty(1));
}

/** Opens `url` in the user's browser, or rejects (the caller then prints the URL). Only http(s) is opened. */
export function openUrlOf(deps: CliDeps): (url: string) => Promise<void> {
  if (deps.openUrl) return deps.openUrl;
  return async (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("not a URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("only http(s) URLs are opened");
    const opener = platformOf(deps) === "darwin" ? "open" : "xdg-open";
    const result = await runnerOf(deps)(opener, [parsed.href]);
    if (result.exitCode !== 0) throw new Error(`${opener} exited with ${result.exitCode}`);
  };
}

/** The `setup.service` value of one config file, or undefined: a missing file, bad JSON or an unknown value is not a failure. */
async function setupServiceOf(file: string): Promise<SetupConfig["service"] | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { setup?: { service?: unknown } } | null;
    const service = parsed?.setup?.service;
    return service === "ask" || service === "default-yes" ? service : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `setup.service` setting: `deps.setupConfig`, else the machine `<config>/bridge/config.json`
 * with, for an `appId`, the app's own `<config>/<app>/bridge/config.json` overriding keys one level
 * deep per section (the machine file is never copied into an app folder). A missing file, bad JSON
 * or an unknown value means the layer below; setup never fails over it.
 */
export async function setupConfigOf(deps: CliDeps, appId?: string): Promise<SetupConfig> {
  if (deps.setupConfig) return deps.setupConfig;
  const machine = await setupServiceOf(path.join(bridgeConfigDir(deps), "config.json"));
  const app = appId === undefined ? undefined : await setupServiceOf(appPathsOf(deps, appId).configFile);
  return { service: app ?? machine ?? DEFAULT_SETUP_CONFIG.service };
}

/** `<configDir>/bridge`: the machine-wide config dir (apps.json, config.json, policy.json, agents/). */
export function bridgeConfigDir(deps: CliDeps): string {
  return path.join(deps.configDir, "bridge");
}

export type { EnrollPrompt };

/** A bad command line: reported with exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
