import { describe, expect, it } from "vitest";

import { findPlaintextViolations } from "./blindness.js";

const envelope = (kind: string, body: unknown) => JSON.stringify({ to: "runner", runnerId: "r1", browserKeyId: "AAAAAAAAAAAAAAAAAAAAAA", kind, body });

describe("findPlaintextViolations", () => {
  it.each([undefined, "workstation.local", "Büro Rechner 🖥", "x".repeat(255)])("passes presence with optional bounded hostname %j", (hostname) => {
    expect(findPlaintextViolations([envelope("presence", { runnerId: "r1", online: true, hostname })])).toEqual([]);
  });

  it.each(["", "x".repeat(256), null, 42, {}, [], "host\u0000name", "host\nname", "host\u007fname", "host\u0085name", "host\u2028name", "host\u2029name"])("fails presence with invalid hostname %j", (hostname) => {
    expect(findPlaintextViolations([envelope("presence", { runnerId: "r1", online: true, hostname })])).toHaveLength(1);
  });

  it("still fails extra presence fields and JSON-RPC smuggled in a bounded hostname", () => {
    expect(findPlaintextViolations([envelope("presence", { runnerId: "r1", online: true, hostname: "workstation", secret: "plaintext" })])).toHaveLength(1);
    for (const hostname of [JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), JSON.stringify({ result: { secret: "plaintext" } })]) {
      expect(findPlaintextViolations([envelope("presence", { runnerId: "r1", online: true, hostname })])).toHaveLength(1);
    }
  });

  it("fails a plaintext initialize response, in a plain frame or smuggled into an encrypted one", () => {
    const rpc = { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } };
    expect(findPlaintextViolations([envelope("frame", { v: 1, kid: "abc", seq: 1, msg: rpc })])).toHaveLength(1);
    expect(findPlaintextViolations([envelope("frame", { v: 1, kid: "abc", seq: 1, nonce: "AAAA", ct: "BBBB", msg: rpc })])).toHaveLength(1);
    expect(findPlaintextViolations([JSON.stringify(rpc)])).toHaveLength(1);
    expect(findPlaintextViolations([envelope("presence", { runnerId: "r1", online: true, agents: [{ id: "x", available: true, result: {} }] })])).toHaveLength(1);
    expect(findPlaintextViolations(["not json"])).toHaveLength(1);
  });

  it("fails JSON-RPC smuggled in string values", () => {
    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
    const hello = { type: "hello", runnerId: "r1", runnerVersion: "0.1.0", protocol: { min: 1, max: 1 } };
    expect(findPlaintextViolations([envelope("control", { type: "error", code: "bad_envelope", message: rpc })])).toHaveLength(1);
    expect(findPlaintextViolations([envelope("presence", { runnerId: "r1", online: true, agents: [{ id: "x", available: true, version: rpc }] })])).toHaveLength(1);
    expect(findPlaintextViolations([JSON.stringify({ ...hello, hostname: rpc })])).toHaveLength(1);
    expect(findPlaintextViolations([JSON.stringify({ ...hello, hostname: 'x "jsonrpc" y' })])).toHaveLength(1);
  });

  it("fails double-serialized and escaped JSON-RPC in a string", () => {
    const twice = JSON.stringify(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { secret: "x" } }));
    expect(findPlaintextViolations([envelope("control", { type: "error", code: "bad_envelope", message: twice })])).toHaveLength(1);
    const noJsonrpcKey = JSON.stringify(JSON.stringify({ id: 1, result: { secret: "x" } }));
    expect(findPlaintextViolations([envelope("control", { type: "error", code: "bad_envelope", message: noJsonrpcKey })])).toHaveLength(1);
  });

  it("fails malformed shapes the field allowlist alone would pass", () => {
    const hello = { type: "hello", runnerId: "r1", runnerVersion: "0.1.0", protocol: { min: 1, max: 1 } };
    const bad = [
      JSON.stringify({ ...hello, protocol: {} }),
      JSON.stringify({ type: "welcome" }),
      JSON.stringify({ kind: "control", body: { type: "revoked", runnerId: "r1" } }),
      JSON.stringify({ kind: "presence", body: { runnerId: "r1", online: true } }),
      envelope("frame", { v: 1, kid: "abc", seq: -1, nonce: "AAAA", ct: "BBBB" }),
      envelope("frame", { v: 1, kid: "abc", ack: -1 }),
      envelope("pake", { t: "pake/done", v: 1, enrollId: "AAAA", ok: false, reason: "because" }),
      envelope("pake", { t: "session/close", v: 1, reason: "whatever" }),
    ];
    for (const m of bad) expect(findPlaintextViolations([m]), m).toHaveLength(1);
  });

  it("passes encrypted frames, acks, pake messages, presence, control and heartbeats", () => {
    const ok = [
      envelope("frame", { v: 1, kid: "abc_-", seq: 3, nonce: "AAAAAAAAAAAAAAAA", ct: "Zm9vYmFy" }),
      envelope("frame", { v: 1, kid: "abc", ack: 3 }),
      envelope("pake", { t: "pake/start", v: 1, enrollId: "AAAAAAAAAAAAAAAAAAAAAA", msg: "Zm9v" }),
      envelope("pake", { t: "pake/done", v: 1, enrollId: "AAAA", ok: true, browserKeyId: "BBBB", proof: { nonce: "AA", ct: "BB" } }),
      envelope("presence", { runnerId: "r1", online: true, agents: [{ id: "claude", available: true }] }),
      envelope("control", { type: "peer_gone", peer: "runner", runnerId: "r1" }),
      JSON.stringify({ type: "hello", runnerId: "r1", runnerVersion: "0.1.0", protocol: { min: 1, max: 1 }, agents: [{ id: "stub", available: true }] }),
      JSON.stringify({ type: "welcome", protocol: 1 }),
      "bridge:ping",
      "bridge:pong",
    ];
    expect(findPlaintextViolations(ok)).toEqual([]);
  });
});
