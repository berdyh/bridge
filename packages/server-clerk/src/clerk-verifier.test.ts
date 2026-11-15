import { beforeEach, describe, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({ verifyToken: vi.fn(), verifyKey: vi.fn(), getKey: vi.fn(), revokeKey: vi.fn(), verifyOAuth: vi.fn(), create: vi.fn() }));
vi.mock("@clerk/backend", () => ({ verifyToken: sdk.verifyToken, createClerkClient: sdk.create }));
import { createClerkVerifier } from "./clerk-verifier.js";
const options = { secretKey: "secret", issuer: "https://app.clerk.accounts.dev", authorizedParties: ["https://app.test"] };
beforeEach(() => {
  vi.resetAllMocks();
  sdk.create.mockReturnValue({ apiKeys: { verify: sdk.verifyKey, get: sdk.getKey, revoke: sdk.revokeKey }, idPOAuthAccessToken: { verify: sdk.verifyOAuth } });
});
describe("Clerk verifier", () => {
  it("verifies issuer, session, azp, user subject and browser origin", async () => {
    const verifier = createClerkVerifier(options);
    const claims = { iss: options.issuer, sub: "user_alice", sid: "sess_one", azp: "https://app.test" };
    sdk.verifyToken.mockResolvedValue(claims);
    expect(await verifier.verifyBrowser("jwt", { origin: "https://app.test" })).toEqual({ userId: "user_alice" });
    expect(sdk.verifyToken).toHaveBeenCalledWith("jwt", { secretKey: "secret", authorizedParties: ["https://app.test"] });
    for (const patch of [{ iss: "https://other.test" }, { azp: undefined }, { azp: "https://other.test" }, { sub: "org_other" }, { sid: undefined }]) {
      sdk.verifyToken.mockResolvedValue({ ...claims, ...patch });
      expect(await verifier.verifyBrowser("jwt", { origin: null })).toBeUndefined();
    }
    sdk.verifyToken.mockClear(); expect(await verifier.verifyBrowser("jwt", { origin: "https://evil.test" })).toBeUndefined(); expect(sdk.verifyToken).not.toHaveBeenCalled();
  });
  it("rejects tokens that cannot be credentials before calling Clerk", async () => {
    const verifier = createClerkVerifier({ ...options, oauth: { clientId: "client_app", allowWithoutCredentialId: true } });
    for (const token of ["a".repeat(4097), "ak_bad token", "ak_\u00e9", "ak_<script>", "a\nb", ""]) {
      expect(await verifier.verifyBrowser(token, { origin: null }), token.slice(0, 12)).toBeUndefined();
      expect(await verifier.verifyRunner(token), token.slice(0, 12)).toBeUndefined();
    }
    expect(sdk.verifyToken).not.toHaveBeenCalled();
    expect(sdk.verifyKey).not.toHaveBeenCalled();
    expect(sdk.verifyOAuth).not.toHaveBeenCalled();
    sdk.verifyKey.mockResolvedValue({ id: "key_one", subject: "user_alice", revoked: false, expired: false });
    expect(await verifier.verifyRunner("ak_" + "a".repeat(4000))).toEqual({ userId: "user_alice", credentialId: "api_key:key_one" });
    expect(await verifier.verifyRunner("ak_header.payload-sig_x~y+z/w=")).toBeDefined();
  });
  it("passes jwtKey to verifyToken for local verification and denies an unknown kid", async () => {
    const jwtKey = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----";
    const verifier = createClerkVerifier({ ...options, jwtKey });
    sdk.verifyToken.mockResolvedValue({ iss: options.issuer, sub: "user_alice", sid: "sess_one", azp: "https://app.test" });
    expect(await verifier.verifyBrowser("jwt", { origin: null })).toEqual({ userId: "user_alice" });
    expect(sdk.verifyToken).toHaveBeenCalledWith("jwt", { secretKey: "secret", authorizedParties: ["https://app.test"], jwtKey });
    sdk.verifyToken.mockRejectedValue({ reason: "jwk-kid-mismatch" });
    expect(await verifier.verifyBrowser("jwt", { origin: null })).toBeUndefined();
  });
  it("uses stable API key ids, rejects organization keys and revoked/expired keys", async () => {
    const verifier = createClerkVerifier(options);
    sdk.verifyKey.mockResolvedValue({ id: "key_one", subject: "user_alice", revoked: false, expired: false });
    expect(await verifier.verifyRunner("ak_secret")).toEqual({ userId: "user_alice", credentialId: "api_key:key_one" });
    for (const patch of [{ subject: "org_one" }, { expired: true }, { expired: true, revoked: true }, { id: "" }, { revoked: true, subject: "org_one" }, { revoked: true, id: undefined }]) {
      sdk.verifyKey.mockResolvedValue({ id: "key_one", subject: "user_alice", ...patch }); expect(await verifier.verifyRunner("ak_secret")).toBeUndefined();
    }
    expect(await verifier.verifyRunner("session")).toBeUndefined();
  });
  it("reports a revoked API key as an authentic but revoked principal, so an offline-revoked runner can get the verdict", async () => {
    const verifier = createClerkVerifier(options);
    sdk.verifyKey.mockResolvedValue({ id: "key_one", subject: "user_alice", revoked: true, expired: false });
    expect(await verifier.verifyRunner("ak_secret")).toEqual({ userId: "user_alice", credentialId: "api_key:key_one", revoked: true });
    // Revoked is only a mark on a verified identity: forged, unknown and expired keys are still undefined.
    sdk.verifyKey.mockRejectedValue({ status: 404 }); expect(await verifier.verifyRunner("ak_forged")).toBeUndefined();
    sdk.verifyKey.mockRejectedValue({ status: 401 }); expect(await verifier.verifyRunner("ak_forged")).toBeUndefined();
    sdk.verifyKey.mockRejectedValue({ status: 503 }); await expect(verifier.verifyRunner("ak_down")).rejects.toEqual({ status: 503 });
    // The browser path never reports revoked.
    sdk.verifyToken.mockResolvedValue({ iss: options.issuer, sub: "user_alice", sid: "sess_one", azp: "https://app.test", revoked: true });
    expect(await verifier.verifyBrowser("jwt", { origin: null })).toEqual({ userId: "user_alice" });
  });
  it("reports a revoked OAuth token only when the app's grant mapping names its grant; expired or unmapped stay 401", async () => {
    const resolveGrant = vi.fn().mockResolvedValue("grant_device");
    const verifier = createClerkVerifier({ ...options, oauth: { clientId: "client_app", resolveGrant, revokeGrant: vi.fn() } });
    const token = { id: "access1", subject: "user_alice", clientId: "client_app", revoked: true, expired: false };
    sdk.verifyOAuth.mockResolvedValue(token);
    expect(await verifier.verifyRunner("oat_access1")).toEqual({ userId: "user_alice", credentialId: "oauth_grant:grant_device", revoked: true });
    sdk.verifyOAuth.mockResolvedValue({ ...token, expired: true }); expect(await verifier.verifyRunner("oat_access1")).toBeUndefined();
    sdk.verifyOAuth.mockResolvedValue({ ...token, clientId: "other" }); expect(await verifier.verifyRunner("oat_access1")).toBeUndefined();
    sdk.verifyOAuth.mockResolvedValue({ ...token, subject: "org_other" }); expect(await verifier.verifyRunner("oat_access1")).toBeUndefined();
    sdk.verifyOAuth.mockResolvedValue(token); resolveGrant.mockResolvedValue(undefined);
    expect(await verifier.verifyRunner("oat_access1")).toBeUndefined();
  });
  it("introspects OAuth and requires an app-owned stable grant mapping across refresh", async () => {
    const resolveGrant = vi.fn().mockResolvedValue("grant_device"); const revokeGrant = vi.fn();
    const verifier = createClerkVerifier({ ...options, oauth: { clientId: "client_app", resolveGrant, revokeGrant } });
    for (const id of ["access1", "access2"]) {
      sdk.verifyOAuth.mockResolvedValue({ id, subject: "user_alice", clientId: "client_app", revoked: false, expired: false });
      expect(await verifier.verifyRunner(`oat_${id}`)).toEqual({ userId: "user_alice", credentialId: "oauth_grant:grant_device" });
    }
    await verifier.revokeRunnerCredentials!("user_alice", ["oauth_grant:grant_device"]);
    expect(revokeGrant).toHaveBeenCalledWith("user_alice", "grant_device");
    resolveGrant.mockResolvedValue(undefined); expect(await verifier.verifyRunner("oat_new")).toBeUndefined();
    sdk.verifyOAuth.mockResolvedValue({ subject: "user_alice", clientId: "other" }); expect(await verifier.verifyRunner("oat_new")).toBeUndefined();
  });
  it("known limit: the installed SDK exposes no refresh-stable OAuth grant id, so resolveGrant gets only { id, subject, clientId }", async () => {
    // Real @clerk/backend client (not the mock) against a stubbed fetch: the resource class is not exported, so this is the supported route to IdPOAuthAccessToken.fromJSON.
    // fromJSON drops unknown wire fields, so this fails only when the SDK resource class changes (an @clerk/backend upgrade that adds a grant, session or refresh-family field): then the documented limitation (README, "OAuth finding") can be lifted.
    const actual = await vi.importActual<typeof import("@clerk/backend")>("@clerk/backend");
    const wire = (id: string) => ({
      object: "clerk_idp_oauth_access_token", id, client_id: "client_app", type: "oauth_token", subject: "user_alice", scopes: ["openid", "offline_access"],
      revoked: false, revocation_reason: null, expired: false, expiration: 1_900_000_000, created_at: 1_800_000_000, updated_at: 1_800_000_000,
    });
    const responses = [wire("oat_first"), wire("oat_refreshed")];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const real = actual.createClerkClient({ secretKey: "sk_test_x", apiUrl: "https://api.clerk.test", telemetry: { disabled: true } });
      const first = await real.idPOAuthAccessToken.verify("oat_one");
      const second = await real.idPOAuthAccessToken.verify("oat_two");
      for (const resource of [first, second]) expect(Object.keys(resource).filter((key) => /grant|session|sid|refresh/i.test(key))).toEqual([]);
      expect([first.id, second.id]).toEqual(["oat_first", "oat_refreshed"]);
      const resolveGrant = vi.fn().mockResolvedValue("grant_app"); const revokeGrant = vi.fn();
      const verifier = createClerkVerifier({ ...options, oauth: { clientId: "client_app", resolveGrant, revokeGrant } });
      for (const resource of [first, second]) { sdk.verifyOAuth.mockResolvedValue(resource); await verifier.verifyRunner("oat_x"); }
      expect(resolveGrant.mock.calls).toEqual([
        [{ id: "oat_first", subject: "user_alice", clientId: "client_app" }],
        [{ id: "oat_refreshed", subject: "user_alice", clientId: "client_app" }],
      ]);
    } finally { vi.unstubAllGlobals(); }
  });
  it("rejects device-grant tokens without OAuth hooks instead of falling back to device-only revocation", async () => {
    sdk.verifyOAuth.mockResolvedValue({ id: "access1", subject: "user_alice", clientId: "client_app" });
    expect(await createClerkVerifier(options).verifyRunner("oat_access1")).toBeUndefined();
    expect(sdk.verifyOAuth).not.toHaveBeenCalled();
    expect(await createClerkVerifier({ ...options, oauth: { clientId: "client_app" } }).verifyRunner("oat_access1")).toBeUndefined();
  });
  it("accepts verified device-grant tokens without credentialId only through explicit opt-in", async () => {
    const token = { id: "access1", subject: "user_alice", clientId: "client_app", revoked: false, expired: false };
    const verifier = createClerkVerifier({ ...options, oauth: { clientId: "client_app", allowWithoutCredentialId: true } });
    for (const id of ["access1", "rotated_access2"]) {
      sdk.verifyOAuth.mockResolvedValue({ ...token, id });
      expect(await verifier.verifyRunner(`oat_${id}`)).toEqual({ userId: "user_alice" });
    }
    for (const patch of [{ subject: "org_other" }, { clientId: "other" }, { expired: true }, { revoked: true }]) {
      sdk.verifyOAuth.mockResolvedValue({ ...token, ...patch });
      expect(await verifier.verifyRunner("oat_invalid")).toBeUndefined();
    }
    sdk.verifyOAuth.mockRejectedValue({ status: 401 }); expect(await verifier.verifyRunner("oat_invalid")).toBeUndefined();
    sdk.verifyOAuth.mockRejectedValue({ status: 503 }); await expect(verifier.verifyRunner("oat_invalid")).rejects.toEqual({ status: 503 });
  });
  it("prefers a stable grant when opted in and permits fallback only for unresolved grants", async () => {
    const resolveGrant = vi.fn().mockResolvedValue("grant_one"); const revokeGrant = vi.fn();
    const verifier = createClerkVerifier({ ...options, oauth: { clientId: "client_app", allowWithoutCredentialId: true, resolveGrant, revokeGrant } });
    sdk.verifyOAuth.mockResolvedValue({ id: "access", subject: "user_alice", clientId: "client_app" });
    expect(await verifier.verifyRunner("oat_access")).toEqual({ userId: "user_alice", credentialId: "oauth_grant:grant_one" });
    resolveGrant.mockResolvedValue(undefined); expect(await verifier.verifyRunner("oat_access")).toEqual({ userId: "user_alice" });
    resolveGrant.mockRejectedValue(new Error("mapping unavailable")); await expect(verifier.verifyRunner("oat_access")).rejects.toThrow("mapping unavailable");
  });
  it("requires grant mapping and whole-grant revocation hooks together", () => {
    expect(() => createClerkVerifier({ ...options, oauth: { clientId: "client_app", resolveGrant: vi.fn() } })).toThrow("both");
    expect(() => createClerkVerifier({ ...options, oauth: { clientId: "client_app", revokeGrant: vi.fn() } })).toThrow("both");
  });
  it("attempts every distinct credential before reporting combined revocation errors", async () => {
    const ownerError = new Error("credential owner mismatch"); const providerError = new Error("provider unavailable");
    const revokeGrant = vi.fn().mockRejectedValue(providerError);
    const verifier = createClerkVerifier({ ...options, oauth: { clientId: "client_app", resolveGrant: vi.fn(), revokeGrant } });
    sdk.getKey.mockImplementation(async (id) => {
      if (id === "missing") throw { status: 404 };
      if (id === "other") throw ownerError;
      return { subject: "user_alice", revoked: id === "already" };
    });
    const result = verifier.revokeRunnerCredentials!("user_alice", ["api_key:other", "oauth_grant:grant", "api_key:good", "api_key:missing", "api_key:already", "api_key:last", "api_key:good"]);
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toMatchObject({ errors: [ownerError, providerError] });
    expect(sdk.getKey.mock.calls.map(([id]) => id)).toEqual(["other", "good", "missing", "already", "last"]);
    expect(sdk.revokeKey.mock.calls).toEqual([[{ apiKeyId: "good" }], [{ apiKeyId: "last" }]]);
    expect(revokeGrant).toHaveBeenCalledWith("user_alice", "grant");
  });
  it("denies an unknown signing kid but preserves other JWKS and configuration failures", async () => {
    const verifier = createClerkVerifier(options);
    sdk.verifyToken.mockRejectedValue({ reason: "jwk-kid-mismatch" });
    expect(await verifier.verifyBrowser("bad", { origin: null })).toBeUndefined();
    for (const reason of ["jwk-failed-to-load", "jwk-remote-failed-to-load", "jwk-local-missing", "jwk-unexpected", "secret-key-invalid"]) {
      sdk.verifyToken.mockRejectedValue({ reason });
      await expect(verifier.verifyBrowser("bad", { origin: null })).rejects.toEqual({ reason });
    }
  });
  it("distinguishes authentication denial from infrastructure failure", async () => {
    const verifier = createClerkVerifier(options);
    sdk.verifyKey.mockRejectedValue({ status: 401 }); expect(await verifier.verifyRunner("ak_bad")).toBeUndefined();
    sdk.verifyKey.mockRejectedValue({ status: 503 }); await expect(verifier.verifyRunner("ak_bad")).rejects.toEqual({ status: 503 });
    sdk.verifyToken.mockRejectedValue({ reason: "token-expired" }); expect(await verifier.verifyBrowser("bad", { origin: null })).toBeUndefined();
    sdk.verifyToken.mockRejectedValue({ reason: "token-verification-failed" }); expect(await verifier.verifyBrowser("bad", { origin: null })).toBeUndefined();
    sdk.verifyToken.mockRejectedValue(new TypeError("network")); await expect(verifier.verifyBrowser("bad", { origin: null })).rejects.toThrow("network");
  });
  it("revokes only owned API keys, deduplicates, tolerates missing/already revoked ids", async () => {
    const verifier = createClerkVerifier(options);
    sdk.getKey.mockResolvedValue({ subject: "user_alice", revoked: false });
    await verifier.revokeRunnerCredentials!("user_alice", ["api_key:key", "api_key:key"]);
    expect(sdk.revokeKey).toHaveBeenCalledExactlyOnceWith({ apiKeyId: "key" });
    sdk.getKey.mockRejectedValue({ status: 404 }); await verifier.revokeRunnerCredentials!("user_alice", ["api_key:missing"]);
    sdk.getKey.mockResolvedValue({ subject: "user_bob" }); await expect(verifier.revokeRunnerCredentials!("user_alice", ["api_key:other"])).rejects.toThrow("owner");
    await expect(verifier.revokeRunnerCredentials!("user_alice", ["unknown"])).rejects.toThrow("unsupported");
  });
});
