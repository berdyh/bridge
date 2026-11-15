import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditFrameContext, AuditRecord, JsonRpcMessage } from "../acp/contracts.js";
import { createLocalPolicy } from "../acp/policy.js";
import * as barrel from "../index.js";
import { appPathsOf } from "../paths.js";

import { AUDIT_ROTATE_BYTES, auditFilesOf, createAuditLog, readAudit } from "./index.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-audit-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const paths = () => appPathsOf({ config: path.join(root, "config"), data: path.join(root, "data"), state: path.join(root, "state") }, "app");
const fileOf = (id = "plug"): string => auditFilesOf(paths(), id)[0]!;
const ctx = (over: Partial<AuditFrameContext> = {}): AuditFrameContext => ({
  appId: "app",
  pluginId: "plug",
  sessionId: "s1",
  trigger: { kind: "headless" },
  servers: ["srv"],
  ...over,
});
const update = (u: Record<string, unknown>): JsonRpcMessage => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: u } });
const toolCall = (id: string, name: string | undefined, extra: Record<string, unknown> = {}): JsonRpcMessage =>
  update({ sessionUpdate: "tool_call", toolCallId: id, title: "t", status: "pending", ...(name ? { _meta: { claudeCode: { toolName: name } } } : {}), ...extra });
const done = (id: string, status = "completed", extra: Record<string, unknown> = {}): JsonRpcMessage => update({ sessionUpdate: "tool_call_update", toolCallId: id, status, ...extra });
const linesOf = async (file: string): Promise<AuditRecord[]> => (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditRecord);
const now = () => Date.UTC(2026, 10, 2, 12, 0, 0);

describe("records", () => {
  it("a tool_call is recorded with a digest and a size and never the arguments; it claims no decision, and the terminal record of an unprompted call says none", async () => {
    const log = createAuditLog(fileOf(), { now });
    const rawInput = { to: "a@example.com", body: "CANARY-body-1f7a" };
    log.recordFrame(toolCall("tc1", "mcp__srv__send", { rawInput }), ctx());
    const [record] = await linesOf(fileOf());
    const text = JSON.stringify(rawInput);
    expect(record).toEqual({
      time: "2026-11-02T12:00:00.000Z",
      appId: "app",
      pluginId: "plug",
      sessionId: "s1",
      trigger: { kind: "headless" },
      servers: ["srv"],
      toolCallId: "tc1",
      toolName: "mcp__srv__send",
      status: "pending",
      argsSha256: (await import("node:crypto")).createHash("sha256").update(text).digest("hex"),
      argsBytes: Buffer.byteLength(text),
    });
    expect(record).not.toHaveProperty("decision"); // a request may still follow this frame: "none" would be a claim
    log.recordFrame(done("tc1"), ctx());
    expect((await linesOf(fileOf())).map((r) => [r.status, r.decision])).toEqual([["pending", undefined], ["completed", "none"]]);
  });

  it.each(["allow", "reject", "cancel"] as const)("a %s decision is written when it is made, and survives a session that ends before the terminal update", async (decision) => {
    const log = createAuditLog(fileOf(), { now });
    log.recordFrame(toolCall("tc1", "mcp__srv__write", { rawInput: { a: 1 } }), ctx({ trigger: { kind: "browser", browserKeyId: "key-1" } }));
    log.recordDecision("s1", "tc1", decision);
    log.endSession("s1"); // no terminal update ever comes
    const records = await linesOf(fileOf());
    expect(records.map((r) => [r.toolCallId, r.status, r.decision])).toEqual([["tc1", "pending", undefined], ["tc1", undefined, decision]]);
    expect(records[1]).toMatchObject({ appId: "app", pluginId: "plug", sessionId: "s1", servers: ["srv"], toolName: "mcp__srv__write", trigger: { kind: "browser", browserKeyId: "key-1" } });
    expect(records.filter((r) => r.decision === "none")).toEqual([]); // a prompted call is never recorded as unprompted
  });

  it("a decision that arrives before any frame of its session is written at once with the fields known, and the session ending loses nothing", async () => {
    const log = createAuditLog(fileOf(), { now });
    log.recordDecision("s1", "tc1", "reject");
    log.endSession("s1");
    const records = await linesOf(fileOf());
    expect(records).toEqual([{ time: "2026-11-02T12:00:00.000Z", pluginId: "plug", sessionId: "s1", toolCallId: "tc1", decision: "reject" }]);
    expect(log.failed).toBe(false);
    expect(await readAudit(fileOf(), { limit: 10 })).toEqual(records); // the reader keeps it
  });

  it("a prompted call carries its decision: joined before the frame, and on the terminal record when the request follows the frame", async () => {
    const log = createAuditLog(fileOf(), { now });
    log.recordDecision("s1", "tc1", "allow");
    log.recordFrame(toolCall("tc1", "mcp__srv__read"), ctx());
    log.recordFrame(toolCall("tc2", "mcp__srv__write"), ctx());
    log.recordDecision("s1", "tc2", "reject");
    log.recordFrame(done("tc2", "failed"), ctx());
    log.recordFrame(done("tc1"), ctx());
    const records = await linesOf(fileOf());
    expect(records.map((r) => [r.toolCallId, r.status, r.decision])).toEqual([
      ["tc1", undefined, "allow"], // written when it was made, before any frame of the session
      ["tc1", "pending", "allow"],
      ["tc2", "pending", undefined],
      ["tc2", undefined, "reject"],
      ["tc2", "failed", "reject"],
      ["tc1", "completed", "allow"],
    ]);
  });

  it("two sessions that both have tc1 keep their own decisions; a session that ended is forgotten", async () => {
    const log = createAuditLog(fileOf(), { now });
    log.recordDecision("s1", "tc1", "allow");
    log.recordDecision("s2", "tc1", "reject");
    log.recordFrame(toolCall("tc1", "mcp__srv__a"), ctx({ sessionId: "s1" }));
    log.recordFrame(toolCall("tc1", "mcp__srv__a"), ctx({ sessionId: "s2" }));
    log.recordDecision("s2", "tc1", "cancel");
    log.recordFrame(done("tc1"), ctx({ sessionId: "s2" }));
    log.endSession("s1");
    log.recordFrame(done("tc1"), ctx({ sessionId: "s1" }));
    const records = await linesOf(fileOf());
    expect(records.map((r) => [r.sessionId, r.status, r.decision])).toEqual([
      ["s1", undefined, "allow"],
      ["s2", undefined, "reject"],
      ["s1", "pending", "allow"],
      ["s2", "pending", "reject"],
      ["s2", undefined, "cancel"],
      ["s2", "completed", "cancel"],
      ["s1", "completed", "none"],
    ]);
  });

  describe("the argument digest is of the call's actual arguments, wherever the adapter delivers them", () => {
    const digest = (raw: unknown) => {
      const text = JSON.stringify(raw);
      return { argsSha256: createHash("sha256").update(text).digest("hex"), argsBytes: Buffer.byteLength(text) };
    };
    const real = { to: "a@example.com", n: 2 };
    const sent = (frames: JsonRpcMessage[]) => async () => {
      const log = createAuditLog(fileOf(), { now });
      for (const f of frames) log.recordFrame(f, ctx());
      const records = await linesOf(fileOf());
      return records.map((r) => [r.status, r.argsSha256 === undefined ? undefined : { argsSha256: r.argsSha256, argsBytes: r.argsBytes }] as const);
    };
    it.each([
      ["the tool_call", () => [toolCall("tc1", "mcp__srv__a", { rawInput: real }), done("tc1")], [["pending", digest(real)], ["completed", digest(real)]]],
      ["a later in_progress update (the tool_call had none)", () => [toolCall("tc1", "mcp__srv__a"), done("tc1", "in_progress", { rawInput: real }), done("tc1")], [["pending", undefined], ["completed", digest(real)]]],
      ["a later update that fills in a placeholder", () => [toolCall("tc1", "mcp__srv__a", { rawInput: {} }), done("tc1", "in_progress", { rawInput: real }), done("tc1")], [["pending", digest({})], ["completed", digest(real)]]],
      ["the last of several updates", () => [toolCall("tc1", "mcp__srv__a"), done("tc1", "in_progress", { rawInput: { a: 1 } }), done("tc1", "in_progress", { rawInput: real }), done("tc1")], [["pending", undefined], ["completed", digest(real)]]],
      ["an update with no status", () => [toolCall("tc1", "mcp__srv__a"), update({ sessionUpdate: "tool_call_update", toolCallId: "tc1", rawInput: real }), done("tc1", "failed")], [["pending", undefined], ["failed", digest(real)]]],
      ["the terminal update itself, which wins over an earlier one", () => [toolCall("tc1", "mcp__srv__a", { rawInput: { a: 1 } }), done("tc1", "completed", { rawInput: real })], [["pending", digest({ a: 1 })], ["completed", digest(real)]]],
      ["nowhere", () => [toolCall("tc1", "mcp__srv__a"), done("tc1")], [["pending", undefined], ["completed", undefined]]],
    ] as const)("%s", async (_name, frames, expected) => {
      expect(await sent([...frames()])()).toEqual(expected);
    });

    it("a nonterminal update writes no record, and the digest is per session and call and forgotten when the session ends", async () => {
      const log = createAuditLog(fileOf(), { now });
      log.recordFrame(done("tc1", "in_progress", { rawInput: real }), ctx());
      expect(await readAudit(fileOf(), { limit: 10 })).toEqual([]);
      log.recordFrame(done("tc2"), ctx()); // another call of the same session
      log.recordFrame(done("tc1"), ctx({ sessionId: "s2" })); // the same call id in another session
      log.recordFrame(done("tc1"), ctx());
      log.endSession("s1");
      log.recordFrame(done("tc1"), ctx());
      expect((await linesOf(fileOf())).map((r) => [r.sessionId, r.toolCallId, r.argsSha256 !== undefined])).toEqual([
        ["s1", "tc2", false],
        ["s2", "tc1", false],
        ["s1", "tc1", true],
        ["s1", "tc1", false],
      ]);
    });
  });

  it("records every tool_call frame and only the terminal updates; other frames are not records", async () => {
    const log = createAuditLog(fileOf(), { now });
    log.recordFrame(toolCall("tc1", "mcp__srv__a"), ctx());
    log.recordFrame(done("tc1", "in_progress"), ctx());
    log.recordFrame(done("tc1", "pending"), ctx());
    log.recordFrame(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }), ctx());
    log.recordFrame({ jsonrpc: "2.0", id: 1, result: {} }, ctx());
    log.recordFrame({ jsonrpc: "2.0", method: "session/update", params: {} }, ctx());
    log.recordFrame(done("tc1", "completed"), ctx());
    expect((await linesOf(fileOf())).map((r) => r.status)).toEqual(["pending", "completed"]);
  });

  it("a terminal update without a tool name takes the one the tool_call gave; the browser trigger is kept", async () => {
    const log = createAuditLog(fileOf(), { now });
    const trigger = { kind: "browser", browserKeyId: "key-1" } as const;
    log.recordFrame(toolCall("tc1", "mcp__srv__a"), ctx({ trigger }));
    log.recordFrame(done("tc1"), ctx({ trigger }));
    const records = await linesOf(fileOf());
    expect(records.map((r) => r.toolName)).toEqual(["mcp__srv__a", "mcp__srv__a"]);
    expect(records.map((r) => r.trigger)).toEqual([trigger, trigger]);
  });

  it("bounds and cleans what an agent supplies: a long or control-laden tool name, an unknown status, a missing call id", async () => {
    const log = createAuditLog(fileOf(), { now });
    log.recordFrame(toolCall("tc\n1", `mcp__srv__${"x".repeat(500)}\u0007\u2028`, { status: "weird" }), ctx());
    log.recordFrame(update({ sessionUpdate: "tool_call", status: "pending" }), ctx());
    const [a, b] = await linesOf(fileOf());
    expect(a!.toolName!.length).toBeLessThanOrEqual(200);
    expect(a!.toolName).not.toMatch(/[\u0000-\u001f\u2028]/);
    expect(a!.toolCallId).toBe("tc?1");
    expect(a!.status).toBeUndefined();
    expect(b!.toolCallId).toBe("");
  });

  it("append writes only the fields of a record: an extra key, such as raw input, never lands in the file", async () => {
    const log = createAuditLog(fileOf(), { now });
    const sneaky = { ...({ time: "t", appId: "a", pluginId: "p", sessionId: "s", trigger: { kind: "headless" }, servers: ["srv"], toolCallId: "tc" } satisfies AuditRecord), rawInput: { k: "CANARY-raw" }, secret: "CANARY-secret" };
    log.append(sneaky as AuditRecord);
    const text = await readFile(fileOf(), "utf8");
    expect(text).not.toContain("CANARY");
    expect(JSON.parse(text)).toEqual({ time: "t", appId: "a", pluginId: "p", sessionId: "s", trigger: { kind: "headless" }, servers: ["srv"], toolCallId: "tc" });
  });

  it("a canary in rawInput, a title, a result or the result content is in no file, rotated or not", async () => {
    const log = createAuditLog(fileOf(), { now, maxBytes: 600 });
    const canary = "CANARY-5b0e-secret";
    for (let i = 0; i < 12; i++) {
      log.recordFrame(toolCall(`tc${i}`, "mcp__srv__a", { title: canary, rawInput: { token: canary }, content: [{ type: "content", content: { type: "text", text: canary } }], locations: [{ path: `/${canary}` }] }), ctx());
      log.recordFrame(done(`tc${i}`, "completed", { rawOutput: { out: canary }, rawInput: { token: canary }, content: [{ type: "content", content: { type: "text", text: canary } }] }), ctx());
    }
    for (const name of await readdir(path.dirname(fileOf()))) expect(await readFile(path.join(path.dirname(fileOf()), name), "utf8"), name).not.toContain("CANARY");
  });
});

describe("the file", () => {
  it("is 0600 in a 0700 folder, and a looser existing file or folder is tightened", async () => {
    const dir = path.dirname(fileOf());
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await chmod(dir, 0o755);
    await writeFile(fileOf(), "", { mode: 0o644 });
    await chmod(fileOf(), 0o644);
    createAuditLog(fileOf()).recordFrame(toolCall("tc1", "mcp__srv__a"), ctx());
    expect((await stat(fileOf())).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("a fresh file is created 0600", async () => {
    createAuditLog(fileOf()).recordFrame(toolCall("tc1", "mcp__srv__a"), ctx());
    expect((await stat(fileOf())).mode & 0o777).toBe(0o600);
  });

  it("appends to what is there instead of truncating it", async () => {
    createAuditLog(fileOf(), { now }).recordFrame(toolCall("tc1", "mcp__srv__a"), ctx());
    createAuditLog(fileOf(), { now }).recordFrame(toolCall("tc2", "mcp__srv__a"), ctx());
    expect((await linesOf(fileOf())).map((r) => r.toolCallId)).toEqual(["tc1", "tc2"]);
  });

  const complete = JSON.stringify({ time: "2026-11-02T11:00:00.000Z", appId: "app", pluginId: "plug", sessionId: "old", trigger: { kind: "headless" }, servers: [], toolCallId: "old1" });
  it.each([
    ["a torn record", `${complete}\n{"time":"2026-11-0`, ["old1", "tc1"]],
    ["a complete record with no newline", complete, ["old1", "tc1"]],
    ["a lone fragment", "{", ["tc1"]],
    ["a newline-terminated file", `${complete}\n`, ["old1", "tc1"]],
    ["an empty file", "", ["tc1"]],
  ])("a new record is its own readable line after %s", async (_name, existing, expected) => {
    await mkdir(path.dirname(fileOf()), { recursive: true, mode: 0o700 });
    await writeFile(fileOf(), existing, { mode: 0o600 });
    const log = createAuditLog(fileOf(), { now });
    log.recordFrame(toolCall("tc1", "mcp__srv__a"), ctx());
    log.recordFrame(toolCall("tc2", "mcp__srv__a"), ctx());
    const text = await readFile(fileOf(), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("\n\n"); // delimiting adds no blank line
    expect((await readAudit(fileOf(), { limit: 10 })).map((r) => r.toolCallId)).toEqual([...expected, "tc2"]);
    // Every new line parses on its own: none is glued to the torn tail.
    expect(text.split("\n").filter(Boolean).slice(-2).map((l) => (JSON.parse(l) as AuditRecord).toolCallId)).toEqual(["tc1", "tc2"]);
  });

  it("refuses a symlinked audit folder, writes nothing through it, and fails closed", async () => {
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(path.dirname(paths().auditDir), { recursive: true });
    await symlink(elsewhere, paths().auditDir);
    const log = createAuditLog(fileOf(), { now });
    expect(() => log.recordFrame(toolCall("tc1", "mcp__srv__a"), ctx())).toThrow(/audit log write failed.*redirected/);
    expect(log.failed).toBe(true);
    expect(await readdir(elsewhere)).toEqual([]);
    // Sticky: later writes throw without trying again.
    expect(() => log.recordFrame(toolCall("tc2", "mcp__srv__a"), ctx())).toThrow(/audit log write failed/);
  });

  it("refuses a symlinked bridge folder (the parent of audit) too", async () => {
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(path.join(elsewhere, "audit"), { recursive: true });
    await mkdir(path.dirname(path.dirname(paths().auditDir)), { recursive: true });
    await symlink(elsewhere, path.dirname(paths().auditDir));
    const log = createAuditLog(fileOf(), { now });
    expect(() => log.append({ time: "t", appId: "a", pluginId: "p", sessionId: "s", trigger: { kind: "headless" }, servers: [], toolCallId: "tc" })).toThrow(/redirected/);
    expect(await readdir(path.join(elsewhere, "audit"))).toEqual([]);
  });

  it("refuses an audit file that is a symlink", async () => {
    await mkdir(path.dirname(fileOf()), { recursive: true });
    const victim = path.join(root, "victim");
    await writeFile(victim, "keep\n");
    await symlink(victim, fileOf());
    const log = createAuditLog(fileOf());
    expect(() => log.recordFrame(toolCall("tc1", "mcp__srv__a"), ctx())).toThrow(/audit log write failed/);
    expect(log.failed).toBe(true);
    expect(await readFile(victim, "utf8")).toBe("keep\n");
  });

  it("fails closed when the file is removed or replaced under the log", async () => {
    const log = createAuditLog(fileOf());
    log.recordFrame(toolCall("tc1", "mcp__srv__a"), ctx());
    await unlink(fileOf());
    expect(() => log.recordFrame(toolCall("tc2", "mcp__srv__a"), ctx())).toThrow(/audit log write failed/);
    expect(log.failed).toBe(true);
    const other = createAuditLog(fileOf());
    other.recordFrame(toolCall("tc1", "mcp__srv__a"), ctx());
    await unlink(fileOf());
    await writeFile(fileOf(), "");
    expect(() => other.recordFrame(toolCall("tc2", "mcp__srv__a"), ctx())).toThrow(/audit log write failed/);
  });

  it("a record that cannot be written is a failure, not a skipped line", () => {
    const log = createAuditLog(fileOf());
    expect(() => log.append({ appId: "a" } as AuditRecord)).toThrow(/audit log write failed/);
    expect(log.failed).toBe(true);
  });
});

describe("rotation", () => {
  it("moves the log to one .1 file at the size limit and keeps writing 0600 files; the older .1 is replaced", async () => {
    const log = createAuditLog(fileOf(), { now, maxBytes: 700 });
    const total = 30;
    for (let i = 0; i < total; i++) log.recordFrame(toolCall(`tc${i}`, "mcp__srv__a"), ctx());
    const [file, rotated] = auditFilesOf(paths(), "plug") as [string, string];
    expect(await readdir(path.dirname(file))).toEqual(["plug.jsonl", "plug.jsonl.1"]);
    for (const f of [file, rotated]) {
      expect((await stat(f)).mode & 0o777).toBe(0o600);
      expect((await stat(f)).size).toBeLessThanOrEqual(700);
    }
    const kept = [...(await linesOf(rotated)), ...(await linesOf(file))].map((r) => r.toolCallId);
    // The newest records are all there, in order, and the oldest were dropped with the replaced .1.
    expect(kept.at(-1)).toBe(`tc${total - 1}`);
    expect(kept).toEqual(kept.map((_, i) => `tc${total - kept.length + i}`));
    expect(kept.length).toBeLessThan(total);
    expect(log.failed).toBe(false);
  });

  it("the default limit is 5 MiB", () => {
    expect(AUDIT_ROTATE_BYTES).toBe(5 * 1024 * 1024);
  });

  it("a log that is already over the limit rotates on its next write", async () => {
    await mkdir(path.dirname(fileOf()), { recursive: true });
    await writeFile(fileOf(), `${"x".repeat(AUDIT_ROTATE_BYTES - 11)}\n`);
    createAuditLog(fileOf(), { now }).recordFrame(toolCall("tc1", "mcp__srv__a"), ctx());
    expect((await stat(`${fileOf()}.1`)).size).toBe(AUDIT_ROTATE_BYTES - 10);
    expect((await linesOf(fileOf())).map((r) => r.toolCallId)).toEqual(["tc1"]);
  });
});

describe("a write failure turns the next decision into cancel", () => {
  const request = (pluginId: string) => ({
    appId: "app",
    agentId: "claude",
    sessionId: "s1",
    cwd: "/x",
    origin: { kind: "plugin" as const, pluginId, contained: true, callsLeft: 3, allow: ["mcp__srv__read"] },
    toolCallId: "tc1",
    toolName: "mcp__srv__read",
    options: [
      { optionId: "once", name: "Once", kind: "allow_once" },
      { optionId: "no", name: "No", kind: "reject_once" },
    ],
  });

  it("through the policy: approved while the log is healthy, cancelled once a write fails, for any session of that plugin only", async () => {
    const logs = new Map([["plug", createAuditLog(fileOf("plug"), { now })], ["other", createAuditLog(fileOf("other"), { now })]]);
    const policy = createLocalPolicy({ auditFailed: (id) => logs.get(id)?.failed ?? true, warn: () => {} });
    expect(await policy.decidePermission(request("plug"))).toEqual({ action: "select", optionId: "once" });
    logs.get("plug")!.recordFrame(toolCall("tc1", "mcp__srv__read"), ctx());
    await unlink(fileOf("plug"));
    expect(() => logs.get("plug")!.recordFrame(toolCall("tc2", "mcp__srv__read"), ctx())).toThrow();
    expect(await policy.decidePermission(request("plug"))).toEqual({ action: "cancel" });
    expect(await policy.decidePermission({ ...request("plug"), sessionId: "s2" })).toEqual({ action: "cancel" });
    expect(await policy.decidePermission(request("other"))).toEqual({ action: "select", optionId: "once" });
    // A log that does not exist is a failed log.
    expect(await policy.decidePermission(request("nobody"))).toEqual({ action: "cancel" });
  });
});

it("is re-exported from the runner barrel", () => {
  expect(barrel.createAuditLog).toBe(createAuditLog);
  expect(barrel.auditFilesOf).toBe(auditFilesOf);
  expect(barrel.readAudit).toBe(readAudit);
});

describe("auditFilesOf", () => {
  it("names exactly the log and its rotated file, inside auditDir", () => {
    expect(auditFilesOf({ auditDir: "/a/audit" }, "my-plugin")).toEqual(["/a/audit/my-plugin.jsonl", "/a/audit/my-plugin.jsonl.1"]);
  });
  it("refuses an id that is not a plugin id, so no path can climb out of auditDir", () => {
    for (const id of ["", "../x", "a/b", "A", ".", "..", "a\u0000b"]) expect(() => auditFilesOf({ auditDir: "/a/audit" }, id), JSON.stringify(id)).toThrow(/plugin id/);
  });
});

describe("readAudit", () => {
  const fill = (n: number, maxBytes?: number) => {
    const log = createAuditLog(fileOf(), { now, ...(maxBytes ? { maxBytes } : {}) });
    for (let i = 0; i < n; i++) log.recordFrame(toolCall(`tc${i}`, "mcp__srv__a"), ctx());
  };

  it("returns the most recent records, oldest first, across the rotated file", async () => {
    fill(30, 700);
    const all = await readAudit(fileOf(), { limit: 1000 });
    expect(all.at(-1)!.toolCallId).toBe("tc29");
    expect(all.length).toBeGreaterThan(5);
    expect((await readAudit(fileOf(), { limit: 3 })).map((r) => r.toolCallId)).toEqual(["tc27", "tc28", "tc29"]);
  });

  it("is empty for a missing file, skips torn and foreign lines, and takes a positive integer limit", async () => {
    expect(await readAudit(fileOf(), { limit: 5 })).toEqual([]);
    fill(2);
    await writeFile(fileOf(), `${await readFile(fileOf(), "utf8")}{"torn":\nnot json\n[1]\n{"time":"t"}\n`);
    expect((await readAudit(fileOf(), { limit: 10 })).map((r) => r.toolCallId)).toEqual(["tc0", "tc1"]);
    for (const limit of [0, -1, 1.5, Number.NaN]) await expect(readAudit(fileOf(), { limit })).rejects.toThrow(RangeError);
  });

  it("does not follow a symlinked audit file", async () => {
    await mkdir(path.dirname(fileOf()), { recursive: true });
    const other = path.join(root, "other.jsonl");
    await writeFile(other, "");
    await symlink(other, fileOf());
    await expect(readAudit(fileOf(), { limit: 5 })).rejects.toThrow();
    expect((await lstat(fileOf())).isSymbolicLink()).toBe(true);
  });
});
