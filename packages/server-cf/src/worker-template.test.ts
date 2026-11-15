import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { build } = require(require.resolve("esbuild", { paths: [require.resolve("wrangler/package.json")] }));

it("wires a working device flow with explicit OAuth fallback and no companion module", async () => {
  // Compile the copied template without any app-owned companion modules.
  // Stub adapter constructors to inspect their config, not the auth algorithms.
  const modules: Record<string, string> = {
    "@berdyh/bridge-server-cf": `
      export const createBridgeWorker = configFor => ({ configFor });
      export const createDoRelayGateway = () => ({});
      export const createRelayDurableObject = () => class {};`,
    "@berdyh/bridge-server-neon": "export const createNeonDeviceStore = () => ({});",
    "@berdyh/bridge-server-clerk": "export const createClerkVerifier = options => options;",
  };
  const bundle = await build({
    entryPoints: [new URL("../templates/worker.ts", import.meta.url).pathname],
    bundle: true, write: false, format: "cjs", platform: "node",
    plugins: [{ name: "app-template-fixture", setup(builder: any) {
      builder.onResolve({ filter: /^@berdyh\/bridge-server/ }, (args: { path: string }) => {
        if (args.path in modules) return { path: args.path, namespace: "fixture" };
      });
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args: { path: string }) => ({ contents: modules[args.path], loader: "js" }));
    } }],
  });
  const module = { exports: {} as any };
  new Function("module", "exports", bundle.outputFiles[0].text)(module, module.exports);
  const env = {
    RELAY: {}, DATABASE_URL: "app-db", CLERK_SECRET_KEY: "app-secret",
    APP_ORIGIN: "https://app.test", CLERK_ISSUER: "https://app.clerk.accounts.dev",
    CLERK_CLIENT_ID: "client_app",
  };
  const config = module.exports.default.configFor(env);
  expect(config.enrollPage).toBe("/bridge/enroll");
  expect(config.auth.deviceAuthorizationEndpoint).toBe(`${env.CLERK_ISSUER}/oauth/device_authorization`);
  expect(config.auth.tokenEndpoint).toBe(`${env.CLERK_ISSUER}/oauth/token`);
  const oauth = config.adapters.verifier.oauth;
  expect(oauth.clientId).toBe(config.auth.clientId);
  expect(oauth.allowWithoutCredentialId).toBe(true);
  expect(oauth.resolveGrant).toBeUndefined();
  expect(oauth.revokeGrant).toBeUndefined();
});
