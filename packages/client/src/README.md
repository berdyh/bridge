# Bridge client SDK

The browser is an ACP client; the local runner proxies requests to the agent.
Serve discovery and the relay on the page's own origin. This 20-line page example
uses an app-provided `session.getToken()` and a paired, online runner with E2EE
(the default); enroll the browser once with `bridge.enroll(code)`. `e2ee: false` is
tests-only.

```ts
import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { connectBridge } from "@berdyh/bridge-client";
const app = client({ name: "agent-page" })
  .onNotification("session/update", ({ params }) => console.log(params.update))
  .onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }));
const bridge = await connectBridge({
  discoveryUrl: new URL("/.well-known/bridge.json", location.href).href,
  getSessionToken: async () => { const token = await session.getToken(); if (!token) throw new Error("Sign in"); return token; },
  label: "Agent page",
});
bridge.onRunners((runners) => console.log(runners));
bridge.onLocalUi(({ pluginId, url }) => console.log(pluginId, url));
const connection = await bridge.acp(app, "your-paired-runner-id");
await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION });
const agentSession = await connection.agent.request("session/new", { cwd: "/your/project", mcpServers: [] });
const result = await connection.agent.request("session/prompt", {
  sessionId: agentSession.sessionId, prompt: [{ type: "text", text: "Explain this project" }],
});
console.log(result.stopReason);
window.addEventListener("pagehide", () => bridge.close(), { once: true });
```

`channel(runnerId)` exposes discrete JSON-RPC messages. `stream(runnerId)` adapts
them to Web Streams; `acp(app, runnerId)` connects the ACP SDK's current `ClientApp`
API. Omitting the runner id selects the only online runner and rejects ambiguity.
Opening another channel to the same runner closes its previous channel. Channels
to different runners coexist. `close()` closes every channel and is idempotent.
Socket reconnects preserve the logical session and resend retained frames in order.

Pages and Web Workers use native WebSocket, enforce same-origin discovery, and use
an IndexedDB store that preserves CryptoKeys by structured clone. Node uses `ws`
and requires an injected `KeyStore` for E2EE; tests with `e2ee: false` can omit it.
All key-store names are prefixed with the discovery origin and
app id. `__bridge/browserKeyId` is reserved metadata: it remembers the enrolled
socket identity on subsequent page loads.

The transport bounds each session to 256 retained frames and 4 MiB of serialized
UTF-8 data, and bounds early unbound frames to 64. Overflow ends the channel with an
error; direct `sendFrame` callers receive a synchronous queue-overflow error.
Unsent handshake/control messages wait for the socket to open in a separate queue
bounded to 256 messages and 4 MiB; overflow rejects visibly. Startup messages flush
before retained data. Sent handshake messages are never replayed after a drop;
a drop during a handshake ends that channel. Cancelled sessions discard queued
startup messages. Malformed current-session frames (including unsafe integer
sequence numbers) close only that session with reason `error`.
Cumulative acknowledgements are batched every 20 ms. Reconnect delay grows from
250 ms to 30 seconds with 50–100% jitter, resetting after a successful socket open.
Sessions have a 15-second handshake deadline. Local UI notifications are consumed
inside the channel and exposed through `onLocalUi`; only HTTP loopback URLs are
accepted, and no URL is opened automatically.
