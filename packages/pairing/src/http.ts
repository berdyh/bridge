import { PairingError, type FetchLike, type PairingConfig, type SleepFn } from "./types.js";

export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function abortError(): PairingError {
  return new PairingError("aborted", "pairing aborted");
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface Resolved {
  fetch: FetchLike;
  sleep: SleepFn;
  now: () => number;
  requestTimeoutMs: number;
}

export function resolve(config: PairingConfig): Resolved {
  return {
    fetch: config.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    sleep: config.sleep ?? defaultSleep,
    now: config.now ?? Date.now,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

export interface PostResult {
  status: number;
  body: Record<string, unknown>;
}

/** POST params; never throws on HTTP status, only on transport or non-JSON failure. */
export async function postParams(
  config: PairingConfig,
  r: Resolved,
  url: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<PostResult> {
  const json = config.encoding === "json";
  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": json ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: json ? JSON.stringify(params) : new URLSearchParams(params).toString(),
    // The body carries a device or refresh token; never re-POST it to a redirect target.
    redirect: "error",
  };
  // Every request has a deadline, so a server that never answers cannot hang the caller; the
  // caller's own signal (a stop) still cancels it at once.
  const deadline = AbortSignal.timeout(r.requestTimeoutMs);
  init.signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let res: Response;
  try {
    res = await r.fetch(url, init);
  } catch (err) {
    if (signal?.aborted) throw abortError();
    throw new PairingError("network_error", `request failed: ${(err as Error)?.message ?? "unknown"}`);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    if (res.status >= 500) return { status: res.status, body: {} };
    throw new PairingError("invalid_response", `non-JSON response (HTTP ${res.status})`);
  }
  return { status: res.status, body };
}

export const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
