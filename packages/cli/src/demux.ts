import {
  HANDSHAKE_TIMEOUT_MS,
  PEER_GONE_GRACE_MS,
  PENDING_FRAMES_MAX,
  createReliableReceiver,
  createReliableSender,
  isAckFrame,
  isE2EEFrame,
  isPakeMessage,
  isPlainFrame,
  type AckFrame,
  type ControlBody,
  type HandshakeIO,
  type PakeMessage,
  type PakeStart,
  type ReliableReceiver,
  type ReliableSender,
  type RelayEnvelope,
  type SequencedFrame,
  type SessionCloseReason,
  type Unsubscribe,
} from "@berdyh/bridge-protocol";
import type { BrowserChannel, EnrollmentWire, RunnerWire } from "@berdyh/bridge-runner";

type Log = (level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;

export interface DemuxOptions {
  appId: string;
  runnerId: string;
  /** Writes one envelope to the current relay socket. False when there is no open, greeted socket. */
  transmit(envelope: RelayEnvelope): boolean;
  /** A transport fault (a sequence gap): close the socket so the reconnect and the resend repair it. */
  faultSocket(reason: string): void;
  /** Builds the channel of a new wire: `wrapRunnerChannel`, then the session caps. */
  makeChannel(wire: RunnerWire): BrowserChannel;
  /** Hands a channel to the proxy. */
  attach(channel: BrowserChannel): void;
  /** `acceptEnrollment` for an enrollment attempt, with its first message. */
  acceptEnrollment(wire: EnrollmentWire, start: PakeStart): Promise<void> | void;
  /**
   * A browser arrived on this app's link (`present` true) or is gone (false). Arrival fires
   * once, on a browser's first envelope or its `peer_reconnected`; departure fires once, when
   * `peer_gone` outlasts `peerGoneGraceMs`, or when the relay socket is lost and the browser
   * is not announced again (`peer_reconnected`, or any envelope from it) inside that same
   * grace period. A drop and return inside the grace period fires neither, whether the
   * browser or the runner's socket dropped. `close` fires nothing. Must not throw; a throw
   * is logged.
   */
  onPeer?(browserKeyId: string, present: boolean): void;
  /** Default `PEER_GONE_GRACE_MS`. */
  peerGoneGraceMs?: number;
  log?: Log;
}

export interface Demux {
  /** One envelope from the runner socket. Never throws. */
  handle(envelope: RelayEnvelope): void;
  /** The socket is greeted: resend everything unacknowledged, in order. */
  socketOpened(): void;
  /** The socket is gone: end the handshakes and enrollments it carried (they are not retained). */
  socketLost(): void;
  /** Ends every wire. */
  close(reason?: string): void;
  /** Wires currently open, for diagnostics and tests. */
  counts(): { sessions: number; enrollments: number };
}

const MAX_SLOTS = 512;
const MAX_ENROLLMENTS = 32;
const MAX_REPLIED_KIDS = 1024;
/**
 * Browsers tracked for `onPeer` at once. The relay feeds the set: ids it never follows with
 * peer_gone would otherwise grow it without bound and pin the browser count above zero. A
 * paired app has a handful of browsers, so 256 is far above any real use. At the cap the
 * oldest entry is evicted *with* its departure reported, so every arrival stays paired with
 * a departure and the count cannot get stuck; `departing` only holds ids from `present`.
 */
const MAX_PRESENT = 256;

/**
 * The reasons a `session/close` may carry; every other local reason is mapped onto these.
 * That includes the e2ee layer's own reasons, for example `revoked` (a browser removed from
 * the trust list while connected): it reaches the browser as `error`, a valid
 * `SessionCloseReason`. `not_trusted` (the handshake of a key that is not in the trust list)
 * passes through, so the browser can tell "not trusted" from a generic failure.
 */
const WIRE_REASONS: readonly string[] = ["closed", "superseded", "unknown_session", "peer_gone", "not_trusted", "error"];
const BENIGN = new Set(["closed", "proxy closed", "runner stopping", "peer closed"]);

function closeReasonFor(reason: string | undefined): SessionCloseReason {
  if (reason === undefined || BENIGN.has(reason)) return "closed";
  if (WIRE_REASONS.includes(reason)) return reason as SessionCloseReason;
  return "error";
}

/** A message bus that holds early messages until its first subscriber, so a first message is never lost. */
function createHandshakeBus() {
  const handlers = new Set<(m: PakeMessage) => void>();
  let buffered: PakeMessage[] | undefined = [];
  return {
    deliver(message: PakeMessage): void {
      if (handlers.size === 0) {
        buffered?.push(message);
        return;
      }
      for (const h of [...handlers]) {
        try {
          h(message);
        } catch {
          /* a handler failure ends its own exchange, not the link */
        }
      }
    },
    subscribe(handler: (m: PakeMessage) => void): Unsubscribe {
      handlers.add(handler);
      const early = buffered;
      buffered = undefined;
      for (const m of early ?? []) handler(m);
      return () => void handlers.delete(handler);
    },
    clear(): void {
      handlers.clear();
      buffered = undefined;
    },
  };
}

function createCloseSet() {
  const handlers = new Set<(reason?: string) => void>();
  return {
    add(h: (reason?: string) => void): Unsubscribe {
      handlers.add(h);
      return () => void handlers.delete(h);
    },
    fire(reason?: string): void {
      for (const h of [...handlers]) {
        try {
          h(reason);
        } catch {
          /* ignore */
        }
      }
      handlers.clear();
    },
  };
}

interface Slot {
  id: string;
  receiver: ReliableReceiver;
  sender: ReliableSender;
  wire?: Wire;
  graceTimer?: NodeJS.Timeout;
}

interface EnrollWire extends EnrollmentWire {
  bus: ReturnType<typeof createHandshakeBus>;
}

interface Wire extends RunnerWire {
  deliverFrame(frame: SequencedFrame): void;
  deliverHandshake(message: PakeMessage): void;
  /** Closes without telling the browser (the browser closed it). */
  closeQuietly(reason: string): void;
  /**
   * Holds a data frame that arrived before the session's `kid` was negotiated (verdict
   * `buffer`). False when the hold is full: the wire is then already closed with `error`.
   */
  hold(frame: SequencedFrame): boolean;
}

export function createDemux(options: DemuxOptions): Demux {
  const { appId, runnerId } = options;
  const log: Log = options.log ?? (() => undefined);
  const grace = options.peerGoneGraceMs ?? PEER_GONE_GRACE_MS;
  const slots = new Map<string, Slot>();
  const enrollments = new Map<string, EnrollWire>();
  /** `kid`s already answered with `unknown_session` on this socket connection. */
  let replied = new Set<string>();
  let closedAll = false;
  /** Browsers reported present through `onPeer`, and the departure timers of those the relay reported gone. */
  const present = new Set<string>();
  const departing = new Map<string, NodeJS.Timeout>();
  /**
   * Enrolled id -> the pre-enrollment id it replaces. After an accepted `pake/done` the browser
   * reconnects under its enrolled id (`Transport.rebind`) and its old socket is closed for good:
   * the old id is retired the moment the new one is seen, instead of being counted as a second
   * browser for the whole departure grace (60 s by default). Retired on arrival, not on `pake/done`
   * itself, so a browser that never rebinds is still counted under its old id until it leaves.
   */
  const rebinding = new Map<string, string>();

  const notifyPeer = (browserKeyId: string, here: boolean): void => {
    try {
      options.onPeer?.(browserKeyId, here);
    } catch (error) {
      log("warn", "onPeer handler failed", { browserKeyId, error: (error as Error)?.message });
    }
  };
  /** The browser is on the link: report an arrival once, and cancel a pending departure. */
  const seen = (browserKeyId: string): void => {
    const timer = departing.get(browserKeyId);
    if (timer) clearTimeout(timer);
    departing.delete(browserKeyId);
    const replaced = rebinding.get(browserKeyId);
    rebinding.delete(browserKeyId);
    if (!present.has(browserKeyId)) {
      while (present.size >= MAX_PRESENT) {
        const oldest = present.values().next().value as string;
        departed(oldest);
      }
      present.add(browserKeyId);
      notifyPeer(browserKeyId, true);
    }
    // Arrival first, then the retired id leaves: the count never passes through zero (no idle flap).
    if (replaced !== undefined) departed(replaced);
  };
  /** Starts the grace timer that reports the departure, unless one is already running. */
  const startDeparture = (browserKeyId: string): void => {
    if (!present.has(browserKeyId) || departing.has(browserKeyId)) return;
    const timer = setTimeout(() => departed(browserKeyId), grace);
    timer.unref?.();
    departing.set(browserKeyId, timer);
  };
  const departed = (browserKeyId: string): void => {
    const timer = departing.get(browserKeyId);
    if (timer) clearTimeout(timer);
    departing.delete(browserKeyId);
    for (const [enrolled, old] of rebinding) if (old === browserKeyId) rebinding.delete(enrolled);
    if (present.delete(browserKeyId)) notifyPeer(browserKeyId, false);
  };
  /** An accepted enrollment under `enrollId` will come back as `enrolledId`: see `rebinding`. */
  const expectRebind = (enrollId: string, enrolledId: string): void => {
    if (enrolledId === enrollId || !present.has(enrollId)) return;
    rebinding.delete(enrolledId);
    while (rebinding.size >= MAX_ENROLLMENTS) rebinding.delete(rebinding.keys().next().value as string);
    rebinding.set(enrolledId, enrollId);
  };

  const toBrowser = (browserKeyId: string, kind: "frame" | "pake", body: unknown): boolean =>
    options.transmit({ to: "browser", runnerId, browserKeyId, kind, body });

  function slotFor(id: string): Slot {
    let slot = slots.get(id);
    if (slot) return slot;
    if (slots.size >= MAX_SLOTS) {
      for (const [key, s] of slots) {
        if (slots.size < MAX_SLOTS) break;
        if (!s.wire || s.wire.closed) slots.delete(key);
      }
    }
    slot = { id, receiver: createReliableReceiver({ role: "runner", bufferUntilKid: true }), sender: createReliableSender() };
    slots.set(id, slot);
    return slot;
  }

  function clearGrace(slot: Slot): void {
    if (slot.graceTimer) clearTimeout(slot.graceTimer);
    slot.graceTimer = undefined;
  }

  function createWire(slot: Slot, init: { sid?: string; kid?: string }): Wire {
    const bus = createHandshakeBus();
    const frames = new Set<(f: SequencedFrame) => void>();
    const closes = createCloseSet();
    let kid = init.kid;
    let closed = false;
    /** Frames held until `bindSession` (verdict `buffer`); bounded, and ended by the handshake timeout. */
    let held: SequencedFrame[] = [];
    let holdTimer: NodeJS.Timeout | undefined;
    const dropHeld = (): SequencedFrame[] => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = undefined;
      const frames = held;
      held = [];
      return frames;
    };

    const handshake: HandshakeIO = {
      send(message) {
        if (!closed) toBrowser(slot.id, "pake", message);
      },
      onMessage: (h) => bus.subscribe(h),
    };

    const finish = (reason: string, tell: boolean): void => {
      if (closed) return;
      closed = true;
      clearGrace(slot);
      dropHeld();
      if (tell && (kid !== undefined || init.sid !== undefined)) {
        toBrowser(slot.id, "pake", {
          t: "session/close",
          v: 1,
          ...(kid !== undefined ? { kid } : { sid: init.sid }),
          reason: closeReasonFor(reason),
        });
      }
      // A wire that is still the slot's current one retires its session. A superseded wire was
      // detached before it was closed, so the new session's state is left alone.
      if (slot.wire === wire) {
        slot.wire = undefined;
        slot.receiver.reset();
        slot.sender.reset();
      }
      bus.clear();
      frames.clear();
      closes.fire(reason);
    };

    const wire: Wire = {
      appId,
      browserKeyId: slot.id,
      ...(init.sid !== undefined ? { sid: init.sid } : {}),
      get kid() {
        return kid;
      },
      bindSession(value) {
        if (kid === undefined && !closed) {
          kid = value;
          // The negotiated kid is the only one the pending receiver may bind: a frame injected
          // with another kid is dropped instead of taking the real session's place.
          if (slot.wire === wire) {
            slot.receiver.expectKid(value);
            // Re-feed what arrived during the handshake. Only frames of the negotiated kid go
            // through the receiver; any other held frame is answered `unknown_session` without
            // touching it, so the arrival order ([real, junk] or [junk, real]) cannot matter:
            // once the real frame binds, the receiver is no longer pending and would adopt the
            // junk one as a new session.
            for (const frame of dropHeld()) {
              if (frame.kid === value) processFrame(slot, frame);
              else replyUnknown(slot, frame.kid);
            }
          }
        }
      },
      hold(frame) {
        if (closed) return false;
        if (held.length >= PENDING_FRAMES_MAX) {
          dropHeld();
          log("warn", "too many frames before the session was negotiated", { browserKeyId: slot.id });
          finish("error", true);
          return false;
        }
        held.push(frame);
        holdTimer ??= setTimeout(() => {
          holdTimer = undefined;
          if (!closed && kid === undefined) finish("error", true);
        }, HANDSHAKE_TIMEOUT_MS);
        holdTimer.unref?.();
        return true;
      },
      get closed() {
        return closed;
      },
      sendFrame(frame) {
        if (closed) return;
        try {
          slot.sender.send(frame);
        } catch (error) {
          log("warn", "outgoing frame rejected by the reliable sender", { error: (error as Error).message });
          finish("error", true);
          return;
        }
        toBrowser(slot.id, "frame", frame);
      },
      onFrame(handler) {
        frames.add(handler);
        return () => void frames.delete(handler);
      },
      handshake,
      onClose: (h) => closes.add(h),
      close: (reason) => finish(reason ?? "closed", true),
      closeQuietly: (reason) => finish(reason, false),
      deliverFrame(frame) {
        for (const h of [...frames]) {
          try {
            h(frame);
          } catch {
            /* the channel handles its own failures */
          }
        }
      },
      deliverHandshake: (m) => bus.deliver(m),
    };
    slot.wire = wire;
    return wire;
  }

  /** Detaches and closes the slot's current wire because a newer session replaces it. */
  function supersede(slot: Slot): void {
    const old = slot.wire;
    if (!old || old.closed) return;
    slot.wire = undefined;
    old.close("superseded");
  }

  function startSession(slot: Slot, init: { sid?: string; kid?: string }): Wire {
    const wire = createWire(slot, init);
    let channel: BrowserChannel;
    try {
      channel = options.makeChannel(wire);
      options.attach(channel);
    } catch (error) {
      log("warn", "could not attach a browser channel", { browserKeyId: slot.id, error: (error as Error).message });
      wire.close("error");
      throw error;
    }
    return wire;
  }

  function sendAck(slot: Slot): void {
    const ack = slot.receiver.ackFrame();
    if (ack) toBrowser(slot.id, "frame", ack satisfies AckFrame);
  }

  function replyUnknown(slot: Slot, kid: string): void {
    const key = `${slot.id}\u0000${kid}`;
    if (replied.has(key)) return;
    if (replied.size >= MAX_REPLIED_KIDS) replied.clear();
    replied.add(key);
    toBrowser(slot.id, "pake", { t: "session/close", v: 1, kid, reason: "unknown_session" });
  }

  function onFrame(browserKeyId: string, body: unknown): void {
    if (isAckFrame(body)) {
      const slot = slots.get(browserKeyId);
      if (!slot) return;
      try {
        slot.sender.ack(body);
      } catch {
        // An ack for frames never sent: the session is faulty.
        slot.wire?.close("error");
      }
      return;
    }
    if (!isPlainFrame(body) && !isE2EEFrame(body)) return;
    processFrame(slotFor(browserKeyId), body);
  }

  /** Classifies one data frame through the slot's receiver and acts on the verdict. */
  function processFrame(slot: Slot, frame: SequencedFrame): void {
    let verdict;
    try {
      verdict = slot.receiver.accept(frame);
    } catch {
      // `invalid sequence`: fail only this session, never the socket listener.
      if (slot.wire && (slot.wire.kid === frame.kid || slot.wire.kid === undefined)) slot.wire.close("error");
      return;
    }
    switch (verdict) {
      case "deliver":
        slot.wire?.deliverFrame(frame);
        sendAck(slot);
        return;
      case "duplicate":
        sendAck(slot);
        return;
      case "gap":
        options.faultSocket("sequence gap");
        return;
      case "bind": {
        let wire = slot.wire;
        if (!wire || wire.closed) wire = tryStart(slot, { kid: frame.kid });
        wire?.deliverFrame(frame);
        sendAck(slot);
        return;
      }
      case "new_session": {
        supersede(slot);
        slot.sender.reset();
        const wire = tryStart(slot, { kid: frame.kid });
        wire?.deliverFrame(frame);
        sendAck(slot);
        return;
      }
      case "buffer": {
        // Runner, handshake not negotiated yet: hold the frame, not acked, not adopted.
        const wire = slot.wire;
        if (wire && !wire.closed) wire.hold(frame);
        return;
      }
      case "unknown_session":
      case "retired":
        replyUnknown(slot, frame.kid);
        return;
    }
  }

  function tryStart(slot: Slot, init: { sid?: string; kid?: string }): Wire | undefined {
    try {
      return startSession(slot, init);
    } catch {
      slot.receiver.reset();
      return undefined;
    }
  }

  function onEnrollmentStart(browserKeyId: string, start: PakeStart): void {
    if (start.enrollId !== browserKeyId) return;
    enrollments.get(browserKeyId)?.close("superseded");
    while (enrollments.size >= MAX_ENROLLMENTS) {
      const oldest = enrollments.values().next().value;
      if (!oldest) break;
      oldest.close("superseded");
    }
    const bus = createHandshakeBus();
    const closes = createCloseSet();
    let closed = false;
    const wire: EnrollWire = {
      appId,
      enrollId: browserKeyId,
      get closed() {
        return closed;
      },
      handshake: {
        send(message) {
          if (closed) return;
          const sent = toBrowser(browserKeyId, "pake", message);
          // The attempt is over once the result is out: close right after `pake/done`. `send`
          // writes to the socket before returning, so a sender that calls `close()` straight
          // after `send` (as `acceptEnrollment` does) never loses a queued handshake message.
          if (message.t === "pake/done") {
            if (sent && message.ok && typeof message.browserKeyId === "string") expectRebind(browserKeyId, message.browserKeyId);
            // A result that never left must not count as delivered: throw so the enrollment rolls back.
            wire.close(sent ? "done" : "undelivered");
            if (!sent) throw new Error("enrollment result could not be sent");
          }
        },
        onMessage: (h) => bus.subscribe(h),
      },
      onClose: (h) => closes.add(h),
      close(reason) {
        if (closed) return;
        closed = true;
        if (enrollments.get(browserKeyId) === wire) enrollments.delete(browserKeyId);
        bus.clear();
        closes.fire(reason);
      },
      bus,
    };
    enrollments.set(browserKeyId, wire);
    const fail = (error: unknown): void => {
      log("warn", "enrollment failed", { enrollId: browserKeyId, error: (error as Error)?.message });
      wire.close("error");
    };
    try {
      const running = options.acceptEnrollment(wire, start);
      if (running) running.catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  function onPake(browserKeyId: string, message: PakeMessage): void {
    switch (message.t) {
      case "pake/start":
        onEnrollmentStart(browserKeyId, message);
        return;
      case "pake/confirm": {
        enrollments.get(browserKeyId)?.bus.deliver(message);
        return;
      }
      case "session/init": {
        const slot = slotFor(browserKeyId);
        supersede(slot);
        slot.sender.reset();
        slot.receiver.expectBind();
        const wire = tryStart(slot, { sid: message.sid });
        wire?.deliverHandshake(message);
        return;
      }
      case "session/close": {
        const slot = slots.get(browserKeyId);
        const wire = slot?.wire;
        if (!wire || wire.closed) return;
        const byKid = message.kid !== undefined && wire.kid === message.kid;
        const bySid =
          message.sid !== undefined && wire.sid === message.sid && (message.kid === undefined || wire.kid === undefined);
        // A close whose kid is present and not the current one belongs to another session.
        if (byKid || bySid) wire.closeQuietly("peer closed");
        return;
      }
      default:
        // pake/reply, pake/done and session/accept flow runner to browser only.
        return;
    }
  }

  function onControl(body: ControlBody): void {
    if (body.type === "peer_reconnected" && body.peer === "browser" && body.browserKeyId !== undefined) {
      // The browser was away: an unknown_session reply sent earlier may have been lost, so allow another.
      seen(body.browserKeyId);
      const prefix = `${body.browserKeyId}\u0000`;
      for (const key of [...replied]) if (key.startsWith(prefix)) replied.delete(key);
      const slot = slots.get(body.browserKeyId);
      if (!slot) return;
      clearGrace(slot);
      resend(slot);
    } else if (body.type === "peer_gone" && body.peer === "browser" && body.browserKeyId !== undefined) {
      const id = body.browserKeyId;
      startDeparture(id);
      enrollments.get(id)?.close("peer_gone");
      const slot = slots.get(id);
      if (!slot?.wire || slot.wire.closed) return;
      clearGrace(slot);
      const wire = slot.wire;
      slot.graceTimer = setTimeout(() => {
        slot.graceTimer = undefined;
        if (slot.wire === wire) wire.close("peer_gone");
      }, grace);
      slot.graceTimer.unref?.();
    }
  }

  function resend(slot: Slot): void {
    if (!slot.wire || slot.wire.closed) return;
    for (const frame of slot.sender.pending()) toBrowser(slot.id, "frame", frame);
  }

  return {
    handle(envelope) {
      if (closedAll) return;
      try {
        const { kind, browserKeyId, body } = envelope;
        if (kind === "control") {
          onControl(body as ControlBody);
        } else if (browserKeyId === undefined) {
          return;
        } else if (kind === "frame") {
          seen(browserKeyId);
          onFrame(browserKeyId, body);
        } else if (kind === "pake") {
          seen(browserKeyId);
          if (isPakeMessage(body)) onPake(browserKeyId, body);
        }
      } catch (error) {
        log("error", "relay envelope handling failed", { error: (error as Error)?.message });
      }
    },
    socketOpened() {
      replied = new Set();
      for (const slot of slots.values()) resend(slot);
    },
    socketLost() {
      // Nothing is heard from any browser until the socket is back; the relay announces each
      // connected one again with `peer_reconnected`, which cancels its departure. Those not
      // announced inside the grace period depart once.
      for (const id of [...present]) startDeparture(id);
      for (const wire of [...enrollments.values()]) wire.close("socket lost");
      // Handshake messages are not retained: a session still setting up cannot continue.
      for (const slot of slots.values()) if (slot.wire && !slot.wire.closed && slot.wire.kid === undefined) slot.wire.close("error");
    },
    close(reason = "runner stopping") {
      closedAll = true;
      for (const timer of departing.values()) clearTimeout(timer);
      departing.clear();
      present.clear();
      rebinding.clear();
      for (const wire of [...enrollments.values()]) wire.close(reason);
      for (const slot of slots.values()) {
        clearGrace(slot);
        slot.wire?.close(reason);
      }
      slots.clear();
    },
    counts() {
      let sessions = 0;
      for (const slot of slots.values()) if (slot.wire && !slot.wire.closed) sessions++;
      return { sessions, enrollments: enrollments.size };
    },
  };
}
