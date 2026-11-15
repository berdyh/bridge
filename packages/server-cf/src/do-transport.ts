import { RELAY_CLOSE_REPLACED, RELAY_CLOSE_REVOKED, RELAY_SUBPROTOCOL } from "@berdyh/bridge-protocol";
import { createDeviceService, createRelayCore, RELAY_CLOSE_MAX_AGE, resolveSocketLimits, revokedVerdictFrame, type BridgeServerConfig, type ConnectionFilter, type ConnectionState, type RelayConnection, type RelayGateway, type RelayHandler, type RelayPeer, type RelayTransport } from "@berdyh/bridge-server";

const PEER_HEADER = "x-bridge-internal-peer";
const INTERNAL = "https://bridge.internal";
export const CF_HEARTBEAT_PING = "bridge:ping";
export const CF_HEARTBEAT_PONG = "bridge:pong";
const HELLO_MS = 10_000;
const SWEEP_MS = 30_000;
const IDLE_MS = 60_000;
const namespaces = new WeakMap<RelayGateway, DurableObjectNamespace>();
interface Attachment extends RelayConnection {
  helloDeadline: number;
  lastInbound: number;
  closed?: boolean;
  discard?: boolean;
  lastSeenAttempt?: number;
}
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
function save(ws: WebSocket, value: Attachment): void {
  if (bytes(JSON.stringify(value)) >= 16 * 1024) throw new Error("relay attachment exceeds 16 KB");
  ws.serializeAttachment(value);
}
function matches(p: RelayPeer, f: ConnectionFilter): boolean {
  return (f.role === undefined || f.role === p.role) &&
    (f.runnerId === undefined || (p.role === "runner" && f.runnerId === p.runnerId)) &&
    (f.browserKeyId === undefined || (p.role === "browser" && f.browserKeyId === p.browserKeyId)) &&
    (f.credentialId === undefined || (p.role === "runner" && f.credentialId === p.credentialId));
}

/** Only the authenticated peer is forwarded; bearer tokens never enter attachments. */
export function createDoRelayGateway(namespace: DurableObjectNamespace): RelayGateway {
  const stub = (u: string) => namespace.get(namespace.idFromName(u));
  const gateway: RelayGateway = {
    accept(request, peer) {
      const headers = new Headers({ upgrade: "websocket", [PEER_HEADER]: JSON.stringify(peer) });
      if (request.headers.get("sec-websocket-protocol")?.split(",").some((p) => p.trim() === RELAY_SUBPROTOCOL)) headers.set("sec-websocket-protocol", RELAY_SUBPROTOCOL);
      return stub(peer.userId).fetch(new Request(`${INTERNAL}/accept`, { headers }));
    },
    // Runs in the Worker and never calls the user's Durable Object: the verdict socket is a plain
    // (non-hibernating) WebSocket that no relay registry knows, so it cannot displace or reach anything.
    async acceptVerdict(request, verdict) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Upgrade Required", { status: 426 });
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      server.send(revokedVerdictFrame(verdict.runnerId));
      server.close(RELAY_CLOSE_REVOKED, "revoked");
      const offered = request.headers.get("sec-websocket-protocol")?.split(",").some((p) => p.trim() === RELAY_SUBPROTOCOL);
      return new Response(null, { status: 101, webSocket: pair[0], ...(offered ? { headers: { "sec-websocket-protocol": RELAY_SUBPROTOCOL } } : {}) });
    },
    async disconnect(userId, filter, code, reason) {
      const response = await stub(userId).fetch(new Request(`${INTERNAL}/disconnect`, { method: "POST", body: JSON.stringify({ userId, filter, code, reason }) }));
      if (!response.ok) throw new Error("relay disconnect failed");
      return response.json<number>();
    },
  };
  namespaces.set(gateway, namespace);
  return gateway;
}

/** All durable connection state is in attachments; only in-flight event chains live in memory. */
export function createRelayDurableObject<Env>(configFor: (env: Env) => BridgeServerConfig): new (state: DurableObjectState, env: Env) => DurableObject {
  return class RelayDurableObject implements DurableObject {
    private readonly transport: RelayTransport;
    private handler!: RelayHandler;
    // A pending handler prevents hibernation. No correctness state depends on these chains after eviction.
    private readonly chains = new WeakMap<WebSocket, Promise<void>>();
    private readonly config: BridgeServerConfig;
    private readonly devices: ReturnType<typeof createDeviceService>;
    private alarmChain: Promise<void> = Promise.resolve();
    constructor(private readonly ctx: DurableObjectState, env: Env) {
      this.config = configFor(env);
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(CF_HEARTBEAT_PING, CF_HEARTBEAT_PONG));
      this.devices = createDeviceService({ store: this.config.adapters.store, now: () => new Date(this.now()), lastSeenIntervalMs: this.config.lastSeenIntervalMs });
      const find = (id: string) => this.sockets().find((ws) => this.attachment(ws).id === id);
      this.transport = {
        bind: (h) => { if (this.handler) throw new Error("relay handler already bound"); this.handler = h; },
        accept: (request, peer) => this.accept(request, peer),
        disconnect: async (u, filter, code, reason) => {
          const targets = this.transport.connections(u, filter);
          for (const c of targets) this.transport.close(c.id, code, reason);
          await this.schedule();
          return targets.length;
        },
        connections: (u, f = {}) => this.sockets().map((ws) => this.attachment(ws)).filter((a) => a.peer.userId === u && matches(a.peer, f)),
        setState: (id, state) => {
          const ws = find(id); if (!ws) return;
          const a = this.attachment(ws);
          save(ws, { ...a, state });
        },
        send: (id, data) => {
          const ws = find(id); if (!ws) return "closed";
          // Workers currently exposes no bufferedAmount. If present on a runtime, honor it;
          // otherwise platform send failures and the per-message cap bound our own queue (zero).
          const buffered = (ws as WebSocket & { bufferedAmount?: number }).bufferedAmount;
          if (buffered !== undefined && buffered + bytes(data) > (this.config.maxQueuedBytes ?? 4 * 1024 * 1024)) {
            this.transport.close(id, 1013, "backpressure"); return "dropped_backpressure";
          }
          try { ws.send(data); return (buffered ?? 0) > 0 ? "queued" : "sent"; }
          catch { this.terminate(ws, 1013, "send failed"); return "dropped_backpressure"; }
        },
        close: (id, code, reason) => {
          const ws = find(id); if (!ws) return;
          this.terminate(ws, code, reason);
        },
      };
      this.transport.bind(createRelayCore({ ...this.config, adapters: { ...this.config.adapters, relay: this.transport } }, this.transport));
    }
    private terminate(ws: WebSocket, code: number, reason: string): void {
      const a = this.attachment(ws);
      if (a.closed) return;
      // Use the socket directly: a failing send can already have removed it from
      // getWebSockets()/OPEN state. Its queued inbound events still need discarding.
      save(ws, { ...a, closed: true, discard: true });
      try { ws.close(code, reason.slice(0, 30)); } catch { /* runtime already closed it */ }
      this.ctx.waitUntil(this.enqueue(ws, () => this.handler.onClose(a, code, reason), true).then(() => this.schedule()));
    }
    private now(): number { return (this.config.now?.() ?? new Date()).getTime(); }
    private ownsUser(userId: string): boolean {
      // state.id.name is not available on every Workers runtime. Compare the
      // deterministic namespace id when using the kit's gateway, including on wake.
      const namespace = namespaces.get(this.config.adapters.relay as RelayGateway);
      return namespace ? namespace.idFromName(userId).equals(this.ctx.id) : this.ctx.id.name === userId;
    }
    private lastInbound(ws: WebSocket): number {
      return Math.max(this.attachment(ws).lastInbound, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0);
    }
    private attachment(ws: WebSocket): Attachment { return ws.deserializeAttachment() as Attachment; }
    private sockets(): WebSocket[] { return this.ctx.getWebSockets().filter((ws) => { const a = this.attachment(ws); return a && !a.closed && ws.readyState === 1; }); }
    private enqueue(ws: WebSocket, fn: () => void | Promise<void>, always = false): Promise<void> {
      const chain = (this.chains.get(ws) ?? Promise.resolve()).then(async () => {
        if (always || !this.attachment(ws).discard) await fn();
      }).catch(() => { this.transport.close(this.attachment(ws).id, 1011, "internal error"); });
      this.chains.set(ws, chain);
      return chain;
    }
    private schedule(): Promise<void> {
      // Serialize read/compare/write so concurrent sockets cannot install a stale
      // deadline. Read durable storage rather than caching alarm state across eviction.
      const next = this.alarmChain.catch(() => {}).then(async () => {
        const sockets = this.sockets();
        const now = this.now();
        const deadline = sockets.length ? Math.min(now + SWEEP_MS, ...sockets.flatMap((ws) => {
          const a = this.attachment(ws);
          return a.peer.role === "runner" && !a.state.greeted ? [a.helloDeadline] : [];
        })) : null;
        const current = await this.ctx.storage.getAlarm();
        if (deadline === null ? current === null : current !== null && current > now && current <= deadline) return;
        if (deadline === null) await this.ctx.storage.deleteAlarm();
        else await this.ctx.storage.setAlarm(deadline);
      });
      this.alarmChain = next;
      return next;
    }
    private async accept(request: Request, peer: RelayPeer): Promise<Response> {
      if (!this.ownsUser(peer.userId)) return new Response("Wrong relay user", { status: 403 });
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Upgrade Required", { status: 426 });
      // Refuse before replacing anything, so a refused upgrade never kicks a live tab.
      const limits = resolveSocketLimits(this.config);
      const held = this.transport.connections(peer.userId, { role: peer.role }).filter((c) => !(peer.role === "browser" && c.peer.role === "browser" && c.peer.browserKeyId === peer.browserKeyId));
      if (held.length >= (peer.role === "browser" ? limits.maxBrowserSockets : limits.maxRunnerSockets)) return new Response("Too many connections", { status: 429, headers: { "retry-after": "30" } });
      if (peer.role === "browser") {
        for (const old of this.transport.connections(peer.userId, { role: "browser", browserKeyId: peer.browserKeyId })) this.transport.close(old.id, RELAY_CLOSE_REPLACED, "replaced");
      }
      const pair = new WebSocketPair();
      const ws = pair[1];
      const latest = Math.max(0, ...this.sockets().map((s) => Date.parse(this.attachment(s).state.connectedAt)));
      const now = this.now();
      const a: Attachment = { id: crypto.randomUUID(), peer, state: { connectedAt: new Date(Math.max(now, latest + 1)).toISOString() }, helloDeadline: now + HELLO_MS, lastInbound: now };
      save(ws, a);
      this.ctx.acceptWebSocket(ws);
      await this.enqueue(ws, () => this.handler.onOpen(a));
      await this.schedule();
      const headers = request.headers.get("sec-websocket-protocol") === RELAY_SUBPROTOCOL ? { "sec-websocket-protocol": RELAY_SUBPROTOCOL } : undefined;
      return new Response(null, { status: 101, webSocket: pair[0], headers });
    }
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === "/accept" && request.method === "GET") {
        const peer = JSON.parse(request.headers.get(PEER_HEADER) ?? "null") as RelayPeer | null;
        if (!peer || !peer.userId || (peer.role !== "runner" && peer.role !== "browser")) return new Response("Invalid peer", { status: 400 });
        return this.transport.accept(request, peer);
      }
      if (path === "/disconnect" && request.method === "POST") {
        const { userId, filter, code, reason } = await request.json<{ userId: string; filter: ConnectionFilter; code: number; reason: string }>();
        if (typeof userId !== "string" || !this.ownsUser(userId)) return new Response("Wrong relay user", { status: 403 });
        return Response.json(await this.transport.disconnect(userId, filter, code, reason));
      }
      return new Response("Not found", { status: 404 });
    }
    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      if (this.attachment(ws).closed) return;
      // Record receipt before an async core handler; its work cannot make a live
      // socket look idle. Auto-responded pings are tracked by the runtime instead.
      save(ws, { ...this.attachment(ws), lastInbound: this.now() });
      if (typeof message !== "string") { this.transport.close(this.attachment(ws).id, 1003, "text only"); return; }
      await this.enqueue(ws, async () => {
        // The runtime normally consumes pings without waking the DO. Keep the
        // event path symmetric as well; neither heartbeat string reaches core.
        if (message === CF_HEARTBEAT_PING) { this.transport.send(this.attachment(ws).id, CF_HEARTBEAT_PONG); return; }
        if (message === CF_HEARTBEAT_PONG) return;
        await this.handler.onMessage(this.attachment(ws), message);
      });
    }
    async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
      const a = this.attachment(ws);
      // Hibernating sockets require the close callback to complete the handshake,
      // including sockets we already marked closed on server termination.
      try { ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason.slice(0, 30)); } catch { /* closed */ }
      if (!a || a.closed) return;
      save(ws, { ...a, closed: true });
      await this.enqueue(ws, () => this.handler.onClose(this.attachment(ws), code, reason), true);
      await this.schedule();
    }
    async webSocketError(ws: WebSocket, _error: unknown): Promise<void> { this.terminate(ws, 1011, "socket error"); }
    async alarm(): Promise<void> {
      for (const ws of this.sockets()) {
        const a = this.attachment(ws);
        if (a.peer.role === "runner" && !a.state.greeted && a.helloDeadline <= this.now()) { this.transport.close(a.id, 1008, "hello timeout"); continue; }
        // Tokens are checked only at upgrade: bound how long a socket outlives its credential.
        const { maxSocketAgeMs: maxAge } = resolveSocketLimits(this.config);
        if (maxAge > 0 && this.now() - Date.parse(a.state.connectedAt) >= maxAge) { this.transport.close(a.id, RELAY_CLOSE_MAX_AGE, "max age"); continue; }
        const lastInbound = this.lastInbound(ws);
        if (this.now() - lastInbound >= IDLE_MS) { this.transport.close(a.id, 1001, "heartbeat timeout"); continue; }
        if (a.peer.role === "runner" && a.state.greeted && lastInbound > (a.lastSeenAttempt ?? 0) && this.now() - (a.lastSeenAttempt ?? 0) >= (this.config.lastSeenIntervalMs ?? 300_000)) {
          save(ws, { ...a, lastSeenAttempt: this.now() });
          this.ctx.waitUntil(this.devices.recordSeen(a.peer.userId, a.peer.runnerId).catch(() => {}));
        }
      }
      await this.schedule();
    }
  };
}
