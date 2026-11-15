import { isBase64Url, isInt, isNonEmpty, isObj, isStr, optional } from "./guards.js";

/**
 * Enrollment and session-setup messages, the body of a `pake` envelope. The relay
 * only ever sees these, never the code, the long-term keys or the session secrets.
 *
 * Enrollment (SPAKE2, RFC 9382) runs browser -> runner -> browser -> runner:
 *
 *   browser                                   runner
 *   pake/start   {enrollId, msg: X}      ->
 *                                        <-   pake/reply   {enrollId, codeId, msg: Y, mac, sealed}
 *   pake/confirm {enrollId, codeId, mac, sealed}  ->
 *                                        <-   pake/done    {enrollId, codeId, ok, ...}
 *
 * The runner shows the browser's details (from `sealed`) and asks the local user
 * before it sends `pake/done` with `ok: true` and adds the key to its trust list.
 *
 * `enrollId` is the random id (at least 128 bits, base64url) the browser's
 * transport was opened with; the browser uses it as `enrollId` as well, so the
 * runner's replies (`pake/reply`, `pake/done`) are addressed to it as the
 * envelope's `browserKeyId` and reach the socket that is waiting for them. After a
 * successful `pake/done` the browser reconnects under its enrolled `browserKeyId`
 * (see below and `Transport.rebind` in bridge-client).
 *
 * Two waits bound the exchange. Up to the runner's `pake/confirm` check, every step is
 * bounded by `HANDSHAKE_TIMEOUT_MS` (layer.ts, 15 s): when it elapses the browser's
 * `enroll` rejects and the runner drops the attempt. The last step, the local user's
 * yes or no on the runner's terminal, takes as long as a person needs, so the browser's
 * wait for `pake/done` and the runner's wait for the answer are bounded by the code's
 * life instead (`ENROLL_CODE_TTL_MS`), not by `HANDSHAKE_TIMEOUT_MS`. The user starts
 * again after a timeout; a resent `pake/start` reuses the same `enrollId` and replaces
 * the stalled attempt on the runner.
 *
 * `browserKeyId` has ONE definition everywhere (envelopes, trust lists, crypto
 * `KeyPair.id`): base64url(SHA-256(browser long-term X25519 public key)[0..16)),
 * unpadded. The runner computes it from the public key in `pake/confirm.sealed`
 * and reports it in `pake/done`; the browser computes the same value and must
 * treat a mismatch as a failed enrollment. `codeId` is chosen by the runner and is
 * not derived from the code, because anything derived from the code allows an
 * offline guess.
 */
export type PakeStart = {
  t: "pake/start";
  v: 1;
  enrollId: string;
  /** SPAKE2 message from the browser (side A), base64url. */
  msg: string;
};

export type PakeReply = {
  t: "pake/reply";
  v: 1;
  enrollId: string;
  codeId: string;
  /** SPAKE2 message from the runner (side B). */
  msg: string;
  /** Runner key-confirmation MAC over the transcript. */
  mac: string;
  /** The runner's long-term X25519 public key, sealed under the SPAKE2 key. */
  sealed: SealedBlob;
};

export type PakeConfirm = {
  t: "pake/confirm";
  v: 1;
  enrollId: string;
  codeId: string;
  /** Browser key-confirmation MAC over the transcript. */
  mac: string;
  /** Browser long-term public key and label, sealed under the SPAKE2 key. */
  sealed: SealedBlob;
};

export const PAKE_DONE_REASONS = [
  "bad_code",
  "expired",
  "locked",
  "rejected_by_user",
  "no_enrollment_open",
  "protocol_error",
] as const;
export type PakeDoneReason = (typeof PAKE_DONE_REASONS)[number];

/** Final result. After `locked` or `expired` the code is dead and a new one is needed. */
export type PakeDone = {
  t: "pake/done";
  v: 1;
  enrollId: string;
  codeId?: string;
  ok: boolean;
  /** Present when `ok` is false. */
  reason?: PakeDoneReason;
  /** Attempts left on the code after this one. */
  attemptsLeft?: number;
  /** ISO 8601 expiry of the code. */
  expiresAt?: string;
  /**
   * On success, the enrolled key's `browserKeyId`: base64url(SHA-256(public key)[0..16)),
   * the same value as `KeyPair.id`. Not "assigned" by the runner; it is derived.
   */
  browserKeyId?: string;
  /**
   * Present on success. `pake/done` itself is not authenticated, so a relay could forge
   * an `ok: true` over a refusal; this is the runner's proof that it really accepted the
   * browser: a fixed token sealed under the SPAKE2 key, with an AAD that binds the
   * enrollment and the enrolled `browserKeyId`. Only a party holding the SPAKE2 key can
   * make it. A browser counts a `pake/done` as success only if it opens.
   */
  proof?: SealedBlob;
};

/**
 * The enrollment identity check, for the browser. `localKeyId` is `KeyPair.id` of
 * the long-term key the browser just generated, computed locally. Enrollment
 * succeeded only if the runner answered `ok: true` AND reported exactly that id in
 * `PakeDone.browserKeyId`.
 *
 * Do NOT compare against the transport's current `browserKeyId`: before
 * `Transport.rebind` that is the random pre-enrollment id (the `enrollId`), which
 * never equals a derived key id. The id to rebind to is `done.browserKeyId`, after
 * this check passes.
 */
export function isEnrolledAs(done: PakeDone, localKeyId: string): boolean {
  return done.ok && done.browserKeyId !== undefined && done.browserKeyId === localKeyId;
}

/** AEAD output, both base64url. */
export type SealedBlob = { nonce: string; ct: string };

/**
 * Session setup, run after enrollment on every new browser<->runner session (not
 * on a mere socket reconnect). Each side contributes a fresh X25519 ephemeral
 * key. The channel keys come from ECDH over both long-term keys and both ephemeral
 * keys (see `ChannelKeys` in bridge-crypto). The first frame that decrypts proves
 * the peer holds its long-term key.
 */
export type SessionInit = {
  t: "session/init";
  v: 1;
  /**
   * Handshake id: random, at least 128 bits, base64url, picked by the browser per
   * session attempt. While the session has no `kid` yet (the wire is pending), this
   * is what correlates `session/close` and `session/accept` to it.
   */
  sid: string;
  eph: string;
};
export type SessionAccept = { t: "session/accept"; v: 1; sid: string; eph: string };

export const SESSION_CLOSE_REASONS = [
  /** The sender ended the session on purpose (a stream was closed, the tab is going away). */
  "closed",
  /** A newer session for the same `browserKeyId` replaced this one. */
  "superseded",
  /** The receiver has no session for the frames it was sent (for example, the runner restarted). Start a new one. */
  "unknown_session",
  /** Closed after the peer stayed away longer than `PEER_GONE_GRACE_MS`. */
  "peer_gone",
  /** The session failed (a replay, a gap, a bad tag, a failed handshake). */
  "error",
  /**
   * The runner does not trust this browser: it is not enrolled, or it was revoked. The browser
   * should enroll (or enroll again) instead of retrying.
   */
  "not_trusted",
] as const;
export type SessionCloseReason = (typeof SESSION_CLOSE_REASONS)[number];

/**
 * Ends one logical browser<->runner session, from either endpoint. The relay cannot
 * originate `control` on behalf of an endpoint, so this is how a browser tells its
 * runner that the channel is gone (the runner then kills the session's agent
 * processes) and how a runner tells a browser the same.
 *
 * `kid` is the session identifier: the `kid` of the browser-to-runner direction
 * (the browser layer's `kid`; the same value as the shared `kid` in E2EE), whichever
 * side sends the close. A browser compares it to `layer.kid`, a runner to the `kid`
 * its wire was created for. A receiver ignores a close whose `kid` is
 * present and is not its current session's kid (this is what lets two tabs share a
 * `browserKeyId` without closing each other's new session). Before a session has a
 * `kid` (a pending wire, a failed handshake) the close carries `sid`, the
 * `session/init` handshake id, and applies only to the wire created by that
 * `session/init`. A close with neither a matching `kid` nor a matching `sid` is
 * never applied to any wire. Full rules: "Sessions" on `ChannelLayer`.
 */
export type SessionClose = { t: "session/close"; v: 1; kid?: string; sid?: string; reason?: SessionCloseReason };

/**
 * How long a runner keeps a browser's session after the relay reports `peer_gone`
 * for it. If the browser has not come back (`peer_reconnected`) within this time,
 * the runner closes the channel as if `session/close` (`peer_gone`) had arrived.
 */
export const PEER_GONE_GRACE_MS = 60 * 1000;

export type PakeMessage =
  | PakeStart
  | PakeReply
  | PakeConfirm
  | PakeDone
  | SessionInit
  | SessionAccept
  | SessionClose;

/** Codes expire after 10 minutes, work once and allow 5 attempts (the plan's rules). */
export const ENROLL_CODE_TTL_MS = 10 * 60 * 1000;
export const ENROLL_MAX_ATTEMPTS = 5;

const isSealed = (v: unknown): v is SealedBlob => isObj(v) && isBase64Url(v.nonce) && isBase64Url(v.ct);

export function isPakeMessage(v: unknown): v is PakeMessage {
  if (!isObj(v) || v.v !== 1 || !isStr(v.t)) return false;
  switch (v.t) {
    case "pake/start":
      return isBase64Url(v.enrollId) && isBase64Url(v.msg);
    case "pake/reply":
      return isBase64Url(v.enrollId) && isNonEmpty(v.codeId) && isBase64Url(v.msg) && isBase64Url(v.mac) && isSealed(v.sealed);
    case "pake/confirm":
      return isBase64Url(v.enrollId) && isNonEmpty(v.codeId) && isBase64Url(v.mac) && isSealed(v.sealed);
    case "pake/done":
      return (
        isBase64Url(v.enrollId) &&
        typeof v.ok === "boolean" &&
        optional(v.codeId, isNonEmpty) &&
        optional(v.reason, (r) => (PAKE_DONE_REASONS as readonly unknown[]).includes(r)) &&
        optional(v.attemptsLeft, (n) => isInt(n) && (n as number) >= 0) &&
        optional(v.expiresAt, isNonEmpty) &&
        optional(v.browserKeyId, isBase64Url) &&
        optional(v.proof, isSealed) &&
        (v.ok || v.reason !== undefined)
      );
    case "session/init":
    case "session/accept":
      return isBase64Url(v.sid) && isBase64Url(v.eph);
    case "session/close":
      return (
        optional(v.kid, isBase64Url) &&
        optional(v.sid, isBase64Url) &&
        optional(v.reason, (r) => (SESSION_CLOSE_REASONS as readonly unknown[]).includes(r))
      );
    default:
      return false;
  }
}
