// Copy into the app's Worker project. Install the five bridge adapter packages there.
import { createBridgeWorker, createDoRelayGateway, createRelayDurableObject } from "@berdyh/bridge-server-cf";
import { createNeonDeviceStore } from "@berdyh/bridge-server-neon";
import { createClerkVerifier } from "@berdyh/bridge-server-clerk";
import type { BridgeServerConfig } from "@berdyh/bridge-server";
interface Env {
  RELAY: DurableObjectNamespace;
  DATABASE_URL: string;
  CLERK_SECRET_KEY: string;
  APP_ORIGIN: string;
  CLERK_ISSUER: string;
  CLERK_CLIENT_ID: string;
  /** Optional PEM public key of the Clerk instance: browser JWTs then verify locally, with no JWKS fetch. */
  CLERK_JWT_KEY?: string;
}
const configFor = (env: Env): BridgeServerConfig => ({
  app: { id: "my-app", name: "My app" }, origin: env.APP_ORIGIN,
  enrollPage: "/bridge/enroll",
  auth: { issuer: env.CLERK_ISSUER, clientId: env.CLERK_CLIENT_ID,
    deviceAuthorizationEndpoint: `${env.CLERK_ISSUER}/oauth/device_authorization`,
    tokenEndpoint: `${env.CLERK_ISSUER}/oauth/token` },
  adapters: { relay: createDoRelayGateway(env.RELAY),
    store: createNeonDeviceStore({ connectionString: env.DATABASE_URL }),
    verifier: createClerkVerifier({ secretKey: env.CLERK_SECRET_KEY,
      authorizedParties: [env.APP_ORIGIN], issuer: env.CLERK_ISSUER,
      ...(env.CLERK_JWT_KEY ? { jwtKey: env.CLERK_JWT_KEY } : {}),
      // Explicit device-id-only revocation: a revoked machine can reconnect under
      // a new runnerId and keep refreshing access tokens (offline_access) while
      // its refresh token/grant remains valid, or until manually revoked in Clerk.
      // Access-token expiry alone does not end this window. To revoke the grant,
      // a trusted backend calls clerkClient.oauthApplications.revokeToken with
      // { oauthApplicationId, token: <opaque access or refresh token of the grant> }
      // using this app's Clerk secret key; Clerk revokes both tokens of the grant.
      // Device-id revocation does not call Clerk. No companion module is required.
      // For whole-grant revocation, supply both resolveGrant/revokeGrant hooks
      // with a refresh-stable grant mapping; see the server-clerk README.
      oauth: { clientId: env.CLERK_CLIENT_ID, allowWithoutCredentialId: true } }) },
});
export const Relay = createRelayDurableObject(configFor);
export default createBridgeWorker(configFor);
