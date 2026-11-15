import { expect } from "vitest";

/** Assert privacy at the socket boundary, including public handshake frames. */
export function assertWirePrivacy(text: string, secret: string): void {
  expect(text).not.toContain(secret);
  expect(text).not.toContain('"method":"session/prompt"');
  expect(text).not.toContain('"method":"_sample/echo"');
  // SPAKE2's public messages travel in cleartext. Only the top-level relay
  // kind grants this exception; a nested kind must not hide a plaintext frame.
  const parsed = text.startsWith("{") ? JSON.parse(text) : undefined;
  if (parsed?.kind !== "pake") expect(text).not.toContain('"msg":');
  // Even there, `msg` is an opaque base64url SPAKE2 point and must not carry JSON-RPC. The
  // encoded text is never searched for "jsonrpc" (a random point can spell it); the raw
  // value is parsed as JSON, and the decoded bytes are searched and parsed as UTF-8 text.
  const msg = parsed?.body?.msg;
  if (typeof msg === "string") expect(msgJsonRpc(msg)).toBeUndefined();
  else expect(findJsonRpc(msg, "pake msg")).toBeUndefined();
  const rest = parsed?.kind === "pake" && parsed.body && typeof parsed.body === "object" ? { ...parsed, body: { ...parsed.body, msg: undefined } } : parsed;
  expect(rest === undefined ? text : JSON.stringify(rest)).not.toMatch(/jsonrpc/i);
}

function msgJsonRpc(msg: string): string | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(msg)) return "pake msg is not base64url";
  try { return findJsonRpc(JSON.parse(msg), "pake msg<raw json>"); } catch { /* not JSON, as expected */ }
  return findJsonRpc(Buffer.from(msg, "base64url").toString("utf8"), "pake msg<decoded>");
}

const JSONRPC_KEYS = ["jsonrpc", "method", "params", "result", "error"];

/** A value that is, parses as, or embeds a JSON-RPC shape (jsonrpc/method/params/result/error, also when double-serialized). */
function findJsonRpc(value: unknown, where: string, depth = 0): string | undefined {
  if (depth > 8) return `${where}: nested deeper than 8 levels`;
  if (typeof value === "string") {
    if (/jsonrpc/i.test(value)) return `${where}: mentions jsonrpc`;
    try { return findJsonRpc(JSON.parse(value), `${where}<json>`, depth + 1); } catch { return undefined; }
  }
  if (Array.isArray(value)) return value.map((v, i) => findJsonRpc(v, `${where}[${i}]`, depth + 1)).find(Boolean);
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    const key = JSONRPC_KEYS.find((k) => keys.includes(k));
    if (key) return `${where}.${key}`;
    for (const k of keys) {
      const hit = findJsonRpc((value as Record<string, unknown>)[k], `${where}.${k}`, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}
