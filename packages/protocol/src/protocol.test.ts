import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  USER_CODE_ALPHABET,
  formatUserCode,
  generateUserCode,
  isAgentAvailability,
  isDeviceAuthorizationResponse,
  isDeviceErrorResponse,
  isDeviceRecord,
  isDeviceTokenResponse,
  isProtocolCompatible,
  isValidUserCode,
  normalizeUserCode,
} from "./index.js";

describe("version", () => {
  it("checks compatibility", () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe(true);
    expect(isProtocolCompatible(0, 1, 3)).toBe(false);
    expect(isProtocolCompatible(2, 1, 3)).toBe(true);
    expect(isProtocolCompatible(4, 1, 3)).toBe(false);
    expect(isProtocolCompatible(1.5)).toBe(false);
  });
});

describe("user code", () => {
  it("alphabet is 20 unique consonants", () => {
    expect(USER_CODE_ALPHABET).toHaveLength(20);
    expect(new Set(USER_CODE_ALPHABET).size).toBe(20);
    expect(USER_CODE_ALPHABET).not.toMatch(/[AEIOUY01I]/);
  });
  it("generates from injected randomness, deterministic", () => {
    const code = generateUserCode((n) => new Uint8Array(n).map((_, i) => i));
    expect(code).toBe("BCDFGHJK");
  });
  it("rejects biased bytes", () => {
    let call = 0;
    const code = generateUserCode((n) => {
      call++;
      // first batch all >= 240 (rejected), then zeros
      return new Uint8Array(n).fill(call === 1 ? 255 : 0);
    });
    expect(code).toBe("BBBBBBBB");
    expect(call).toBe(2);
  });
  it("default source yields valid codes", () => {
    for (let i = 0; i < 50; i++) expect(isValidUserCode(generateUserCode())).toBe(true);
  });
  it("normalizes", () => {
    expect(normalizeUserCode(" bcdf-ghjk ")).toBe("BCDFGHJK");
    expect(normalizeUserCode("bcdf ghjk\n")).toBe("BCDFGHJK");
    expect(normalizeUserCode("bc_df.gh/jk")).toBe("BCDFGHJK");
  });
  it("formats", () => {
    expect(formatUserCode("bcdfghjk")).toBe("BCDF-GHJK");
    expect(formatUserCode("BCDF GHJK")).toBe("BCDF-GHJK");
    expect(() => formatUserCode("BCDF")).toThrow();
    expect(() => formatUserCode("AAAAAAAA")).toThrow();
  });
  it("validates", () => {
    expect(isValidUserCode("BCDF-GHJK")).toBe(true);
    expect(isValidUserCode("BCDF-GHJA")).toBe(false);
    expect(isValidUserCode("")).toBe(false);
  });
});

describe("validators", () => {
  it("agent availability", () => {
    expect(isAgentAvailability({ id: "claude", available: true, version: "2" })).toBe(true);
    expect(isAgentAvailability({ id: "codex", available: false })).toBe(true);
    expect(isAgentAvailability({ id: "x" })).toBe(false);
    expect(isAgentAvailability(null)).toBe(false);
  });
  it("device record", () => {
    const rec = { userId: "u", deviceId: "d", hostname: "h", os: "linux", runnerVersion: "1", createdAt: "t", lastSeen: "t" };
    expect(isDeviceRecord(rec)).toBe(true);
    expect(isDeviceRecord({ ...rec, userId: "" })).toBe(false);
  });
  it("device authorization response", () => {
    const r = { device_code: "x", user_code: "BCDF-GHJK", verification_uri: "https://a/b", expires_in: 900, interval: 5 };
    expect(isDeviceAuthorizationResponse(r)).toBe(true);
    expect(isDeviceAuthorizationResponse({ ...r, expires_in: "900" })).toBe(false);
    expect(isDeviceAuthorizationResponse({ ...r, interval: undefined })).toBe(true);
  });
  it("token and error responses", () => {
    expect(isDeviceTokenResponse({ access_token: "a", token_type: "Bearer" })).toBe(true);
    expect(isDeviceTokenResponse({ token_type: "Bearer" })).toBe(false);
    for (const error of ["authorization_pending", "slow_down", "access_denied", "expired_token"])
      expect(isDeviceErrorResponse({ error })).toBe(true);
    expect(isDeviceErrorResponse({ error: "invalid_request" })).toBe(false);
  });
});
