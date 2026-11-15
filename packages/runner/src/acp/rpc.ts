/**
 * A thin JSON-RPC 2.0 peer over a `MessageStream`. The proxy is a forwarder: it must pass
 * through methods it has no typed model for and must answer a malformed message with an
 * error instead of dying, so it works at this level rather than through the ACP SDK's
 * per-method connection classes. Internal to the runner (not in the package barrel).
 */
import type { JsonRpcMessage, MessageStream } from "./contracts.js";

export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  closed: -32000,
} as const;

/** An error that travels as a JSON-RPC error object. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcHandlers {
  /** Resolves with the result, or throws (an `RpcError` keeps its code, anything else is -32603). */
  onRequest(method: string, params: unknown): Promise<unknown> | unknown;
  onNotification(method: string, params: unknown): void;
}

export interface RpcPeer {
  request(method: string, params?: unknown): Promise<unknown>;
  /** Forgets a pending outgoing request: it rejects with a `closed` error and a late answer is ignored. */
  forget(request: Promise<unknown>): void;
  /** Number of outgoing requests still waiting for an answer. */
  readonly pendingCount: number;
  notify(method: string, params?: unknown): void;
  readonly closed: boolean;
  close(reason?: string): void;
}

/** Turns an arbitrary thrown value into a wire error. Only `RpcError` messages are shown. */
export function toWireError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof RpcError) {
    return error.data === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, data: error.data };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "number" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    const e = error as { code: number; message: string; data?: unknown };
    return e.data === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, data: e.data };
  }
  return { code: RPC_ERROR.internal, message: "Internal error" };
}

export function createRpcPeer(stream: MessageStream<JsonRpcMessage>, handlers: RpcHandlers): RpcPeer {
  let nextId = 1;
  const pending = new Map<string | number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  const ids = new WeakMap<Promise<unknown>, string | number>();

  const send = (message: JsonRpcMessage) => {
    if (stream.closed) return;
    try {
      const result = stream.send(message);
      if (result && typeof (result as Promise<void>).catch === "function") (result as Promise<void>).catch(() => undefined);
    } catch {
      // a send on a dying stream is dropped; its close handler cleans up
    }
  };
  const respondError = (id: unknown, error: { code: number; message: string; data?: unknown }) =>
    send({ jsonrpc: "2.0", id: id as string | number | null, error });

  const failPending = (reason: string) => {
    const entries = [...pending.values()];
    pending.clear();
    for (const p of entries) p.reject(new RpcError(RPC_ERROR.closed, reason));
  };

  stream.onClose((reason) => failPending(`connection closed${reason ? `: ${reason}` : ""}`));

  stream.onMessage((message) => {
    const m = message as Record<string, unknown>;
    const hasId = typeof m.id === "string" || typeof m.id === "number";
    if (typeof m.method === "string") {
      if (hasId) {
        const id = m.id as string | number;
        void (async () => {
          try {
            const result = await handlers.onRequest(m.method as string, m.params);
            send({ jsonrpc: "2.0", id, result: result ?? null });
          } catch (error) {
            respondError(id, toWireError(error));
          }
        })();
      } else if (m.id === undefined) {
        try {
          handlers.onNotification(m.method, m.params);
        } catch {
          // notifications have no answer
        }
      } else {
        respondError(null, { code: RPC_ERROR.invalidRequest, message: "Invalid request id" });
      }
      return;
    }
    if (hasId && ("result" in m || "error" in m)) {
      const waiter = pending.get(m.id as string | number);
      if (!waiter) return;
      pending.delete(m.id as string | number);
      if ("error" in m && typeof m.error === "object" && m.error !== null) {
        const e = m.error as { code?: unknown; message?: unknown; data?: unknown };
        waiter.reject(
          new RpcError(typeof e.code === "number" ? e.code : RPC_ERROR.internal, typeof e.message === "string" ? e.message : "error", e.data),
        );
      } else {
        waiter.resolve(m.result);
      }
      return;
    }
    // Anything else (no method, no usable id): answer if it has a request-looking id, else drop.
    if (hasId) respondError(m.id, { code: RPC_ERROR.invalidRequest, message: "Invalid request" });
  });

  return {
    request(method, params) {
      if (stream.closed) return Promise.reject(new RpcError(RPC_ERROR.closed, "connection closed"));
      const id = nextId++;
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
      });
      ids.set(promise, id);
      return promise;
    },
    forget(request) {
      const id = ids.get(request);
      if (id === undefined) return;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      waiter.reject(new RpcError(RPC_ERROR.closed, "request forgotten"));
    },
    get pendingCount() {
      return pending.size;
    },
    notify(method, params) {
      send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
    },
    get closed() {
      return stream.closed;
    },
    close(reason) {
      stream.close(reason);
    },
  };
}
