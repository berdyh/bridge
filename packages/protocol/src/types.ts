export type AgentAvailability = {
  /** Agent CLI id, e.g. "claude", "codex". */
  id: string;
  available: boolean;
  version?: string;
};

export type DeviceRecord = {
  userId: string;
  deviceId: string;
  hostname: string;
  os: string;
  runnerVersion: string;
  /** ISO 8601 timestamps. */
  createdAt: string;
  lastSeen: string;
};

/** RFC 8628 section 3.2. */
export type DeviceAuthorizationResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

/** RFC 8628 section 3.5 / RFC 6749 section 5.1. */
export type DeviceTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

export const DEVICE_ERROR_CODES = [
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];

export type DeviceErrorResponse = {
  error: DeviceErrorCode;
  error_description?: string;
};
