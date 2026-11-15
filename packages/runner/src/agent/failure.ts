import type { ExecOutcome } from "./exec.js";
import type { FailureReason } from "./types.js";

const AUTH = /not logged in|not signed in|please (log ?in|sign ?in)|unauthori[sz]ed|\b401\b|invalid (api key|credentials|token)|authentication (failed|required)|login required|expired.*(token|session)/i;
const RATE = /rate.?limit|\b429\b|quota|usage limit|too many requests/i;
const OVERLOADED = /overloaded|\b50[234]\b|temporarily unavailable|try again|service unavailable/i;
const FORMAT = /unknown (option|argument|flag)|unexpected argument|unrecognized (option|arguments?)|invalid (option|value for)|usage:/i;

/**
 * Turn a finished, unsuccessful invocation into a reason. Auth is checked
 * first: a signed-out CLI is chatty ("try again" lines would otherwise read as
 * overloaded and the ladder would retry a credential that never works).
 */
export function classifyFailure(o: ExecOutcome): FailureReason {
  if (o.aborted) return "cancelled";
  if (o.spawnCode === "ENOENT" || o.spawnCode === "EACCES") return "not_installed";
  if (o.timedOut) return "timeout";
  const text = `${o.stderr}\n${o.stdout}`;
  if (AUTH.test(text)) return "auth_permanent";
  if (RATE.test(text)) return "rate_limit";
  if (FORMAT.test(text)) return "format";
  if (OVERLOADED.test(text)) return "overloaded";
  return "unknown";
}

/** Reasons where trying the next agent can help. `format`/`cancelled` stop the ladder. */
export function shouldFailover(reason: FailureReason): boolean {
  return reason !== "format" && reason !== "cancelled";
}

export function tail(text: string, limit = 2_000): string {
  const t = text.trim();
  return t.length > limit ? `...${t.slice(-limit)}` : t;
}
