# @berdyh/bridge-server-clerk

The `AuthVerifier` for the bridge server kit backed by Clerk. It verifies a browser's Clerk session token and a runner's device-grant token or API key, and revokes a runner's credentials at Clerk. It is for apps that use Clerk for sign-in; each app configures its own Clerk application.

Configure an app-specific secret key, the exact issuer from bridge.json and browser
origins in authorizedParties. Browser verification requires a verified session JWT,
user subject, session id, matching issuer and explicit azp. Runner API keys must
have user subjects (organization and machine identities are refused). The API-key
BAPI verifier is the same one used by authenticateRequest with acceptsToken api_key;
calling it directly preserves infrastructure failures. Stable credential ids are
`api_key:<key id>`. Revocation checks ownership and revokes the key at Clerk.
Clerk's `apiKeys.verify` keeps accepting a revoked key for about a minute (observed
47-62 s on a development instance, reporting `revoked: false`, then 404), so the kit
relies on the device store's credential tombstone, not on Clerk, for immediate refusal.

### A runner revoked while it was offline

Within that minute `apiKeys.verify` reports the key as revoked, and the verifier returns it as an authentic but revoked principal
(`{ userId, credentialId, revoked: true }`); the relay gives it the revoked verdict when its store confirms the revoke. After
the minute Clerk answers 404 for the key, which is indistinguishable from a forged key, so the verifier returns undefined. A
runner that comes back after that would get a plain 401, and never learn that it was revoked. The kit closes that gap in the
device store, not in Clerk: when a runner says hello, the core stores the SHA-256 (lowercase hex) of its token next to the
credential binding (only the hash, never the token); when the verifier refuses a runner token, the core looks the token's hash up
and, if it names a credential of a revoked device that the store confirms revoked, answers with the revoked verdict instead of a
401. Requirements: a store that implements `revokedCredentialByFingerprint` (`@berdyh/bridge-server-node`'s memory store,
`-server-d1` and `-server-neon` after their migration `0002_credential_fingerprint.sql`). A credential bound before that
migration has no stored hash, and a runner holding it still gets the 401. An unknown token, a store without the method, or a
lookup error all keep the 401. This applies to API keys (one token per key). An OAuth access token changes at every refresh, so
only the token the runner last connected with is known.

## Claim shapes

What the verifier requires before it returns a principal. Anything else is denied (undefined), never partially accepted.

| Credential | Required |
|---|---|
| Browser session JWT (`verifyBrowser`) | a valid Clerk signature; `iss` equal to the configured `issuer`; `sub` matching `user_*` (an organization or machine subject is refused); `sid` matching `sess_*`; `azp` present and one of `authorizedParties`; the request origin, when there is one, in `authorizedParties` |
| Runner API key (`verifyRunner`, token starts `ak_`) | `apiKeys.verify` succeeds; `subject` matching `user_*`; not expired; the key has an id (the credential id is `api_key:<id>`). A revoked key is returned with `revoked: true` (see above), never as a usable principal |
| Runner OAuth token (`verifyRunner`, any other token) | `oauth` configured; `idPOAuthAccessToken.verify` succeeds; `subject` matching `user_*`; `clientId` equal to `oauth.clientId`; not expired; not revoked (a revoked token is returned with `revoked: true` only when `resolveGrant` maps its grant, else denied) |

`user_*` is `user_` followed by letters and digits; `sess_*` is the `sess_` prefix on the session id. The `sid` is required of the browser JWT only: the OAuth token a runner holds has no session id (see OAuth verification below).

## Hardening against unauthenticated callers

Both `verifyBrowser` and `verifyRunner` return undefined, without calling Clerk, for a
token longer than 4096 characters or outside the base64url-like charset
(`A-Za-z0-9._~+/=-`). Pass `jwtKey` (the instance's PEM public key from the Clerk
dashboard) so browser JWTs verify locally and a JWT with an unknown `kid` is denied
without a JWKS fetch. Runner API keys and OAuth tokens are still introspected at Clerk,
so also rate limit `/relay/*` and `/bridge/devices*` at the edge (see
[Add the bridge to an app](../../docs/guides/add-to-an-app.md)).

## OAuth verification in @clerk/backend 3.23.2

OAuth verification IS supported: authenticateRequest accepts oauth_token, and
`client.idPOAuthAccessToken.verify(accessToken)` introspects via
`POST /oauth_applications/access_tokens/verify`. This adapter uses that backend
method so both opaque and JWT tokens get a revocation check. Device grant uses the
same OAuth token verifier. No app forwarding route is necessary: discovery allows
the issuer's Frontend API device/token endpoints.

### Why Clerk cannot give `resolveGrant` a refresh-stable grant id

The grant id would have to be the same for the access tokens a refresh token
mints, and different for another grant of the same user and client. Clerk exposes
nothing that does this (checked against @clerk/backend 3.23.2):

- The `IdPOAuthAccessToken` resource (introspection result) has only id, clientId,
  type, subject, scopes, revoked, revocationReason, expired, expiration, createdAt,
  updatedAt, aud and act. No sid, session, grant or refresh-family field. A test
  pins this against the installed SDK.
- For a JWT access token the resource is built by `fromJwtPayload`, whose id is
  explicitly payload.jti: new on every refresh, so unusable as a credential id.
  An opaque token carries no claims at all.
- Clerk's documented `claims_supported` for its OAuth/OIDC implementation (the
  `claims_supported` list of the instance's `/.well-known/openid-configuration`
  discovery document) is sub,
  iss, aud, exp, iat, email, name, org_id. No sid either. (The browser JWT's `sid`
  is a sign-in session id; a device-grant token is not tied to a browser session.)
- There is no grant-id revocation endpoint: `oauthApplications.revokeToken` needs an
  opaque access or refresh token and revokes both tokens of that grant.

So `resolveGrant` receives exactly `{ id, subject, clientId }` and nothing in it
identifies the grant. The kit never reads claims from an unverified JWT to find
one. A changed SDK resource (an `@clerk/backend` upgrade that adds a grant, session or
refresh-family field) fails the known-limit test, which is the cue to revisit this.

### The window `allowWithoutCredentialId: true` leaves

OAuth is disabled by default. With `oauth.clientId` configured, verification stays
strict unless the app supplies both a durable `resolveGrant` mapping and
`revokeGrant(userId, grantId)`, or opts in with `allowWithoutCredentialId: true`.
An opted-in token with no resolved grant yields a Principal with no credentialId,
so revoking a device cannot reach the grant: **a revoked machine's refresh token
keeps minting access tokens, and each reconnect appears as a new device under a new
runnerId, until the grant is revoked at Clerk.** Access-token expiry does not end
this: the runner requests `offline_access` and refreshes. Accepting this window is
the expected configuration for the device grant (the Workers template does so).

### What closes the window

1. **API-key runner credentials (`ak_`)**: the closed-window option. Either use app-hosted
   enrollment ([ARCHITECTURE section 5](../../docs/ARCHITECTURE.md#5-pairing-and-enrollment)):
   mount `createRunnerEnrollmentApp` from `@berdyh/bridge-server` at `/bridge/enrollment/*`,
   mint the key with `createClerkEnrollmentIssuer`, and pass the `enrollment` option to
   `createClerkVerifier` so it accepts only keys the issuer created (the D1 store for it needs
   `0003_enrollment.sql`). Or mint a user API key from your own code page. The
   credential id is the stable `api_key:<key id>`, the device store tombstones it on
   revoke, and `revokeRunnerCredentials` revokes the key at Clerk. A revoked machine
   cannot reconnect with it (mind the roughly one minute Clerk keeps accepting a
   revoked key, covered by the tombstone above).
2. **An app backend holding a token of the grant** calls
   `clerkClient.oauthApplications.revokeToken({ oauthApplicationId, token })` with
   that app's secret key, the Clerk OAuth application id and an opaque access or
   refresh token of the grant; Clerk revokes both tokens. A runnerId, userId,
   clientId or jti alone cannot do this, and device-id revocation does not make the
   call automatically.
3. **`resolveGrant` / `revokeGrant`**, kept for an app that fronts the token endpoint
   (and so sees the grant at issue time and can key its own store) or for a future
   Clerk field. The revoker must check ownership, revoke both access and refresh
   tokens of the whole grant, and tolerate already-revoked grants. Resolvers receive
   verified metadata only, must distinguish grants of the same user and client, and
   must map rotated access tokens to the same grant. Do not substitute clientId,
   userId or jti. The two hooks must be supplied together.

To enable device-grant login without a stable grant mapping, explicitly opt in:

```ts
createClerkVerifier({
  secretKey, issuer, authorizedParties: [appOrigin],
  oauth: { clientId, allowWithoutCredentialId: true },
});
```

The token is still introspected for its user subject, matching OAuth client, expiry
and revocation. With no resolved grant, the returned Principal has no credentialId,
as the core contract permits, and the window above applies.

A resolved stable grant takes precedence even when fallback is enabled; an
unresolved grant falls back only with the explicit opt-in. Resolver failures remain
infrastructure errors. Without the opt-in, unresolved grants are denied.

`revokeRunnerCredentials` attempts every distinct credential, tolerates provider
404s, and throws one AggregateError containing all other failures after the loop.
One failed credential does not prevent subsequent credentials from being revoked.

Evidence inside the installed SDK (3.23.2):
- dist/tokens/request.d.ts: acceptsToken overloads;
- dist/tokens/authObjects.d.ts: oauth_token and API key authenticated objects;
- dist/api/endpoints/IdPOAuthAccessTokenApi.d.ts: backend verify;
- dist/api/resources/IdPOAuthAccessToken.d.ts: exposed fields;
- dist/internal.js, IdPOAuthAccessToken.fromJwtPayload: id comes from jti;
- dist/api/endpoints/OAuthApplicationsApi.d.ts: revokeToken semantics.

No live Clerk tenant or real credential is used by the tests.

## Guides

Deploying a server: [Add the bridge to an app](../../docs/guides/add-to-an-app.md). Writing your own adapter: [Write an adapter](../../docs/guides/write-an-adapter.md).
