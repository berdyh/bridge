import { createClerkClient, verifyToken } from "@clerk/backend";
import type { AuthVerifier } from "@berdyh/bridge-server";
import { validEnrollmentKey, type ClerkEnrollmentPolicy } from "./enrollment-issuer.js";

export interface ClerkVerifierOptions {
  secretKey: string;
  /** Browser session JWTs must carry an azp in this app-origin allowlist. */
  authorizedParties: string[];
  /** Exactly the issuer published in bridge.json. */
  issuer: string;
  /**
   * PEM public key of the Clerk instance. When set, browser JWTs are verified locally
   * and an unknown signing kid is denied without any fetch. Without it, an unknown kid
   * makes the SDK call the Clerk JWKS endpoint, which an unauthenticated caller can
   * trigger. Set it in production.
   */
  jwtKey?: string;
  /** Opt-in app-hosted mode: reject API keys without backend-only enrollment claims and exact Bridge scope. OAuth retains its configured behavior. */
  enrollment?: ClerkEnrollmentPolicy;
  /**
   * Finding (@clerk/backend 3.23.2, Clerk's claims_supported list in /.well-known/openid-configuration): an IdP OAuth
   * access token carries an access-token id (the jti, new on every refresh) but no sid, session,
   * grant or refresh-family field, so Clerk gives no refresh-stable grant id (see the README,
   * "OAuth finding"; pinned by a known-limit test). OAuth is strict unless device-only
   * revocation is explicitly enabled. Stable grant mapping requires both hooks, which the app
   * must back with its own store. Never use a per-token jti as a grant id.
   */
  oauth?: {
    clientId: string;
    allowWithoutCredentialId?: boolean;
    resolveGrant?(token: { id: string; subject: string; clientId: string }): Promise<string | undefined>;
    revokeGrant?(userId: string, grantId: string): Promise<void>;
  };
}
/** The longest token any credential here can be (JWTs are about 1 KB). */
export const MAX_TOKEN_LENGTH = 4096;
/** JWTs, API keys and opaque OAuth tokens are all base64url-like; nothing else can be a credential. */
const TOKEN_CHARSET = /^[A-Za-z0-9._~+/=-]+$/;
/** Cheap gate in front of every network verification: junk never reaches the Clerk API. */
const plausibleToken = (token: string): boolean => token.length <= MAX_TOKEN_LENGTH && TOKEN_CHARSET.test(token);
const userId = (value: unknown): value is string => typeof value === "string" && /^user_[A-Za-z0-9]+$/.test(value);
function status(error: unknown): number | undefined { return typeof error === "object" && error !== null && "status" in error ? Number(error.status) : undefined; }
function invalid(error: unknown): boolean {
  if ([400, 401, 403, 404, 422].includes(status(error) ?? 0)) return true;
  if (typeof error === "object" && error !== null && "reason" in error) {
    // Key loading, configuration and network errors remain infrastructure failures.
    const reason = String(error.reason);
    return reason === "jwk-kid-mismatch" || /^(token-(expired|invalid|not-active|iat-in-the-future|verification-failed)|jwt-)/.test(reason);
  }
  return false;
}

/** Each instance is bound to one app's Clerk secret, issuer and browser origins. */
export function createClerkVerifier(options: ClerkVerifierOptions): AuthVerifier {
  if (!options.authorizedParties.length) throw new Error("authorizedParties must contain the app origin");
  const issuer = new URL(options.issuer).origin;
  if (issuer !== options.issuer || new URL(issuer).protocol !== "https:") throw new Error("issuer must be an HTTPS origin");
  for (const origin of options.authorizedParties) if (new URL(origin).origin !== origin) throw new Error("authorizedParties must be origins");
  if (options.oauth && Boolean(options.oauth.resolveGrant) !== Boolean(options.oauth.revokeGrant)) throw new Error("OAuth grant mapping requires both resolveGrant and revokeGrant");
  const client = createClerkClient({ secretKey: options.secretKey, telemetry: { disabled: true } });
  return {
    async verifyBrowser(token, context) {
      if (context.origin !== null && !options.authorizedParties.includes(context.origin)) return undefined;
      if (!plausibleToken(token)) return undefined;
      try {
        const claims = await verifyToken(token, {
          secretKey: options.secretKey,
          authorizedParties: options.authorizedParties,
          ...(options.jwtKey ? { jwtKey: options.jwtKey } : {}),
        });
        if (claims.iss !== issuer || !userId(claims.sub) || typeof claims.sid !== "string" || !claims.sid.startsWith("sess_") || typeof claims.azp !== "string" || !options.authorizedParties.includes(claims.azp)) return undefined;
        return { userId: claims.sub };
      } catch (error) { if (invalid(error)) return undefined; throw error; }
    },
    async verifyRunner(token) {
      if (!plausibleToken(token)) return undefined;
      try {
        if (token.startsWith("ak_")) {
          // This is the exact verifier used by authenticateRequest({ acceptsToken: 'api_key' }).
          // Calling it directly preserves BAPI infrastructure errors instead of signed-out wrapping.
          const key = await client.apiKeys.verify(token);
          if (!userId(key.subject) || key.expired || !key.id) return undefined;
          if (options.enrollment && !validEnrollmentKey(key, options.enrollment)) return undefined;
          // A revoked key with a valid subject and id is authentic: report it, so the relay can tell a runner that was
          // offline at device revoke (Principal.revoked). The relay still checks its own store before it says so.
          return { userId: key.subject, credentialId: `api_key:${key.id}`, ...(key.revoked ? { revoked: true as const } : {}) };
        }
        if (!options.oauth) return undefined;
        // Backend introspection covers opaque AND JWT access tokens, including revoked tokens.
        const verified = await client.idPOAuthAccessToken.verify(token);
        if (!userId(verified.subject) || verified.expired || verified.clientId !== options.oauth.clientId) return undefined;
        const grantId = await options.oauth.resolveGrant?.({ id: verified.id, subject: verified.subject, clientId: verified.clientId });
        // A revoked token is reported only when the app's own mapping names its grant (Principal.revoked); without a
        // grant it cannot be tied to a device, so it stays a 401 (as does allowWithoutCredentialId).
        if (grantId) return { userId: verified.subject, credentialId: `oauth_grant:${grantId}`, ...(verified.revoked ? { revoked: true as const } : {}) };
        if (verified.revoked) return undefined;
        return options.oauth.allowWithoutCredentialId === true ? { userId: verified.subject } : undefined;
      } catch (error) { if (invalid(error)) return undefined; throw error; }
    },
    async revokeRunnerCredentials(user, ids) {
      const errors: unknown[] = [];
      for (const id of new Set(ids)) {
        try {
          if (id.startsWith("api_key:")) {
            const apiKeyId = id.slice("api_key:".length);
            const key = await client.apiKeys.get(apiKeyId);
            if (key.subject !== user) throw new Error("credential owner mismatch");
            if (!key.revoked) await client.apiKeys.revoke({ apiKeyId });
          } else if (id.startsWith("oauth_grant:") && options.oauth?.revokeGrant) {
            await options.oauth.revokeGrant(user, id.slice("oauth_grant:".length));
          } else throw new Error("unsupported credential id");
        } catch (error) { if (status(error) !== 404) errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, `Credential revocation failed: ${errors.map((error) => error instanceof Error ? error.message : "provider error").join("; ")}`);
    },
  };
}
