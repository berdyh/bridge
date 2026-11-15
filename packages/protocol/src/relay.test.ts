import { describe, expect, it } from "vitest";
import {
  type RunnerHello,
  HOSTNAME_MAX_LENGTH,
  SESSION_CLOSE_REASONS,
  bearerSubprotocol,
  boundedHostname,
  isAckFrame,
  isE2EEFrame,
  isFrameBody,
  isJsonRpcMessage,
  isEnrolledAs,
  isPakeMessage,
  isPlainFrame,
  isRelayEnvelope,
  isRunnerHello,
  isServerWelcome,
  RELAY_CLOSE_REPLACED,
  RELAY_CLOSE_REVOKED,
  parseExtensionMethod,
  relayEndpoint,
  selectProtocolVersion,
  tokenFromSubprotocols,
} from "./index.js";

describe("relay close codes", () => {
  it("are distinct application codes", () => expect([RELAY_CLOSE_REPLACED, RELAY_CLOSE_REVOKED]).toEqual([4409, 4401]));
});

describe("relay envelope", () => {
  const env = { to: "runner", runnerId: "r1", browserKeyId: "k1", kind: "frame", body: "not json {" };
  it("checks only the header; the body may be anything", () => {
    expect(isRelayEnvelope(env)).toBe(true);
    expect(isRelayEnvelope({ ...env, body: 42 })).toBe(true);
    expect(isRelayEnvelope({ ...env, to: "server" })).toBe(false);
    expect(isRelayEnvelope({ ...env, kind: "other" })).toBe(false);
    expect(isRelayEnvelope({ ...env, runnerId: "" })).toBe(false);
    const { body: _b, ...noBody } = env;
    expect(isRelayEnvelope(noBody)).toBe(false);
    expect(isRelayEnvelope(null)).toBe(false);
  });

  it("builds socket URLs under the discovery relay base", () => {
    expect(relayEndpoint("wss://app.example.com/relay", "runner", "r 1")).toBe("wss://app.example.com/relay/runner?runnerId=r+1");
    expect(relayEndpoint("wss://app.example.com/relay/", "browser", "k1")).toBe("wss://app.example.com/relay/browser?browserKeyId=k1");
  });

  it("round-trips the bearer token through the subprotocol header", () => {
    const header = `bridge.v1, ${bearerSubprotocol("abc.def-ghi_jkl")}`;
    expect(tokenFromSubprotocols(header)).toBe("abc.def-ghi_jkl");
    expect(tokenFromSubprotocols("bridge.v1")).toBeUndefined();
    expect(tokenFromSubprotocols(null)).toBeUndefined();
  });
});

describe("frames", () => {
  const e2ee = { v: 1, kid: "kid_1", seq: 1, nonce: "AAAAAAAAAAAAAAAA", ct: "Zm9v" };
  it("validates the three frame bodies", () => {
    expect(isE2EEFrame(e2ee)).toBe(true);
    expect(isE2EEFrame({ ...e2ee, seq: 0 })).toBe(false);
    expect(isE2EEFrame({ ...e2ee, ct: "a+b/" })).toBe(false);
    expect(isE2EEFrame({ ...e2ee, v: 2 })).toBe(false);
    const plain = { v: 1, kid: "Zq3-x_9aBcDeFgHiJkLmNw", seq: 3, msg: { jsonrpc: "2.0", method: "x" } };
    expect(isPlainFrame(plain)).toBe(true);
    expect(isPlainFrame({ ...plain, kid: "plain" })).toBe(true); // any base64url kid; plaintext is told apart by `msg`
    expect(isPlainFrame({ ...plain, msg: { method: "x" } })).toBe(false);
    expect(isPlainFrame({ ...plain, kid: "no spaces" })).toBe(false);
    expect(isPlainFrame(e2ee)).toBe(false); // an encrypted frame has nonce and ct, no msg
    expect(isE2EEFrame(plain)).toBe(false);
    expect(isE2EEFrame({ ...e2ee, kid: "plain" })).toBe(true); // "plain" is no longer special
    expect(isAckFrame({ v: 1, kid: "kid_1", ack: 0 })).toBe(true);
    expect(isAckFrame({ v: 1, kid: "kid_1", ack: 4, seq: 1 })).toBe(false);
    expect(isFrameBody(e2ee) && isFrameBody(plain)).toBe(true);
    expect(isFrameBody({})).toBe(false);
  });
});

describe("pake messages", () => {
  const sealed = { nonce: "AAAA", ct: "BBBB" };
  it("validates each message", () => {
    expect(isPakeMessage({ t: "pake/start", v: 1, enrollId: "e1", msg: "AAAA" })).toBe(true);
    expect(isPakeMessage({ t: "pake/reply", v: 1, enrollId: "e1", codeId: "c1", msg: "AAAA", mac: "BBBB", sealed })).toBe(true);
    expect(isPakeMessage({ t: "pake/confirm", v: 1, enrollId: "e1", codeId: "c1", mac: "BBBB", sealed })).toBe(true);
    expect(isPakeMessage({ t: "pake/done", v: 1, enrollId: "e1", ok: true, browserKeyId: "k1" })).toBe(true);
    expect(isPakeMessage({ t: "session/close", v: 1 })).toBe(true);
    expect(isPakeMessage({ t: "session/close", v: 1, kid: "kid_1", reason: "superseded" })).toBe(true);
    expect(isPakeMessage({ t: "session/close", v: 1, kid: "kid_1", reason: "not_trusted" })).toBe(true);
    expect(isPakeMessage({ t: "session/close", v: 1, reason: "because" })).toBe(false);
    expect(isPakeMessage({ t: "session/close", v: 1, kid: "" })).toBe(false);
    expect(isPakeMessage({ t: "pake/done", v: 1, enrollId: "e1", ok: false, reason: "bad_code", attemptsLeft: 4, expiresAt: "2026-10-14T00:10:00Z" })).toBe(true);
    expect(isPakeMessage({ t: "session/init", v: 1, sid: "BBBB", eph: "AAAA" })).toBe(true);
    expect(isPakeMessage({ t: "session/init", v: 1, eph: "AAAA" })).toBe(false);
    expect(isPakeMessage({ t: "session/close", v: 1, sid: "BBBB" })).toBe(true);
    expect(isPakeMessage({ t: "session/accept", v: 1, sid: "BBBB", eph: "AAAA" })).toBe(true);
  });
  it("validates the optional proof of an accepted pake/done", () => {
    const done = { t: "pake/done", v: 1, enrollId: "e1", ok: true, browserKeyId: "k1" };
    expect(isPakeMessage({ ...done, proof: sealed })).toBe(true);
    expect(isPakeMessage({ ...done, proof: { nonce: "AAAA" } })).toBe(false);
    expect(isPakeMessage({ ...done, proof: { nonce: "AAAA", ct: "not base64url!" } })).toBe(false);
    expect(isPakeMessage({ ...done, proof: "enrolled" })).toBe(false);
  });
  it("checks the enrolled identity against the reported key id, not the pre-enrollment id", () => {
    const done = { t: "pake/done", v: 1, enrollId: "random_pre_enrollment_id", ok: true, browserKeyId: "derived_key_id" } as const;
    expect(isEnrolledAs(done, "derived_key_id")).toBe(true);
    // The transport's current id is the random enrollId: it must never count as a match.
    expect(isEnrolledAs(done, "random_pre_enrollment_id")).toBe(false);
    expect(isEnrolledAs({ ...done, browserKeyId: undefined }, "derived_key_id")).toBe(false);
    expect(isEnrolledAs({ t: "pake/done", v: 1, enrollId: "e", ok: false, reason: "bad_code", browserKeyId: "derived_key_id" }, "derived_key_id")).toBe(false);
  });
  it("rejects malformed ones", () => {
    expect(isPakeMessage({ t: "pake/done", v: 1, enrollId: "e1", ok: false })).toBe(false); // failure needs a reason
    expect(isPakeMessage({ t: "pake/start", v: 1, enrollId: "e1" })).toBe(false);
    expect(isPakeMessage({ t: "pake/reply", v: 1, enrollId: "e1", codeId: "c1", msg: "AAAA", mac: "BBBB", sealed: {} })).toBe(false);
    expect(isPakeMessage({ t: "pake/start", v: 2, enrollId: "e1", msg: "AAAA" })).toBe(false);
    expect(isPakeMessage({ t: "nope", v: 1 })).toBe(false);
  });
});

describe("handshake", () => {
  const hello: RunnerHello = { type: "hello", runnerId: "r1", runnerVersion: "0.1.0", protocol: { min: 1, max: 2 } };
  it("validates hello and welcome", () => {
    expect(isRunnerHello(hello)).toBe(true);
    expect(isRunnerHello({ ...hello, agents: [{ id: "claude", available: true }] })).toBe(true);
    expect(isRunnerHello({ ...hello, agents: [{ id: "claude" }] })).toBe(false);
    expect(isRunnerHello({ ...hello, protocol: { min: 3, max: 2 } })).toBe(false);
    expect(isRunnerHello({ ...hello, type: "welcome" })).toBe(false);
    expect(isServerWelcome({ type: "welcome", protocol: 1 })).toBe(true);
    expect(isServerWelcome({ type: "welcome" })).toBe(false);
  });
  it("accepts a hello whose hostname is unusable; the relay then drops the name", () => {
    for (const hostname of ["bad\nname", "x".repeat(HOSTNAME_MAX_LENGTH + 1), ""]) {
      expect(isRunnerHello({ ...hello, hostname })).toBe(true);
      expect(boundedHostname(hostname)).toBeUndefined();
    }
  });
  it("bounds a hostname to printable text of at most 255 characters", () => {
    expect(boundedHostname("my-laptop.local")).toBe("my-laptop.local");
    expect(boundedHostname("Büro Rechner 🖥")).toBe("Büro Rechner 🖥");
    expect(boundedHostname("x".repeat(255))).toBe("x".repeat(255));
    expect(boundedHostname("x".repeat(256))).toBeUndefined();
    for (const bad of ["", "a\u0000b", "a\tb", "a\x7fb", "a\u0085b", "a\u009fb", "a\u2028b", "a\u2029b", "\u001b[31m"]) {
      expect(boundedHostname(bad)).toBeUndefined();
    }
    expect(boundedHostname(undefined)).toBeUndefined();
    expect(boundedHostname(42)).toBeUndefined();
  });
  it("lists not_trusted among the session close reasons", () => {
    expect(SESSION_CLOSE_REASONS).toContain("not_trusted");
  });
  it("selects the highest shared version", () => {
    expect(selectProtocolVersion({ min: 1, max: 3 }, { min: 2, max: 5 })).toBe(3);
    expect(selectProtocolVersion({ min: 1, max: 1 }, { min: 2, max: 2 })).toBeUndefined();
    expect(selectProtocolVersion({ min: 2, max: 4 }, { min: 1, max: 2 })).toBe(2);
  });
});

describe("json-rpc helpers", () => {
  it("recognises messages", () => {
    expect(isJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(true);
    expect(isJsonRpcMessage({ id: 1 })).toBe(false);
    expect(isJsonRpcMessage([])).toBe(false);
  });
  it("parses extension methods and reserves _bridge", () => {
    expect(parseExtensionMethod("_app-a.mail-sync/sync")).toEqual({ pluginId: "app-a.mail-sync", name: "sync" });
    expect(parseExtensionMethod("_sample/echo")).toEqual({ pluginId: "sample", name: "echo" });
    expect(parseExtensionMethod("_bridge/localUi")).toBeUndefined();
    expect(parseExtensionMethod("session/new")).toBeUndefined();
    expect(parseExtensionMethod("_/x")).toBeUndefined();
    expect(parseExtensionMethod("_sample")).toBeUndefined();
  });
});
