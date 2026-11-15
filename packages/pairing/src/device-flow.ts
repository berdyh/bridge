import {
  isDeviceAuthorizationResponse,
  isDeviceErrorCode,
  isDeviceTokenResponse,
} from "@berdyh/bridge-protocol";
import { abortError, postParams, resolve, str, type Resolved } from "./http.js";
import {
  PairingError,
  type DeviceAuthorization,
  type PairingConfig,
  type TokenSet,
} from "./types.js";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;
const MAX_TRANSIENT_FAILURES = 3;

function oauthFailure(status: number, body: Record<string, unknown>, what: string): PairingError {
  const code = str(body.error);
  if (code) {
    // Only the error code and description are surfaced; bodies may hold secrets otherwise.
    const desc = str(body.error_description);
    return new PairingError(
      status >= 500 ? "server_error" : "oauth_error",
      `${what}: ${code}${desc ? ` (${desc})` : ""}`,
      code,
    );
  }
  return new PairingError(status >= 500 ? "server_error" : "invalid_response", `${what}: HTTP ${status}`);
}

/** RFC 8628 §3.1: request device and user codes, sending device details for the approval page. */
export async function startDeviceAuthorization(
  config: PairingConfig,
  opts: { signal?: AbortSignal } = {},
): Promise<DeviceAuthorization> {
  const r = resolve(config);
  const names = config.deviceParams ?? {
    hostname: "device_name",
    os: "device_os",
    runnerVersion: "runner_version",
  };
  const params: Record<string, string> = { client_id: config.clientId };
  if (config.scope) params.scope = config.scope;
  params[names.hostname] = config.device.hostname;
  params[names.os] = config.device.os;
  params[names.runnerVersion] = config.device.runnerVersion;

  const { status, body } = await postParams(config, r, config.deviceAuthorizationUrl, params, opts.signal);
  if (status < 200 || status >= 300 || str(body.error)) {
    throw oauthFailure(status, body, "device authorization failed");
  }
  if (!isDeviceAuthorizationResponse(body)) {
    throw new PairingError("invalid_response", "device authorization response is missing or malformed");
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    ...(body.verification_uri_complete ? { verificationUriComplete: body.verification_uri_complete } : {}),
    expiresIn: body.expires_in,
    interval: body.interval ?? DEFAULT_INTERVAL_S,
    expiresAt: r.now() + body.expires_in * 1000,
  };
}

export function toTokenSet(body: Record<string, unknown>, r: Resolved, previousRefresh?: string): TokenSet {
  if (!isDeviceTokenResponse(body)) {
    throw new PairingError("invalid_response", "token response is missing or malformed");
  }
  const refreshToken = str(body.refresh_token) ?? previousRefresh;
  const scope = str(body.scope);
  return {
    accessToken: body.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    tokenType: body.token_type,
    ...(scope ? { scope } : {}),
    ...(body.expires_in !== undefined ? { expiresAt: r.now() + body.expires_in * 1000 } : {}),
  };
}

/**
 * RFC 8628 §3.4/§3.5: poll the token endpoint until approval, denial, expiry or abort.
 * Waits the interval before each request; slow_down permanently adds 5 seconds.
 */
export async function pollForToken(
  config: PairingConfig,
  auth: Pick<DeviceAuthorization, "deviceCode" | "interval" | "expiresAt">,
  opts: { signal?: AbortSignal } = {},
): Promise<TokenSet> {
  const r = resolve(config);
  const { signal } = opts;
  let intervalS = auth.interval > 0 ? auth.interval : DEFAULT_INTERVAL_S;
  let transient = 0;

  for (;;) {
    if (signal?.aborted) throw abortError();
    if (r.now() >= auth.expiresAt) {
      throw new PairingError("expired_token", "device code expired before approval", "expired_token");
    }
    try {
      await r.sleep(intervalS * 1000, signal);
    } catch (err) {
      if (signal?.aborted) throw abortError();
      throw err;
    }
    if (signal?.aborted) throw abortError();
    if (r.now() >= auth.expiresAt) {
      throw new PairingError("expired_token", "device code expired before approval", "expired_token");
    }

    let result;
    try {
      result = await postParams(
        config,
        r,
        config.tokenUrl,
        { grant_type: DEVICE_GRANT, device_code: auth.deviceCode, client_id: config.clientId },
        signal,
      );
    } catch (err) {
      if (err instanceof PairingError && err.code === "network_error" && ++transient <= MAX_TRANSIENT_FAILURES) {
        continue;
      }
      throw err;
    }
    const { status, body } = result;
    const error = str(body.error);

    if (!error && status >= 200 && status < 300) {
      const tokens = toTokenSet(body, r);
      if (body.enrollment_receipt !== undefined) {
        if (typeof body.enrollment_receipt !== "string" || !/^[a-f0-9]{64}$/.test(body.enrollment_receipt)) throw new PairingError("invalid_response", "invalid enrollment delivery receipt");
        tokens.enrollmentReceipt = { deviceCode: auth.deviceCode, receipt: body.enrollment_receipt };
      }
      return tokens;
    }

    if (isDeviceErrorCode(error)) {
      switch (error) {
        case "authorization_pending":
          transient = 0;
          continue;
        case "slow_down":
          transient = 0;
          intervalS += SLOW_DOWN_STEP_S;
          continue;
        case "access_denied":
          throw new PairingError("access_denied", "the user denied the request", error);
        case "expired_token":
          throw new PairingError("expired_token", "device code expired", error);
      }
    }
    if (error === "invalid_grant") {
      throw new PairingError("invalid_grant", "the device code is no longer valid", error);
    }
    // Any 5xx is transient, with or without an OAuth error body.
    if (status >= 500 && ++transient <= MAX_TRANSIENT_FAILURES) continue;
    throw oauthFailure(status, body, "token request failed");
  }
}

/**
 * Confirm durable storage of an app-hosted enrollment. Caller MUST save tokens first;
 * then save the returned TokenSet to remove the receipt. A lost ack response is safe
 * to retry, including on process restart from the saved receipt. OAuth is a no-op.
 * The device code and receipt stay in the POST body to the original token endpoint.
 */
export async function acknowledgeEnrollment(
  config: PairingConfig,
  tokens: TokenSet,
  opts: { signal?: AbortSignal } = {},
): Promise<TokenSet> {
  if (!tokens.enrollmentReceipt) return tokens;
  const r = resolve(config);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await postParams(config, r, config.tokenUrl, {
        grant_type: "urn:berdyh:bridge:enrollment-ack", client_id: config.clientId,
        device_code: tokens.enrollmentReceipt.deviceCode, enrollment_receipt: tokens.enrollmentReceipt.receipt,
      }, opts.signal);
      if (result.status >= 200 && result.status < 300 && result.body.acknowledged === true) {
        const { enrollmentReceipt: _receipt, ...saved } = tokens;
        return saved;
      }
      if (result.status < 500 && result.status !== 409 && result.status !== 429) throw new PairingError("invalid_grant", "enrollment delivery could not be confirmed; pair again");
    } catch (e) {
      if (!(e instanceof PairingError) || e.code !== "network_error") throw e;
    }
    if (attempt < 2) await r.sleep(1000 * (attempt + 1), opts.signal);
  }
  throw new PairingError("server_error", "enrollment acknowledgement unavailable; retry setup to confirm the saved credential");
}

/** RFC 6749 §6 refresh. Keeps the old refresh token when the server does not rotate it. */
export async function refreshAccessToken(
  config: PairingConfig,
  refreshToken: string,
  opts: { signal?: AbortSignal } = {},
): Promise<TokenSet> {
  const r = resolve(config);
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  };
  const { status, body } = await postParams(config, r, config.tokenUrl, params, opts.signal);
  const error = str(body.error);
  if (error === "invalid_grant") {
    throw new PairingError("invalid_grant", "refresh token is no longer valid; pair again", error);
  }
  if (error || status < 200 || status >= 300) throw oauthFailure(status, body, "token refresh failed");
  return toTokenSet(body, r, refreshToken);
}
