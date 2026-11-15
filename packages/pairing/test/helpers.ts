import type { CredentialStore, FetchLike, PairingConfig } from "../src/index.js";

export type Reply = { status?: number; body?: unknown; raw?: string } | Error;

export function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit; params: Record<string, string> }[] = [];
  const fn: FetchLike = async (url, init = {}) => {
    const body = typeof init.body === "string" ? init.body : "";
    const params = init.headers && (init.headers as Record<string, string>)["content-type"] === "application/json"
      ? (JSON.parse(body) as Record<string, string>)
      : Object.fromEntries(new URLSearchParams(body));
    calls.push({ url, init, params });
    const r = replies.shift();
    if (!r) throw new Error("fakeFetch: no reply queued");
    if (r instanceof Error) throw r;
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  };
  return { fn, calls };
}

export function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleeps,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("aborted-in-sleep");
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => void (t += ms),
  };
}

export function memoryStore(): CredentialStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

export function baseConfig(over: Partial<PairingConfig> = {}): PairingConfig {
  return {
    clientId: "client-1",
    deviceAuthorizationUrl: "https://clerk.example/oauth/device_authorization",
    tokenUrl: "https://clerk.example/oauth/token",
    scope: "openid offline_access",
    device: { hostname: "laptop", os: "linux", runnerVersion: "1.2.3" },
    ...over,
  };
}
