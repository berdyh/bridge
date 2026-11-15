import { describe, expect, it } from "vitest";
import { type BridgeDiscovery, DISCOVERY_PATH, isBridgeDiscovery, validateDiscovery } from "./index.js";

const doc: BridgeDiscovery = {
  app: { id: "app-a", name: "App A" },
  origin: "https://app.example.com",
  auth: {
    issuer: "https://clerk.app.example.com",
    clientId: "client_1",
    deviceAuthorizationEndpoint: "https://app.example.com/oauth/device_authorization",
    tokenEndpoint: "https://app.example.com/oauth/token",
  },
  relayUrl: "wss://app.example.com/relay",
  protocol: { min: 1, max: 1 },
};
const errorsOf = (d: unknown, appUrl?: string) => {
  const r = validateDiscovery(d, appUrl ? { appUrl } : {});
  return r.ok ? [] : r.errors;
};

describe("discovery", () => {
  it("accepts explicit app enrollment scope while rejecting malformed or oversized scope lists", () => {
    expect(errorsOf({ ...doc, auth: { ...doc.auth, scope: "bridge:runner" } })).toEqual([]);
    expect(errorsOf({ ...doc, auth: { ...doc.auth, scope: "openid profile offline_access" } })).toEqual([]);
    for (const scope of ["", "bridge:runner\nadmin", " bridge:runner", "bridge:runner  admin", "x".repeat(513), 7]) {
      expect(errorsOf({ ...doc, auth: { ...doc.auth, scope } })).toEqual([expect.stringContaining("auth.scope")]);
    }
  });

  it("serves from the well-known path", () => expect(DISCOVERY_PATH).toBe("/.well-known/bridge.json"));

  it("accepts a valid document, with an off-origin issuer and auth endpoints on the app origin", () => {
    expect(validateDiscovery(doc, { appUrl: "https://app.example.com/some/page" })).toEqual({ ok: true, value: doc });
    expect(isBridgeDiscovery(doc)).toBe(true);
  });

  it("accepts auth endpoints on the issuer origin (Clerk serves them from its Frontend API host)", () => {
    const onIssuer = {
      ...doc,
      auth: {
        ...doc.auth,
        deviceAuthorizationEndpoint: "https://clerk.app.example.com/oauth/device_authorization",
        tokenEndpoint: "https://clerk.app.example.com/oauth/token",
      },
    };
    expect(errorsOf(onIssuer)).toEqual([]);
    expect(isBridgeDiscovery(onIssuer)).toBe(true);
  });

  it("rejects an auth endpoint on a third origin", () => {
    const bad = { ...doc, auth: { ...doc.auth, tokenEndpoint: "https://evil.example.net/token" } };
    expect(errorsOf(bad)).toEqual([expect.stringContaining("tokenEndpoint")]);
    const third = { ...doc, auth: { ...doc.auth, deviceAuthorizationEndpoint: "https://evil.example.net/device" } };
    expect(errorsOf(third)).toEqual([expect.stringContaining("deviceAuthorizationEndpoint")]);
  });

  it("rejects non-auth endpoints on the issuer origin", () => {
    expect(errorsOf({ ...doc, relayUrl: "wss://clerk.app.example.com/relay" })).toEqual([expect.stringContaining("relayUrl")]);
  });

  it("rejects a relay URL off the app origin", () => {
    expect(errorsOf({ ...doc, relayUrl: "wss://evil.example.net/relay" })).toEqual([expect.stringContaining("relayUrl")]);
    expect(errorsOf({ ...doc, relayUrl: "wss://app.example.com:8443/relay" })).toEqual([expect.stringContaining("relayUrl")]);
  });

  it("rejects a document for another origin than the app URL it came from", () => {
    expect(errorsOf(doc, "https://other.example.com")).toEqual([expect.stringContaining("does not match")]);
  });

  it("rejects insecure schemes except on loopback", () => {
    expect(errorsOf({ ...doc, origin: "http://app.example.com" }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...doc, relayUrl: "ws://app.example.com/relay" }).length).toBeGreaterThan(0);
    const local: BridgeDiscovery = {
      ...doc,
      origin: "http://127.0.0.1:8787",
      auth: { ...doc.auth, issuer: "http://127.0.0.1:8787", deviceAuthorizationEndpoint: "http://127.0.0.1:8787/device", tokenEndpoint: "http://127.0.0.1:8787/token" },
      relayUrl: "ws://127.0.0.1:8787/relay",
    };
    expect(errorsOf(local, "http://127.0.0.1:8787/")).toEqual([]);
  });

  it("rejects an origin with a path, embedded credentials and bad protocol ranges", () => {
    expect(errorsOf({ ...doc, origin: "https://app.example.com/x" }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...doc, origin: "https://u:p@app.example.com" }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...doc, protocol: { min: 2, max: 1 } }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...doc, protocol: { min: 0, max: 1 } }).length).toBeGreaterThan(0);
    expect(errorsOf(null)).toEqual(["discovery document must be an object"]);
    expect(errorsOf({}).length).toBeGreaterThan(3);
  });

  describe("enrollPage", () => {
    it("accepts a path on the app origin and a document without one", () => {
      expect(errorsOf({ ...doc, enrollPage: "/bridge/enroll" })).toEqual([]);
      expect(errorsOf({ ...doc, enrollPage: "/" })).toEqual([]);
      expect(errorsOf(doc)).toEqual([]);
    });

    it.each([
      ["a query", "/enroll?x=1"],
      ["a fragment", "/enroll#code=1"],
      ["a protocol-relative host", "//evil.example/x"],
      ["a backslash host (WHATWG reads it as //)", "/\\evil.example/x"],
      ["an absolute URL", "https://app.example.com/enroll"],
      ["an absolute URL on another origin", "https://evil.example/enroll"],
      ["a relative path", "enroll"],
      ["an empty string", ""],
      ["a space", "/en roll"],
      ["a control character", "/en\nroll"],
      ["a non-string", 7],
    ])("rejects %s", (_name, enrollPage) => {
      expect(errorsOf({ ...doc, enrollPage })).toEqual([expect.stringContaining("enrollPage")]);
    });
  });
});
