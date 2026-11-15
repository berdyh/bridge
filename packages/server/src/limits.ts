import type { BridgeServerConfig } from "./contracts.js";

/**
 * Close code of a socket that reached `maxSocketAgeMs`. It is a plain "service restart"
 * code on purpose: the client SDK and the runner stop only on 4409 (replaced) and 4401
 * (revoked), so any other code makes them reconnect with a freshly fetched token.
 */
export const RELAY_CLOSE_MAX_AGE = 1012;

/** Default maximum socket age: 12 hours. */
export const DEFAULT_MAX_SOCKET_AGE_MS = 12 * 60 * 60 * 1000;

/** Default per-user socket caps: 16 browsers, 8 runners. */
export const DEFAULT_MAX_BROWSER_SOCKETS = 16;
export const DEFAULT_MAX_RUNNER_SOCKETS = 8;

export interface SocketLimits {
  /** 0 disables the age limit. */
  maxSocketAgeMs: number;
  maxBrowserSockets: number;
  maxRunnerSockets: number;
}

/** The effective limits of a config, with defaults applied. */
export function resolveSocketLimits(config: Pick<BridgeServerConfig, "maxSocketAgeMs" | "maxSocketsPerUser">): SocketLimits {
  return {
    maxSocketAgeMs: config.maxSocketAgeMs ?? DEFAULT_MAX_SOCKET_AGE_MS,
    maxBrowserSockets: config.maxSocketsPerUser?.browser ?? DEFAULT_MAX_BROWSER_SOCKETS,
    maxRunnerSockets: config.maxSocketsPerUser?.runner ?? DEFAULT_MAX_RUNNER_SOCKETS,
  };
}
