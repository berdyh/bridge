import { AsyncLocalStorage } from "node:async_hooks";

import type { JsonRpcMessage } from "@berdyh/bridge-protocol";
import { PROXY_ERROR, type AgentAdapter, type AgentProcess, type BrowserChannel } from "@berdyh/bridge-runner";

import type { SessionCaps } from "./deps.js";

/**
 * Caps concurrent agent sessions per browser channel and per app, so an enrolled
 * browser cannot loop `session/new` and spawn unbounded agents. It sits around the
 * proxy without changing it:
 *
 *  - a `session/new` over a cap is answered with an error here and never reaches the proxy;
 *  - a session counts from the moment its agent is spawned until that process exits, which the
 *    proxy cannot hide: a crashed agent frees its slot, a closed channel kills its agents.
 *
 * Which channel a spawn belongs to travels in an `AsyncLocalStorage` set around the browser's
 * `session/new` message, and only counts while that channel has a `session/new` in flight, so a
 * plugin-brokered session (no browser request in flight) is never charged to a channel; it is
 * charged to the app counter instead, and refused when the app is at its cap.
 */
export interface SessionLimiter {
  /** The adapters to give the proxy: same ids, spawn counted. */
  wrapAdapters(adapters: readonly AgentAdapter[]): AgentAdapter[];
  /** The channel to attach to the proxy instead of `channel`. */
  wrapChannel(channel: BrowserChannel): BrowserChannel;
  /** Live agent processes and in-flight starts, for diagnostics and tests. */
  usage(): { app: number; byChannel: Record<string, number> };
}

interface Counter {
  live: number;
  /** In-flight `session/new` requests whose agent is not spawned yet. */
  starting: number;
}

interface ChannelCtx {
  counter: Counter;
  /** Every browser request still unanswered, by id. A `session/new` holds a reservation. */
  pending: Map<string, { sessionNew: boolean; spawned: boolean }>;
}

/** The channel and the request whose `session/new` a spawn belongs to. */
interface SpawnScope {
  ctx: ChannelCtx;
  key: string;
}

/** JSON-RPC 2.0 "Invalid Request". */
const INVALID_REQUEST = -32600;
const used = (c: Counter): number => c.live + c.starting;
const keyOf = (id: unknown): string => `${typeof id}:${String(id)}`;

export function createSessionLimiter(caps: SessionCaps): SessionLimiter {
  const als = new AsyncLocalStorage<SpawnScope>();
  const app: Counter = { live: 0, starting: 0 };
  const channels = new Map<string, Counter>();

  const wrapAdapter = (adapter: AgentAdapter): AgentAdapter => ({
    id: adapter.id,
    availability: () => adapter.availability(),
    // The proxy reads this to decide whether a contained session may start: dropping it refuses every one of them.
    ...(adapter.containment ? { containment: () => adapter.containment!() } : {}),
    // Likewise the reason a contained session is refused, when it has a fixed code (the claude adapter is not installed): the proxy returns it to the plugin.
    ...(adapter.containmentRefusalReason ? { containmentRefusalReason: () => adapter.containmentRefusalReason!() } : {}),
    async spawn(options) {
      const scope = als.getStore();
      if (!scope) {
        // A plugin-brokered session: no browser request is in flight, so it counts toward the
        // app's cap only (there is no channel to charge), and is refused when the app is full.
        if (used(app) >= caps.perApp) throw new Error(`session limit reached (${caps.perApp} per app)`);
        app.starting++;
        let brokered: AgentProcess;
        try {
          brokered = await adapter.spawn(options);
        } finally {
          app.starting--;
        }
        app.live++;
        void brokered.exited.finally(() => {
          app.live--;
        });
        return brokered;
      }
      const proc = await adapter.spawn(options);
      const { ctx } = scope;
      // Charge the reservation of the request this spawn runs under, never another request's.
      const reservation = ctx.pending.get(scope.key);
      if (!reservation || !reservation.sessionNew || reservation.spawned) return proc;
      reservation.spawned = true;
      ctx.counter.starting--;
      app.starting--;
      ctx.counter.live++;
      app.live++;
      void proc.exited.finally(() => {
        ctx.counter.live--;
        app.live--;
      });
      return proc;
    },
  });

  return {
    wrapAdapters: (adapters) => adapters.map(wrapAdapter),
    wrapChannel(channel) {
      const counter: Counter = { live: 0, starting: 0 };
      channels.set(channel.channelId, counter);
      const ctx: ChannelCtx = { counter, pending: new Map() };

      const release = (key: string): void => {
        const r = ctx.pending.get(key);
        if (!r) return;
        ctx.pending.delete(key);
        if (r.sessionNew && !r.spawned) {
          counter.starting--;
          app.starting--;
        }
      };
      channel.onClose(() => {
        channels.delete(channel.channelId);
        for (const key of [...ctx.pending.keys()]) release(key);
      });

      const refuse = (id: unknown, why?: string, code: number = PROXY_ERROR.sessionNotAllowed): void => {
        const error = {
          code,
          message: why ?? `session limit reached (${caps.perChannel} per browser, ${caps.perApp} per app)`,
        };
        try {
          const sent = channel.send({ jsonrpc: "2.0", id, error } as JsonRpcMessage);
          if (sent) void sent.catch(() => undefined);
        } catch {
          /* closing */
        }
      };

      return {
        get channelId() {
          return channel.channelId;
        },
        get appId() {
          return channel.appId;
        },
        get browserKeyId() {
          return channel.browserKeyId;
        },
        get closed() {
          return channel.closed;
        },
        send(message) {
          if (message.id !== undefined && ("result" in message || "error" in message)) release(keyOf(message.id));
          return channel.send(message);
        },
        onMessage(handler) {
          return channel.onMessage((message) => {
            // A message that carries an id must be a well-formed request or response. Anything else
            // (an id with no method and no result/error, or a method with a null or structured id)
            // would make the proxy answer `-32600` echoing the id, and that reply would release the
            // reservation of a pending `session/new` that reuses it, so its spawn would go uncharged.
            // Answer it here with a null id and never forward it.
            if (message.id !== undefined) {
              const validId = typeof message.id === "string" || typeof message.id === "number";
              const isResponse = message.method === undefined && ("result" in message || "error" in message);
              if (!validId || (typeof message.method !== "string" && !isResponse)) {
                return refuse(null, "invalid request", INVALID_REQUEST);
              }
              // A response carries exactly one of result/error, and an error is an object with an
              // integer code and a string message. Anything else is malformed and is never forwarded.
              if (isResponse && !wellFormedResponse(message as unknown as Record<string, unknown>)) {
                return refuse(null, "invalid request", INVALID_REQUEST);
              }
            }
            const isRequest = message.method !== undefined && message.id !== undefined;
            if (!isRequest) return handler(message);
            const key = keyOf(message.id);
            // JSON-RPC ids must be unique among pending requests; a reused in-flight id would
            // either reach the proxy without its own reservation or let an unrelated response
            // free a session's reservation.
            if (ctx.pending.has(key)) return refuse(message.id, "request id already in flight");
            if (message.method !== "session/new") {
              ctx.pending.set(key, { sessionNew: false, spawned: false });
              return handler(message);
            }
            if (used(counter) >= caps.perChannel || used(app) >= caps.perApp) return refuse(message.id);
            ctx.pending.set(key, { sessionNew: true, spawned: false });
            counter.starting++;
            app.starting++;
            return als.run({ ctx, key }, () => handler(message));
          });
        },
        onClose: (handler) => channel.onClose(handler),
        close: (reason) => channel.close(reason),
      };
    },
    usage() {
      const byChannel: Record<string, number> = {};
      for (const [id, c] of channels) byChannel[id] = used(c);
      return { app: used(app), byChannel };
    },
  };
}

/** JSON-RPC 2.0 response shape: exactly one of result/error; error = { integer code, string message }. */
function wellFormedResponse(m: Record<string, unknown>): boolean {
  const hasResult = "result" in m;
  const hasError = "error" in m;
  if (hasResult === hasError) return false;
  if (!hasError) return true;
  const e = m.error;
  if (typeof e !== "object" || e === null || Array.isArray(e)) return false;
  const { code, message } = e as Record<string, unknown>;
  return Number.isInteger(code) && typeof message === "string";
}
