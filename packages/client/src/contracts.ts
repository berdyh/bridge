/**
 * Contracts of bridge-client: browser-first, also runnable headless in Node. Two
 * layers sit between an ACP connection and the relay:
 *
 *   ACP client connection (SDK)
 *        │ JSON-RPC messages
 *   ChannelLayer      plain or end-to-end encrypted: message <-> sequenced frame
 *        │ frames (kid, seq visible)
 *   Transport         reliable link: seq, ack, resend, dedupe, reconnect with jittered backoff
 *        │ RelayEnvelope text messages
 *   WebSocket to /relay/browser   (native in browsers, `ws` in Node)
 */
import type { ClientApp, ClientConnection, RequestPermissionRequest, RequestPermissionResponse, Stream } from "@agentclientprotocol/sdk";
import type {
  AckFrame,
  BridgeDiscovery,
  ChannelLayer,
  ControlBody,
  EnrollLink,
  HandshakeIO,
  JsonRpcMessage,
  LocalUiParams,
  MessageStream,
  PakeMessage,
  PresenceBody,
  SequencedFrame,
  Unsubscribe,
} from "@berdyh/bridge-protocol";

export type { ChannelLayer, EnrollLink, MessageStream, SequencedFrame };

export type TransportState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/**
 * The reliable link between this browser and the relay. It speaks `RelayEnvelope`s
 * with `to: "runner"` and this client's `browserKeyId`.
 *
 * Reliability contract (the runner implements the mirror image):
 *  - `sendFrame` retains the frame until an `AckFrame` for its `kid` covers its
 *    `seq`. Retained frames are resent in `seq` order, byte-identical, after the
 *    socket reconnects and whenever a `peer_reconnected` control arrives for the
 *    runner. The transport never changes a frame; it reads `kid` and `seq` only.
 *  - Received frames are delivered to `onFrame` in order, once. A duplicate
 *    (`seq` <= last delivered for the current `kid`) is dropped and re-acked. A gap
 *    (`seq` > last + 1 on the current `kid`) is a transport fault: the socket is
 *    closed so that the reconnect and `peer_reconnected` resend repair it. A frame
 *    whose `kid` is NOT the current session's `kid` is never a gap: if its `seq`
 *    is > 1 or its `kid` is retired it is dropped silently, and the socket is
 *    never closed for it (Sessions rule 3 on `ChannelLayer`). In E2EE the browser
 *    keeps only r2b frames with `kid == layer.kid` once `start` resolves. Before
 *    `bindSession` the session is unbound: frames with an unseen, non-retired `kid`
 *    are buffered (at most `PENDING_FRAMES_MAX`; a retired `kid` is dropped) and fed
 *    through the receiver right after `bindSession`, which drops those of another
 *    `kid`. Buffer overflow or `HANDSHAKE_TIMEOUT_MS` ends the session with
 *    `session/close` reason `error`. An `AckFrame` beyond the highest `seq` sent is a
 *    fault and ends the session the same way (`ReliableSender.ack` throws). The shared state machine is
 *    `createReliableSender` / `createReliableReceiver` in bridge-protocol, which this
 *    transport implements.
 *  - The cumulative `AckFrame` is sent after delivery, batched (at most one per
 *    animation frame or 20 ms) and not retained.
 *  - Sending while disconnected queues; the queue is bounded and `sendFrame`
 *    throws when it overflows.
 *  - Reconnect uses jittered exponential backoff, and re-reads the session token
 *    (`getSessionToken`) each time.
 *  - A socket reconnect is not a session end. Sessions (a `kid` per
 *    `browserKeyId`, how they start and end, `session/close`, multi-tab) are
 *    defined once, in "Sessions" on `ChannelLayer` in bridge-protocol. For this
 *    link: frames of a new `kid` replace the retained frames and dedupe state of
 *    the old one; `session/close` for the current `kid` is
 *    surfaced through `onPake` to the channel, which ends its stream.
 *  - Close code `RELAY_CLOSE_REPLACED` (a newer tab took this `browserKeyId`) puts
 *    the transport in `closed` without reconnecting.
 */
export interface Transport {
  readonly state: TransportState;
  /** The `browserKeyId` the socket is (or will be) opened under. Changes only through `rebind`. */
  readonly browserKeyId: string;
  connect(): Promise<void>;
  /**
   * Reopens the socket under a new `browserKeyId`, for the moment enrollment turns
   * the random pre-enrollment id into the enrolled key's id (`KeyPair.id`). Closes
   * the current socket (without `session/close`), drops retained frames and dedupe
   * state, then connects again; resolves when `state` is `open` under the new id.
   * Only valid while no session is running (enrollment is such a time). Rejects
   * if the transport is `closed`.
   */
  rebind(browserKeyId: string): Promise<void>;
  /** Closes for good; retained frames are dropped. */
  close(): void;
  /**
   * Starts a new session toward `runnerId`: retires the current `kid`, resets the
   * dedupe and retain state and puts the receiver in the unbound state, so early
   * frames of the new session are buffered (`PENDING_FRAMES_MAX`) until
   * `bindSession`. `createChannel` calls it first, before `layer.start`.
   */
  beginSession(runnerId: string): void;
  /**
   * Tells the transport the session identifier (`layer.kid`) of the channel to
   * `runnerId`, so its receiver can filter on it and flush buffered frames. Order:
   * `beginSession`, then `layer.start`, then `createChannel` calls it once `layer.start` has resolved (E2EE, where the `kid`
   * is derived by the handshake) or right away (plaintext, where `kid` is valid at
   * once), and before it sends or opens any data frame. Calling it again with the
   * same `kid` is a no-op; with a different `kid` it starts a new session (the old
   * `kid` is retired, retained frames and dedupe state are reset).
   */
  bindSession(runnerId: string, kid: string): void;
  sendFrame(runnerId: string, frame: SequencedFrame): void;
  sendPake(runnerId: string, message: PakeMessage): void;
  onFrame(handler: (runnerId: string, frame: SequencedFrame) => void): Unsubscribe;
  onPake(handler: (runnerId: string, message: PakeMessage) => void): Unsubscribe;
  onPresence(handler: (presence: PresenceBody) => void): Unsubscribe;
  /** Relay-originated controls: `peer_reconnected`, `peer_gone`, `revoked`, `error`. */
  onControl(handler: (control: ControlBody) => void): Unsubscribe;
  onState(handler: (state: TransportState) => void): Unsubscribe;
}

export interface TransportOptions {
  /** `BridgeDiscovery.relayUrl`. */
  relayUrl: string;
  /**
   * This client's initial `browserKeyId`: the enrolled key's id (`KeyPair.id` of the
   * stored key) when the browser is enrolled with a runner, otherwise a random id of
   * at least 128 bits (base64url) that `BridgeClient` picks once per page load.
   */
  browserKeyId: string;
  getSessionToken: () => Promise<string>;
  /** Test seams. */
  webSocket?: typeof WebSocket;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type { AckFrame };

/** The result of enrollment. */
export interface EnrolledRunner {
  runnerId: string;
  /** The enrolled key's id, `KeyPair.id` = base64url(SHA-256(public key)[0..16)); the value `PakeDone.browserKeyId` reports. */
  browserKeyId: string;
  enrolledAt: string;
}

/** Where a browser's long-term key rests. Browsers use IndexedDB; Node tests and the headless client inject their own. */
export interface KeyStore {
  /** Opaque, structured-clone-safe value (see `StoredKeyPair` in bridge-crypto). */
  load(name: string): Promise<unknown | undefined>;
  save(name: string, value: unknown): Promise<void>;
  delete(name: string): Promise<void>;
}

/** What `wrapClientLayer` and `enroll` receive. Everything environmental is injected. */
export interface ClientE2eeContext {
  /** Talks pake-kind messages to one runner, through the transport. */
  handshakeFor(runnerId: string): HandshakeIO;
  /**
   * The transport's current `browserKeyId`. `enroll` uses it as the `enrollId` of
   * `pake/start`, so the runner's replies are routed back to this socket.
   */
  readonly browserKeyId: string;
  /**
   * Reconnects the transport under `browserKeyId` (`Transport.rebind`). `enroll`
   * calls it once, after `pake/done` with `ok: true` passed the identity check
   * (`isEnrolledAs`), with `PakeDone.browserKeyId`.
   * After it resolves, `browserKeyId` returns the new id.
   */
  rebind(browserKeyId: string): Promise<void>;
  keyStore: KeyStore;
  /** The runner this layer or enrollment is for. */
  runnerId: string;
  /** Label shown on the runner when it asks the user to trust this browser. */
  label?: string;
  /**
   * `enroll` calls this with the browser's own key id (`KeyPair.id`) as soon as the long-term
   * key is loaded, before `pake/start`, so the page can show `wordsOf(keyId)` while the runner
   * asks.
   */
  onBrowserKey?: (keyId: string) => void;
  /** Test seams. */
  random?: (n: number) => Uint8Array;
  now?: () => Date;
}

export interface BridgeClientOptions {
  /** `<app-url>/.well-known/bridge.json`. */
  discoveryUrl: string;
  /** Returns the app user's current session token (Clerk: `session.getToken()`). Called on every (re)connect. */
  getSessionToken: () => Promise<string>;
  /** Where the browser key lives. Default: IndexedDB in browsers; required in Node. */
  keyStore?: KeyStore;
  /** `false` forces the plaintext layer (tests only; real runners refuse it). Default: E2EE. */
  e2ee?: boolean;
  label?: string;
  /** Test seams. */
  fetch?: typeof fetch;
  webSocket?: typeof WebSocket;
}

/** Options of `BridgeClient.enroll`. */
export interface EnrollOptions {
  /** Called with this browser's key id as soon as it is known, before `pake/start`. Show `wordsOf(keyId)`. */
  onBrowserKey?(keyId: string): void;
}

/**
 * What a page can know about the runner: it cannot know "not installed", only that no
 * runner is online for this user.
 *  - `no_runner`: no runner is known from relay presence or this app's saved IDs.
 *  - `runner_offline`: a runner is known but not online.
 *  - `online_not_enrolled`: a runner is online and this browser is not enrolled with it.
 *  - `ready`: a runner is online and this browser is enrolled with it.
 *  - `runner_selection_required`: several known runners are online at once; select an
 *    explicit runner. Offline known runners never trigger it: with none online, the most
 *    recently seen one is reported `runner_offline` (the persisted list is capped at 8, most
 *    recent first).
 */
export type BridgeStatusState = "no_runner" | "runner_offline" | "online_not_enrolled" | "ready" | "runner_selection_required";

export interface BridgeStatus {
  state: BridgeStatusState;
  /** The selected runner (absent for `no_runner` or `runner_selection_required`). Persisted IDs start offline. */
  runner?: PresenceBody;
}

export type SetupFlavor = "human" | "agent";

export interface SetupInstructionsOptions {
  /** The app's URL, `https://app.example`; the command is `bridge setup <appUrl>`. */
  appUrl: string;
  appName: string;
  /** Picks the install one-liner wording; default: detected from the browser, else `linux`. */
  platform?: "linux" | "darwin";
  /** `human`: steps for a person at a terminal. `agent`: a prompt for Claude Code or Codex. */
  flavor: SetupFlavor;
  /** Pin the CLI the copy runs: `npx @berdyh/bridge@<cliVersion>`. Default: unpinned (latest). */
  cliVersion?: string;
  /** npm registry for the `npx` commands: `npx --registry <registry> ...`. Default: the user's npm config. */
  registry?: string;
}

/** Structured setup copy. Pure data: usable on the server too. */
export interface SetupInstructions {
  flavor: SetupFlavor;
  /** The line to paste into a terminal. */
  oneLiner: string;
  steps: string[];
  /** `flavor: "agent"` only: the prompt to paste into a coding agent. */
  agentPrompt?: string;
  troubleshooting: { problem: string; fix: string }[];
}

/** One option the runner forwards for a permission request (only allow_once and reject_once reach a browser). */
export interface PermissionOptionView {
  optionId: string;
  name: string;
  kind: string;
}

/** What `permissionPrompt` hands to `mount` to render. Strings from the agent: display as text only. */
export interface PermissionView {
  sessionId: string;
  title?: string;
  toolKind?: string;
  locations?: { path: string; line?: number }[];
  /** Untrusted JSON from the agent. */
  rawInput?: unknown;
  options: PermissionOptionView[];
}

export interface PermissionPromptOptions {
  /**
   * Renders `view` and calls `answer(optionId)` on a choice, or `answer(null)` to dismiss.
   * Returns an unmount function. With no `mount`, or on `answer(null)`, the handler selects
   * `reject_once` if offered, otherwise cancels.
   */
  mount?: (view: PermissionView, answer: (optionId: string | null) => void) => () => void;
  /** Dismiss after this long. Default: never (the runner cancels on `session/cancel`). */
  timeoutMs?: number;
}

/** The `onRequest` handler for the ACP `client({...})` that `permissionPrompt` returns. */
export type PermissionHandler = (args: { params: RequestPermissionRequest }) => Promise<RequestPermissionResponse>;

/**
 * The client app's handle on the bridge. Created by `connectBridge`; discovery has
 * already been fetched and validated (same-origin rule) when it exists.
 */
export interface BridgeClient {
  readonly discovery: BridgeDiscovery;
  readonly transport: Transport;
  /** Runners from relay presence or this app's saved known-runner IDs; saved IDs start offline. */
  runners(): PresenceBody[];
  onRunners(handler: (runners: PresenceBody[]) => void): Unsubscribe;
  /**
   * Enrolls this browser with a runner using the 8-character code the runner
   * shows (SPAKE2 through the relay). Delegates to `enroll` in `./e2ee`.
   *
   * Identity. The socket is open under a random pre-enrollment `browserKeyId`,
   * which `enroll` also uses as the `enrollId`. When the runner answers
   * `pake/done` with `ok: true`, the client checks `isEnrolledAs(done, keyId)`
   * (bridge-protocol): `PakeDone.browserKeyId` must equal `KeyPair.id` of the new
   * key, computed locally. It must NOT compare the transport's current
   * `browserKeyId` or the `enrollId`: those are the random pre-enrollment id and
   * never equal a derived id. On a match it stores the key and calls
   * `transport.rebind(done.browserKeyId)`, so the relay now routes this browser
   * under its enrolled identity. On a mismatch the enrollment fails, nothing is
   * stored and the transport is not rebound. The result's `browserKeyId` is that
   * id. Any channel opened before enrollment is closed first; call `channel()`
   * again afterwards.
   */
  enroll(code: string, runnerId?: string, opts?: EnrollOptions): Promise<EnrolledRunner>;
  /**
   * Where this page stands with a runner: default to the only online runner, or the most
   * recently seen offline one. Several online runners report `runner_selection_required`.
   * Resolves from relay presence and app-scoped saved IDs/trust after a short initial
   * presence settle window. See `BridgeStatusState`.
   */
  status(runnerId?: string): Promise<BridgeStatus>;
  /**
   * Calls `handler` whenever `status()` would answer differently. Returns an unsubscribe.
   * With `runnerId`, follows `status(runnerId)` instead of the default summary, so changes to
   * that runner are delivered even while several runners stay online.
   */
  onStatus(handler: (status: BridgeStatus) => void, runnerId?: string): Unsubscribe;
  /**
   * Whether this browser holds an enrolled key for `runnerId`: the key is saved only after a
   * confirmed `pake/done`. The runner may have revoked it since; a `not_trusted` close tells.
   */
  isEnrolled(runnerId: string): Promise<boolean>;
  /**
   * A JSON-RPC message stream to a runner's ACP proxy, through the channel layer.
   * `runnerId` defaults to the only online runner and throws if that is ambiguous.
   */
  channel(runnerId?: string): Promise<MessageStream<JsonRpcMessage>>;
  /** `channel()` as an ACP SDK `Stream` (a pair of Web streams of JSON-RPC messages), for `ClientApp.connect(stream)`. */
  stream(runnerId?: string): Promise<Stream>;
  /**
   * Connects `app` (built with the SDK's `client({...})` and its `onRequest`
   * handlers for permissions and fs) to the runner over `stream()`. Uses the SDK's
   * current `ClientApp` API, not the deprecated `ClientSideConnection`.
   */
  acp(app: ClientApp, runnerId?: string): Promise<ClientConnection>;
  /** A plugin's local UI URL, delivered inside the channel as `_bridge/localUi`. */
  onLocalUi(handler: (params: LocalUiParams) => void): Unsubscribe;
  close(): void;
}
