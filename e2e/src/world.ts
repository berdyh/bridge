import { PROTOCOL_VERSION, client, type ClientApp, type ClientConnection } from "@agentclientprotocol/sdk";
import { connectBridge, type BridgeClient, type KeyStore } from "@berdyh/bridge-client";
import type { PresenceBody } from "@berdyh/bridge-protocol";
import { createNodeBridgeServer, createStubAuthVerifier, createWsRelayTransport, type NodeBridgeServer } from "@berdyh/bridge-server-node";
import WsWebSocket from "ws";

import { Machine, type BridgeProcess } from "./machine.js";
import { startOAuthStub, type OAuthStub } from "./oauth-stub.js";

/** One relay message as the server forwarded it: exactly the text it received. */
export interface Tapped {
  raw: string;
  from: string;
  to: string;
}

/**
 * One app's deployment: its own stub OAuth server and its own `server-node`, with its own tokens.
 * Nothing is shared between two of these, as in production.
 */
export interface Ingress {
  raw: string;
  role: string;
}

export interface AppDeployment {
  appId: string;
  oauth: OAuthStub;
  server: NodeBridgeServer;
  /** Every envelope the relay forwarded (the test hook `tap`). */
  traffic: Tapped[];
  /** Every text message the relay RECEIVED, forwarded or not (hello, rejected, dropped), captured at the transport. */
  ingress: Ingress[];
  /** Every text message the relay SENT to any peer, including its own replies. */
  egress: string[];
  browserToken: string;
  runnerToken: string;
  close(): Promise<void>;
}

export async function deployApp(appId: string, options: { enrollPage?: string } = {}): Promise<AppDeployment> {
  const browserToken = `browser-token-${appId}`;
  const runnerToken = `runner-token-${appId}`;
  const oauth = await startOAuthStub({ clientId: `runner-${appId}`, runnerToken });
  const traffic: Tapped[] = [];
  const ingress: Ingress[] = [];
  const egress: string[] = [];
  // Capture at the relay's ingress: wrap the transport's handler so every received message is recorded
  // before the relay core decides whether to forward, reject or drop it.
  const relay = createWsRelayTransport({});
  const bind = relay.bind.bind(relay);
  relay.bind = (handler) => bind({ ...handler, onMessage: (conn, data) => (ingress.push({ raw: data, role: conn.peer.role }), handler.onMessage(conn, data)) });
  const send = relay.send.bind(relay);
  relay.send = (id, data) => (egress.push(data), send(id, data));
  const server = await createNodeBridgeServer({
    app: { id: appId, name: `App ${appId}` },
    ...(options.enrollPage !== undefined ? { enrollPage: options.enrollPage } : {}),
    auth: {
      issuer: oauth.url,
      clientId: `runner-${appId}`,
      deviceAuthorizationEndpoint: oauth.deviceAuthorizationEndpoint,
      tokenEndpoint: oauth.tokenEndpoint,
    },
    adapters: { relay, verifier: createStubAuthVerifier({ browser: { [browserToken]: "alice" }, runner: { [runnerToken]: "alice" } }) },
    tap: (raw, meta) => void traffic.push({ raw, from: meta.from.role, to: meta.to.role }),
  });
  return { appId, oauth, server, traffic, ingress, egress, browserToken, runnerToken, close: async () => void (await server.close(), await oauth.close()) };
}

/** `bridge connect <app-url> --yes` on `machine`; the stub OAuth server approves at once. */
export async function connectApp(machine: Machine, app: AppDeployment): Promise<void> {
  const result = await machine.exec(["connect", app.server.url, "--yes"]);
  if (result.code !== 0) throw new Error(`bridge connect failed (${result.code}):\n${result.stdout}\n${result.stderr}`);
}

/** Starts `bridge run` and waits until `app` is online on the relay. */
export async function startRunner(machine: Machine, apps: AppDeployment[], options: { e2ee: boolean }): Promise<BridgeProcess> {
  const runner = machine.start(["run"], { BRIDGE_E2EE: options.e2ee ? "1" : "0" });
  for (const app of apps) await runner.waitFor(new RegExp(`\\[${app.appId}\\] online`));
  return runner;
}

/** A browser key store in memory: the headless client's stand-in for IndexedDB. */
export function memoryKeyStore(): KeyStore {
  const data = new Map<string, unknown>();
  return {
    load: async (name) => data.get(name),
    save: async (name, value) => void data.set(name, value),
    delete: async (name) => void data.delete(name),
  };
}

/** The `ws` client with the `Origin` header a browser would send; the server rejects browser sockets without it. */
function originWebSocket(origin: string): typeof globalThis.WebSocket {
  return class extends WsWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { headers: { origin } });
    }
  } as unknown as typeof globalThis.WebSocket;
}

export interface Headless {
  bridge: BridgeClient;
  keyStore: KeyStore;
  /** The one runner online for this app. */
  runner(): Promise<PresenceBody>;
}

/** A headless `bridge-client` for `app`, signed in as its user. */
export async function headlessClient(app: AppDeployment, options: { e2ee: boolean; keyStore?: KeyStore; token?: string }): Promise<Headless> {
  const keyStore = options.keyStore ?? memoryKeyStore();
  const bridge = await connectBridge({
    discoveryUrl: `${app.server.url}/.well-known/bridge.json`,
    getSessionToken: async () => options.token ?? app.browserToken,
    keyStore,
    e2ee: options.e2ee,
    label: "e2e headless client",
    webSocket: originWebSocket(app.server.url),
  });
  return {
    bridge,
    keyStore,
    async runner() {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const online = bridge.runners().filter((r) => r.online);
        if (online.length === 1) return online[0]!;
        if (Date.now() > deadline) throw new Error(`expected one online runner, saw ${JSON.stringify(bridge.runners())}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}

export interface PromptResult {
  text: string;
  stopReason: string;
}

/** ACP initialize, session/new in `cwd`, and one prompt; returns what the agent streamed back. */
export async function promptOnce(connection: ClientConnection, updates: string[], cwd: string, text: string): Promise<PromptResult> {
  await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const session = await connection.agent.request("session/new", { cwd, mcpServers: [] });
  const result = await connection.agent.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text }] });
  return { text: updates.join(""), stopReason: result.stopReason };
}

/** An ACP client app that collects the agent's message chunks into `updates`. */
export function collectingApp(updates: string[]): ClientApp {
  return client({ name: "e2e-headless" }).onNotification("session/update", ({ params }) => {
    const update = params.update as { sessionUpdate: string; content?: { type: string; text?: string } };
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") updates.push(update.content.text ?? "");
  });
}
