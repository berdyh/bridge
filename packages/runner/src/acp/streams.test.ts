import { PassThrough } from "node:stream";

import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import type { JsonRpcMessage, MessageStream } from "./contracts.js";
import { RPC_ERROR, RpcError, createRpcPeer } from "./rpc.js";
import { ndjsonMessageStream, toAcpStream } from "./streams.js";

function pipePair() {
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output, stream: ndjsonMessageStream(input, output) };
}

function memoryPair(): [MessageStream<JsonRpcMessage>, MessageStream<JsonRpcMessage>] {
  interface Side extends MessageStream<JsonRpcMessage> {
    peer: Side;
    handlers: Set<(m: JsonRpcMessage) => void>;
  }
  const make = (): Side => {
    const handlers = new Set<(m: JsonRpcMessage) => void>();
    const closers = new Set<(r?: string) => void>();
    let closed = false;
    const s: Side = {
      peer: undefined as unknown as Side,
      get closed() {
        return closed;
      },
      send(m: JsonRpcMessage) {
        if (closed) throw new Error("closed");
        const target = s.peer;
        queueMicrotask(() => [...target.handlers].forEach((h) => h(m)));
      },
      handlers,
      onMessage(h: (m: JsonRpcMessage) => void) {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      onClose(h: (r?: string) => void) {
        closers.add(h);
        return () => closers.delete(h);
      },
      close(reason?: string) {
        if (closed) return;
        closed = true;
        closers.forEach((h) => h(reason));
        if (!s.peer.closed) s.peer.close(reason);
      },
    };
    return s;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe("ndjsonMessageStream", () => {
  it("parses messages split across chunks and multi-byte characters", async () => {
    const { input, stream } = pipePair();
    const got: JsonRpcMessage[] = [];
    stream.onMessage((m) => got.push(m));
    const line = `${JSON.stringify({ jsonrpc: "2.0", method: "x", params: { t: "héllo ✓" } })}\n`;
    const bytes = Buffer.from(line + line);
    input.write(bytes.subarray(0, 25));
    input.write(bytes.subarray(25, 40));
    input.write(bytes.subarray(40));
    await new Promise((r) => setImmediate(r));
    expect(got).toHaveLength(2);
    expect(got[0]?.params).toEqual({ t: "héllo ✓" });
  });

  it("drops stray non-JSON-RPC lines without closing", async () => {
    const { input, stream } = pipePair();
    const got: JsonRpcMessage[] = [];
    stream.onMessage((m) => got.push(m));
    input.write('Debug: starting up\n{"not":"rpc"}\n[1,2]\n\n{"jsonrpc":"2.0","method":"ok"}\n');
    await new Promise((r) => setImmediate(r));
    expect(got.map((m) => m.method)).toEqual(["ok"]);
    expect(stream.closed).toBe(false);
  });

  it("holds messages that arrive before the first handler", async () => {
    const { input, stream } = pipePair();
    input.write('{"jsonrpc":"2.0","method":"early"}\n');
    await new Promise((r) => setImmediate(r));
    const got: string[] = [];
    stream.onMessage((m) => got.push(m.method as string));
    expect(got).toEqual(["early"]);
  });

  it("writes one line per message and closes once when the input ends", async () => {
    const { input, output, stream } = pipePair();
    const written: string[] = [];
    output.on("data", (c: Buffer) => written.push(c.toString()));
    await stream.send({ jsonrpc: "2.0", method: "a" });
    expect(written.join("")).toBe('{"jsonrpc":"2.0","method":"a"}\n');
    const reasons: (string | undefined)[] = [];
    stream.onClose((r) => reasons.push(r));
    input.end();
    await new Promise((r) => setImmediate(r));
    expect(stream.closed).toBe(true);
    expect(reasons).toEqual(["input ended"]);
    await expect(stream.send({ jsonrpc: "2.0", method: "b" })).rejects.toThrow(/closed/);
    stream.close();
    expect(reasons).toHaveLength(1);
  });

  it("closes on an over-long line", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const stream = ndjsonMessageStream(input, output, { maxLineBytes: 64 });
    input.write("x".repeat(100));
    await new Promise((r) => setImmediate(r));
    expect(stream.closed).toBe(true);
  });

  it("applies the line cap to a complete, newline-terminated line before parsing it", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const stream = ndjsonMessageStream(input, output, { maxLineBytes: 64 });
    const seen: unknown[] = [];
    stream.onMessage((m) => seen.push(m));
    const reasons: (string | undefined)[] = [];
    stream.onClose((r) => reasons.push(r));
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "ok" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "m", params: { pad: "x".repeat(256) } })}\n`);
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([{ jsonrpc: "2.0", method: "ok" }]);
    expect(stream.closed).toBe(true);
    expect(reasons).toEqual(["line too long"]);
  });

  it("counts the line cap in bytes, not characters", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const stream = ndjsonMessageStream(input, output, { maxLineBytes: 64 });
    // 30 characters, 90 bytes.
    input.write("\u20ac".repeat(30));
    await new Promise((r) => setImmediate(r));
    expect(stream.closed).toBe(true);
  });
});

describe("rpc peer", () => {
  it("correlates requests, answers with errors, and never dies on a malformed message", async () => {
    const [a, b] = memoryPair();
    const server = createRpcPeer(b, {
      onRequest(method) {
        if (method === "boom") throw new Error("secret detail");
        if (method === "typed") throw new RpcError(-32010, "typed failure");
        return { ok: method };
      },
      onNotification() {},
    });
    const client = createRpcPeer(a, { onRequest: () => null, onNotification: () => undefined });
    await expect(client.request("ping")).resolves.toEqual({ ok: "ping" });
    await expect(client.request("typed")).rejects.toMatchObject({ code: -32010, message: "typed failure" });
    // Unknown errors are generic: no internal message reaches the other side.
    await expect(client.request("boom")).rejects.toMatchObject({ code: RPC_ERROR.internal, message: "Internal error" });

    const raw: JsonRpcMessage[] = [];
    a.onMessage((m) => raw.push(m));
    a.send({ jsonrpc: "2.0", id: 9, method: 5 } as unknown as JsonRpcMessage);
    a.send({ jsonrpc: "2.0", id: { nested: true }, method: "ping" } as unknown as JsonRpcMessage);
    await new Promise((r) => setTimeout(r, 10));
    expect(raw.some((m) => (m.error as { code: number } | undefined)?.code === RPC_ERROR.invalidRequest)).toBe(true);
    await expect(client.request("ping")).resolves.toEqual({ ok: "ping" });
    expect(server.closed).toBe(false);
  });

  it("fails pending requests when the connection closes", async () => {
    const [a, b] = memoryPair();
    createRpcPeer(b, { onRequest: () => new Promise(() => undefined), onNotification: () => undefined });
    const client = createRpcPeer(a, { onRequest: () => null, onNotification: () => undefined });
    const pending = client.request("never");
    a.close("gone");
    await expect(pending).rejects.toMatchObject({ code: RPC_ERROR.closed });
  });
});

describe("toAcpStream", () => {
  it("lets the ACP SDK's connection run over an arbitrary MessageStream", async () => {
    const [clientSide, agentSide] = memoryPair();
    createRpcPeer(agentSide, {
      onRequest(method) {
        if (method === "initialize") return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] };
        throw new RpcError(RPC_ERROR.methodNotFound, "nope");
      },
      onNotification() {},
    });
    const connection = new ClientSideConnection(
      () => ({ requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }), sessionUpdate: async () => undefined }),
      toAcpStream(clientSide),
    );
    const init = await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});
