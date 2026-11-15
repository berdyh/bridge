import type { Readable, Writable } from "node:stream";
import type { JsonRpcMessage } from "@berdyh/bridge-protocol";

export const MAX_FRAME_BYTES = 1024 * 1024;
export function rpcError(message: string, code = -32603, data?: unknown): Error & { code: number; data?: unknown } {
  return Object.assign(new Error(message), { code }, data === undefined ? {} : { data });
}

/**
 * The error `data` this connection carries: only the fixed reason and hint of a refused contained session (-32016,
 * `ContainedSessionRefusal`), exactly and with no other key. Anything else is dropped, here and again by the runner.
 */
function refusalData(code: number | undefined, data: unknown): { reason: "adapter_missing"; hint: string } | undefined {
  if (code !== -32016 || typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const { reason, hint } = data as { reason?: unknown; hint?: unknown };
  return Object.keys(data).length === 2 && reason === "adapter_missing" && hint === "bridge agent install claude" ? { reason, hint } : undefined;
}

/** A bounded, bidirectional NDJSON connection. Stdio is exclusively protocol data. */
export class RpcPeer {
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer?: NodeJS.Timeout }>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  onNotification?: (method: string, params: unknown) => void;
  onClose?: () => void;
  constructor(private input: Readable, private output: Writable, private timeoutMs = 30_000) {
    input.on("data", this.read);
    input.on("end", this.ended);
    input.on("error", this.ended);
    output.on("error", this.ended);
  }
  private ended = () => this.close();
  private read = (chunk: Buffer | string) => {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) !== -1) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > MAX_FRAME_BYTES) { this.close(rpcError("RPC frame too large")); return; }
      if (!line.length) continue;
      try {
        const message: unknown = JSON.parse(line.toString("utf8"));
        if (!message || typeof message !== "object" || Array.isArray(message) || (message as JsonRpcMessage).jsonrpc !== "2.0") {
          throw rpcError("Invalid JSON-RPC message", -32600);
        }
        void this.receive(message as JsonRpcMessage);
      } catch { this.close(rpcError("Invalid JSON-RPC frame", -32700)); return; }
    }
    if (this.buffer.length > MAX_FRAME_BYTES) this.close(rpcError("RPC frame too large"));
  };
  private async receive(message: JsonRpcMessage): Promise<void> {
    if (typeof message.method === "string") {
      if (!("id" in message)) {
        try { this.onNotification?.(message.method, message.params); } catch { this.close(); }
        return;
      }
      try {
        if (!this.onRequest) throw rpcError("Method not found", -32601);
        const result = await this.onRequest(message.method, message.params);
        this.send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
      } catch (error) {
        const failure = error as { code?: number; message?: string; data?: unknown };
        const code = failure?.code ?? -32603;
        const data = refusalData(code, failure?.data);
        try { this.send({ jsonrpc: "2.0", id: message.id, error: { code, message: failure?.message ?? "Request failed", ...(data ? { data } : {}) } }); } catch { /* Disconnected. */ }
      }
    } else if (typeof message.id === "number") {
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) {
        const error = message.error as { message?: string; code?: number; data?: unknown };
        item.reject(rpcError(error.message ?? "Request failed", error.code, error.data));
      } else item.resolve(message.result);
    }
  }
  send(message: JsonRpcMessage): void {
    if (this.closed) throw rpcError("Plugin connection closed");
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw rpcError("RPC frame too large");
    this.output.write(line);
  }
  notify(method: string, params: unknown): void { this.send({ jsonrpc: "2.0", method, params }); }
  /** A null timeout waits for completion or disconnect, for long-running work. */
  request(method: string, params: unknown, timeoutMs: number | null = this.timeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(rpcError("Plugin request timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close(error: Error = rpcError("Plugin connection closed")): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off("data", this.read);
    this.input.off("end", this.ended);
    this.input.off("error", this.ended);
    // Keep the output's error listener: an in-flight write may still emit EPIPE.
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.onClose?.();
  }
}
