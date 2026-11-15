/**
 * Audit log of contained plugin sessions: one JSONL file per plugin, `<auditDir>/<plugin id>.jsonl`,
 * written from the `tool_call` frames of its sessions whether or not a permission request came first.
 * The types and names (`AuditSink`, `AuditLog`, `AuditRecord`) are in `../acp/contracts.ts`.
 *
 * What a line holds: who, which session, which tool, the frame's status, the permission decision and a
 * digest and size of the raw input. Never the raw input, never a result, never a secret: the record is built
 * from a fixed list of fields, so a value that is not on it cannot reach the file.
 *
 * Fail closed: the first failed write (a refused directory, a full disk, a file removed or replaced under the
 * log) makes the log `failed` for good. Every later write throws, and `FileAuditLog.failed` lets the policy
 * cancel the next decision (`LocalPolicyConfig.auditFailed`). Writes are synchronous on purpose: when
 * `recordFrame` returns, the line is written or the failure is already visible, so no decision can slip in
 * between a failed write and the flag.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeSync,
} from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { isPluginId } from "@berdyh/bridge-protocol";

import type { AuditFrameContext, AuditLog, AuditRecord, AuditTrigger, JsonRpcMessage } from "../acp/contracts.js";
import type { AppPaths } from "../paths.js";

/** The size at which a log is rotated to its single `.1` file. */
export const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;
/** The most `readAudit` reads of one file: the tail of an oversized (tampered) one. */
const READ_TAIL_BYTES = 16 * 1024 * 1024;
/** The per-app tail that must not be a link: `bridge` and `audit` (as `ensurePrivateAppDir` for `work`/`tmp`). */
const DIR_LEVELS = 2;
const MAX_NAME = 200;
const MAX_SERVERS = 64;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);

/** The log `createAuditLog` returns: the contract plus the fail-closed state the policy reads. */
export interface FileAuditLog extends AuditLog {
  /** True after any failed write, for the life of this object. */
  readonly failed: boolean;
}

export interface AuditLogOptions {
  /** Rotation size. Default `AUDIT_ROTATE_BYTES` (5 MiB). */
  maxBytes?: number;
  /** Clock for the record's `time`. Default `Date.now`. */
  now?: () => number;
}

/** `[<auditDir>/<id>.jsonl, <auditDir>/<id>.jsonl.1]`: the one place the file names are made, and exactly what removal deletes. */
export function auditFilesOf(paths: Pick<AppPaths, "auditDir">, pluginId: string): string[] {
  if (!isPluginId(pluginId)) throw new Error("not a plugin id: no audit path can be named for it");
  const file = path.join(paths.auditDir, `${pluginId}.jsonl`);
  return [file, `${file}.1`];
}

const clean = (text: string): string => text.slice(0, MAX_NAME).replace(CONTROL, "?");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The `(hex sha256, byte count)` of a raw input's JSON text, or nothing when it has none. */
function digestOf(rawInput: unknown): { argsSha256: string; argsBytes: number } | undefined {
  if (rawInput === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(rawInput);
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  const bytes = Buffer.from(text, "utf8");
  return { argsSha256: createHash("sha256").update(bytes).digest("hex"), argsBytes: bytes.length };
}

function updateOf(frame: JsonRpcMessage): Record<string, unknown> | undefined {
  if (frame.method !== "session/update" || !isObject(frame.params)) return undefined;
  return isObject(frame.params.update) ? frame.params.update : undefined;
}

function toolNameOf(update: Record<string, unknown>): string | undefined {
  const claude = isObject(update._meta) ? update._meta.claudeCode : undefined;
  const name = isObject(claude) ? claude.toolName : undefined;
  return typeof name === "string" && name.length > 0 ? clean(name) : undefined;
}

/** The first link among the last `DIR_LEVELS` components of `dir`; any lstat error but "not there" counts as one. */
function redirected(dir: string): string | undefined {
  const abs = path.resolve(dir);
  const parts = abs.split(path.sep).filter((c) => c !== "");
  for (let i = Math.max(1, parts.length - DIR_LEVELS + 1); i <= parts.length; i++) {
    const prefix = path.parse(abs).root + parts.slice(0, i).join(path.sep);
    try {
      if (lstatSync(prefix).isSymbolicLink()) return prefix;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return prefix;
    }
  }
  return undefined;
}

/** Creates the audit dir 0700 unless `bridge` or `audit` is a link (checked before and after, as `ensurePrivateAppDir`). */
function ensureAuditDir(dir: string): void {
  const before = redirected(dir);
  if (before !== undefined) throw new Error(`refusing a redirected audit folder: ${before} is a symlink`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const after = redirected(dir);
  if (after !== undefined) throw new Error(`refusing a redirected audit folder: ${after} is a symlink`);
}

/**
 * Writes JSONL records to `file` (`<auditDir>/<plugin id>.jsonl`): the folder 0700 and not reached through a
 * link, the file 0600 and opened without following a link, rotated at `maxBytes` to one `.1` file (the previous
 * `.1` is replaced). One log serves every session of the plugin; join state is kept per session.
 *
 * The digest is of the arguments as the adapter delivered them, in the `tool_call` or in a later nonterminal
 * `tool_call_update` (which is not a record of its own); the terminal record carries the last digest seen.
 *
 * A `tool_call` frame is written when it arrives, with the decision known by then, else without one: `none`
 * means no permission request was made, which a frame that comes first cannot know. The terminal
 * `tool_call_update` is written with the decision joined by `(sessionId, toolCallId)`, else `none`. A permission
 * request normally follows its `tool_call` frame, so `recordDecision` also writes its own record at once (a
 * session that ends before the terminal update still has its decision in the file). A `recordDecision` that came
 * before any frame of the session is written at once too, with the fields known by then (the session, the call, the
 * decision and the plugin, which is this log), and is still joined to the frames that follow.
 */
export function createAuditLog(file: string, options: AuditLogOptions = {}): FileAuditLog {
  const target = path.resolve(file);
  const rotated = `${target}.1`;
  const maxBytes = options.maxBytes ?? AUDIT_ROTATE_BYTES;
  const now = options.now ?? Date.now;
  /** The plugin this log belongs to: `<plugin id>.jsonl`. */
  const pluginOfLog = path.basename(target, ".jsonl");
  let fd: number | undefined;
  let size = 0;
  let identity: { dev: number; ino: number } | undefined;
  let failure: Error | undefined;
  /** sessionId -> toolCallId -> decision / tool name. Dropped by `endSession`. */
  const decisions = new Map<string, Map<string, "allow" | "reject" | "cancel">>();
  const names = new Map<string, Map<string, string>>();
  /** sessionId -> toolCallId -> the digest of the arguments as last delivered (a `tool_call` or a nonterminal update). */
  const digests = new Map<string, Map<string, ReturnType<typeof digestOf>>>();
  /** sessionId -> the context its last frame came with: what a decision record needs to name its session. */
  const contexts = new Map<string, AuditFrameContext>();

  const fail = (error: unknown): never => {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the log is already failed */
      }
      fd = undefined;
    }
    // Our own message or a bare error code: nothing from a frame is in it.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const reason = code === undefined && error instanceof Error ? error.message : `error ${code ?? "unknown"}`;
    failure = new Error(`audit log write failed (${reason}); the plugin's sessions are no longer approved`);
    throw failure;
  };

  const openFile = (): void => {
    ensureAuditDir(path.dirname(target));
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error("refusing a linked audit file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const handle = openSync(target, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      fchmodSync(handle, 0o600);
      const st = fstatSync(handle);
      if (!st.isFile()) throw new Error("the audit file is not a regular file");
      size = st.size;
      // A tail without a newline (a torn write, a crash) would swallow the next record into one unreadable line:
      // delimit it first, so every record this log accepts is a line of its own. A failure here fails the log.
      if (size > 0) {
        const last = Buffer.alloc(1);
        if (readSync(handle, last, 0, 1, size - 1) !== 1) throw new Error("the audit file tail could not be read");
        if (last[0] !== 0x0a) {
          if (writeSync(handle, "\n") !== 1) throw new Error("the audit file tail could not be delimited");
          size += 1;
        }
      }
      identity = { dev: st.dev, ino: st.ino };
    } catch (error) {
      closeSync(handle);
      throw error;
    }
    fd = handle;
  };

  /** The open file must still be the file at `target`: a removed or replaced log would swallow lines unseen. */
  const stillThere = (): void => {
    const st = lstatSync(target);
    if (!st.isFile() || st.dev !== identity?.dev || st.ino !== identity?.ino) throw new Error("the audit file was replaced or removed");
  };

  const rotate = (): void => {
    closeSync(fd!);
    fd = undefined;
    renameSync(target, rotated);
    openFile();
  };

  const writeLine = (line: string): void => {
    if (failure) throw failure;
    try {
      if (fd === undefined) openFile();
      else stillThere();
      const bytes = Buffer.from(line, "utf8");
      if (size > 0 && size + bytes.length > maxBytes) rotate();
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd!, bytes, offset);
      size += bytes.length;
    } catch (error) {
      fail(error);
    }
  };

  /** The record as written: a fixed list of fields, each bounded, so nothing else a caller passes can land in the file. */
  const normalized = (r: AuditRecord): AuditRecord => {
    const trigger: AuditTrigger | undefined = r.trigger === undefined ? undefined : r.trigger.kind === "browser" ? { kind: "browser", browserKeyId: clean(String(r.trigger.browserKeyId)) } : { kind: "headless" };
    const digest = r.argsSha256 !== undefined && r.argsBytes !== undefined ? { argsSha256: clean(String(r.argsSha256)), argsBytes: Number(r.argsBytes) } : undefined;
    return {
      time: r.time,
      ...(r.appId !== undefined ? { appId: clean(r.appId) } : {}),
      pluginId: clean(r.pluginId),
      sessionId: clean(r.sessionId),
      ...(trigger !== undefined ? { trigger } : {}),
      ...(r.servers !== undefined ? { servers: r.servers.slice(0, MAX_SERVERS).map((s) => clean(String(s))) } : {}),
      toolCallId: clean(r.toolCallId),
      ...(r.toolName !== undefined ? { toolName: clean(r.toolName) } : {}),
      ...(r.status !== undefined && STATUSES.has(r.status) ? { status: r.status } : {}),
      ...(r.decision !== undefined ? { decision: r.decision } : {}),
      ...digest,
    };
  };

  const append = (r: AuditRecord): void => {
    if (failure) throw failure;
    let line: string;
    try {
      line = `${JSON.stringify(normalized(r))}\n`;
    } catch (error) {
      return fail(error); // a record that cannot be written is an unaudited call
    }
    writeLine(line);
  };

  return {
    get failed(): boolean {
      return failure !== undefined;
    },
    append,
    recordFrame(frame: JsonRpcMessage, context: AuditFrameContext): void {
      const update = updateOf(frame);
      if (!update) return;
      const kind = update.sessionUpdate;
      const status = typeof update.status === "string" ? update.status : undefined;
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
      // The adapter may deliver the arguments in the `tool_call` or in a later update (not a record of its own):
      // the digest of the last ones seen is what the terminal record carries, unless it brings its own.
      let digest = kind === "tool_call" || kind === "tool_call_update" ? digestOf(update.rawInput) : undefined;
      if (digest !== undefined) {
        if (!digests.has(context.sessionId)) digests.set(context.sessionId, new Map());
        digests.get(context.sessionId)!.set(toolCallId, digest);
      } else {
        digest = digests.get(context.sessionId)?.get(toolCallId);
      }
      if (kind !== "tool_call" && !(kind === "tool_call_update" && (status === "completed" || status === "failed"))) return;
      contexts.set(context.sessionId, context);
      // The terminal update may not repeat the tool name: take the one its `tool_call` frame gave.
      let toolName = toolNameOf(update);
      if (toolName !== undefined) {
        if (!names.has(context.sessionId)) names.set(context.sessionId, new Map());
        names.get(context.sessionId)!.set(toolCallId, toolName);
      } else {
        toolName = names.get(context.sessionId)?.get(toolCallId);
      }
      append({
        time: new Date(now()).toISOString(),
        appId: context.appId,
        pluginId: context.pluginId,
        sessionId: context.sessionId,
        trigger: context.trigger,
        servers: context.servers,
        toolCallId,
        ...(toolName !== undefined ? { toolName } : {}),
        ...(kind === "tool_call" ? { status: status ?? "pending" } : { status: status! }),
        // A `tool_call` frame comes before its permission request: with no decision yet it says nothing, because
        // "none" means no request was made. Only a terminal record, written after the request would have come, says "none".
        ...decisionField(decisions.get(context.sessionId)?.get(toolCallId) ?? (kind === "tool_call" ? undefined : "none")),
        ...digest,
      });
    },
    recordDecision(sessionId: string, toolCallId: string, decision: "allow" | "reject" | "cancel"): void {
      if (!decisions.has(sessionId)) decisions.set(sessionId, new Map());
      decisions.get(sessionId)!.set(toolCallId, decision);
      // Written when it is made, so it reaches the file even if the session ends before the terminal update.
      // Before any frame of the session only the session, the call, the decision and the plugin (the log itself) are
      // known: the record carries those and no guess at the rest; the decision still joins the frame that follows.
      const known = contexts.get(sessionId);
      append({
        time: new Date(now()).toISOString(),
        ...(known ? { appId: known.appId } : {}),
        pluginId: known?.pluginId ?? pluginOfLog,
        sessionId,
        ...(known ? { trigger: known.trigger, servers: known.servers } : {}),
        toolCallId,
        ...(names.get(sessionId)?.get(toolCallId) !== undefined ? { toolName: names.get(sessionId)!.get(toolCallId)! } : {}),
        decision,
      });
    },
    endSession(sessionId: string): void {
      decisions.delete(sessionId);
      contexts.delete(sessionId);
      names.delete(sessionId);
      digests.delete(sessionId);
    },
  };
}

const decisionField = (decision: AuditRecord["decision"]): Pick<AuditRecord, "decision"> => (decision === undefined ? {} : { decision });

const isTrigger = (v: unknown): v is AuditTrigger => isObject(v) && (v.kind === "headless" || (v.kind === "browser" && typeof v.browserKeyId === "string"));

function asRecord(v: unknown): AuditRecord | undefined {
  if (!isObject(v)) return undefined;
  const { time, appId, pluginId, sessionId, trigger, servers, toolCallId } = v;
  if (typeof time !== "string" || typeof pluginId !== "string" || typeof sessionId !== "string" || typeof toolCallId !== "string") return undefined;
  // appId, trigger and servers are absent together on a decision written before its session's first frame.
  if (appId !== undefined && typeof appId !== "string") return undefined;
  if (trigger !== undefined && !isTrigger(trigger)) return undefined;
  if (servers !== undefined && (!Array.isArray(servers) || !servers.every((s) => typeof s === "string"))) return undefined;
  return v as unknown as AuditRecord;
}

/** The complete lines of `file`, oldest first; `[]` when it does not exist. A link is not followed. */
async function linesOf(file: string): Promise<string[]> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - READ_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // the first line of a tail is cut
    return lines.filter((l) => l.length > 0);
  } finally {
    await handle.close();
  }
}

/**
 * The most recent `limit` records of an audit file and its rotated `.1`, oldest first. A line that is not a
 * record (a torn write, a hand edit) is skipped. A missing file is no records.
 */
export async function readAudit(file: string, options: { limit: number }): Promise<AuditRecord[]> {
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new RangeError("limit must be a positive integer");
  const out: AuditRecord[] = [];
  for (const source of [`${file}.1`, file]) {
    for (const line of await linesOf(source)) {
      try {
        const parsed = asRecord(JSON.parse(line));
        if (parsed) out.push(parsed);
      } catch {
        /* skipped */
      }
    }
  }
  return out.slice(-options.limit);
}
