/**
 * The runner's E2EE seam: the CLI and the end-to-end layer meet here. The CLI always calls
 * the functions in `./index.ts`; the end-to-end layer implements their bodies and does
 * not change these signatures.
 *
 * Stack for one browser on one app connection (the CLI builds the bottom, the end-to-end layer the middle):
 *
 *   AcpProxy ── BrowserChannel ── wrapRunnerChannel ── RunnerWire ── relay envelopes
 *               (JSON-RPC)         (ChannelLayer)      (frames)       (reliable link, CLI)
 *
 * Enrollment runs beside that stack, not through it. The first message of an
 * unenrolled browser is `pake/start` under a random pre-enrollment id, which creates
 * no session and no `RunnerWire`: the CLI's link creates an `EnrollmentWire` for it and
 * hands it to `acceptEnrollment`.
 *
 *   relay envelope (pake/*) ── link ── EnrollmentWire ── acceptEnrollment (E2EE layer)
 */
import type { HandshakeIO, MessageStream, SequencedFrame, Unsubscribe } from "@berdyh/bridge-protocol";

import type { AppPaths } from "../paths.js";

/** The identity of one app connection of this runner, and where its local state lives. */
export interface E2eeApp {
  /** `BridgeDiscovery.app.id`. */
  appId: string;
  /** This runner's id for that app (`DeviceRecord.deviceId`). */
  runnerId: string;
  /**
   * The app's own bridge config folder (`appPathsOf(base, id)`, `<config>/<app>/bridge`): one
   * connection per app folder, so the files are `trust.json`, `identity.json`, `identity.key` and
   * `enroll.json` inside it (the runner id still goes into the identity's AAD). Never default this
   * to the real `~/.config` inside the package: the CLI passes it. It must belong to this app:
   * `paths.appId` equals `appId` and `configDir` is `<...>/<appId>/bridge`, or every store call
   * throws. The `bridge/` folder and the files in it must not be symlinks (the store refuses them).
   */
  paths: Pick<AppPaths, "appId" | "configDir">;
  /**
   * Where the key that encrypts this runner's identity key at rest lives. The CLI passes the
   * runner's durable credential store (the OS keychain), so the identity file on disk is
   * useless without it. Without one, the key sits in a separate 0600 file under
   * the config folder: that still keeps the secret out of the identity file (a copy or backup
   * of that file alone reveals nothing), but not out of reach of whoever can read
   * that folder.
   */
  secrets?: SecretStore;
}

/** The part of a credential store (`CredentialStore` in bridge-pairing fits) that the identity key needs. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Needed to forget an app (`removeAppState`); a store without it keeps the wrapping key. */
  delete?(key: string): Promise<void>;
}

/**
 * The runner's reliable link to one browser: what `wrapRunnerChannel` receives.
 * The CLI implements it over the relay socket with the same reliability rules as the
 * client `Transport`: frames are retained until acked, resent in `seq` order after
 * a reconnect or `peer_reconnected`, delivered once and in order, acked after
 * delivery. The link reads `kid` and `seq` only.
 *
 * It carries frames and `pake`-kind handshake messages for ONE SESSION of one
 * `browserKeyId`. When a newer session for the same `browserKeyId` starts, the
 * demultiplexer closes this wire (`close("superseded")`) and creates a new
 * `RunnerWire`; see "Sessions" on `ChannelLayer` in bridge-protocol for the
 * triggers, `session/close`, the retired-`kid` rule, `unknown_session`, the
 * `PEER_GONE_GRACE_MS` fallback and the multi-tab rule. The wire consumes
 * `session/close` itself (it closes, reason `peer closed`) and never passes it to
 * `handshake`.
 *
 * `closed` becomes true when the link is torn down. `close` sends the browser a
 * `session/close` (with the session identifier, the browser-to-runner `kid`, once
 * known, and a matching reason)
 * so that the browser's channel ends too.
 */
export interface RunnerWire {
  readonly appId: string;
  readonly browserKeyId: string;
  /**
   * The `session/init` handshake id of a wire created by `session/init`: the
   * correlation key for closes while the wire is pending. Unset for a plaintext wire
   * created by a data frame.
   */
  readonly sid?: string;
  /**
   * The session identifier (the browser's `kid`). Bound when the handshake completes:
   * the layer reports its negotiated `kid` at `start` resolution and the link sets
   * this through `bindSession`, before any data. A wire created by a plaintext data
   * frame has it from creation. The plaintext layer adopts it
   * (`createPlainLayer({ kid })`) so both directions carry the browser's `kid`.
   */
  readonly kid?: string;
  /** Called by `channelFromLayer` once `layer.start` resolves, with `layer.kid`. Sets `kid`. */
  bindSession(kid: string): void;
  readonly closed: boolean;
  sendFrame(frame: SequencedFrame): void;
  onFrame(handler: (frame: SequencedFrame) => void): Unsubscribe;
  /** Session setup and enrollment messages with this browser. */
  readonly handshake: HandshakeIO;
  onClose(handler: (reason?: string) => void): Unsubscribe;
  close(reason?: string): void;
}

/**
 * The runner's link to one browser that is enrolling. The CLI creates it when a
 * `pake/start` arrives whose `enrollId` (the envelope's `browserKeyId`) has no
 * enrollment wire yet, and passes it to `acceptEnrollment`; it is never given to
 * `wrapRunnerChannel` and never becomes a `BrowserChannel` (see rule 7 of "Sessions"
 * on `ChannelLayer` in bridge-protocol).
 *
 * `handshake` carries the `pake/*` messages of this enrollment, in both directions;
 * replies are addressed to the same `enrollId`. Nothing is retained or resent. The
 * link closes the wire right after it sends `pake/done`, or when the browser's
 * socket goes away, or when a newer `pake/start` from the same `enrollId` replaces
 * it (`close("superseded")`).
 */
export interface EnrollmentWire {
  readonly appId: string;
  /** `PakeStart.enrollId`: the browser's random pre-enrollment id; the replies' `browserKeyId`. */
  readonly enrollId: string;
  readonly closed: boolean;
  readonly handshake: HandshakeIO;
  onClose(handler: (reason?: string) => void): Unsubscribe;
  /** Idempotent. The link closes it itself after `pake/done`; an enrollment may close early (for example on a protocol error). */
  close(reason?: string): void;
}

/** What `wrapRunnerChannel` needs besides the wire. */
export interface RunnerE2eeContext {
  app: E2eeApp;
  /**
   * False selects the plaintext layer (`createPlainLayer`), used by the plaintext test harness
   * (`BRIDGE_E2EE=0`). True requires an enrolled browser and refuses plaintext frames.
   */
  e2ee: boolean;
  /** Test seams. */
  now?: () => Date;
  random?: (n: number) => Uint8Array;
}

/** An entry of a runner's trust list for one app. */
export interface TrustedBrowser {
  /** `KeyPair.id` of `publicKey`: base64url(SHA-256(public key)[0..16)). */
  browserKeyId: string;
  /** Raw X25519 public key, base64url. */
  publicKey: string;
  label: string;
  /** ISO 8601. */
  enrolledAt: string;
  lastSeen: string;
}

/**
 * The runner-side half of the enrollment UI. It is injected, so tests need no TTY.
 * (`enroll` and the running daemon share state through files under `configDir`,
 * because `bridge enroll` is a separate process from `bridge run`.)
 */
export interface EnrollPrompt {
  /** Shows the 8-character code and when it expires. */
  showCode(code: string, expiresAt: string): void;
  /**
   * Shows the browser's details and asks the local user to trust it. `keyId` is the
   * browser's `browserKeyId` (`KeyPair.id`); show it so the user can compare.
   *
   * The wait is bounded: when the code expires or the enrollment is cancelled, `enroll`
   * stops waiting and aborts `options.signal`, so a prompt can dismiss itself. Whatever
   * it answers after that is discarded.
   */
  confirm(browser: { label: string; keyId: string }, options?: { signal?: AbortSignal }): Promise<boolean>;
}

export interface EnrollResult {
  /** The enrolled browser's `KeyPair.id`, as reported in `PakeDone.browserKeyId`. */
  browserKeyId: string;
  label: string;
  enrolledAt: string;
}
