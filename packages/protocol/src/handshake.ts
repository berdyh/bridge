import type { AgentAvailability } from "./types.js";
import { PROTOCOL_VERSION } from "./version.js";
import { isInt, isNonEmpty, isObj, isStr, optional } from "./guards.js";

/** An inclusive range of wire protocol versions. */
export type ProtocolRange = { min: number; max: number };

/** The range this build speaks. */
export const PROTOCOL_RANGE: ProtocolRange = { min: 1, max: PROTOCOL_VERSION };

/**
 * First message on a runner socket, sent by the runner. It replaces the HTTP
 * heartbeat: the relay keeps presence from the open socket.
 */
export type RunnerHello = {
  type: "hello";
  /** The `DeviceRecord.deviceId` the runner was paired as. */
  runnerId: string;
  runnerVersion: string;
  protocol: ProtocolRange;
  /**
   * Used to create or refresh the device record and to name the machine in presence.
   * Untrusted text: use `boundedHostname(hello.hostname)`, never the raw value.
   */
  hostname?: string;
  os?: string;
  agents?: AgentAvailability[];
};

/**
 * The server's answer to a `RunnerHello` that it can serve. `protocol` is the
 * version both sides use for this connection: the highest in both ranges. When the
 * ranges do not overlap the server sends a `control` envelope instead and closes
 * the socket: `update_required` when the runner is too old, or `error` with code
 * `protocol_mismatch` when the server is too old.
 */
export type ServerWelcome = {
  type: "welcome";
  protocol: number;
};

/** The highest version in both ranges, or undefined when they do not overlap. */
export function selectProtocolVersion(a: ProtocolRange, b: ProtocolRange): number | undefined {
  const hi = Math.min(a.max, b.max);
  const lo = Math.max(a.min, b.min);
  return hi >= lo ? hi : undefined;
}

/** Longest hostname the relay stores or repeats. */
export const HOSTNAME_MAX_LENGTH = 255;

/**
 * The hostname a relay may store and repeat: a string of 1 to `HOSTNAME_MAX_LENGTH` characters
 * with no control characters (C0, DEL, C1) and no line or paragraph separators (U+2028/2029),
 * otherwise `undefined`. `isRunnerHello` still accepts a hello whose hostname fails this
 * (an odd machine name must not lock a runner out); the relay just drops the name.
 */
export function boundedHostname(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > HOSTNAME_MAX_LENGTH) return undefined;
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value) ? undefined : value;
}

export function isProtocolRange(v: unknown): v is ProtocolRange {
  return isObj(v) && isInt(v.min) && isInt(v.max) && v.min >= 1 && v.min <= v.max;
}

export function isRunnerHello(v: unknown): v is RunnerHello {
  return (
    isObj(v) &&
    v.type === "hello" &&
    isNonEmpty(v.runnerId) &&
    isNonEmpty(v.runnerVersion) &&
    isProtocolRange(v.protocol) &&
    optional(v.hostname, isStr) &&
    optional(v.os, isStr) &&
    optional(v.agents, (a) => Array.isArray(a) && a.every((x) => isObj(x) && isNonEmpty(x.id) && typeof x.available === "boolean"))
  );
}

export function isServerWelcome(v: unknown): v is ServerWelcome {
  return isObj(v) && v.type === "welcome" && isInt(v.protocol) && v.protocol >= 1;
}

