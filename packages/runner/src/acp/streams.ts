import { StringDecoder } from "node:string_decoder";

import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

import { type JsonRpcMessage, type MessageStream } from "./contracts.js";

export interface NdjsonStreamOptions {
  /** A line longer than this closes the stream. Default 16 MiB. */
  maxLineBytes?: number;
  /** Called for a line that is not a JSON-RPC 2.0 object. It is dropped either way. */
  onInvalid?: (reason: string) => void;
}

const DEFAULT_MAX_LINE = 16 * 1024 * 1024;

function isJsonRpc(v: unknown): v is JsonRpcMessage {
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as { jsonrpc?: unknown }).jsonrpc === "2.0";
}

/**
 * Newline-delimited JSON over a child's stdout/stdin as a `MessageStream`.
 *
 * Lines that are not JSON-RPC objects are dropped (stray agent logging on stdout must not
 * end the session). Messages that arrive before the first `onMessage` handler are held and
 * delivered to it, so a caller that subscribes right after spawning loses nothing. The
 * stream closes when the input ends or errors, when the output fails, when a line is too
 * long, or on `close()`.
 */
export function ndjsonMessageStream(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  options: NdjsonStreamOptions = {},
): MessageStream<JsonRpcMessage> {
  const maxLine = options.maxLineBytes ?? DEFAULT_MAX_LINE;
  const messageHandlers = new Set<(m: JsonRpcMessage) => void>();
  const closeHandlers = new Set<(reason?: string) => void>();
  const backlog: JsonRpcMessage[] = [];
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let closed = false;
  let closeReason: string | undefined;

  const finish = (reason?: string) => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    input.removeListener("data", onData);
    messageHandlers.clear();
    backlog.length = 0;
    const handlers = [...closeHandlers];
    closeHandlers.clear();
    for (const h of handlers) {
      try {
        h(reason);
      } catch {
        // a close handler must not stop the others
      }
    }
  };

  const dispatch = (message: JsonRpcMessage) => {
    if (messageHandlers.size === 0) {
      backlog.push(message);
      return;
    }
    for (const h of [...messageHandlers]) {
      try {
        h(message);
      } catch {
        // a handler's failure is its own
      }
    }
  };

  const handleLine = (raw: string) => {
    const line = raw.trim();
    if (!line || closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      options.onInvalid?.("not JSON");
      return;
    }
    if (!isJsonRpc(parsed)) {
      options.onInvalid?.("not a JSON-RPC 2.0 object");
      return;
    }
    dispatch(parsed);
  };

  function tooLong() {
    buffer = "";
    finish("line too long");
    output.end();
  }

  function onData(chunk: Buffer | string) {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let index = buffer.indexOf("\n");
    while (index >= 0 && !closed) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      // The cap applies to complete lines too: a long line that arrives with its newline
      // must not get parsed just because it was not split across chunks.
      if (Buffer.byteLength(line) > maxLine) {
        tooLong();
        return;
      }
      handleLine(line);
      index = buffer.indexOf("\n");
    }
    if (!closed && Buffer.byteLength(buffer) > maxLine) tooLong();
  }

  input.on("data", onData);
  input.on("end", () => finish("input ended"));
  input.on("close", () => finish("input closed"));
  input.on("error", (error: Error) => finish(`input error: ${error.message}`));
  output.on("error", (error: Error) => finish(`output error: ${error.message}`));

  return {
    get closed() {
      return closed;
    },
    send(message) {
      if (closed) return Promise.reject(new Error(`stream closed${closeReason ? `: ${closeReason}` : ""}`));
      return new Promise<void>((resolve, reject) => {
        try {
          output.write(`${JSON.stringify(message)}\n`, (error?: Error | null) => (error ? reject(error) : resolve()));
        } catch (error) {
          reject(error);
        }
      });
    },
    onMessage(handler) {
      if (closed) return () => undefined;
      messageHandlers.add(handler);
      if (backlog.length > 0) {
        const pending = backlog.splice(0);
        for (const m of pending) {
          try {
            handler(m);
          } catch {
            // see dispatch
          }
        }
      }
      return () => {
        messageHandlers.delete(handler);
      };
    },
    onClose(handler) {
      if (closed) {
        queueMicrotask(() => handler(closeReason));
        return () => undefined;
      }
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
    close(reason) {
      if (closed) return;
      try {
        output.end();
      } catch {
        // already ended
      }
      finish(reason ?? "closed");
    },
  };
}

/**
 * Adapts a `MessageStream` (a `BrowserChannel`, or an agent's stdio) to the ACP SDK's
 * `Stream`, a pair of Web streams of JSON-RPC messages. This answers "does the SDK's
 * connection accept an arbitrary bidirectional stream": yes, through this adapter. The
 * proxy itself forwards at the message level and does not need the SDK's typed classes.
 */
export function toAcpStream(stream: MessageStream<JsonRpcMessage>): Stream {
  let off: (() => void) | undefined;
  let offClose: (() => void) | undefined;
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      off = stream.onMessage((message) => {
        try {
          controller.enqueue(message as unknown as AnyMessage);
        } catch {
          // the reader is gone
        }
      });
      offClose = stream.onClose(() => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      off?.();
      offClose?.();
      stream.close();
    },
  });
  const writable = new WritableStream<AnyMessage>({
    write(message) {
      return stream.send(message as unknown as JsonRpcMessage);
    },
    close() {
      stream.close();
    },
    abort() {
      stream.close();
    },
  });
  return { readable, writable };
}
