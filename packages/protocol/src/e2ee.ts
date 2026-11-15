import { isBase64Url, isNonNegInt, isObj, isPosInt, isStr } from "./guards.js";
import type { JsonRpcMessage } from "./jsonrpc.js";

/** Which way a frame travels. Part of the AEAD associated data. */
export type Direction = "b2r" | "r2b";
export const DIRECTIONS: readonly Direction[] = ["b2r", "r2b"];

/** Frame format version. Bump on any change to the layout or the AAD. */
export const FRAME_VERSION = 1;

/**
 * An encrypted channel frame, the body of a `frame` envelope.
 *
 * - `kid` names the session key set (one per browser<->runner session, derived from
 *   the handshake transcript). A receiver drops frames with an unknown `kid`.
 * - `seq` starts at 1 and rises by exactly 1 per frame per direction within a
 *   session. Frames are retransmitted byte-identical, so a duplicate has the same
 *   `seq`, `nonce` and `ct`.
 * - `nonce` is 12 random bytes. `ct` is AES-256-GCM over the UTF-8 JSON of one
 *   JSON-RPC message, with AAD `(v, kid, seq, direction)`.
 *
 * All binary fields are unpadded base64url.
 */
export type E2EEFrame = {
  v: 1;
  kid: string;
  seq: number;
  nonce: string;
  ct: string;
};

/**
 * The plaintext stand-in for `E2EEFrame`, used when the encryption layer is
 * absent. It has the same `seq` rules, so reconnect and replay behave identically.
 * It is told apart from `E2EEFrame` by its `msg` field (an `E2EEFrame` has `nonce`
 * and `ct`), never by its `kid`.
 *
 * `kid` is a random base64url id that the browser's `createPlainLayer` instance
 * picks, one per session; the runner's plain layer adopts it, so both directions
 * of a plaintext session carry the same kid. A constant kid would make a reloaded browser look like the
 * continuation of its previous session; see "Sessions" on `ChannelLayer`.
 * Servers and runners that require E2EE refuse plain frames.
 */
export type PlainFrame = {
  v: 1;
  kid: string;
  seq: number;
  msg: JsonRpcMessage;
};

/**
 * A cumulative acknowledgement, also the body of a `frame` envelope: the receiver
 * has delivered every frame of session `kid` up to and including `ack`. It is not
 * encrypted and has no `seq` of its own, so the relay (or anyone on the path) can
 * forge it. The worst a forged ack does is make the sender drop frames the peer
 * never got, which breaks the session and forces a re-key. The relay can already
 * drop frames, so this adds no new power.
 */
export type AckFrame = {
  v: 1;
  kid: string;
  ack: number;
};

/** Every shape a `frame` envelope body may take. */
export type FrameBody = E2EEFrame | PlainFrame | AckFrame;

export function isE2EEFrame(v: unknown): v is E2EEFrame {
  return (
    isObj(v) &&
    v.v === FRAME_VERSION &&
    isBase64Url(v.kid) &&
    isPosInt(v.seq) &&
    isBase64Url(v.nonce) &&
    isBase64Url(v.ct)
  );
}

export function isPlainFrame(v: unknown): v is PlainFrame {
  return isObj(v) && v.v === FRAME_VERSION && isBase64Url(v.kid) && isPosInt(v.seq) && isObj(v.msg) && v.msg.jsonrpc === "2.0";
}

export function isAckFrame(v: unknown): v is AckFrame {
  return isObj(v) && v.v === FRAME_VERSION && isStr(v.kid) && v.kid.length > 0 && isNonNegInt(v.ack) && !("seq" in v);
}

export function isFrameBody(v: unknown): v is FrameBody {
  return isE2EEFrame(v) || isPlainFrame(v) || isAckFrame(v);
}
