import { Console } from "node:console";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import type { Readable, Writable } from "node:stream";
import { PLUGIN_RPC, SESSION_END_REASONS, isSessionQuiescence, parseExtensionMethod, validatePluginManifest, type PluginManifest, type SessionEndReason, type SessionEvent, type SessionQuiescence } from "@berdyh/bridge-protocol";
import type { AgentSession, MethodHandler, PluginContext, PluginLogger, PluginSetup } from "./contracts.js";
import { RpcPeer, rpcError } from "./rpc.js";

/** Injectable streams for embedded plugins and tests; definePlugin uses stdio. */
export interface PluginRuntimeOptions {
  manifest: PluginManifest;
  dataDir: string;
  input: Readable;
  output: Writable;
  onDisconnect?: () => void;
}

let stderrGuarded = false;

/** The most events a session holds before its first listener, or the host sends about a handle that is still being registered. */
const SESSION_EVENT_LIMIT = 1024;
/** The most handles with events held while their starts are in flight. */
const EARLY_HANDLE_LIMIT = 64;

export async function runPlugin(setup: PluginSetup, options: PluginRuntimeOptions): Promise<{ close(): Promise<void> }> {
  const validated = validatePluginManifest(options.manifest);
  if (!validated.ok) throw new Error(validated.errors.join("; "));
  const manifest = validated.value;
  const methods = new Map<string, MethodHandler>();
  const calls = new AsyncLocalStorage<string | undefined>();
  const servers = new Set<import("node:http").Server>();
  const peer = new RpcPeer(options.input, options.output);
  // The sessions this process started, by the host's handle: where `host/sessionUpdate` and `host/sessionEnded` land.
  const sessions = new Map<string, { update(event: SessionEvent): void; end(reason: SessionEndReason, quiescence?: SessionQuiescence): void; quiesce(receipt: SessionQuiescence): void; disconnect(): void }>();
  // What the host sent about a handle whose start response has not registered it yet (the response and the
  // events behind it can reach `onNotification` in one chunk, before the request's continuation runs). Held only
  // while a start is in flight, bounded, and replayed in arrival order once the handle is registered. The end of a
  // session is not an event: it has a slot of its own per pending handle, outside the event limit, so a full buffer
  // never costs a session its end. It is delivered after the events, once.
  const early = new Map<string, SessionEvent[]>();
  const earlyEnd = new Map<string, { reason: SessionEndReason; quiescence?: SessionQuiescence }>();
  const earlyQuiescence = new Map<string, SessionQuiescence>();
  let starting = 0;
  let disconnected = false;
  const log = Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level,
    (message: string, fields?: Record<string, unknown>) => {
      // Logging must never throw: after the host disconnects, `finally { log.info() }` would turn into a rejection.
      try { peer.notify(PLUGIN_RPC.log, { level, message, fields }); }
      catch {
        // Fall back to stderr only while it is usable; its async EPIPE must not become an uncaught error.
        const err = process.stderr;
        if (err.writable && !err.destroyed) {
          if (!stderrGuarded) { stderrGuarded = true; err.on("error", () => {}); }
          try { err.write(`[${manifest.id}] ${level}: ${message}\n`); } catch { /* nowhere left to log */ }
        }
      }
    },
  ])) as unknown as PluginLogger;
  const context: PluginContext = {
    pluginId: manifest.id,
    dataDir: options.dataDir,
    log,
    registerMethod(name, handler) {
      if (parseExtensionMethod(name)?.pluginId !== manifest.id) throw new Error("Method must use the plugin's own prefix");
      methods.set(name, handler);
    },
    async startAgentSession(request) {
      if (!manifest.permissions.agents?.includes(request.agent)) throw rpcError("Agent not declared", -32012);
      if (request.onBehalfOf && request.onBehalfOf.appId !== manifest.app) throw rpcError("Browser belongs to another app", -32014);
      // Send only the documented fields; plugins cannot set a permission mode. The host judges every one of them
      // against the consent before anything starts, so none is dropped or defaulted here. `budget` is sent only
      // when the plugin names one: the runner applies its own default (15 minutes, 200 tool calls) and ceiling.
      starting++;
      let result: { sessionId: string };
      let closed = false;
      let cleanupReceived = false;
      const handlers = new Set<(event: SessionEvent) => void>();
      // The events that came before anyone listened go to the first listener, once: a plugin can only subscribe after the start returns.
      let backlog: SessionEvent[] | undefined = [];
      let end!: (result: { reason: SessionEndReason }) => void;
      const ended = new Promise<{ reason: SessionEndReason }>((resolve) => { end = resolve; });
      let settleQuiescence!: (receipt: SessionQuiescence) => void;
      let quiescenceDeadline: NodeJS.Timeout | undefined;
      const quiescence = new Promise<SessionQuiescence>((resolve) => {
        settleQuiescence = (receipt) => { clearTimeout(quiescenceDeadline); resolve(receipt); };
      });
      try {
        result = await peer.request(PLUGIN_RPC.startAgentSession, {
          agent: request.agent, cwd: request.cwd, onBehalfOf: request.onBehalfOf,
          callToken: calls.getStore(),
          execution: request.execution, broker: request.broker, mcpServers: request.mcpServers, tools: request.tools, secret: request.secret,
          model: request.model, budget: request.budget, headless: request.headless,
        }, null) as { sessionId: string };
        sessions.set(result.sessionId, {
          update(event) {
            if (cleanupReceived) return;
            if (backlog) { if (backlog.length < SESSION_EVENT_LIMIT) backlog.push(event); return; }
            for (const handler of [...handlers]) { try { handler(event); } catch { /* A plugin's handler must not break the wire. */ } }
          },
          end(reason, receipt) {
            closed = true; handlers.clear(); sessions.delete(result.sessionId); end({ reason });
            settleQuiescence(receipt ?? { status: "incomplete", mechanism: "unknown", reason: "cleanup-unavailable" });
          },
          quiesce(receipt) {
            closed = true; cleanupReceived = true; handlers.clear(); settleQuiescence(receipt);
          },
          disconnect() {
            closed = true; handlers.clear(); sessions.delete(result.sessionId);
            settleQuiescence({ status: "incomplete", mechanism: "unknown", reason: "disconnected" });
          },
        });
        const held = early.get(result.sessionId) ?? [];
        const heldEnd = earlyEnd.get(result.sessionId);
        const heldQuiescence = earlyQuiescence.get(result.sessionId);
        early.delete(result.sessionId);
        earlyEnd.delete(result.sessionId);
        earlyQuiescence.delete(result.sessionId);
        const live = sessions.get(result.sessionId)!;
        for (const event of held) live.update(event);
        if (heldQuiescence !== undefined) live.quiesce(heldQuiescence);
        if (heldEnd !== undefined) live.end(heldEnd.reason, heldEnd.quiescence);
        if (disconnected && sessions.has(result.sessionId)) live.disconnect();
      } finally {
        if (--starting === 0) { early.clear(); earlyEnd.clear(); earlyQuiescence.clear(); }
      }
      const session: AgentSession = {
        sessionId: result.sessionId,
        async prompt(text) {
          if (closed) throw new Error("Session closed");
          return await peer.request("host/sessionPrompt", { sessionId: result.sessionId, text }, null) as { stopReason: string; text: string };
        },
        async cancel() {
          if (!closed) await peer.request("host/sessionCancel", { sessionId: result.sessionId }, null);
        },
        async close() {
          if (closed) return;
          closed = true;
          // Even an older host that sends no ended receipt cannot leave a caller's
          // requested cleanup completion pending forever. close itself keeps its API.
          quiescenceDeadline = setTimeout(() => settleQuiescence({ status: "incomplete", mechanism: "unknown", reason: "timeout" }), 30_000);
          quiescenceDeadline.unref();
          await peer.request("host/sessionClose", { sessionId: result.sessionId }, null);
        },
        onUpdate(handler) {
          handlers.add(handler);
          if (backlog) {
            const held = backlog;
            backlog = undefined;
            for (const event of held) {
              if (!handlers.has(handler)) break;
              try { handler(event); } catch { /* A plugin's handler must not break the wire. */ }
            }
          }
          return () => { handlers.delete(handler); };
        },
        ended,
        quiescence,
      };
      return session;
    },
    localUi: {
      async listen(handler) {
        if (!manifest.permissions.localUi) throw rpcError("Local UI not declared", -32012);
        const server = createServer(handler);
        servers.add(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No local UI address");
        const url = `http://127.0.0.1:${address.port}`;
        peer.notify(PLUGIN_RPC.localUi, { url });
        return { url, close: () => closeServer(server) };
      },
    },
  };
  function closeServer(server: import("node:http").Server): Promise<void> {
    servers.delete(server);
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  }
  async function close(): Promise<void> {
    disconnected = true;
    for (const live of [...sessions.values()]) live.disconnect();
    peer.close();
    await Promise.all([...servers].map(closeServer));
  }
  peer.onNotification = (method, raw) => {
    const p = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as { sessionId?: unknown; event?: unknown; reason?: unknown; quiescence?: unknown } : undefined;
    if (!p || typeof p.sessionId !== "string") return;
    const live = sessions.get(p.sessionId);
    if (method === PLUGIN_RPC.sessionUpdate && p.event && typeof p.event === "object") {
      const event = p.event as SessionEvent;
      if (live) { live.update(event); return; }
      // An unknown handle is held only for a start that may be about to register it; nothing follows its end.
      if (starting === 0 || earlyEnd.has(p.sessionId) || earlyQuiescence.has(p.sessionId)) return;
      const held = early.get(p.sessionId);
      if (held) { if (held.length < SESSION_EVENT_LIMIT) held.push(event); }
      else if (early.size < EARLY_HANDLE_LIMIT) early.set(p.sessionId, [event]);
    } else if (method === PLUGIN_RPC.sessionQuiescence) {
      const receipt: SessionQuiescence = isSessionQuiescence(p.quiescence) ? p.quiescence : { status: "incomplete", mechanism: "unknown", reason: "cleanup-unavailable" };
      if (live) { live.quiesce(receipt); return; }
      if (starting === 0 || earlyEnd.has(p.sessionId) || earlyQuiescence.has(p.sessionId)) return;
      if (earlyQuiescence.size < Math.max(EARLY_HANDLE_LIMIT, starting)) earlyQuiescence.set(p.sessionId, receipt);
    } else if (method === PLUGIN_RPC.sessionEnded && (SESSION_END_REASONS as readonly unknown[]).includes(p.reason)) {
      const reason = p.reason as SessionEndReason;
      const receipt = isSessionQuiescence(p.quiescence) ? p.quiescence : undefined;
      if (live) { live.end(reason, receipt); return; }
      // One slot per pending handle, kept apart from the event limit; the first end wins.
      if (starting === 0 || earlyEnd.has(p.sessionId)) return;
      if (earlyEnd.size < Math.max(EARLY_HANDLE_LIMIT, starting)) earlyEnd.set(p.sessionId, { reason, ...(receipt ? { quiescence: receipt } : {}) });
    }
  };
  peer.onClose = () => { void close().finally(options.onDisconnect); };
  peer.onRequest = async (method, raw) => {
    if (method !== PLUGIN_RPC.call) throw rpcError("Method not found", -32601);
    const p = raw as { method?: string; params?: unknown; callToken?: string; caller?: { appId: string; browserKeyId: string } } | null;
    if (!p || typeof p.method !== "string" || !p.caller || typeof p.caller.browserKeyId !== "string") throw rpcError("Invalid call", -32602);
    if (p.caller.appId !== manifest.app) throw rpcError("Caller belongs to another app", -32014);
    const handler = methods.get(p.method);
    if (!handler) throw rpcError("Method not found", -32601);
    return calls.run(typeof p.callToken === "string" ? p.callToken : undefined, () => handler(p.params, p.caller!));
  };
  try {
    await setup(context);
    peer.notify("plugin/ready", {});
  } catch (error) { await close(); throw error; }
  return { close };
}

/** Connect a plugin entry module to the runner's JSON-RPC stdio connection. */
export function definePlugin(setup: PluginSetup): void {
  // Reserve stdout for JSON-RPC, including console calls made by dependencies.
  const diagnostics = new Console({ stdout: process.stderr, stderr: process.stderr });
  globalThis.console = diagnostics;
  try {
    const manifest: unknown = JSON.parse(process.env.BRIDGE_PLUGIN_MANIFEST ?? "null");
    const result = validatePluginManifest(manifest);
    const dataDir = process.env.PLUGIN_DATA;
    if (!result.ok || !dataDir) throw new Error("Plugin must be launched by a bridge host");
    void runPlugin(setup, {
      manifest: result.value, dataDir, input: process.stdin, output: process.stdout,
      onDisconnect: () => { process.stdin.pause(); },
    }).catch((error: unknown) => { console.error(error); process.exitCode = 1; process.stdin.destroy(); });
  } catch (error) { console.error(error); process.exitCode = 1; }
}
