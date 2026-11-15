import { expect, it } from "vitest";
import { assertWirePrivacy } from "./wire-privacy.js";

const secret = "CF_E2EE_PRIVATE_PROMPT_7f025d";
const start = { t: "pake/start", v: 1, enrollId: "enrollment", msg: "public-spake2-message" };
const reply = { t: "pake/reply", v: 1, enrollId: "enrollment", codeId: "code", msg: "public-spake2-reply",
  mac: "confirmation-mac", sealed: { nonce: "nonce", ct: "ciphertext" } };

it.each([start, reply])("allows public $t messages at the socket boundary", (body) => {
  expect(() => assertWirePrivacy(JSON.stringify({ kind: "pake", body }), secret)).not.toThrow();
});

it.each(["bridge:ping", "bridge:pong", JSON.stringify({ kind: "frame", body: { ct: "ciphertext" } })])(
  "allows heartbeat and encrypted frames: %s", (text) => {
    expect(() => assertWirePrivacy(text, secret)).not.toThrow();
  },
);

it.each([
  { kind: "frame", body: { msg: { jsonrpc: "2.0", method: "initialize" } } },
  { kind: "control", body: { msg: "plaintext" } },
  { kind: "frame", body: { kind: "pake", msg: "plaintext" } },
])("rejects plaintext msg in non-pake envelopes: %j", (envelope) => {
  expect(() => assertWirePrivacy(JSON.stringify(envelope), secret)).toThrow();
});

it.each([
  { ...start, msg: secret },
  { ...start, method: "session/prompt" },
  { ...start, method: "_sample/echo" },
])("still rejects private content in pake envelopes: %j", (body) => {
  expect(() => assertWirePrivacy(JSON.stringify({ kind: "pake", body }), secret)).toThrow();
});

it.each([
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }),
  JSON.stringify({ id: 1, method: "session/new" }),
  JSON.stringify({ id: 2, result: { ok: true } }),
  JSON.stringify(JSON.stringify({ id: 3, params: { prompt: "x" } })),
  '{"JSONRPC":"2.0"}',
  "carries jsonrpc text",
  Buffer.from('{"method":"session/new"}'.padEnd(32, " ")).toString("base64url"),
  Buffer.from('{"jsonrpc":"2.0"}').toString("base64url"),
  { jsonrpc: "2.0", method: "initialize" },
  { id: 1, params: { cwd: "/" } },
])("rejects JSON-RPC smuggled inside a pake msg: %j", (msg) => {
  for (const t of ["pake/start", "pake/reply"]) {
    const body = { ...(t === "pake/start" ? start : reply), t, msg };
    expect(() => assertWirePrivacy(JSON.stringify({ kind: "pake", body }), secret)).toThrow();
  }
});

it("does not flag a legitimate SPAKE2 point that happens to spell jsonrpc", () => {
  const msg = "jsonrpcloenkHFH0wjcZfgoZqUHMd1-FmuZm9LHNYYc";
  for (const body of [{ ...start, msg }, { ...reply, msg }]) {
    expect(() => assertWirePrivacy(JSON.stringify({ kind: "pake", body }), secret)).not.toThrow();
  }
});
