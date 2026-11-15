/**
 * Structural relay-blindness check. Every text message the relay received, forwarded or sent must be
 * a known envelope kind whose body carries only the fields the protocol defines for it, and nothing
 * anywhere may look like JSON-RPC. Searching for chosen strings would pass a plaintext message that
 * simply avoids them.
 */

import { RELAY_ERROR_CODES, boundedHostname, isAckFrame, isE2EEFrame, isPakeMessage, isRelayEnvelope, isRunnerHello, isServerWelcome } from "@berdyh/bridge-protocol";

const HEARTBEATS = new Set(["bridge:ping", "bridge:pong"]);
const JSONRPC_KEYS = ["jsonrpc", "method", "params", "result", "error"];
const B64URL = /^[A-Za-z0-9_-]+$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isB64 = (v: unknown): boolean => typeof v === "string" && B64URL.test(v);
const isStr = (v: unknown): boolean => typeof v === "string" && v.length > 0;
const isInt = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v);
const isSealed = (v: unknown): boolean => isObj(v) && onlyKeys(v, ["nonce", "ct"]) && isB64(v.nonce) && isB64(v.ct);

function onlyKeys(o: Obj, allowed: string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

/** Any object at any depth with a JSON-RPC looking key, or any string value that is or embeds one. */
function findJsonRpc(v: unknown, path: string, depth = 0): string | undefined {
  if (depth > 8) return `${path} (nested deeper than 8 levels)`;
  if (typeof v === "string") {
    if (/jsonrpc/i.test(v)) return `${path} (string mentions jsonrpc)`;
    let inner: unknown;
    try {
      inner = JSON.parse(v);
    } catch {
      return undefined;
    }
    // Decoded objects, arrays and strings (double-serialized JSON) are scanned again.
    return typeof inner === "object" && inner !== null ? findJsonRpc(inner, `${path}<json>`, depth + 1) : typeof inner === "string" ? findJsonRpc(inner, `${path}<json>`, depth + 1) : undefined;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = findJsonRpc(v[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
  } else if (isObj(v)) {
    for (const k of JSONRPC_KEYS) if (k in v) return `${path}.${k}`;
    for (const [k, child] of Object.entries(v)) {
      const hit = findJsonRpc(child, `${path}.${k}`, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

function checkFrameBody(b: unknown): string | undefined {
  if (!isObj(b) || b.v !== 1) return "frame body is not a v1 object";
  if (!isE2EEFrame(b) && !isAckFrame(b)) return "frame body is neither an E2EE frame nor an ack (protocol guards)";
  if ("ack" in b) return onlyKeys(b, ["v", "kid", "ack"]) && isStr(b.kid) && isInt(b.ack) ? undefined : "malformed ack frame";
  if ("msg" in b) return "plain frame (carries msg)";
  if (!onlyKeys(b, ["v", "kid", "seq", "nonce", "ct"])) return `E2EE frame has extra fields: ${Object.keys(b).join(",")}`;
  return isB64(b.kid) && isInt(b.seq) && isB64(b.nonce) && isB64(b.ct) ? undefined : "malformed E2EE frame";
}

function checkPakeBody(b: unknown): string | undefined {
  if (!isObj(b) || b.v !== 1 || typeof b.t !== "string") return "pake body is not a v1 typed object";
  if (!isPakeMessage(b)) return `pake body fails the protocol guard (${b.t})`;
  const ok = (keys: string[], valid: boolean) => (onlyKeys(b, ["t", "v", ...keys]) && valid ? undefined : `malformed ${b.t}`);
  switch (b.t) {
    case "pake/start":
      return ok(["enrollId", "msg"], isB64(b.enrollId) && isB64(b.msg));
    case "pake/reply":
      return ok(["enrollId", "codeId", "msg", "mac", "sealed"], isB64(b.enrollId) && isStr(b.codeId) && isB64(b.msg) && isB64(b.mac) && isSealed(b.sealed));
    case "pake/confirm":
      return ok(["enrollId", "codeId", "mac", "sealed"], isB64(b.enrollId) && isStr(b.codeId) && isB64(b.mac) && isSealed(b.sealed));
    case "pake/done":
      return ok(
        ["enrollId", "codeId", "ok", "reason", "attemptsLeft", "expiresAt", "browserKeyId", "proof"],
        isB64(b.enrollId) && typeof b.ok === "boolean" && (b.proof === undefined || isSealed(b.proof)),
      );
    case "session/init":
    case "session/accept":
      return ok(["sid", "eph"], isB64(b.sid) && isB64(b.eph));
    case "session/close":
      return ok(["kid", "sid", "reason"], true);
    default:
      return `unknown pake type ${String((b as Obj).t)}`;
  }
}

const optStr = (v: unknown): boolean => v === undefined || typeof v === "string";

function checkAgents(agents: unknown): boolean {
  return agents === undefined || (Array.isArray(agents) && agents.every((a) => isObj(a) && onlyKeys(a, ["id", "available", "version"]) && isStr(a.id) && typeof a.available === "boolean" && optStr(a.version)));
}

function checkPresenceBody(b: unknown): string | undefined {
  if (!isObj(b) || !onlyKeys(b, ["runnerId", "online", "lastSeen", "runnerVersion", "agents", "hostname"])) return "malformed presence body";
  if (!isStr(b.runnerId) || typeof b.online !== "boolean" || !optStr(b.lastSeen) || !optStr(b.runnerVersion) || !checkAgents(b.agents)) return "malformed presence body";
  if (b.hostname !== undefined && boundedHostname(b.hostname) === undefined) return "malformed presence hostname";
  return undefined;
}

function checkControlBody(b: unknown): string | undefined {
  if (!isObj(b) || typeof b.type !== "string") return "malformed control body";
  const bad = `unknown or malformed control body ${b.type}`;
  const role = (v: unknown) => v === "runner" || v === "browser";
  switch (b.type) {
    case "update_required":
      return onlyKeys(b, ["type", "server", "latestRunnerVersion", "message"]) && isObj(b.server) && onlyKeys(b.server, ["min", "max"]) && isInt(b.server.min) && isInt(b.server.max) && optStr(b.latestRunnerVersion) && optStr(b.message) ? undefined : bad;
    case "peer_reconnected":
    case "peer_gone":
      return onlyKeys(b, ["type", "peer", "runnerId", "browserKeyId"]) && role(b.peer) && isStr(b.runnerId) && optStr(b.browserKeyId) ? undefined : bad;
    case "revoked":
      return onlyKeys(b, ["type", "runnerId"]) && isStr(b.runnerId) ? undefined : bad;
    case "error":
      return onlyKeys(b, ["type", "code", "message"]) && (RELAY_ERROR_CODES as readonly unknown[]).includes(b.code) && optStr(b.message) ? undefined : bad;
    default:
      return bad;
  }
}

function checkEnvelope(o: Obj): string | undefined {
  if (!isRelayEnvelope(o)) return "not a relay envelope (protocol guard)";
  if (!onlyKeys(o, ["to", "runnerId", "browserKeyId", "kind", "body"])) return `envelope has extra fields: ${Object.keys(o).join(",")}`;
  switch (o.kind) {
    case "frame":
      return checkFrameBody(o.body);
    case "pake":
      return checkPakeBody(o.body);
    case "presence":
      return checkPresenceBody(o.body);
    case "control":
      return checkControlBody(o.body);
    default:
      return `unknown envelope kind ${String(o.kind)}`;
  }
}

function checkHello(o: Obj): string | undefined {
  if (!isRunnerHello(o)) return "hello fails the protocol guard";
  if (!onlyKeys(o, ["type", "runnerId", "runnerVersion", "protocol", "hostname", "os", "agents"])) return "hello has extra fields";
  if (!isObj(o.protocol) || !onlyKeys(o.protocol, ["min", "max"])) return "hello protocol malformed";
  if (!optStr(o.hostname) || !optStr(o.os)) return "hello hostname/os malformed";
  return checkAgents(o.agents) ? undefined : "hello agents malformed";
}

/** Returns one violation message per offending capture; empty when every message is clean. */
export function findPlaintextViolations(messages: readonly string[]): string[] {
  const out: string[] = [];
  messages.forEach((raw, i) => {
    const at = (why: string) => out.push(`message ${i}: ${why}: ${raw.slice(0, 120)}`);
    if (HEARTBEATS.has(raw)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return at("unparseable text");
    }
    if (!isObj(parsed)) return at("not a JSON object");
    const bad = parsed.type === "hello" ? checkHello(parsed) : parsed.type === "welcome" ? (isServerWelcome(parsed) && onlyKeys(parsed, ["type", "protocol"]) ? undefined : "malformed welcome") : checkEnvelope(parsed);
    if (bad) return at(bad);
    const rpc = findJsonRpc(parsed, "$");
    if (rpc) at(`JSON-RPC shaped field at ${rpc}`);
  });
  return out;
}
