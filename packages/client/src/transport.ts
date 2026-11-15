import {
  bearerSubprotocol, createReliableReceiver, createReliableSender, HANDSHAKE_TIMEOUT_MS,
  isAckFrame, isFrameBody, isPakeMessage, isRelayEnvelope, PENDING_FRAMES_MAX,
  RELAY_CLOSE_REPLACED, RELAY_CLOSE_REVOKED, RELAY_SUBPROTOCOL, relayEndpoint,
  type ControlBody, type PakeMessage, type PresenceBody,
  type RelayEnvelope, type SequencedFrame,
} from "@berdyh/bridge-protocol";

import type { Transport, TransportOptions, TransportState } from "./contracts.js";
import { events } from "./events.js";

/** Bounds include sent but unacknowledged frames, even while the socket is open. */
const RETAINED_FRAMES_MAX = 256;
const RETAINED_BYTES_MAX = 4 * 1024 * 1024;

/**
 * Heartbeat: after 20 s with no outbound traffic the transport sends `bridge:ping`;
 * a socket that returns no pong within 10 s of it is half-open (only a pong settles a ping) and is abandoned for a
 * reconnect. Servers answer at the transport layer; neither string reaches the relay core or
 * the session code. The literals stay local to each package.
 */
const HEARTBEAT_IDLE_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;
const PING = "bridge:ping";
const PONG = "bridge:pong";

function sessionState() {
  return {
    sender: createReliableSender(), receiver: createReliableReceiver({ role: "browser" }),
    active: false, sid: undefined as string | undefined,
    buffered: [] as SequencedFrame[], serialized: new Map<number, { text: string; bytes: number }>(),
    retainedBytes: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    ackTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
}
type Session = ReturnType<typeof sessionState>;

/** The reliable relay link. See `Transport` for the contract. */
export function createTransport(options: TransportOptions): Transport {
  let state: TransportState = "idle";
  let browserKeyId = options.browserKeyId;
  let socket: WebSocket | undefined;
  let generation = 0;
  let running = false;
  let established = false;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Heartbeat of the current socket, if it is open: outbound traffic defers the next ping. */
  let beat: { sent(): void; stop(): void } | undefined;
  const sessions = new Map<string, Session>();
  // Only unsent control/handshake messages are queued; sent PAKE is never replayed.
  const writes: { text: string; bytes: number; session?: Session }[] = [];
  let queuedBytes = 0;
  const encoder = new TextEncoder();
  const frames = events<{ runnerId: string; frame: SequencedFrame }>();
  const pake = events<{ runnerId: string; message: PakeMessage }>();
  const presence = events<PresenceBody>();
  const controls = events<ControlBody>();
  const states = events<TransportState>();
  const waiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  const random = options.random ?? Math.random;
  let cancelBackoff: (() => void) | undefined;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const finish = () => { cancelBackoff = undefined; resolve(); };
    const timer = setTimeout(finish, ms);
    cancelBackoff = () => { clearTimeout(timer); finish(); };
  }));
  const setState = (next: TransportState) => {
    if (next === state) return;
    state = next;
    states.emit(next);
  };
  const canWrite = () => state === "open" && socket?.readyState === 1;
  const write = (text: string, session?: Session) => {
    if (state === "closed") throw new Error("transport closed");
    if (canWrite()) {
      try { socket!.send(text); } catch (cause) {
        socket?.close();
        throw new Error("WebSocket send failed", { cause });
      }
      beat?.sent();
      return;
    }
    const bytes = encoder.encode(text).byteLength;
    if (writes.length >= RETAINED_FRAMES_MAX || queuedBytes + bytes > RETAINED_BYTES_MAX) {
      throw new Error("send queue overflow");
    }
    writes.push({ text, bytes, session });
    queuedBytes += bytes;
  };
  const envelope = (runnerId: string, kind: "frame" | "pake", body: unknown) =>
    JSON.stringify({ to: "runner", runnerId, browserKeyId, kind, body } satisfies RelayEnvelope);
  const clearSession = (session: Session) => {
    clearTimeout(session.timer);
    clearTimeout(session.ackTimer);
    session.timer = session.ackTimer = undefined;
    session.active = false;
    session.sid = undefined;
    session.buffered = [];
    session.serialized.clear();
    session.retainedBytes = 0;
    for (let i = writes.length - 1; i >= 0; i--) {
      if (writes[i]!.session !== session) continue;
      queuedBytes -= writes[i]!.bytes;
      writes.splice(i, 1);
    }
    session.sender.reset();
    session.receiver.reset();
  };
  const matchesClose = (session: Session, message: Extract<PakeMessage, { t: "session/close" }>) =>
    message.kid !== undefined ? message.kid === session.receiver.kid : message.sid !== undefined && message.sid === session.sid;
  const failSession = (runnerId: string, session: Session) => {
    const message: PakeMessage = { t: "session/close", v: 1, reason: "error",
      ...(session.receiver.kid ? { kid: session.receiver.kid } : { sid: session.sid }) };
    try {
      if (message.kid !== undefined || message.sid !== undefined) write(envelope(runnerId, "pake", message));
    } catch { /* The local close still reaches the channel if the socket/queue fails. */ }
    clearSession(session);
    pake.emit({ runnerId, message });
  };
  const resend = (session: Session) => {
    for (const frame of session.sender.pending()) {
      if (!canWrite()) return;
      const retained = session.serialized.get(frame.seq);
      if (retained) write(retained.text);
    }
  };
  const scheduleAck = (runnerId: string, session: Session) => {
    if (session.ackTimer !== undefined) return;
    session.ackTimer = setTimeout(() => {
      session.ackTimer = undefined;
      const ack = session.receiver.ackFrame();
      if (session.active && ack) {
        try { write(envelope(runnerId, "frame", ack), session); }
        catch { failSession(runnerId, session); }
      }
    }, 20);
  };
  const receiveFrame = (runnerId: string, session: Session, frame: SequencedFrame) => {
    let verdict: ReturnType<Session["receiver"]["accept"]>;
    try { verdict = session.receiver.accept(frame); }
    catch { failSession(runnerId, session); return; }
    switch (verdict) {
      case "buffer":
        if (session.buffered.length >= PENDING_FRAMES_MAX) failSession(runnerId, session);
        else session.buffered.push(frame);
        break;
      case "deliver":
        frames.emit({ runnerId, frame });
        if (session.active) scheduleAck(runnerId, session);
        break;
      case "duplicate": scheduleAck(runnerId, session); break;
      case "gap": socket?.close(); break;
    }
  };
  const receive = (data: unknown) => {
    // Both native WebSocket and ws deliver text frames as strings with addEventListener.
    if (typeof data !== "string") return;
    let message: unknown;
    try { message = JSON.parse(data); } catch { return; }
    if (!isRelayEnvelope(message) || message.to !== "browser" ||
        (message.browserKeyId !== undefined && message.browserKeyId !== browserKeyId)) return;
    const { runnerId, body } = message;
    const session = sessions.get(runnerId);
    try {
      if (message.kind === "frame" && session?.active) {
        // Retired/other sessions must be ignored even when their seq is malformed.
        if (body && typeof body === "object" && "kid" in body && typeof body.kid === "string" &&
            (session.receiver.isRetired(body.kid) || (session.receiver.kid !== undefined && body.kid !== session.receiver.kid))) return;
        if (!isFrameBody(body) || ("seq" in body ? !Number.isSafeInteger(body.seq) : !Number.isSafeInteger(body.ack))) {
          failSession(runnerId, session);
          return;
        }
        if (isAckFrame(body)) {
          if (body.kid === session.receiver.kid && session.sender.kid === undefined && body.ack > 0) {
            failSession(runnerId, session);
            return;
          }
          try { session.sender.ack(body); } catch { failSession(runnerId, session); return; }
          for (const [seq, retained] of session.serialized) {
            if (seq > session.sender.acked) continue;
            session.retainedBytes -= retained.bytes;
            session.serialized.delete(seq);
          }
        } else receiveFrame(runnerId, session, body);
      } else if (message.kind === "pake" && isPakeMessage(body)) {
        if (body.t === "session/close") {
          if (!session?.active || !matchesClose(session, body)) return;
          clearSession(session);
        }
        pake.emit({ runnerId, message: body });
      } else if (message.kind === "presence" && validPresence(body) && body.runnerId === runnerId) {
        presence.emit(body);
      } else if (message.kind === "control" && validControl(body)) {
        if (body.type === "peer_reconnected" && body.peer === "runner") {
          const target = sessions.get(body.runnerId);
          if (target?.active) {
            try { resend(target); } catch { failSession(body.runnerId, target); }
          }
        }
        controls.emit(body);
      }
    } catch {
      if (session?.active) failSession(runnerId, session);
    }
  };
  const stop = (error = new Error("transport closed")) => {
    if (state === "closed") return;
    generation++;
    clearTimeout(connectTimer);
    connectTimer = undefined;
    cancelBackoff?.();
    running = false;
    beat?.stop();
    beat = undefined;
    for (const session of sessions.values()) clearSession(session);
    writes.length = 0;
    queuedBytes = 0;
    const previous = socket;
    socket = undefined;
    setState("closed");
    previous?.close();
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  };
  /**
   * The latest getSessionToken rejection (the app's own error, e.g. "Sign in"), surfaced when the connect deadline fires.
   * Socket and constructor errors are never forwarded: they may echo the bearer subprotocol.
   */
  let lastTokenError: unknown;
  /** Only the message survives: a cause, stack or property of the app's error could carry a credential. */
  const deadlineError = () => lastTokenError instanceof Error
    ? new Error(String(lastTokenError.message).slice(0, 200))
    : new Error("transport connect timed out");
  const openSocket = async (epoch: number) => {
    let token: string;
    try { token = await options.getSessionToken(); if (epoch === generation) lastTokenError = undefined; }
    catch (error) { if (epoch === generation) lastTokenError = error; throw error; }
    if (epoch !== generation || state === "closed") return;
    // The dynamic import keeps ws out of the native browser execution path.
    const Socket = options.webSocket ?? (globalThis.WebSocket && globalThis.location
      ? globalThis.WebSocket : (await import("ws")).default as unknown as typeof WebSocket);
    if (epoch !== generation) return;
    let opened = false;
    await new Promise<void>((resolve) => {
      const current = new Socket(relayEndpoint(options.relayUrl, "browser", browserKeyId),
        [RELAY_SUBPROTOCOL, bearerSubprotocol(token)]);
      socket = current;
      const timer = setTimeout(() => current.close(), HANDSHAKE_TIMEOUT_MS);
      let heartbeat: { sent(): void; alive(): void; stop(): void } | undefined;
      /** Gives up on a socket that stopped answering. A half-open socket may never finish its close handshake, so do not wait for it. */
      const abandon = () => {
        if (socket !== current) return;
        heartbeat?.stop();
        if (beat === heartbeat) beat = undefined;
        socket = undefined;
        try { current.close(); } catch { /* already closing */ }
        if (epoch === generation) setState("reconnecting");
        resolve();
      };
      const startHeartbeat = () => {
        let idle: ReturnType<typeof setTimeout> | undefined;
        let pong: ReturnType<typeof setTimeout> | undefined;
        const armIdle = () => {
          clearTimeout(idle);
          idle = setTimeout(() => {
            idle = undefined;
            try { current.send(PING); } catch { abandon(); return; }
            pong = setTimeout(() => { pong = undefined; abandon(); }, PONG_TIMEOUT_MS);
          }, HEARTBEAT_IDLE_MS);
        };
        heartbeat = {
          // Outbound traffic: the next ping is due 20 s from now, unless one awaits its pong.
          sent() { if (pong === undefined) armIdle(); },
          // Only a pong settles a pending ping (other inbound frames do not). It is not outbound traffic,
          // so it never defers the next ping (receive-only traffic must still be pinged every 20 s).
          alive() { if (pong === undefined) return; clearTimeout(pong); pong = undefined; armIdle(); },
          stop() { clearTimeout(idle); clearTimeout(pong); idle = pong = undefined; },
        };
        beat = heartbeat;
        armIdle();
      };
      current.addEventListener("open", () => {
        clearTimeout(timer);
        if (epoch !== generation) { current.close(); return; }
        // Flush startup messages before exposing open or replaying any data.
        try {
          while (writes.length > 0) {
            const queued = writes[0]!;
            current.send(queued.text);
            writes.shift();
            queuedBytes -= queued.bytes;
          }
        } catch { current.close(); return; }
        startHeartbeat();
        opened = true;
        established = true;
        clearTimeout(connectTimer);
        connectTimer = undefined;
        setState("open");
        if (epoch !== generation) return;
        for (const [runnerId, session] of sessions) if (session.active) {
          try { resend(session); } catch { failSession(runnerId, session); }
        }
        for (const waiter of waiters) waiter.resolve();
        waiters.clear();
      });
      current.addEventListener("message", (event) => {
        if (epoch !== generation || socket !== current) return;
        // Heartbeat strings are the transport's own: answer a ping, ignore a pong, never parse either.
        if (event.data === PING) {
          try { current.send(PONG); heartbeat?.sent(); } catch { /* the close event follows */ }
          return;
        }
        if (event.data === PONG) { heartbeat?.alive(); return; }
        try { receive(event.data); }
        catch {
          // Last-resort containment: a message listener must never throw into ws.
          for (const [runnerId, session] of sessions) if (session.active) failSession(runnerId, session);
        }
      });
      current.addEventListener("error", () => { /* close follows errors, including failed upgrades. */ });
      current.addEventListener("close", (event) => {
        clearTimeout(timer);
        heartbeat?.stop();
        if (beat === heartbeat) beat = undefined;
        // A socket that was already abandoned says nothing about the current one.
        if (epoch === generation && socket === current) {
          socket = undefined;
          if (event.code === RELAY_CLOSE_REPLACED || event.code === RELAY_CLOSE_REVOKED) stop();
          else setState("reconnecting");
        }
        resolve();
      });
    });
    return opened;
  };
  const run = async (epoch: number) => {
    let attempts = 0;
    while (epoch === generation && state !== "closed") {
      try {
        if (await openSocket(epoch)) attempts = 0;
      } catch { if (epoch === generation) setState("reconnecting"); }
      if (epoch !== generation || (state as TransportState) === "closed") return;
      const delay = Math.min(30_000, 250 * 2 ** Math.min(attempts++, 7)) * (0.5 + random() * 0.5);
      await sleep(delay);
    }
  };
  const connect = (): Promise<void> => {
    if (state === "closed") return Promise.reject(new Error("transport closed"));
    if (state === "open") return Promise.resolve();
    const result = new Promise<void>((resolve, reject) => { waiters.add({ resolve, reject }); });
    if (!running) {
      running = true;
      lastTokenError = undefined;
      if (!established) connectTimer = setTimeout(() => stop(deadlineError()), HANDSHAKE_TIMEOUT_MS);
      setState("connecting");
      void run(generation);
    }
    return result;
  };
  return {
    get state() { return state; },
    get browserKeyId() { return browserKeyId; },
    connect,
    async rebind(next) {
      if (state === "closed") throw new Error("transport closed");
      if ([...sessions.values()].some((session) => session.active)) throw new Error("cannot rebind during a session");
      generation++;
      clearTimeout(connectTimer);
      connectTimer = undefined;
      established = false;
      cancelBackoff?.();
      running = false;
      beat?.stop();
      beat = undefined;
      const previous = socket;
      socket = undefined;
      previous?.close();
      for (const session of sessions.values()) clearSession(session);
      writes.length = 0;
      queuedBytes = 0;
      browserKeyId = next;
      setState("idle");
      await connect();
    },
    close: stop,
    beginSession(runnerId) {
      if (state === "closed") throw new Error("transport closed");
      let session = sessions.get(runnerId);
      if (!session) { session = sessionState(); sessions.set(runnerId, session); }
      clearSession(session);
      session.receiver.beginSession();
      session.active = true;
      session.timer = setTimeout(() => failSession(runnerId, session), HANDSHAKE_TIMEOUT_MS);
    },
    bindSession(runnerId, kid) {
      const session = sessions.get(runnerId);
      if (!session?.active) throw new Error("no active session");
      if (session.receiver.kid === kid) return;
      session.receiver.bind(kid);
      session.sender.reset();
      session.serialized.clear();
      session.retainedBytes = 0;
      clearTimeout(session.timer);
      session.timer = undefined;
      const pending = session.buffered;
      session.buffered = [];
      for (const frame of pending) if (session.active) receiveFrame(runnerId, session, frame);
    },
    sendFrame(runnerId, frame) {
      const session = sessions.get(runnerId);
      if (!session?.active || session.receiver.kid !== frame.kid) throw new Error("frame outside bound session");
      const text = envelope(runnerId, "frame", frame);
      const bytes = encoder.encode(text).byteLength;
      if (session.serialized.size >= RETAINED_FRAMES_MAX || session.retainedBytes + bytes > RETAINED_BYTES_MAX) {
        throw new Error("send queue overflow");
      }
      session.sender.send(frame);
      session.serialized.set(frame.seq, { text, bytes });
      session.retainedBytes += bytes;
      // Retained data is replayed on open; avoid also placing it in writes.
      if (canWrite()) write(text);
    },
    sendPake(runnerId, message) {
      if (state === "closed") throw new Error("transport closed");
      const session = sessions.get(runnerId);
      // Before session/init there is no peer-side session to close. An unscoped
      // outgoing close is local cancellation, never a wire message. Incoming
      // closes still require a matching kid or sid.
      if (message.t === "session/close" && message.kid === undefined && message.sid === undefined) {
        if (session?.active && session.receiver.kid === undefined && session.sid === undefined) clearSession(session);
        return;
      }
      if (message.t === "session/init" && session?.active) session.sid = message.sid;
      if (message.t === "session/close" && session?.active && matchesClose(session, message)) clearSession(session);
      write(envelope(runnerId, "pake", message), message.t !== "session/close" && session?.active ? session : undefined);
    },
    onFrame: (handler) => frames.on(({ runnerId, frame }) => handler(runnerId, frame)),
    onPake: (handler) => pake.on(({ runnerId, message }) => handler(runnerId, message)),
    onPresence: presence.on, onControl: controls.on, onState: states.on,
  };
}

function validPresence(value: unknown): value is PresenceBody {
  if (!value || typeof value !== "object") return false;
  const p = value as PresenceBody;
  return typeof p.runnerId === "string" && typeof p.online === "boolean" &&
    (p.lastSeen === undefined || typeof p.lastSeen === "string") &&
    (p.runnerVersion === undefined || typeof p.runnerVersion === "string") &&
    (p.agents === undefined || (Array.isArray(p.agents) && p.agents.every((agent) =>
      agent && typeof agent.id === "string" && typeof agent.available === "boolean")));
}

function validControl(value: unknown): value is ControlBody {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  switch (c.type) {
    case "peer_reconnected": case "peer_gone":
      return (c.peer === "runner" || c.peer === "browser") && typeof c.runnerId === "string" &&
        (c.browserKeyId === undefined || typeof c.browserKeyId === "string");
    case "revoked": return typeof c.runnerId === "string";
    case "error": return typeof c.code === "string";
    default: return false;
  }
}
