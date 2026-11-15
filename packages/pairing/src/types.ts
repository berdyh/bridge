import type { DeviceRecord } from "@berdyh/bridge-protocol";

/** Device details shown on the approval page so a phished code is visible (RFC 8628 §5.4). */
export type DeviceInfo = Pick<DeviceRecord, "hostname" | "os" | "runnerVersion">;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface PairingConfig {
  /** Public client id. There is no client secret: this is a public client. */
  clientId: string;
  /** Full URL of the device authorization endpoint (Clerk: `<frontend-api>/oauth/device_authorization`). */
  deviceAuthorizationUrl: string;
  /** Full URL of the token endpoint (Clerk: `<frontend-api>/oauth/token`). */
  tokenUrl: string;
  /** Space-separated scopes; include `offline_access` to get a refresh token. */
  scope?: string;
  device: DeviceInfo;
  /** Request body encoding. RFC 8628 and Clerk use form; a home-grown /api/pair may prefer json. Default form. */
  encoding?: "form" | "json";
  /** Parameter names used to send device details. Defaults: device_name, device_os, runner_version. */
  deviceParams?: { hostname: string; os: string; runnerVersion: string };
  /** Injectable for tests. Default: global fetch. */
  fetch?: FetchLike;
  /** Injectable for tests. Default: abortable setTimeout. */
  sleep?: SleepFn;
  /** Deadline of each HTTP request, in ms. Default 30000. A request that exceeds it fails with `network_error`. */
  requestTimeoutMs?: number;
  /** Injectable clock in epoch ms. Default: Date.now. */
  now?: () => number;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Minimum polling interval in seconds. */
  interval: number;
  /** Epoch ms at which the device code expires, by the injected clock. */
  expiresAt: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  /** Epoch ms at which the access token expires, if the server said. */
  expiresAt?: number;
  /** Private app-hosted enrollment delivery receipt. Persist with tokens, acknowledge only AFTER protected storage succeeds. */
  enrollmentReceipt?: { deviceCode: string; receipt: string };
}

export type PairingErrorCode =
  | "access_denied"
  | "expired_token"
  | "aborted"
  | "invalid_grant"
  | "server_error"
  | "network_error"
  | "invalid_response"
  | "no_refresh_token"
  /** A refresh finished but the stored credentials were cleared, replaced or rotated meanwhile; re-read the store, do not re-pair. */
  | "credentials_changed"
  | "oauth_error";

export class PairingError extends Error {
  readonly code: PairingErrorCode;
  /** Raw OAuth `error` value when the server sent one. */
  readonly oauthError?: string;
  constructor(code: PairingErrorCode, message: string, oauthError?: string) {
    super(message);
    this.name = "PairingError";
    this.code = code;
    if (oauthError !== undefined) this.oauthError = oauthError;
  }
}

/** Implemented by the runner (OS keychain or file fallback). Values are opaque strings. */
export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
