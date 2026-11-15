import type { AckFrame } from "./e2ee.js";
import type { SequencedFrame } from "./layer.js";

/**
 * The reliable link's state machines, shared by both ends: the client `Transport` and the
 * runner's `RunnerWire` demultiplexer use them. They are pure: no sockets, timers or I/O.
 * The caller owns the transport, the ack batching and the resend triggers (socket
 * reconnect, `peer_reconnected`). They read `kid` and `seq` only and never decrypt.
 * The rules are the "Sessions" rules on `ChannelLayer` (layer.ts).
 */

/** Maximum frames the browser buffers for a session whose `kid` is not bound yet. */
export const PENDING_FRAMES_MAX = 64;

/** Minimum size of the retired-`kid` set (Sessions rule 2). The receiver may keep more. */
export const RETIRED_KIDS_MIN = 8;

/**
 * Outgoing half. One instance per session: `seal` (the layer) assigns `seq` 1, 2, 3,
 * ... and the sender retains each frame until a cumulative ack covers it.
 */
export interface ReliableSender {
  /** The `kid` of the frames retained so far; `undefined` before the first `send`. */
  readonly kid: string | undefined;
  /** The highest cumulative ack seen; 0 before the first. */
  readonly acked: number;
  /**
   * Retains `frame` for resend and returns it unchanged (byte-identical, the same
   * object). `seq` is the one the layer's `seal` assigned; it must be contiguous
   * (the previous `seq` + 1, starting at 1) and carry the sender's
   * `kid`, otherwise `send` throws (a programming error, not a network fault).
   */
  send(frame: SequencedFrame): SequencedFrame;
  /**
   * Applies a cumulative ack: drops every retained frame with `seq` <= `ack.ack`.
   * An ack for another `kid`, or one lower than `acked`, is ignored (stale or
   * retired sessions are dropped silently). An ack higher than the highest `seq`
   * sent acknowledges frames that were never sent: that is a FAULT, `ack` throws
   * before it changes any state, and the caller ends the session with reason
   * `error`.
   */
  ack(ack: AckFrame): void;
  /** The frames still unacked, in `seq` order, to resend after a reconnect or `peer_reconnected`. */
  pending(): readonly SequencedFrame[];
  /** Drops all retained frames and forgets the `kid`: a new session, or `Transport.rebind`. */
  reset(): void;
}

/**
 * What the receiver decided about one incoming data frame (never an ack).
 *
 *  - `deliver`: the next frame of the current session (`seq` == last + 1). Deliver
 *    it, then send the cumulative ack.
 *  - `duplicate`: current `kid`, `seq` <= last delivered. Drop it and re-ack.
 *  - `gap`: current `kid`, `seq` > last + 1. A transport fault: close the socket so
 *    the reconnect and `peer_reconnected` resend repair it. Only this value ever
 *    closes the socket.
 *  - `bind`: runner role, receiver PENDING (a `session/init` wire exists, no `kid`
 *    yet; see `expectBind`). An unseen, non-retired `kid` with `seq` 1. The receiver
 *    adopts the `kid`, counts the frame as delivered, and the caller delivers it to
 *    the EXISTING wire and layer. Nothing is superseded. Once the pending wire's
 *    negotiated `kid` is known (`expectKid`), only that `kid` binds; another one is `unknown_session`.
 *  - `new_session`: runner role, receiver NONE or BOUND (no pending wire). An
 *    unseen, non-retired `kid` with `seq` 1. The receiver has already retired the previous `kid`, adopted the new
 *    one and reset its dedupe state, and counts this frame as delivered. The caller closes
 *    the old wire (`superseded`), creates the new one and delivers this frame to it.
 *  - `buffer`: browser role, session not bound yet (see `bind`): an unseen,
 *    non-retired `kid`. The caller buffers the frame (at most `PENDING_FRAMES_MAX`;
 *    overflow, or `HANDSHAKE_TIMEOUT_MS`, ends the session with reason `error`) and
 *    re-feeds it through `accept` right after `bind`. It is not acked meanwhile.
 *    Runner role, only with `ReliableReceiverOptions.bufferUntilKid`: the receiver is
 *    PENDING (`expectBind`) but has no expected `kid` yet (`expectKid` not called), and
 *    the frame has an unseen, non-retired `kid` with `seq` 1. Nothing is adopted; the
 *    caller buffers the frame and re-feeds it through `accept` after `expectKid`, when
 *    only that `kid` binds (any other is `unknown_session`).
 *  - `unknown_session`: a `kid` that is not the current one, not retired, and not
 *    `bind`, `new_session` or `buffer` (that is: `seq` > 1 on the runner, or any
 *    other `kid` once the browser is bound). Drop it. The runner replies
 *    `session/close` with that `kid` and reason `unknown_session`; the browser drops
 *    it with no reply. Never a gap, never a socket close.
 *  - `retired`: a retired `kid`. Drop it. Runner role: the caller replies `session/close`
 *    with that `kid` and reason `unknown_session`, at most once per `kid` per socket
 *    connection, so a browser whose close was lost (for example after
 *    `PEER_GONE_GRACE_MS`) ends its session instead of resending forever. Browser
 *    role: drop silently.
 */
export type ReceiveVerdict = "deliver" | "duplicate" | "gap" | "bind" | "new_session" | "buffer" | "unknown_session" | "retired";

/** The ends of the link differ only in how an unseen `kid` is treated (Sessions rules 2 and 3). */
export type ReliableRole = "runner" | "browser";

export interface ReliableReceiverOptions {
  role: ReliableRole;
  /**
   * The browser's `layer.kid`, when already valid (plaintext). In E2EE it is bound
   * with `bind` once `start` resolves (`Transport.bindSession`); until then frames
   * with an unseen `kid` are `buffer`.
   * Ignored for the runner, which learns the `kid` from the first frame.
   */
  kid?: string;
  /** Size of the retired-`kid` set; at least `RETIRED_KIDS_MIN` (default `RETIRED_KIDS_MIN`). */
  retiredCapacity?: number;
  /**
   * Runner role, opt-in (default false, so behaviour is unchanged unless set). While the
   * receiver is PENDING (`expectBind`) and the wire's `kid` is not known yet (`expectKid`
   * not called), an unseen, non-retired `kid` with `seq` 1 returns `buffer` instead of
   * `bind`: nothing is adopted, so a frame with a junk `kid` cannot take the place of the
   * real session during the handshake. The caller buffers the frame and re-feeds it
   * through `accept` after `expectKid`; from then on only that `kid` binds. Ignored for the
   * browser, and when the receiver is not PENDING.
   */
  bufferUntilKid?: boolean;
}

/** Incoming half, for all the sessions of one peer; it tracks one current session. */
export interface ReliableReceiver {
  /** The current session's `kid`, if any. */
  readonly kid: string | undefined;
  /** The highest `seq` delivered for the current `kid`; 0 before the first. */
  readonly delivered: number;
  /** Classifies one incoming data frame and updates the dedupe state (see `ReceiveVerdict`). */
  accept(frame: SequencedFrame): ReceiveVerdict;
  /** Browser role: binds the current `kid` (E2EE, after `start` resolves). No-op if equal; a different `kid` retires the old one and resets. */
  bind(kid: string): void;
  /**
   * Runner role: a wire created by `session/init` exists but has no `kid` yet. The
   * receiver becomes PENDING: the next unseen, non-retired `kid` with `seq` 1 returns
   * `bind` instead of `new_session`. `reset` clears it.
   */
  expectBind(): void;
  /**
   * Runner role, PENDING: the pending wire's negotiated `kid` is now known (`bindSession`).
   * From here only that `kid` can `bind`; any other unseen `kid` with `seq` 1 is
   * `unknown_session` and is not adopted, so a frame injected with a junk `kid` cannot take
   * the place of the real session. No-op unless PENDING. `reset` clears it.
   */
  expectKid(kid: string): void;
  /**
   * Browser role: the unbound state for a new session. Retires the current `kid`,
   * clears the dedupe state and makes unseen non-retired kids `buffer` until `bind`.
   * `Transport.beginSession` calls it.
   */
  beginSession(): void;
  /** The cumulative ack to send after a `deliver` or `duplicate`; `undefined` before anything was delivered. */
  ackFrame(): AckFrame | undefined;
  /** Retires the current `kid` (it joins the bounded retired set) and clears the dedupe state. */
  reset(): void;
  /** Whether `kid` is in the retired set. */
  isRetired(kid: string): boolean;
}

/** Creates the outgoing state machine. */
export function createReliableSender(): ReliableSender {
  let kid: string | undefined;
  let highest = 0;
  let acked = 0;
  let frames: SequencedFrame[] = [];
  return {
    get kid() { return kid; },
    get acked() { return acked; },
    send(frame) {
      if (!Number.isSafeInteger(frame.seq) || frame.seq !== highest + 1 || (kid !== undefined && frame.kid !== kid)) {
        throw new Error("non-contiguous frame or wrong session");
      }
      kid = frame.kid;
      highest = frame.seq;
      frames.push(frame);
      return frame;
    },
    ack(ack) {
      if (ack.kid !== kid || ack.ack < acked) return;
      if (!Number.isSafeInteger(ack.ack) || ack.ack < 0 || ack.ack > highest) throw new Error("invalid acknowledgement");
      acked = ack.ack;
      frames = frames.filter((frame) => frame.seq > acked);
    },
    pending: () => frames.slice(),
    reset() { kid = undefined; highest = 0; acked = 0; frames = []; },
  };
}

/** Creates the incoming state machine. */
export function createReliableReceiver(options: ReliableReceiverOptions): ReliableReceiver {
  let kid = options.role === "browser" ? options.kid : undefined;
  let delivered = 0;
  let pending = false;
  let expected: string | undefined;
  const retired = new Set<string>();
  const requested = options.retiredCapacity ?? RETIRED_KIDS_MIN;
  const capacity = Number.isFinite(requested) ? Math.max(RETIRED_KIDS_MIN, Math.floor(requested)) : RETIRED_KIDS_MIN;
  const reset = () => {
    if (kid !== undefined) {
      retired.add(kid);
      while (retired.size > capacity) retired.delete(retired.values().next().value!);
    }
    kid = undefined;
    delivered = 0;
    pending = false;
    expected = undefined;
  };
  const bind = (next: string) => {
    if (next === kid) return;
    if (retired.has(next)) throw new Error("cannot bind a retired session");
    reset();
    kid = next;
  };
  return {
    get kid() { return kid; },
    get delivered() { return delivered; },
    accept(frame) {
      if (!Number.isSafeInteger(frame.seq) || frame.seq < 1) throw new Error("invalid sequence");
      if (retired.has(frame.kid)) return "retired";
      if (frame.kid !== kid) {
        if (options.role === "browser") return kid === undefined ? "buffer" : "unknown_session";
        if (frame.seq !== 1) return "unknown_session";
        // Opt-in: PENDING with no expected kid yet. Hold the frame, adopt nothing.
        if (pending && expected === undefined && options.bufferUntilKid) return "buffer";
        if (pending && expected !== undefined && frame.kid !== expected) return "unknown_session";
        const verdict = pending ? "bind" : "new_session";
        bind(frame.kid);
        delivered = 1;
        return verdict;
      }
      if (frame.seq <= delivered) return "duplicate";
      if (frame.seq !== delivered + 1) return "gap";
      delivered = frame.seq;
      return "deliver";
    },
    bind,
    expectBind() { reset(); pending = true; },
    expectKid(next) { if (pending && kid === undefined) expected = next; },
    beginSession: reset,
    ackFrame: () => kid !== undefined && delivered > 0 ? { v: 1, kid, ack: delivered } : undefined,
    reset,
    isRetired: (value) => retired.has(value),
  };
}
