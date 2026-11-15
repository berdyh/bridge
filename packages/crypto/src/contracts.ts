/**
 * Contracts of bridge-crypto. Types only; implementations are the sibling modules.
 * Everything here must run unchanged in browsers (WebCrypto, no Node-only
 * APIs) and in Node >= 22.
 *
 * Roles. SPAKE2 side A is the browser, side B is the runner. Frame directions are
 * `b2r` (browser to runner) and `r2b`.
 */
import type { Direction, E2EEFrame, JsonRpcMessage, SealedBlob } from "@berdyh/bridge-protocol";

export type Bytes = Uint8Array;
export type CryptoRole = "browser" | "runner";

export const CRYPTO_ERROR_CODES = [
  /** Frame seq is not newer than the last accepted one (also an honest retransmit). */
  "replay",
  /** Frame seq jumps past the next expected one (seq > lastAccepted + 1). */
  "gap",
  /** Frame kid does not match the session. */
  "bad_kid",
  /** Frame was sealed for the other direction. */
  "bad_direction",
  /** AEAD tag did not verify, or the ciphertext is malformed. */
  "auth_failed",
  /** SPAKE2 key confirmation MAC did not verify (wrong code or a mismatched transcript). */
  "confirmation_failed",
  /** The peer's SPAKE2 message is not a valid group element. */
  "bad_point",
  "malformed",
] as const;
export type CryptoErrorCode = (typeof CRYPTO_ERROR_CODES)[number];

/**
 * Thrown for every failure above. `message` is generic on purpose: nothing a peer
 * can observe (including the error text relayed back) may reveal which check failed.
 * Callers branch on `code`, locally.
 */
export interface CryptoError extends Error {
  readonly code: CryptoErrorCode;
}

/**
 * Both SPAKE2 sides run the same steps (RFC 9382, edwards25519, SHA-256, HKDF and
 * HMAC for confirmation), with the password being the normalized 8-character user
 * code from bridge-protocol.
 *
 *   const s = createSpake2({role, password, idA, idB});
 *   send(s.message);                       // pake/start (browser) or pake/reply (runner)
 *   const r = s.finish(peerMessage);       // throws CryptoError "bad_point"
 *   send(r.confirmation);                  // the MAC goes in pake/reply or pake/confirm
 *   r.verifyPeerConfirmation(peerMac);     // constant time; false means wrong code
 *   const sealed = await r.seal(myPublicKey, aad);   // long-term key under the SPAKE2 key
 *
 * A session is single use. It does not count attempts: the runner owns the attempt
 * counter (5 per code, 10 minutes, single use) because it is the one that knows
 * the code.
 */
export interface Spake2Session {
  readonly role: CryptoRole;
  /** The message to send to the peer (X from the browser, Y from the runner). */
  readonly message: Bytes;
  /** Consumes the peer's message. Call once. */
  finish(peerMessage: Bytes): Spake2Result;
  /** Zeroizes secrets. Idempotent. */
  destroy(): void;
}

export interface Spake2Result {
  /** Our key-confirmation MAC over the RFC 9382 transcript. */
  readonly confirmation: Bytes;
  /** True when `mac` is the peer's valid confirmation. Constant time. */
  verifyPeerConfirmation(mac: Bytes): boolean;
  /** AEAD-seals `plaintext` under the SPAKE2-derived key. Fresh random nonce. */
  seal(plaintext: Bytes, aad: Bytes): Promise<SealedBlob>;
  /** Opens a blob sealed by the peer. Throws CryptoError "auth_failed". */
  open(blob: SealedBlob, aad: Bytes): Promise<Bytes>;
  destroy(): void;
}

export interface Spake2Params {
  role: CryptoRole;
  /** Normalized user code (`normalizeUserCode`), UTF-8 encoded into the SPAKE2 password. */
  password: string;
  /** Identities in the transcript, e.g. the enrollId and the runnerId. */
  idA: Bytes;
  idB: Bytes;
}

/**
 * A long-term or ephemeral X25519 key pair. The private key is never exposed: use
 * `agree`. `id` is the stable key id used as `browserKeyId`:
 * base64url(SHA-256(publicKey)[0..16)).
 */
export interface KeyPair {
  /** 32-byte raw X25519 public key. */
  readonly publicKey: Bytes;
  readonly id: string;
  /** X25519 shared secret with `peerPublicKey` (32 bytes). Rejects low-order points. */
  agree(peerPublicKey: Bytes): Promise<Bytes>;
  /** A structured-clone-safe form for IndexedDB or an injected store. */
  toStored(): Promise<StoredKeyPair>;
  destroy(): void;
}

/**
 * How a key pair rests. `webcrypto`: a non-extractable CryptoKey (browsers with
 * WebCrypto X25519). `wrapped`: the noble key wrapped by a non-extractable AES-GCM
 * CryptoKey. `raw`: the secret in the clear, for Node, where the caller encrypts it
 * at rest (file mode 0600). Anything in a browser must not be `raw`.
 */
export type StoredKeyPair =
  | { kind: "webcrypto"; publicKey: Bytes; privateKey: CryptoKey }
  | { kind: "wrapped"; publicKey: Bytes; wrappingKey: CryptoKey; iv: Bytes; wrapped: Bytes }
  | { kind: "raw"; publicKey: Bytes; secretKey: Bytes };

/** Inputs of the per-session key schedule. Both sides pass their own view of the same four keys. */
export interface ChannelKeyParams {
  role: CryptoRole;
  ownStatic: KeyPair;
  ownEphemeral: KeyPair;
  peerStaticPublic: Bytes;
  peerEphemeralPublic: Bytes;
}

/**
 * Two directional AES-256-GCM keys, from HKDF-SHA256 over ECDH(static, static),
 * ECDH(ephemeral, ephemeral) and the two cross terms, with info `"bridge channel v1"`
 * plus all four public keys in canonical (sorted) order. `kid` is derived from the
 * same transcript, so both sides compute the same value without sending it.
 *
 * The directional `CryptoKey`s are held internally (non-extractable AES-GCM keys,
 * kept in an internal `WeakMap` keyed by this object, exported by `channel.ts` to `frame.ts` but not from the package barrel) and are reachable only
 * by `createFrameCodec`, which lives in the same package. Nothing outside
 * bridge-crypto can read them; `destroy` drops them.
 */
export interface ChannelKeys {
  readonly kid: string;
  readonly role: CryptoRole;
  destroy(): void;
}

/**
 * Seals and opens frames for one session and one side. AEAD is AES-256-GCM, a
 * random 12-byte nonce from `crypto.getRandomValues`, and AAD = `(v, kid, seq,
 * direction)` with a fixed encoding.
 *
 * Invariants:
 *  - `encrypt` uses seq 1, 2, 3, ... in call order and returns frames in that order.
 *    The frame for a given seq is produced once; retransmission re-sends the same
 *    object.
 *  - `decrypt` checks, before touching the key: version, `kid`, then replay (seq
 *    <= `lastAccepted`) and gap (seq > `lastAccepted` + 1). There is no reordering window: the reliable link
 *    delivers frames in order, once, so a frame is accepted only when seq ==
 *    `lastAccepted` + 1, and accepting out of order would need a seen-set to stop replays. It advances
 *    `lastAccepted` only after the tag verifies, so a forged frame cannot burn a seq.
 *  - Errors are `CryptoError`. A frame at or below `lastAccepted` is `replay`. The
 *    reliable link dedupes by `seq` before it calls `decrypt`, so a replay that
 *    reaches the codec is a fault (a bug or an attack), not a benign duplicate: the
 *    session ends.
 *  - The sealing direction is fixed by the role (browser seals `b2r`); a frame
 *    sealed for the other direction fails as `auth_failed` or `bad_direction`.
 */
export interface FrameCodec {
  readonly kid: string;
  /** The seq the next `encrypt` will use. */
  readonly nextSeq: number;
  /** Highest contiguous seq accepted from the peer; 0 before the first. */
  readonly lastAccepted: number;
  encrypt(message: JsonRpcMessage): Promise<E2EEFrame>;
  decrypt(frame: E2EEFrame): Promise<JsonRpcMessage>;
  destroy(): void;
}

export type { Direction };
