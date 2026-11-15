import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import type { CredentialStore } from "@berdyh/bridge-pairing";
import type { CommandResult, CommandRunner } from "./contracts.js";
import { createKeychainCredentialStore, KeychainError, macDiagnostic } from "./keychain.js";
import { keychainCommand } from "./keychain-command.js";
import { markSanitized } from "./keychain-sanitized.js";

export type KeychainAvailability =
  | { status: "available"; reason: "ready" }
  | { status: "absent"; reason: "unsupported_platform" | "executable_missing" | "service_missing" }
  | { status: "locked"; reason: "collection_locked" }
  | { status: "unknown"; reason: "observer_unavailable" | "inspection_unsupported" | "service_not_running" | "no_default_collection" | "timeout" | "access_denied" | "invalid_response" | "command_failed" | "mutation_outcome_unknown" };

export type KeychainOperationCode = "unsupported_platform" | "executable_missing" | "timeout" | "access_denied" | "locked" | "command_failed" | "output_limit" | "invalid_input" | "mutation_uncertain";
export type KeychainOperation = "get" | "set" | "delete";

/** Safe to log: no credential, key, platform stderr, or underlying error is retained. */
export class KeychainOperationError extends KeychainError {
  constructor(
    readonly operation: KeychainOperation,
    readonly code: KeychainOperationCode,
    readonly outcome: "not_started" | "unknown",
    readonly mayHaveMutated: boolean,
  ) {
    super(`Keychain ${operation}: ${code}`);
    this.name = "KeychainOperationError";
    markSanitized(this);
  }
}

export interface KeychainAccessOptions {
  service: string;
  label?: string;
  platform?: string;
  /** Trusted test/host collaborators; never pass agent-supplied implementations. */
  run?: CommandRunner;
  findExecutable?: (name: string) => Promise<boolean>;
  /** Whole observation deadline, default 5000; both bounds accept 1..30000 ms. */
  inspectionTimeoutMs?: number;
  /** Whole store-call deadline, default 5000. Timeout does not prove rollback. */
  operationTimeoutMs?: number;
}

export interface KeychainAccess {
  readonly store: CredentialStore;
  readonly inspectionTimeoutMs: number;
  readonly operationTimeoutMs: number;
  inspect(): Promise<KeychainAvailability>;
}

class ObservationError extends Error {
  constructor(readonly reason: Extract<KeychainAvailability, { status: "unknown" }>["reason"]) { super(reason); }
}

const coded = (error: unknown): string | undefined => error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
function bound(value: number | undefined): number {
  const n = value ?? 5000;
  if (!Number.isInteger(n) || n < 1 || n > 30000) throw new RangeError("Keychain deadlines must be integers between 1 and 30000 ms");
  return n;
}

async function executable(name: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
    // Match execvp: relative and empty PATH components refer to the caller cwd.
    const file = path.resolve(dir || ".", name);
    try { if ((await stat(file)).isFile()) { await access(file, constants.X_OK); return true; } }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(coded(error) ?? "")) throw error;
    }
  }
  return false;
}

function deadline<T>(ms: number, task: (signal: AbortSignal) => Promise<T>, failure: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { const error = failure(); controller.abort(); reject(error); }, ms);
    Promise.resolve().then(() => task(controller.signal)).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function jsonValue(result: CommandResult, type: string, property = false): unknown {
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 1024 * 1024) throw new ObservationError("invalid_response");
  if (result.exitCode !== 0) throw new ObservationError(/(?:AccessDenied|access denied|Permission denied)/i.test(result.stderr) ? "access_denied" : "command_failed");
  try {
    const body: unknown = JSON.parse(result.stdout);
    if (!body || typeof body !== "object" || !("type" in body) || body.type !== type || !("data" in body)) throw new Error();
    // busctl call returns an output tuple; get-property returns the value itself.
    if (property) return body.data;
    if (!Array.isArray(body.data) || body.data.length !== 1) throw new Error();
    return body.data[0];
  } catch { throw new ObservationError("invalid_response"); }
}

/**
 * Public keychain port. Inspection never retrieves items, opens Secret Service
 * sessions, activates a service, writes files, changes permissions, or unlocks.
 * Linux observes the existing default collection. macOS inspection conservatively
 * returns unknown until a supported noninteractive lock observer is available.
 * No method chooses a file backend or migrates application credentials.
 */
export function createKeychainAccess(options: KeychainAccessOptions): KeychainAccess {
  if (!options.service || /[\r\n\0]/.test(options.service) || (options.label !== undefined && /[\r\n\0]/.test(options.label))) throw new TypeError("Invalid keychain service or label");
  const platform = options.platform ?? process.platform;
  const run = options.run ?? keychainCommand;
  const find = options.findExecutable ?? executable;
  const inspectionTimeoutMs = bound(options.inspectionTimeoutMs);
  const operationTimeoutMs = bound(options.operationTimeoutMs);
  let mutationUncertain = false;

  async function observe(signal: AbortSignal): Promise<KeychainAvailability> {
    const check = () => { if (signal.aborted) throw new ObservationError("timeout"); };
    const lookup = async (name: string) => { check(); const found = await find(name); check(); return found; };
    if (mutationUncertain) return { status: "unknown", reason: "mutation_outcome_unknown" };
    if (platform !== "linux" && platform !== "darwin") return { status: "absent", reason: "unsupported_platform" };
    if (!(await lookup(platform === "linux" ? "secret-tool" : "security"))) return { status: "absent", reason: "executable_missing" };
    if (platform === "darwin") return { status: "unknown", reason: "inspection_unsupported" };
    if (!(await lookup("busctl"))) return { status: "unknown", reason: "observer_unavailable" };
    const args = ["--user", "--json=short", "--auto-start=no", `--timeout=${inspectionTimeoutMs}ms`];
    const execute = async (commandArgs: string[]) => { check(); const result = await run("busctl", commandArgs, { timeoutMs: inspectionTimeoutMs, signal }); check(); return result; };
    const call = async (destination: string, object: string, iface: string, method: string, type: string, extra: string[] = []) =>
      jsonValue(await execute([...args, "call", destination, object, iface, method, ...extra]), type);
    const names = async (method: string): Promise<string[]> => {
      const value = await call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", method, "as");
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new ObservationError("invalid_response");
      return value as string[];
    };
    if (!(await names("ListNames")).includes("org.freedesktop.secrets")) {
      return (await names("ListActivatableNames")).includes("org.freedesktop.secrets")
        ? { status: "unknown", reason: "service_not_running" }
        : { status: "absent", reason: "service_missing" };
    }
    // Pin the current owner: a service restart/race must not activate a new one.
    const owner = await call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner", "s", ["s", "org.freedesktop.secrets"]);
    if (typeof owner !== "string" || !/^:[0-9]+\.[0-9]+$/.test(owner)) throw new ObservationError("invalid_response");
    const collection = await call(owner, "/org/freedesktop/secrets", "org.freedesktop.Secret.Service", "ReadAlias", "o", ["s", "default"]);
    if (collection === "/") return { status: "unknown", reason: "no_default_collection" };
    if (typeof collection !== "string" || !/^\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_]+$/.test(collection)) throw new ObservationError("invalid_response");
    const locked = jsonValue(await execute([...args, "get-property", owner, collection, "org.freedesktop.Secret.Collection", "Locked"]), "b", true);
    if (typeof locked !== "boolean") throw new ObservationError("invalid_response");
    return locked ? { status: "locked", reason: "collection_locked" } : { status: "available", reason: "ready" };
  }

  async function perform<T>(operation: KeychainOperation, action: (store: CredentialStore) => Promise<T>): Promise<T> {
    let dispatched = false;
    const failure = (code: KeychainOperationCode, started = dispatched) => {
      const mayHaveMutated = operation !== "get" && started;
      if (mayHaveMutated) mutationUncertain = true;
      return new KeychainOperationError(operation, code, started ? "unknown" : "not_started", mayHaveMutated);
    };
    if (mutationUncertain && operation !== "get") throw failure("mutation_uncertain", false);
    if (platform !== "linux" && platform !== "darwin") throw failure("unsupported_platform", false);
    return deadline(operationTimeoutMs, async (signal) => {
      const check = () => { if (signal.aborted) throw failure("timeout"); };
      if (!(await find(platform === "linux" ? "secret-tool" : "security"))) throw failure("executable_missing", false);
      check();
      const guarded: CommandRunner = async (command, args, opts) => {
        check();
        if (mutationUncertain && operation !== "get") throw failure("mutation_uncertain", false);
        dispatched = true;
        try {
          const result = await run(command, args, { ...opts, timeoutMs: operationTimeoutMs, signal });
          check();
          if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 1024 * 1024) throw Object.assign(new Error(), { code: "EOUTPUTLIMIT" });
          // A macOS `find-generic-password -g` prints the item (value and attributes) on stderr: that is
          // data, never a diagnostic, and a killed process may print it and still exit nonzero.
          // On a read only the text before the `password:` line is a diagnosis.
          const diagnostics = platform === "darwin" && operation === "get" ? (result.exitCode === 0 ? "" : macDiagnostic(result.stderr)) : result.stderr;
          if (/org\.freedesktop\.Secret\.Error\.IsLocked|Cannot create an item in a locked collection|errSecInteractionNotAllowed|user interaction is not allowed/i.test(diagnostics)) throw failure("locked");
          if (/org\.freedesktop\.DBus\.Error\.AccessDenied|permission denied|access denied/i.test(diagnostics)) throw failure("access_denied");
          const missingRead = operation === "get" && (platform === "linux"
            ? result.exitCode === 1 && result.stdout === "" && result.stderr.trim() === ""
            : result.exitCode === 44);
          const missingMacDelete = operation === "delete" && platform === "darwin" && result.exitCode === 44;
          if (result.exitCode !== 0 && !missingRead && !missingMacDelete) throw failure("command_failed");
          return result;
        } catch (error) {
          if (error instanceof KeychainOperationError) throw error;
          const code = coded(error);
          throw failure(code === "ETIMEDOUT" ? "timeout" : code === "ENOENT" ? "executable_missing" : code === "EACCES" || code === "EPERM" ? "access_denied" : code === "EOUTPUTLIMIT" ? "output_limit" : "command_failed", code === "ENOENT" || code === "EACCES" ? false : dispatched);
        }
      };
      const store = createKeychainCredentialStore({ platform, run: guarded, service: options.service, ...(options.label === undefined ? {} : { label: options.label }) });
      try { return await action(store); }
      catch (error) {
        // Legacy store wraps transport errors: retain only our own safe typed one.
        if (error instanceof KeychainOperationError) throw error;
        if (error instanceof KeychainError && error.cause_ instanceof KeychainOperationError) throw error.cause_;
        throw failure(dispatched ? "command_failed" : "invalid_input");
      }
    }, () => failure("timeout")).catch((error: unknown) => {
      if (error instanceof KeychainOperationError) throw error;
      const code = coded(error);
      throw failure(code === "ETIMEDOUT" ? "timeout" : code === "ENOENT" ? "executable_missing" : code === "EACCES" || code === "EPERM" ? "access_denied" : "command_failed");
    });
  }

  return {
    inspectionTimeoutMs, operationTimeoutMs,
    async inspect() {
      try {
        const result = await deadline(inspectionTimeoutMs, observe, () => new ObservationError("timeout"));
        return mutationUncertain ? { status: "unknown", reason: "mutation_outcome_unknown" } : result;
      } catch (error) {
        return { status: "unknown", reason: error instanceof ObservationError ? error.reason : coded(error) === "ETIMEDOUT" ? "timeout" : coded(error) === "EACCES" || coded(error) === "EPERM" ? "access_denied" : "command_failed" };
      }
    },
    store: {
      get: (key) => perform("get", (store) => store.get(key)),
      set: (key, value) => perform("set", (store) => store.set(key, value)),
      delete: (key) => perform("delete", (store) => store.delete(key)),
    },
  };
}
