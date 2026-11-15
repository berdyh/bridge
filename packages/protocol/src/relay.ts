import type { ProtocolRange } from "./handshake.js";
import { isNonEmpty, isObj, isStr, optional } from "./guards.js";
import type { AgentAvailability } from "./types.js";

export type RelayRole = "runner" | "browser";
export const RELAY_ROLES: readonly RelayRole[] = ["runner", "browser"];

export const RELAY_KINDS = ["frame", "pake", "presence", "control"] as const;
export type RelayKind = (typeof RELAY_KINDS)[number];

/**
 * The routing header the relay can read. `body` is opaque to the relay: it is
 * forwarded, never parsed, never rewritten.
 *
 * Addressing. `to` is the role of the recipient. `runnerId` is the runner on either
 * side of the conversation (`DeviceRecord.deviceId`). `browserKeyId` names the
 * browser end:
 *  - browser -> runner: the sender's own id. The relay rejects an envelope whose
 *    `browserKeyId` differs from the id the browser socket was opened with.
 *  - runner -> browser: the target browser. Required for `frame` and `pake`.
 *  - relay-originated `presence` and `control` envelopes follow the same shape.
 *
 * `browserKeyId` is the id of the enrolled long-term key, base64url(SHA-256(public
 * key)[0..16)) (see `pake.ts`); before enrollment (and in plaintext mode) it is
 * a random id the browser picked, at least 128 bits. During enrollment the
 * browser's socket stays under its random id, and the runner's `pake` replies
 * (including `pake/done`) are addressed to that id; afterwards the browser
 * reconnects under the enrolled id.
 *
 * One socket per `browserKeyId`. The relay keeps at most one browser socket per
 * (user, `browserKeyId`): a newer upgrade with the same id closes the older socket
 * with close code `RELAY_CLOSE_REPLACED`. The older one must not reconnect. This is
 * the multi-tab rule: tabs that share an enrolled key replace each other, newest
 * wins, and the older tab's session ends (see "Sessions" on `ChannelLayer`).
 *
 * Kinds. `frame`: a `FrameBody`, forwarded between a browser and a runner of the
 * same user. `pake`: a `PakeMessage`, forwarded the same way. `presence` and
 * `control`: originated by the relay only; the relay drops any it receives.
 */
export type RelayEnvelope<K extends RelayKind = RelayKind, B = unknown> = {
  to: RelayRole;
  runnerId: string;
  browserKeyId?: string;
  kind: K;
  body: B;
};

/** Close code of a browser socket that a newer socket with the same `browserKeyId` replaced. Not retried. */
export const RELAY_CLOSE_REPLACED = 4409;

/** Close code of a runner socket closed because its device or credential was revoked. Not retried. */
export const RELAY_CLOSE_REVOKED = 4401;

/** `kind: "presence"`, sent to a user's browsers when a runner connects or leaves. */
export type PresenceBody = {
  runnerId: string;
  online: boolean;
  /** ISO 8601. */
  lastSeen?: string;
  runnerVersion?: string;
  agents?: AgentAvailability[];
  /**
   * The machine's name from the runner's `hello`, so a page can say "Pair with <hostname>".
   * Always `boundedHostname(hello.hostname)`; display text only, never an identifier.
   */
  hostname?: string;
};

export const RELAY_ERROR_CODES = [
  "protocol_mismatch",
  "unknown_runner",
  "unauthorized",
  "bad_envelope",
  "backpressure",
  "rate_limited",
  "revoked",
] as const;
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];

/** `kind: "control"`, always originated by the relay. */
export type ControlBody =
  /** To a runner whose protocol range is below the server's minimum; the socket is then closed. */
  | { type: "update_required"; server: ProtocolRange; latestRunnerVersion?: string; message?: string }
  /**
   * The peer's socket (re)connected. The recipient must resend every frame the peer
   * has not acknowledged. `browserKeyId` is set when the peer is a browser.
   */
  | { type: "peer_reconnected"; peer: RelayRole; runnerId: string; browserKeyId?: string }
  /** The peer's socket closed. Frames sent now are lost unless resent after `peer_reconnected`. */
  | { type: "peer_gone"; peer: RelayRole; runnerId: string; browserKeyId?: string }
  /** The device was revoked on the server; the socket is closed right after. */
  | { type: "revoked"; runnerId: string }
  | { type: "error"; code: RelayErrorCode; message?: string };

export type FrameEnvelope = RelayEnvelope<"frame">;
export type PakeEnvelope = RelayEnvelope<"pake">;
export type PresenceEnvelope = RelayEnvelope<"presence", PresenceBody>;
export type ControlEnvelope = RelayEnvelope<"control", ControlBody>;

/** Relay socket paths, relative to `BridgeDiscovery.relayUrl`. */
export const RELAY_PATHS: Record<RelayRole, string> = { runner: "/runner", browser: "/browser" };

/**
 * The URL a socket of `role` connects to, built from `BridgeDiscovery.relayUrl`.
 * Runner: `.../runner?runnerId=<id>`. Browser: `.../browser?browserKeyId=<id>`.
 */
export function relayEndpoint(relayUrl: string, role: RelayRole, id: string): string {
  const url = new URL(relayUrl);
  url.pathname = url.pathname.replace(/\/+$/, "") + RELAY_PATHS[role];
  url.search = "";
  url.searchParams.set(role === "runner" ? "runnerId" : "browserKeyId", id);
  return url.toString();
}

/**
 * WebSocket subprotocols. Browsers cannot set headers on a WebSocket, so the
 * session token travels as a subprotocol entry; the server selects `bridge.v1`.
 * Runners may use an `Authorization: Bearer` header instead.
 */
export const RELAY_SUBPROTOCOL = "bridge.v1";
const BEARER_PREFIX = "bearer.";

export function bearerSubprotocol(token: string): string {
  return BEARER_PREFIX + token;
}

/** Extracts the token from a `Sec-WebSocket-Protocol` header value, if any. */
export function tokenFromSubprotocols(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  for (const raw of header.split(",")) {
    const p = raw.trim();
    if (p.startsWith(BEARER_PREFIX) && p.length > BEARER_PREFIX.length) return p.slice(BEARER_PREFIX.length);
  }
  return undefined;
}

/** Header-level check only; it never looks inside `body`. */
export function isRelayEnvelope(v: unknown): v is RelayEnvelope {
  return (
    isObj(v) &&
    (v.to === "runner" || v.to === "browser") &&
    isNonEmpty(v.runnerId) &&
    optional(v.browserKeyId, isNonEmpty) &&
    isStr(v.kind) &&
    (RELAY_KINDS as readonly string[]).includes(v.kind) &&
    "body" in v
  );
}
