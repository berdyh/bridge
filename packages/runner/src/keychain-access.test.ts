import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKeychainAccess, KeychainOperationError } from "./keychain-access.js";
import type { CommandResult, CommandRunner } from "./contracts.js";

const result = (type: string, value: unknown): CommandResult => ({ exitCode: 0, stdout: JSON.stringify({ type, data: [value] }), stderr: "" });
const ready = (locked = false) => [result("as", ["org.freedesktop.secrets"]), result("s", ":1.42"), result("o", "/org/freedesktop/secrets/collection/login"), { exitCode: 0, stdout: JSON.stringify({ type: "b", data: locked }), stderr: "" }];
function fixture(results = ready(), overrides: Parameters<typeof createKeychainAccess>[0] extends infer T ? Partial<T> : never = {}) {
  const calls: { command: string; args: readonly string[]; options?: unknown }[] = [];
  const run: CommandRunner = async (command, args, options) => { calls.push({ command, args, options }); return results.shift() ?? { exitCode: 0, stdout: "", stderr: "" }; };
  return { calls, access: createKeychainAccess({ service: "test-app", platform: "linux", findExecutable: async () => true, run, ...overrides }) };
}
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("observational keychain availability", () => {
  it.each([false, true])("reads only existing service metadata (locked=%s)", async (locked) => {
    const f = fixture(ready(locked));
    expect(await f.access.inspect()).toEqual(locked ? { status: "locked", reason: "collection_locked" } : { status: "available", reason: "ready" });
    expect(f.calls).toHaveLength(4);
    for (const call of f.calls) {
      expect(call.command).toBe("busctl");
      expect(call.args).toContain("--auto-start=no");
      expect(call.options).toMatchObject({ timeoutMs: 5000 });
      expect(JSON.stringify(call)).not.toMatch(/secret-tool|OpenSession|GetSecret|SearchItems|Unlock|CreateCollection|store|clear/);
    }
    expect(f.calls.at(-1)?.args).toContain(":1.42");
  });
  it("distinguishes missing service from an activatable inactive one", async () => {
    expect(await fixture([result("as", []), result("as", [])]).access.inspect()).toEqual({ status: "absent", reason: "service_missing" });
    expect(await fixture([result("as", []), result("as", ["org.freedesktop.secrets"])]).access.inspect()).toEqual({ status: "unknown", reason: "service_not_running" });
  });
  it("distinguishes unsupported platform, missing store executable, and missing observer", async () => {
    const find = vi.fn(async () => true);
    const f = fixture([], { platform: "win32", findExecutable: find });
    expect(await f.access.inspect()).toEqual({ status: "absent", reason: "unsupported_platform" });
    expect(find).not.toHaveBeenCalled();
    expect(await fixture([], { findExecutable: async () => false }).access.inspect()).toEqual({ status: "absent", reason: "executable_missing" });
    expect(await fixture([], { findExecutable: async (name) => name === "secret-tool" }).access.inspect()).toEqual({ status: "unknown", reason: "observer_unavailable" });
  });
  it("does not invent macOS lock evidence or invoke its keychain", async () => {
    const f = fixture([], { platform: "darwin" });
    expect(await f.access.inspect()).toEqual({ status: "unknown", reason: "inspection_unsupported" });
    expect(f.calls).toEqual([]);
  });
  it.each([
    [{ exitCode: 1, stdout: "", stderr: "org.freedesktop.DBus.Error.AccessDenied synthetic-private-value" }, "access_denied"],
    [{ exitCode: 2, stdout: "synthetic-private-value", stderr: "synthetic-private-value" }, "command_failed"],
    [{ exitCode: 0, stdout: "synthetic-private-value", stderr: "" }, "invalid_response"],
    [result("as", [12]), "invalid_response"],
  ] as const)("never turns nonzero, denied, or malformed metadata into absence", async (response, reason) => {
    const answer = await fixture([response]).access.inspect();
    expect(answer).toEqual({ status: "unknown", reason });
    expect(JSON.stringify(answer)).not.toContain("synthetic-private-value");
  });
  it("treats missing default collection and owner replacement as unverified", async () => {
    expect(await fixture([result("as", ["org.freedesktop.secrets"]), result("s", ":1.42"), result("o", "/")]).access.inspect()).toEqual({ status: "unknown", reason: "no_default_collection" });
    expect(await fixture([result("as", ["org.freedesktop.secrets"]), result("s", "org.freedesktop.secrets")]).access.inspect()).toEqual({ status: "unknown", reason: "invalid_response" });
  });
  it.each([[false], "false", null, 0])("refuses malformed property value %j without guessing lock state", async (value) => {
    const responses = ready(); responses[3] = { exitCode: 0, stdout: JSON.stringify({ type: "b", data: value }), stderr: "" };
    expect(await fixture(responses).access.inspect()).toEqual({ status: "unknown", reason: "invalid_response" });
  });
  it.each(["EACCES", "EPERM", "ETIMEDOUT", "ENOENT"])("does not infer absence from inspection failure %s", async (code) => {
    const answer = await fixture([], { run: async () => { throw Object.assign(new Error("private-error"), { code }); } }).access.inspect();
    expect(answer.status).toBe("unknown");
    expect(JSON.stringify(answer)).not.toContain("private-error");
  });
  it("bounds the entire observation and prevents late follow-on commands", async () => {
    vi.useFakeTimers();
    let release!: (v: CommandResult) => void;
    const run = vi.fn<CommandRunner>(() => new Promise((resolve) => { release = resolve; }));
    const f = fixture([], { run, inspectionTimeoutMs: 10 });
    const pending = f.access.inspect();
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toEqual({ status: "unknown", reason: "timeout" });
    release(result("as", ["org.freedesktop.secrets"]));
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each(["relative", "empty"])("does not falsely report an executable absent for a %s PATH component", async (kind) => {
    const scratch = fileURLToPath(new URL("../../../.ci-local/", import.meta.url));
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(path.join(scratch, "path-")); roots.push(root);
    for (const name of ["secret-tool", "busctl"]) await writeFile(path.join(root, name), "synthetic fixture", { mode: 0o700 });
    const relative = path.relative(process.cwd(), root);
    if (kind === "empty") { vi.spyOn(process, "cwd").mockReturnValue(root); vi.stubEnv("PATH", ""); }
    else vi.stubEnv("PATH", relative);
    const f = fixture(ready(), { findExecutable: undefined });
    expect(await f.access.inspect()).toEqual({ status: "available", reason: "ready" });
    expect(f.calls).toHaveLength(4);
  });
});

describe("bounded typed keychain store", () => {
  it("supplies the existing store contract with finite operation deadlines and no secret in argv", async () => {
    const f = fixture([{ exitCode: 0, stdout: "", stderr: "" }, { exitCode: 0, stdout: "synthetic-secret", stderr: "" }, { exitCode: 0, stdout: "", stderr: "" }]);
    await f.access.store.set("account", "synthetic-secret");
    expect(await f.access.store.get("account")).toBe("synthetic-secret");
    await f.access.store.delete("account");
    expect(f.calls.map((c) => c.args[0])).toEqual(["store", "lookup", "clear"]);
    expect(f.calls[0]?.options).toMatchObject({ stdin: "synthetic-secret", timeoutMs: 5000 });
    expect(JSON.stringify(f.calls.map((c) => c.args))).not.toContain("synthetic-secret");
  });
  it("preserves not-found behavior and macOS stdin quoting", async () => {
    expect(await fixture([{ exitCode: 1, stdout: "", stderr: "" }]).access.store.get("missing")).toBeNull();
    const f = fixture([{ exitCode: 0, stdout: "", stderr: "" }], { platform: "darwin" });
    await f.access.store.set("a", "synthetic-secret");
    expect(f.calls[0]?.args).toEqual(["-i"]);
    expect(f.calls[0]?.options).toMatchObject({ stdin: 'add-generic-password -U -a "a" -s "test-app" -w "synthetic-secret"\n' });
  });
  it.each(["get", "set", "delete"] as const)("bounds %s and reports mutation ambiguity conservatively", async (operation) => {
    vi.useFakeTimers();
    const f = fixture([], { run: () => new Promise(() => {}), operationTimeoutMs: 10 });
    const pending = operation === "set" ? f.access.store.set("a", "synthetic-secret") : f.access.store[operation]("a");
    const caught = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await caught).toMatchObject({ name: "KeychainOperationError", operation, code: "timeout", outcome: "unknown", mayHaveMutated: operation !== "get" });
    if (operation !== "get") {
      expect(await f.access.inspect()).toEqual({ status: "unknown", reason: "mutation_outcome_unknown" });
      await expect(f.access.store.set("a", "retry")).rejects.toMatchObject({ code: "mutation_uncertain", outcome: "not_started" });
    }
  });
  it("cannot dispatch a late write after a timed-out executable check", async () => {
    vi.useFakeTimers();
    let release!: (value: boolean) => void;
    const run = vi.fn<CommandRunner>(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const f = fixture([], { run, findExecutable: () => new Promise((resolve) => { release = resolve; }), operationTimeoutMs: 10 });
    const pending = f.access.store.set("a", "secret").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ code: "timeout", outcome: "not_started", mayHaveMutated: false });
    release(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).not.toHaveBeenCalled();
  });
  it("never converts a late successful write or later missing executable into a fallback signal", async () => {
    vi.useFakeTimers();
    let release!: (value: CommandResult) => void;
    let present = true;
    const f = fixture([], { run: () => new Promise((resolve) => { release = resolve; }), findExecutable: async () => present, operationTimeoutMs: 10 });
    const pending = f.access.store.set("a", "secret").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBeInstanceOf(KeychainOperationError);
    release({ exitCode: 0, stdout: "", stderr: "" }); present = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(await f.access.inspect()).toEqual({ status: "unknown", reason: "mutation_outcome_unknown" });
  });
  it.each([
    ["ENOENT", "executable_missing", false], ["EACCES", "access_denied", false], ["ETIMEDOUT", "timeout", true], ["OTHER", "command_failed", true],
  ] as const)("sanitizes transport error %s without retaining raw causes", async (code, expected, mayHaveMutated) => {
    const f = fixture([], { run: async () => { throw Object.assign(new Error("synthetic-secret"), { code }); } });
    const error: unknown = await f.access.store.set("account-secret", "synthetic-secret").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeychainOperationError);
    expect(error).toMatchObject({ code: expected, mayHaveMutated });
    expect(String(error)).not.toMatch(/synthetic-secret|account-secret/);
    expect(error).toHaveProperty("cause_", undefined);
  });
  it.each([
    ["org.freedesktop.Secret.Error.IsLocked synthetic-secret", "locked"],
    ["Permission denied synthetic-secret", "access_denied"],
    ["unclassified synthetic-secret", "command_failed"],
  ])("sanitizes nonzero operation output %s", async (stderr, code) => {
    const f = fixture([{ exitCode: 2, stdout: "synthetic-secret", stderr }]);
    const error: unknown = await f.access.store.set("a", "synthetic-secret").catch((e: unknown) => e);
    expect(error).toMatchObject({ code, outcome: "unknown", mayHaveMutated: true });
    expect(String(error)).not.toContain("synthetic-secret");
    expect(await f.access.inspect()).toEqual({ status: "unknown", reason: "mutation_outcome_unknown" });
  });
  it("reports pre-dispatch failures without creating a fallback store", async () => {
    const f = fixture([], { findExecutable: async () => false });
    await expect(f.access.store.set("a", "value")).rejects.toMatchObject({ code: "executable_missing", outcome: "not_started", mayHaveMutated: false });
    expect(f.calls).toEqual([]);
    await expect(fixture([], { platform: "win32" }).access.store.get("a")).rejects.toMatchObject({ code: "unsupported_platform" });
    const denied = fixture([], { findExecutable: async () => { throw Object.assign(new Error("synthetic-private"), { code: "EACCES" }); } });
    const error: unknown = await denied.access.store.set("a", "secret").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "access_denied", outcome: "not_started", mayHaveMutated: false });
    expect(String(error)).not.toContain("synthetic-private");
  });
  it("rejects nonzero empty-stderr deletion instead of accepting legacy permissive status", async () => {
    const f = fixture([{ exitCode: 42, stdout: "", stderr: "" }]);
    await expect(f.access.store.delete("a")).rejects.toMatchObject({ code: "command_failed", outcome: "unknown", mayHaveMutated: true });
    expect(await f.access.inspect()).toEqual({ status: "unknown", reason: "mutation_outcome_unknown" });
  });
  it("accepts only exact not-found statuses, not matching prose on arbitrary failure", async () => {
    await expect(fixture([{ exitCode: 42, stdout: "", stderr: "could not be found" }], { platform: "darwin" }).access.store.get("a")).rejects.toMatchObject({ code: "command_failed" });
    await expect(fixture([{ exitCode: 1, stdout: "unexpected", stderr: "" }]).access.store.get("a")).rejects.toMatchObject({ code: "command_failed" });
    await expect(fixture([{ exitCode: 44, stdout: "", stderr: "not found" }], { platform: "darwin" }).access.store.delete("a")).resolves.toBeUndefined();
  });
  it("refuses an oversize macOS write before dispatch without latching mutation uncertainty", async () => {
    const f = fixture([{ exitCode: 0, stdout: "", stderr: "" }], { platform: "darwin" });
    await expect(f.access.store.set("a", "y".repeat(5000))).rejects.toMatchObject({ code: "invalid_input", outcome: "not_started", mayHaveMutated: false });
    expect(f.calls).toEqual([]);
    await expect(f.access.store.set("a", "small")).resolves.toBeUndefined();
    expect(f.calls).toHaveLength(1);
  });
  it("a lone surrogate is invalid_input before dispatch and does not latch", async () => {
    const f = fixture([{ exitCode: 0, stdout: "", stderr: "" }], { platform: "darwin" });
    await expect(f.access.store.set("a", "\ud800")).rejects.toMatchObject({ code: "invalid_input", outcome: "not_started", mayHaveMutated: false });
    expect(f.calls).toEqual([]);
    await expect(f.access.store.set("a", "ok")).resolves.toBeUndefined();
  });
  it("never classifies the stored value that macOS find -g prints on stderr", async () => {
    // As /usr/bin/security prints it: the value and the item's attributes, all on stderr.
    const dump = 'password: "access denied; user interaction is not allowed"\nkeychain: "/k"\nclass: "genp"\nattributes:\n    "acct"<blob>="permission denied"\n    "icmt"<blob>="user interaction is not allowed"\n    "svce"<blob>="test-app"\n';
    const f = fixture([{ exitCode: 0, stdout: "", stderr: dump }], { platform: "darwin" });
    expect(await f.access.store.get("permission denied")).toBe("access denied; user interaction is not allowed");
    const g = fixture([{ exitCode: 51, stdout: "", stderr: "security: SecKeychainSearchCopyNext: User interaction is not allowed.\n" }], { platform: "darwin" });
    await expect(g.access.store.get("a")).rejects.toMatchObject({ code: "locked" });
  });
  it("a stored value printed before an abnormal exit is not a locked or denied diagnosis and is not retained", async () => {
    for (const value of ["access denied", "user interaction is not allowed", "SYNTHETIC_TOKEN"]) {
      const f = fixture([{ exitCode: 1, stdout: "", stderr: `password: "${value}"\n` }], { platform: "darwin" });
      const error: unknown = await f.access.store.get("a").catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "command_failed" });
      expect(`${String(error)} ${(error as Error).message} ${JSON.stringify(error)}`).not.toContain(value);
      expect((error as { cause_?: unknown }).cause_).toBeUndefined();
    }
    const g = fixture([{ exitCode: 51, stdout: "", stderr: 'security: SecKeychainSearchCopyNext: User interaction is not allowed.\npassword: "SYNTHETIC_TOKEN"\n' }], { platform: "darwin" });
    await expect(g.access.store.get("a")).rejects.toMatchObject({ code: "locked" });
  });
  it("a transport failure carrying the token reaches the facade as a fixed code", async () => {
    const run: CommandRunner = async () => { throw Object.assign(new Error('boom password: "SYNTHETIC_TOKEN"'), { code: "EPIPE" }); };
    const error: unknown = await createKeychainAccess({ service: "a", platform: "darwin", findExecutable: async () => true, run }).store.get("a").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "command_failed" });
    expect(`${String(error)} ${(error as Error).message} ${JSON.stringify(error)}`).not.toContain("SYNTHETIC_TOKEN");
  });
  it.each([["get", "timeout", false], ["set", "timeout", true], ["delete", "timeout", true]] as const)("macOS %s keeps its typed classification when the transport fails with output text", async (operation, code, mayHaveMutated) => {
    const run: CommandRunner = async () => { throw Object.assign(new Error('out password: "SYNTHETIC_TOKEN"'), { code: "ETIMEDOUT" }); };
    const { store } = createKeychainAccess({ service: "a", platform: "darwin", findExecutable: async () => true, run });
    const error: unknown = await (operation === "get" ? store.get("a") : operation === "set" ? store.set("a", "v") : store.delete("a")).catch((e: unknown) => e);
    expect(error).toMatchObject({ operation, code, mayHaveMutated });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("SYNTHETIC_TOKEN");
    expect((error as { cause_?: unknown }).cause_).toBeUndefined();
  });
  it("rejects unsafe configuration and invalid macOS stdin before dispatch", async () => {
    expect(() => createKeychainAccess({ service: "a\0b" })).toThrow();
    for (const value of [0, -1, Infinity, 30001, 1.5]) expect(() => createKeychainAccess({ service: "a", inspectionTimeoutMs: value })).toThrow(RangeError);
    const f = fixture([], { platform: "darwin" });
    await expect(f.access.store.set("a", "x\ny")).rejects.toMatchObject({ code: "invalid_input", outcome: "not_started", mayHaveMutated: false });
    expect(f.calls).toEqual([]);
  });
});
