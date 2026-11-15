import type { E2EEFrame, PlainFrame } from "./e2ee.js";
import { isPlainFrame } from "./e2ee.js";
import type { JsonRpcMessage } from "./jsonrpc.js";
import type { PakeMessage } from "./pake.js";
import type { RandomBytes } from "./user-code.js";

/**
 * Upper bound on `ChannelLayer.start`, and on one enrollment attempt (`pake/start`
 * to `pake/done`). When it elapses `start` rejects, the channel ends with
 * `session/close` reason `error` and the app calls `channel()` again. An
 * enrollment that times out is restarted by the user; a resent `pake/start` reuses
 * the same `enrollId` and replaces the stalled attempt on the runner.
 */
export const HANDSHAKE_TIMEOUT_MS = 15_000;

export type Unsubscribe = () => void;

/**
 * A bidirectional stream of discrete messages, the shape every hop shares.
 *
 * Invariants: `send` never throws once the stream is open; after `close` (from
 * either side) `closed` is true, `send` is a no-op, handlers get no more messages
 * and every `onClose` handler has been called exactly once. Messages from one
 * sender arrive in order.
 */
export interface MessageStream<M = JsonRpcMessage> {
  readonly closed: boolean;
  send(message: M): void | Promise<void>;
  onMessage(handler: (message: M) => void): Unsubscribe;
  onClose(handler: (reason?: string) => void): Unsubscribe;
  close(reason?: string): void;
}

/** Sends and receives `pake`-kind bodies to and from one peer (one browser or one runner). */
export interface HandshakeIO {
  send(message: PakeMessage): void;
  onMessage(handler: (message: PakeMessage) => void): Unsubscribe;
}

/** A frame the reliable link can carry: it has a visible `kid` and `seq`. */
export type SequencedFrame = E2EEFrame | PlainFrame;

/**
 * Turns JSON-RPC messages into sequenced frames and back. This is the seam where
 * end-to-end encryption plugs in: a plaintext layer (below), and an AES-GCM
 * layer from bridge-crypto. The reliable link (seq, ack, resend, dedupe) sits
 * beneath it and only reads `kid` and `seq`; it never decrypts.
 *
 * Invariants:
 *  - `seal` assigns `seq` 1, 2, 3, ... in call order; frames come out in that order.
 *  - `open` is called with frames in `seq` order, each at most once per session. It
 *    rejects (typed error, never a leak of which check failed) on a replayed seq, a
 *    gap, an unknown `kid`, or a failed tag. After a rejection the session is dead.
 *  - One layer instance is one session. `start` runs once per instance; there is no
 *    re-key of a live layer (rule 8 below says why, and what rotates instead). A new
 *    session is a new instance.
 *
 * ## Sessions
 *
 * This is the one place the session rules are written down. `Transport` and
 * `RunnerWire` (the reliable links), the client `createChannel`, the runner's
 * `channelFromLayer` and the runner's demultiplexer all follow it.
 *
 * 1. A logical session is a `kid` on a `browserKeyId`. The SESSION IDENTIFIER is the
 *    `kid` of the browser's layer (`layer.kid` in the browser); every frame of the
 *    session, in BOTH directions, carries it. E2EE: both sides derive that `kid`
 *    from the handshake transcript. Plaintext: the browser's layer picks a random
 *    `kid` and the runner's plain layer ADOPTS it (`createPlainLayer({ kid })`, with
 *    the `kid` the runner learned from the data frame that created its wire), so the
 *    two directions carry the same `kid` and the browser filters inbound frames on
 *    `kid == layer.kid` exactly as in E2EE. `seq` restarts at 1 in every session.
 *    "Current kid" means this value on both sides. `session/close.kid` is always the
 *    session identifier. The reliable link dedupes by `seq` per `kid` and keeps no
 *    state across sessions.
 * 2. One session per `browserKeyId` per runner at a time; the newest wins. A session
 *    starts, on the runner side, when the link sees (a) a `session/init` pake
 *    message, or (b) a data frame (not an ack) whose `kid` is neither the current
 *    nor a retired one, and whose `seq` is 1. On either trigger the link closes the
 *    current channel for that `browserKeyId` (`RunnerWire.close("superseded")`, which
 *    sends `session/close` with reason `superseded` and the old `kid`, or its `sid` if the wire is still pending), resets
 *    its retain/dedupe state, remembers the old `kid` as retired (a small bounded
 *    set, at least 8) and creates a new `RunnerWire`, which the demultiplexer passes to
 *    `wrapRunnerChannel`. Data frames and acks carrying a retired `kid` are dropped
 *    (a data frame also draws a scoped close, rule 3). BINDING is distinct from
 *    supersession. A wire created by `session/init` is PENDING and is identified by
 *    that message's `sid` (handshake id). Its `kid` is bound when the handshake
 *    completes, before any data: the channel layer reports the negotiated `kid` when
 *    `start` resolves and the link sets `RunnerWire.kid` then (`bindSession`). A
 *    pending wire's closes (`superseded`, a browser `session/close`) are correlated
 *    by `sid`; a close with neither a matching `kid` nor a matching `sid` is never
 *    applied to another wire. A plaintext wire created by a data frame (trigger b)
 *    has its `kid` from creation. A data frame with an unseen `kid` and `seq` 1 that
 *    reaches a wire still PENDING (the receiver was told `expectBind`) BINDS it
 *    (`bind`; delivered to the existing wire, negotiated layer kept). Once the negotiated `kid` is
 *    known (`bindSession`), only that `kid` binds: a frame with another unseen `kid` is dropped like
 *    any `unknown_session` frame, so a relay cannot inject a junk `kid` and supersede the session. Only a new `kid`
 *    arriving at an already BOUND wire is supersession (`new_session`), and trigger
 *    (b) creates a wire only when none is pending or bound. A `pake/start` is NOT a
 *    session trigger: see rule 7.
 * 3. A data frame whose `kid` is not the current one is never a gap fault and never
 *    closes the socket (a reconnect would resend the same frame forever). Runner: an
 *    unseen `kid` with `seq` > 1 belongs to a session this side lost (the runner
 *    restarted, or the session was already closed); the link drops the frame and
 *    replies `session/close` with that `kid` and reason `unknown_session`. A
 *    RETIRED `kid` is dropped and draws the same scoped `session/close`
 *    (`unknown_session`, that `kid`), at most once per `kid` per socket connection:
 *    otherwise a browser whose earlier close was lost (for example the runner retired
 *    the session after `PEER_GONE_GRACE_MS` while the browser was away) would resend
 *    forever. The browser treats that close as the end of its session (rule 5). Acks
 *    with a retired `kid` are dropped silently. Browser: a frame whose `kid` is not
 *    `layer.kid`, whatever its `seq`, or whose `kid` is retired, is dropped silently,
 *    with no reply (the browser has no session to close for it). A new browser
 *    session begins with `Transport.beginSession` (before `layer.start`), which
 *    retires the current `kid` and leaves the receiver UNBOUND; in E2EE `kid ==
 *    layer.kid` filtering starts once `start` resolves (`Transport.bindSession`).
 *    While unbound the transport BUFFERS frames with an unseen, non-retired `kid`
 *    (at most `PENDING_FRAMES_MAX`), then feeds them through the receiver right after
 *    `bindSession`, dropping those of another `kid`. Overflow, or
 *    `HANDSHAKE_TIMEOUT_MS`, ends the session with reason `error`. The shared state
 *    machine is `createReliableReceiver` (reliable.ts).
 * 4. The browser side. `BridgeClient.channel()` creates a new layer (a new `kid`),
 *    so a page reload or a second call starts a new session. A socket reconnect is
 *    NOT a session end: the same session continues, with retained frames resent.
 *    The client's channel ends when: it is closed locally (it sends `session/close`
 *    reason `closed`), a `session/close` for its `kid` arrives, its layer fails
 *    (a frame of another `kid` is dropped under rule 3, it does not end the channel),
 *    or the transport is closed for good
 *    (including `RELAY_CLOSE_REPLACED`). The app then calls `channel()` again.
 * 5. Ending. Either endpoint ends a session with `session/close { kid, reason }`.
 *    The runner closing its `BrowserChannel` is what kills the session's agent
 *    processes, so a `session/close` received on a wire closes the channel
 *    (reason `peer closed`). The link consumes `session/close`; it is not passed on
 *    to `HandshakeIO` handlers. A receiver ignores a close whose `kid` is present
 *    and not its current one. Fallback when no close arrives (tab killed, network
 *    gone): the runner closes the session if the relay reports `peer_gone` for the
 *    browser and no `peer_reconnected` follows within `PEER_GONE_GRACE_MS`.
 * 6. Multi-tab. Tabs that share one `browserKeyId` share one session slot. The relay
 *    keeps one browser socket per id (the newest, see `RELAY_CLOSE_REPLACED`), so
 *    opening a second tab replaces the first end to end: the first tab's socket is
 *    closed and does not reconnect, and its session is closed as `superseded` once
 *    the second tab's session starts.
 * 7. Enrollment is not a session. `pake/start` is the first message a runner sees
 *    from a browser that is not yet in its trust list, and that browser's
 *    `browserKeyId` is the random pre-enrollment id (the message's `enrollId`). The
 *    link does not create a `RunnerWire` for it and never passes it to
 *    `wrapRunnerChannel`, so an enrollment can never become a `BrowserChannel` that
 *    the proxy attaches. It creates an `EnrollmentWire` keyed by that id and hands
 *    it to `acceptEnrollment` (bridge-runner, `e2ee`), which owns the `pake/*`
 *    exchange for it. The `EnrollmentWire` closes right after `pake/done`, ok or
 *    not: on success the browser rebinds its socket under the enrolled id and
 *    starts a normal session (rule 2) with `session/init`. A second `pake/start`
 *    from the same id while an enrollment is running replaces the first. Enrollment
 *    messages are not retained or resent (like all `pake` messages, see rule 8): a
 *    dropped socket ends the attempt and the user starts again with the same code
 *    while it is still valid.
 * 8. Key rotation, and what a reconnect does. Session keys rotate per SESSION: every
 *    new layer instance uses fresh ephemeral keys and derives a new `kid`, so no key
 *    outlives its session (a page reload, `channel()`, a runner restart and
 *    `superseded` all rotate them). A socket reconnect continues the session with the
 *    SAME keys: the link must resend its retained frames byte-identical, and those
 *    bytes were sealed under the current keys, so re-keying a live layer is
 *    prohibited. Nothing on `RunnerWire` or `Transport` signals "re-key now" for this
 *    reason; `peer_reconnected` only triggers a resend. Handshake messages
 *    (`HandshakeIO`) are not retained: if the socket drops while `start` is still
 *    running, `start` rejects (it times out or the link reports the loss) and the
 *    channel ends as a failed handshake; the app calls `channel()` again. `start` is
 *    bounded: it rejects after `HANDSHAKE_TIMEOUT_MS` at the latest, and the channel
 *    ends with `session/close` reason `error`. This is
 *    the reading of "session keys rotate per connection" in the plan (a connection
 *    is a session between a browser and a runner, not a socket).
 */
export interface ChannelLayer {
  readonly kind: "plain" | "e2ee";
  /**
   * Session key id, the session identifier (rule 1), equal on both sides. E2EE:
   * derived from the handshake, valid after `start` resolves. Plain: a random
   * base64url id picked by the browser's layer instance, valid at once; the
   * runner's layer adopts the browser's (`PlainLayerOptions.kid`). Never a constant.
   */
  readonly kid: string;
  /**
   * Runs session setup for this session over `io` and resolves when frames may
   * flow. Called exactly once per instance. Plaintext resolves at once. Rejects if
   * the peer is not trusted, if the link reports the socket lost mid-handshake, or
   * after `HANDSHAKE_TIMEOUT_MS`.
   */
  start(io: HandshakeIO): Promise<void>;
  seal(message: JsonRpcMessage): Promise<SequencedFrame>;
  open(frame: SequencedFrame): Promise<JsonRpcMessage>;
  /** Zeroizes key material. Idempotent. */
  close(): void;
}

export interface PlainLayerOptions {
  /**
   * The session `kid`. The runner passes the browser's `kid` so both directions
   * carry it. Default (the browser, and tests): 16 random bytes, base64url.
   */
  kid?: string;
  /** Test seam for the random source. */
  random?: RandomBytes;
}

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * The plaintext layer: wraps each message in a `PlainFrame`. Used until the E2EE layer
 * replaces it, and by tests that exercise the link without crypto. Never use it on
 * a reachable deployment.
 *
 * Each instance is one session (see "Sessions" on `ChannelLayer`): it uses
 * `options.kid` (the runner: the browser's `kid`) or picks a random one (the
 * browser), numbers its frames from 1, and `open` accepts only frames of that same
 * `kid`; any other is rejected with `bad_kid`, so a stale frame from an earlier
 * session cannot be delivered into this one.
 */
export function createPlainLayer(options: PlainLayerOptions = {}): ChannelLayer {
  const kid = options.kid ?? toBase64Url((options.random ?? ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n))))(16));
  let out = 0;
  let inSeq = 0;
  return {
    kind: "plain",
    kid,
    start: async () => {},
    seal: async (message) => ({ v: 1, kid, seq: ++out, msg: message }),
    open: async (frame) => {
      if (!isPlainFrame(frame)) throw new Error("not a plain frame");
      if (frame.kid !== kid) throw new Error("bad_kid");
      if (frame.seq !== inSeq + 1) throw new Error(frame.seq <= inSeq ? "replay" : "gap");
      inSeq = frame.seq;
      return frame.msg;
    },
    close: () => {},
  };
}
