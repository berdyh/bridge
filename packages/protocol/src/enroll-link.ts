import { isValidUserCode, normalizeUserCode } from "./user-code.js";

/**
 * The enroll link: how `bridge setup` hands the enrollment code to the app's enroll page
 * without the code ever reaching the app server. The CLI opens
 * `<origin><enrollPage>#code=XXXXXXXX&runner=<runnerId>`; a fragment is never sent in an
 * HTTP request, and the page strips it before doing anything else. Shared by the CLI (writer)
 * and the client (reader).
 */
export type EnrollLink = {
  /** The normalized 8-character code (`normalizeUserCode`), without a dash. */
  code: string;
  /** The runner's id for this app (`DeviceRecord.deviceId`). */
  runnerId: string;
};

/** What a runner id may contain in a link: letters, digits, `.`, `_`, `-` (UUIDs fit). */
const RUNNER_ID = /^[A-Za-z0-9._-]{1,128}$/;
const CODE_FORM = /^[A-Za-z0-9-]{8,12}$/;

export function isEnrollRunnerId(value: unknown): value is string {
  return typeof value === "string" && RUNNER_ID.test(value);
}

/**
 * The fragment for a link, WITH the leading `#`: `#code=XXXXXXXX&runner=<runnerId>`.
 * Throws when the code is not a valid user code or the runner id is outside the safe
 * charset, so nothing that needs escaping ever reaches the URL.
 */
export function formatEnrollFragment(link: { code: string; runnerId: string }): string {
  if (!isValidUserCode(link.code)) throw new Error("invalid enrollment code");
  if (!isEnrollRunnerId(link.runnerId)) throw new Error("invalid runner id");
  return `#code=${normalizeUserCode(link.code)}&runner=${link.runnerId}`;
}

/**
 * Strict reader for `location.hash` (with or without the leading `#`). Only the keys `code`
 * and `runner` are allowed, each exactly once, in any order; values are taken literally
 * (no percent-decoding, no `+`), the code must pass `isValidUserCode`, and the runner id
 * must be in the safe charset. Anything else is `undefined`: an unknown key, a duplicate, a
 * missing part, an empty fragment.
 */
export function parseEnrollFragment(hash: string): EnrollLink | undefined {
  if (typeof hash !== "string") return undefined;
  const parts = (hash.startsWith("#") ? hash.slice(1) : hash).split("&");
  let code: string | undefined;
  let runnerId: string | undefined;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) return undefined;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "code") {
      if (code !== undefined || !CODE_FORM.test(value) || !isValidUserCode(value)) return undefined;
      code = normalizeUserCode(value);
    } else if (key === "runner") {
      if (runnerId !== undefined || !isEnrollRunnerId(value)) return undefined;
      runnerId = value;
    } else {
      return undefined;
    }
  }
  return code !== undefined && runnerId !== undefined ? { code, runnerId } : undefined;
}
