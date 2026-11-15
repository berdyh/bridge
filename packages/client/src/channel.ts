import {
  HANDSHAKE_TIMEOUT_MS, PENDING_FRAMES_MAX,
  type ChannelLayer, type JsonRpcMessage, type MessageStream, type PakeMessage,
  type SessionCloseReason, type Unsubscribe,
} from "@berdyh/bridge-protocol";

import type { Transport } from "./contracts.js";
import { events } from "./events.js";

/** One logical session; reconnects keep the same layer and its keys. */
export function createChannel(
  transport: Transport, runnerId: string, layer: ChannelLayer,
  observe?: (message: JsonRpcMessage) => void,
): MessageStream<JsonRpcMessage> {
  let closed = false;
  let reason: string | undefined;
  let started = false;
  let sid: string | undefined;
  let waitingSends = 0;
  let messageHandlers = 0;
  const backlog: JsonRpcMessage[] = [];
  const messages = events<JsonRpcMessage>();
  const closes = events<string | undefined>();
  const handshake = events<PakeMessage>();
  const subscriptions: Unsubscribe[] = [];
  let releaseClosed!: () => void;
  const whenClosed = new Promise<void>((resolve) => { releaseClosed = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (why: string, notify: boolean, closeReason: SessionCloseReason = "closed") => {
    if (closed) return;
    closed = true;
    releaseClosed();
    reason = why;
    clearTimeout(timer);
    for (const unsubscribe of subscriptions) unsubscribe();
    if (notify) {
      try {
        transport.sendPake(runnerId, { t: "session/close", v: 1, reason: closeReason,
          // With no kid or sid this only clears the transport's local session.
          ...(started || layer.kind === "plain" ? { kid: layer.kid } : sid !== undefined ? { sid } : {}) });
      } catch { /* A transport that has closed cannot carry the final close. */ }
    }
    try { layer.close(); } catch { /* Complete stream teardown even if a layer's cleanup fails. */ }
    backlog.length = 0;
    messages.clear();
    handshake.clear();
    closes.emit(why);
    closes.clear();
  };
  const fail = () => finish("error", true, "error");
  transport.beginSession(runnerId);
  subscriptions.push(transport.onPake((from, message) => {
    if (from !== runnerId || closed) return;
    if (message.t === "session/close") {
      const matches = message.kid !== undefined
        ? (started || layer.kind === "plain") && message.kid === layer.kid
        : message.sid !== undefined ? message.sid === sid
          // Transport rejects identifierless wire closes. Only a locally failed
          // pre-init session can emit this error before it has a kid or sid.
          : !started && sid === undefined && message.reason === "error";
      if (matches) finish(message.reason === "not_trusted" ? "not_trusted" : message.reason === "error" ? "error" : "peer closed", false);
    } else handshake.emit(message);
  }));
  subscriptions.push(transport.onState((state) => {
    if (state === "closed") finish("transport closed", false);
    else if (!started && state === "reconnecting") fail();
  }));
  subscriptions.push(transport.onControl((control) => {
    if (control.type === "revoked" && control.runnerId === runnerId) finish("revoked", true);
    if (!started && control.type === "peer_gone" && control.peer === "runner" && control.runnerId === runnerId) fail();
  }));
  let ready: Promise<void>;
  let incoming = Promise.resolve();
  subscriptions.push(transport.onFrame((from, frame) => {
    if (from !== runnerId || closed) return;
    incoming = incoming.then(async () => {
      await ready;
      if (closed || frame.kid !== layer.kid) return;
      const message = await Promise.race([layer.open(frame), whenClosed]);
      if (closed || !message) return;
      try { observe?.(message); } catch { /* Observers do not own the stream. */ }
      if (closed) return;
      if (messageHandlers > 0) messages.emit(message);
      else if (backlog.length < PENDING_FRAMES_MAX) backlog.push(message);
      else fail();
    }).catch(fail);
  }));
  timer = setTimeout(fail, HANDSHAKE_TIMEOUT_MS);
  try {
    const starting = layer.start({
      send(message) {
        if (closed) return;
        if (message.t === "session/init") sid = message.sid;
        transport.sendPake(runnerId, message);
      },
      onMessage: handshake.on,
    });
    // A plaintext kid is valid immediately, including if the caller closes in
    // this turn before the resolved start promise has run its continuation.
    if (!closed && layer.kind === "plain") transport.bindSession(runnerId, layer.kid);
    const bound = starting.then(() => {
      if (closed) return;
      started = true;
      clearTimeout(timer);
      transport.bindSession(runnerId, layer.kid);
    }).catch(fail);
    ready = Promise.race([bound, whenClosed]);
  } catch {
    fail();
    ready = Promise.resolve();
  }
  let outgoing = ready;
  return {
    get closed() { return closed; },
    send(message) {
      if (closed) return;
      if (++waitingSends > 256) { fail(); return; }
      outgoing = outgoing.then(async () => {
        if (closed) return;
        const frame = await Promise.race([layer.seal(message), whenClosed]);
        if (!closed && frame) transport.sendFrame(runnerId, frame);
      }).catch(fail).finally(() => { waitingSends--; });
      return outgoing;
    },
    onMessage(handler) {
      if (closed) return () => {};
      messageHandlers++;
      const unsubscribe = messages.on(handler);
      for (const message of backlog.splice(0)) {
        if (closed) break;
        messages.emit(message);
      }
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        messageHandlers--;
        unsubscribe();
      };
    },
    onClose(handler) {
      if (closed) { handler(reason); return () => {}; }
      return closes.on(handler);
    },
    close: (why = "closed") => finish(why, true),
  };
}
