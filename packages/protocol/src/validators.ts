import {
  DEVICE_ERROR_CODES,
  type AgentAvailability,
  type DeviceAuthorizationResponse,
  type DeviceErrorCode,
  type DeviceErrorResponse,
  type DeviceRecord,
  type DeviceTokenResponse,
} from "./types.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => isStr(v) && v.length > 0;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isPosNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const optional = (v: unknown, f: (x: unknown) => boolean) => v === undefined || f(v);

export function isAgentAvailability(v: unknown): v is AgentAvailability {
  return (
    isObj(v) && isNonEmpty(v.id) && typeof v.available === "boolean" && optional(v.version, isStr)
  );
}

export function isDeviceRecord(v: unknown): v is DeviceRecord {
  return (
    isObj(v) &&
    isNonEmpty(v.userId) &&
    isNonEmpty(v.deviceId) &&
    isNonEmpty(v.hostname) &&
    isNonEmpty(v.os) &&
    isNonEmpty(v.runnerVersion) &&
    isNonEmpty(v.createdAt) &&
    isNonEmpty(v.lastSeen)
  );
}

export function isDeviceAuthorizationResponse(v: unknown): v is DeviceAuthorizationResponse {
  return (
    isObj(v) &&
    isNonEmpty(v.device_code) &&
    isNonEmpty(v.user_code) &&
    isNonEmpty(v.verification_uri) &&
    optional(v.verification_uri_complete, isNonEmpty) &&
    isPosNum(v.expires_in) &&
    optional(v.interval, isPosNum)
  );
}

export function isDeviceTokenResponse(v: unknown): v is DeviceTokenResponse {
  return (
    isObj(v) &&
    isNonEmpty(v.access_token) &&
    isNonEmpty(v.token_type) &&
    optional(v.expires_in, isPosNum) &&
    optional(v.refresh_token, isStr) &&
    optional(v.scope, isStr)
  );
}

export function isDeviceErrorCode(v: unknown): v is DeviceErrorCode {
  return isStr(v) && (DEVICE_ERROR_CODES as readonly string[]).includes(v);
}

export function isDeviceErrorResponse(v: unknown): v is DeviceErrorResponse {
  return isObj(v) && isDeviceErrorCode(v.error) && optional(v.error_description, isStr);
}
