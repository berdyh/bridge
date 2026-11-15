// Opt-in: exercises createClerkVerifier against a live Clerk DEVELOPMENT instance.
// Skipped unless CLERK_SECRET_KEY and CLERK_ISSUER (https://<frontend-api-host>) are set.
// Requires a throwaway dev app. The user API key tests also need the "API keys" feature enabled in the
// Clerk dashboard (it is not toggleable through the Backend or Platform API) and skip themselves otherwise.
import { randomUUID } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { afterAll, describe, expect, it } from "vitest";
import { createClerkVerifier } from "./clerk-verifier.js";

const secretKey = process.env.CLERK_SECRET_KEY;
const issuer = process.env.CLERK_ISSUER;
const origin = "https://app.bridge-kit-test.example";
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe.skipIf(!secretKey || !issuer)("Clerk verifier against a live dev instance", () => {
  const key = secretKey ?? "sk_test_unused";
  const client = createClerkClient({ secretKey: key, telemetry: { disabled: true } });
  const verifier = createClerkVerifier({ secretKey: key, issuer: issuer ?? "https://unused.example", authorizedParties: [origin], oauth: { clientId: "oauth_client_not_real", allowWithoutCredentialId: true } });
  const cleanup: Array<() => Promise<unknown>> = [];
  afterAll(async () => { for (const fn of cleanup.reverse()) await fn().catch(() => undefined); });

  it("denies (does not throw) a well-formed JWT whose kid is unknown to the instance", async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = `${b64({ alg: "RS256", typ: "JWT", kid: "ins_unknown_kid" })}.${b64({ iss: issuer, sub: "user_abc123", sid: "sess_abc123", azp: origin, iat: now, nbf: now - 5, exp: now + 300 })}.${Buffer.alloc(256, 7).toString("base64url")}`;
    await expect(verifier.verifyBrowser(jwt, { origin })).resolves.toBeUndefined();
  });

  it("denies garbage browser tokens and wrong origins", async () => {
    await expect(verifier.verifyBrowser("not-a-jwt", { origin })).resolves.toBeUndefined();
    await expect(verifier.verifyBrowser("a.b.c", { origin })).resolves.toBeUndefined();
    await expect(verifier.verifyBrowser("a.b.c", { origin: "https://evil.example" })).resolves.toBeUndefined();
  });

  it("denies unknown API keys and unknown OAuth tokens as 401, not as infrastructure errors", async () => {
    await expect(verifier.verifyRunner(`ak_${"x".repeat(40)}`)).resolves.toBeUndefined();
    await expect(verifier.verifyRunner(`oat_${"x".repeat(40)}`)).resolves.toBeUndefined();
    await expect(verifier.verifyRunner("something-else")).resolves.toBeUndefined();
  });

  // Clerk's verify path caches a key: after a revoke, `apiKeys.verify` kept accepting it
  // (with `revoked: false`) for 47-62 s on a dev instance, then answered 404. The poll
  // below waits that out; kit revocation itself is immediate through the store tombstone.
  it("verifies a user API key with a stable credential id, then revokes it", { timeout: 180_000 }, async (ctx) => {
    const user = await client.users.createUser({ emailAddress: [`bk-live-${randomUUID().slice(0, 8)}@example.com`], password: `Zx9!${randomUUID()}` });
    cleanup.push(() => client.users.deleteUser(user.id));
    let created;
    try { created = await client.apiKeys.create({ name: "bk-live", subject: user.id }); }
    catch (error) {
      if (JSON.stringify(error).includes("feature_not_enabled")) return ctx.skip("API keys feature is not enabled on this Clerk instance");
      throw error;
    }
    cleanup.push(() => client.apiKeys.delete(created.id));
    const secret = created.secret;
    expect(secret).toMatch(/^ak_/);
    const principal = await verifier.verifyRunner(secret!);
    expect(principal).toEqual({ userId: user.id, credentialId: `api_key:${created.id}` });
    expect(await verifier.verifyRunner(secret!)).toEqual(principal); // stable across verifications
    await expect(verifier.revokeRunnerCredentials!("user_someone_else", [principal!.credentialId!])).rejects.toThrow();
    expect(await verifier.verifyRunner(secret!)).toEqual(principal);
    await verifier.revokeRunnerCredentials!(user.id, [principal!.credentialId!]);
    await verifier.revokeRunnerCredentials!(user.id, [principal!.credentialId!]); // idempotent
    expect((await client.apiKeys.get(created.id)).revoked).toBe(true);
    const deadline = Date.now() + 150_000;
    let after = await verifier.verifyRunner(secret!);
    while (after !== undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      after = await verifier.verifyRunner(secret!);
    }
    expect(after).toBeUndefined();
  });

  // An OAuth access token needs an interactive user consent (authorization code flow) and cannot be minted
  // from the Backend API alone, so the positive OAuth path is not covered here.
  it.skip("verifies an OAuth access token (needs interactive consent)", () => undefined);
});
