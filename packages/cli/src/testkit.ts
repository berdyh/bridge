/**
 * Test helpers shared by the CLI tests. Imports nothing from vitest, so it is safe in the
 * build; it is not part of the package's API.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CredentialStore } from "@berdyh/bridge-pairing";
import type { CommandResult } from "@berdyh/bridge-runner";

import type { HostedAppRecord } from "./config.js";
import type { CliDeps, Notification } from "./deps.js";

export function memoryCredentials(): CredentialStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

export interface Harness {
  deps: CliDeps;
  root: string;
  out: string[];
  err: string[];
  questions: string[];
  /** Commands the fake runner was asked to run. */
  commands: string[][];
  /** URLs `openUrl` was asked to open (nothing is opened). */
  opened: string[];
  /** Commands `openTerminal` was asked to run (no terminal is opened). */
  terminals: string[][];
  /** What `notify` was asked to show. */
  notifications: Notification[];
  /** Interactive commands `spawnInteractive` was asked to run (nothing is run); `exitCodes.next` is what the next one returns. */
  spawned: { command: string; args: string[]; env: Record<string, string> }[];
  answers: { yes: boolean };
  /** What the fake `spawnInteractive` resolves with, and an optional hook run before it returns. */
  spawnResult: { exitCode: number; onRun?: (command: string, args: string[], env: Record<string, string>) => Promise<void> | void };
  /** Commands `spawnQuiet` was asked to run (nothing is run). */
  quiet: { command: string; args: string[]; env: Record<string, string>; timeoutMs: number }[];
  /** What the fake `spawnQuiet` gives: an exit code, a timeout, or `missing` (rejects with ENOENT); `onRun` runs first. */
  quietResult: { exitCode: number; timedOut?: boolean; missing?: boolean; onRun?: (command: string, args: string[], env: Record<string, string>) => Promise<void> | void };
  cleanup(): Promise<void>;
}

/** Deps over a temp dir, a fake keychain and no real command execution. */
export async function harness(over: Partial<CliDeps> = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-cli-"));
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const commands: string[][] = [];
  const opened: string[] = [];
  const terminals: string[][] = [];
  const notifications: Notification[] = [];
  const answers = { yes: true };
  const spawned: Harness["spawned"] = [];
  const spawnResult: Harness["spawnResult"] = { exitCode: 0 };
  const quiet: Harness["quiet"] = [];
  const quietResult: Harness["quietResult"] = { exitCode: 0 };
  const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "" };
  const deps: CliDeps = {
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    confirm: async (q) => {
      questions.push(q);
      return answers.yes;
    },
    // BRIDGE_UPDATE_CHECK=0: no unit test reaches a real registry; the update-check tests unset it and inject `fetch`.
    env: { HOME: path.join(root, "home"), PATH: "/usr/bin", BRIDGE_UPDATE_CHECK: "0" },
    homeDir: path.join(root, "home"),
    configDir: path.join(root, "config"),
    dataDir: path.join(root, "data"),
    fetch: globalThis.fetch,
    credentials: memoryCredentials(),
    platform: "linux",
    run: async (command, args) => {
      commands.push([command, ...args]);
      return ok;
    },
    sleep: async () => {},
    isTTY: false,
    openUrl: async (url) => void opened.push(url),
    openTerminal: async (command) => void terminals.push(command),
    notify: async (notification) => void notifications.push(notification),
    spawnInteractive: async (command, args, options) => {
      spawned.push({ command, args, env: options.env });
      await spawnResult.onRun?.(command, args, options.env);
      return spawnResult.exitCode;
    },
    spawnQuiet: async (command, args, options) => {
      quiet.push({ command, args, env: options.env, timeoutMs: options.timeoutMs });
      await quietResult.onRun?.(command, args, options.env);
      if (quietResult.missing) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
      return { exitCode: quietResult.timedOut ? 1 : quietResult.exitCode, timedOut: quietResult.timedOut === true, stderr: "" };
    },
    ...over,
  };
  return { deps, root, out, err, questions, commands, opened, terminals, notifications, spawned, spawnResult, quiet, quietResult, answers, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A valid app record for tests. */
export function record(over: Partial<HostedAppRecord> = {}): HostedAppRecord {
  return {
    appId: "demo",
    name: "Demo",
    url: "https://demo.example/",
    origin: "https://demo.example",
    relayUrl: "wss://demo.example/relay",
    auth: {
      issuer: "https://idp.example",
      clientId: "c",
      deviceAuthorizationEndpoint: "https://idp.example/d",
      tokenEndpoint: "https://idp.example/t",
    },
    protocol: { min: 1, max: 1 },
    runnerId: "runner-1",
    connectedAt: "2026-10-14T00:00:00.000Z",
    ...over,
  };
}

/** Whether `p` exists. */
export async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}
