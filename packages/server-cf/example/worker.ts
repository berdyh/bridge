import { createBridgeWorker, createDoRelayGateway, createRelayDurableObject } from "@berdyh/bridge-server-cf";
import { createD1DeviceStore } from "@berdyh/bridge-server-d1";
import { testing } from "./guard.js";
import type { AuthVerifier, BridgeServerConfig } from "@berdyh/bridge-server";

interface Env {
  RELAY: DurableObjectNamespace;
  DB: D1Database;
  APP_ORIGIN: string;
  BRIDGE_TEST_AUTH?: string;
}

function configFor(env: Env): BridgeServerConfig {
  const enabled = testing(env);
  const verifier: AuthVerifier = {
    async verifyBrowser(token) { return enabled && token === "test-browser" ? { userId: "alice" } : undefined; },
    async verifyRunner(token) { return enabled && token === "test-runner" ? { userId: "alice", credentialId: "test-credential" } : undefined; },
  };
  return {
    app: { id: "sample-app", name: "Local Cloudflare bridge" }, origin: env.APP_ORIGIN,
    // Names the app page that enrolls a browser; discovery (`/.well-known/bridge.json`) advertises it so
    // `bridge setup` can open it. The example serves no page there: a real app serves one at this path.
    enrollPage: "/bridge/enroll",
    auth: { issuer: env.APP_ORIGIN, clientId: "test-client",
      deviceAuthorizationEndpoint: `${env.APP_ORIGIN}/oauth/device_authorization`, tokenEndpoint: `${env.APP_ORIGIN}/oauth/token` },
    adapters: { store: createD1DeviceStore(env.DB), verifier, relay: createDoRelayGateway(env.RELAY) },
  };
}

const BaseRelay = createRelayDurableObject(configFor);
export class Relay extends BaseRelay {
  private readonly boot = crypto.randomUUID();
  private first = true;
  constructor(private readonly state: DurableObjectState, private readonly env: Env) { super(state, env); }
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (testing(this.env) && this.first) {
      this.first = false;
      await this.state.storage.put("test-first-message", { boot: this.boot, message });
    }
    await super.webSocketMessage!(ws, message);
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/__test/state" && testing(this.env)) {
      return Response.json({ boot: this.boot, firstMessage: await this.state.storage.get("test-first-message"),
        sockets: this.state.getWebSockets().map((ws) => ({ attachment: ws.deserializeAttachment(),
          autoResponseAt: this.state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null })) });
    }
    return super.fetch!(request);
  }
}

const bridge = createBridgeWorker(configFor);
export default {
  async fetch(request: Request<unknown, IncomingRequestCfProperties>, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/oauth/") || path.startsWith("/__test/")) {
      if (!testing(env)) return new Response("Not found", { status: 404 });
      if (path === "/oauth/device_authorization" && request.method === "POST") return Response.json({
        device_code: "local-device-code", user_code: "BCDF-GHJK", verification_uri: `${env.APP_ORIGIN}/__test/approve`, expires_in: 600, interval: 1,
      });
      if (path === "/oauth/token" && request.method === "POST") {
        const body = new URLSearchParams(await request.text());
        if (body.get("client_id") !== "test-client" || body.get("device_code") !== "local-device-code") return Response.json({ error: "invalid_grant" }, { status: 400 });
        // Deliberately auto-approved fake OAuth, available only behind the test binding.
        return Response.json({ access_token: "test-runner", token_type: "Bearer", expires_in: 3600 });
      }
      if (path === "/__test/state" && request.headers.get("authorization") === "Bearer test-browser") {
        return env.RELAY.get(env.RELAY.idFromName("alice")).fetch(new Request("https://bridge.internal/__test/state"));
      }
      return new Response("Not found", { status: 404 });
    }
    return bridge.fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
