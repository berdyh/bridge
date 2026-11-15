import { createClerkClient } from "@clerk/backend";
import { ENROLLMENT_SCOPE, type EnrollmentCredentialIssuer } from "@berdyh/bridge-server";

export interface ClerkEnrollmentPolicy {
  appId: string;
  /** Rotation needs fresh browser approval. Default/max 90 days; shorter lifetimes may be configured. */
  maxLifetimeSeconds?: number;
}

const DEFAULT_LIFETIME = 90 * 24 * 60 * 60;
function lifetime(policy: ClerkEnrollmentPolicy): number {
  const seconds = policy.maxLifetimeSeconds ?? DEFAULT_LIFETIME;
  if (!policy.appId || !Number.isInteger(seconds) || seconds < 60 || seconds > DEFAULT_LIFETIME) throw new Error("Enrollment keys require appId and a lifetime of 60 seconds..90 days");
  return seconds;
}

/** Checked on verification as well as creation; ordinary user-created keys lack these backend claims. */
export function validEnrollmentKey(key: { scopes: string[]; claims: Record<string, unknown> | null; expiration: number | null; createdAt: number }, policy: ClerkEnrollmentPolicy): boolean {
  const seconds = lifetime(policy);
  return Array.isArray(key.scopes) && key.scopes.length === 1 && key.scopes[0] === ENROLLMENT_SCOPE
    && key.claims?.bridgeAppId === policy.appId && key.claims?.bridgePurpose === "runner"
    && typeof key.claims?.bridgeEnrollmentId === "string" && /^[a-f0-9]{64}$/.test(key.claims.bridgeEnrollmentId)
    && Number.isFinite(key.expiration) && Number.isFinite(key.createdAt) && key.expiration! > key.createdAt
    && key.expiration! - key.createdAt <= seconds * 1000;
}

/** Backend-only one-create adapter. Uses each app's own Clerk instance, never any browser API. */
export function createClerkEnrollmentIssuer(options: ClerkEnrollmentPolicy & { secretKey: string }): EnrollmentCredentialIssuer {
  const seconds = lifetime(options);
  const client = createClerkClient({ secretKey: options.secretKey, telemetry: { disabled: true } });
  const owned = (key: { subject: string; claims: Record<string, unknown> | null }, request: { appId: string; enrollmentId: string; userId: string }) =>
    key.subject === request.userId && key.claims?.bridgeAppId === request.appId && key.claims?.bridgePurpose === "runner" && key.claims?.bridgeEnrollmentId === request.enrollmentId;
  return {
    async issue(request) {
      if (request.appId !== options.appId || !/^user_[A-Za-z0-9]+$/.test(request.userId) || !/^[a-f0-9]{64}$/.test(request.enrollmentId)) throw new Error("Invalid enrollment ownership");
      // The enrollment store has already atomically claimed this request. Never retry create:
      // an ambiguous network failure is cleaned up by the durable enrollment id claim.
      const key = await client.apiKeys.create({
        name: "Bridge runner", subject: request.userId, createdBy: request.userId,
        scopes: [ENROLLMENT_SCOPE], secondsUntilExpiration: seconds,
        claims: { bridgeAppId: options.appId, bridgePurpose: "runner", bridgeEnrollmentId: request.enrollmentId },
      });
      if (!owned(key, request) || !validEnrollmentKey(key, options) || key.expired || key.revoked || !key.id || !key.secret?.startsWith("ak_")) {
        if (owned(key, request) && key.id) await client.apiKeys.revoke({ apiKeyId: key.id });
        throw new Error("Provider returned an invalid enrollment key");
      }
      return { credentialId: `api_key:${key.id}`, secret: key.secret };
    },
    async revoke(request) {
      if (request.appId !== options.appId || !/^user_[A-Za-z0-9]+$/.test(request.userId)) throw new Error("Invalid enrollment ownership");
      // A create may have succeeded at Clerk while its response was lost. List by verified
      // subject and check backend claims; never use a user/client-wide revocation handle.
      const matching = new Set<string>();
      if (request.credentialId) {
        if (!request.credentialId.startsWith("api_key:")) throw new Error("Invalid credential id");
        try {
          const key = await client.apiKeys.get(request.credentialId.slice(8));
          if (!owned(key, request)) throw new Error("Enrollment credential owner mismatch");
          if (!key.revoked) matching.add(key.id);
        } catch (e) { if (!(typeof e === "object" && e !== null && "status" in e && e.status === 404)) throw e; }
      } else {
        let offset = 0;
        for (;;) {
          const page = await client.apiKeys.list({ subject: request.userId, includeInvalid: true, limit: 100, offset });
          for (const key of page.data) if (!key.revoked && owned(key, request)) matching.add(key.id);
          offset += page.data.length;
          if (offset >= page.totalCount) break;
          if (!page.data.length || offset >= 10_000) throw new Error("Enrollment cleanup key scan limit reached");
        }
      }
      for (const id of matching) await client.apiKeys.revoke({ apiKeyId: id, revocationReason: "Unclaimed Bridge enrollment" });
    },
  };
}
