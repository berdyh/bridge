import { acknowledgeEnrollment, pollForToken, refreshAccessToken } from "./device-flow.js";
import {
  PairingError,
  type CredentialStore,
  type PairingConfig,
  type TokenSet,
} from "./types.js";

export const DEFAULT_TOKEN_KEY = "pairing.tokens";

/**
 * Per store+key credential generation. Every deliberate mutation (save, clear, re-pair) bumps
 * it synchronously, so a refresh that started earlier can tell its credential was replaced.
 */
const generations = new WeakMap<CredentialStore, Map<string, number>>();

function generation(store: CredentialStore, key: string): number {
  return generations.get(store)?.get(key) ?? 0;
}

function bumpGeneration(store: CredentialStore, key: string): void {
  let m = generations.get(store);
  if (!m) generations.set(store, (m = new Map()));
  m.set(key, (m.get(key) ?? 0) + 1);
}

/**
 * Per store+key async mutex. Every credential write (save, clear, refresh commit) runs inside
 * it, so with a genuinely async store (file, keychain) writes land in the order they were
 * requested and a refresh commit's generation check and write are one atomic step.
 */
const locks = new WeakMap<CredentialStore, Map<string, Promise<void>>>();

async function withLock<T>(store: CredentialStore, key: string, fn: () => Promise<T>): Promise<T> {
  let m = locks.get(store);
  if (!m) locks.set(store, (m = new Map()));
  const prev = m.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  m.set(key, tail);
  try {
    return await run;
  } finally {
    if (m.get(key) === tail) m.delete(key);
  }
}

export async function saveTokens(store: CredentialStore, tokens: TokenSet, key = DEFAULT_TOKEN_KEY): Promise<void> {
  // Bump before queueing so a refresh commit already waiting on the lock sees it and discards.
  bumpGeneration(store, key);
  await withLock(store, key, () => store.set(key, JSON.stringify(tokens)));
}

export async function loadTokens(store: CredentialStore, key = DEFAULT_TOKEN_KEY): Promise<TokenSet | null> {
  const raw = await store.get(key);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<TokenSet>;
    if (typeof v?.accessToken !== "string") return null;
    return v as TokenSet;
  } catch {
    return null;
  }
}

export async function clearTokens(store: CredentialStore, key = DEFAULT_TOKEN_KEY): Promise<void> {
  bumpGeneration(store, key);
  await withLock(store, key, () => store.delete(key));
}

/** Confirm an already protected-store-persisted delivery without resurrecting cleared/replaced credentials. */
export async function acknowledgeStoredEnrollment(
  config: PairingConfig,
  store: CredentialStore,
  tokens: TokenSet,
  opts: { key?: string; signal?: AbortSignal } = {},
): Promise<TokenSet> {
  if (!tokens.enrollmentReceipt) return tokens;
  const key = opts.key ?? DEFAULT_TOKEN_KEY;
  const startedAt = generation(store, key);
  const confirmed = await acknowledgeEnrollment(config, tokens, opts.signal ? { signal: opts.signal } : {});
  await withLock(store, key, async () => {
    const current = await loadTokens(store, key);
    if (generation(store, key) !== startedAt || current?.accessToken !== tokens.accessToken || current?.enrollmentReceipt?.receipt !== tokens.enrollmentReceipt?.receipt) {
      throw new PairingError("credentials_changed", "credentials changed during enrollment acknowledgement; re-read the store");
    }
    await store.set(key, JSON.stringify(confirmed));
  });
  return confirmed;
}

interface Flight {
  promise: Promise<string>;
  forced: boolean;
}

const inFlight = new WeakMap<CredentialStore, Map<string, Flight>>();

export interface AccessTokenOptions {
  key?: string;
  skewMs?: number;
  signal?: AbortSignal;
  /** Skip the freshness check and refresh now, e.g. after the API answered 401. */
  forceRefresh?: boolean;
}

/**
 * Returns a usable access token, refreshing (and persisting) when it expires within
 * `skewMs` (default 60s) or when `forceRefresh` is set. Concurrent callers on the same
 * store and key share one refresh (single-flight), which is also tied to the first
 * caller's `signal`. Clears the store on invalid_grant only if the rejected refresh token
 * is still the stored one, so a rotation by another process is never wiped.
 *
 * Throws PairingError `credentials_changed` when the stored credential was replaced (re-pair,
 * save, rotation) while this refresh was in flight, whether the refresh succeeded or got
 * invalid_grant: re-read the store by calling again rather than starting pairing. After a
 * clear the store is empty, so the next call throws `no_refresh_token` and pairing is right.
 */
export function getValidAccessToken(
  config: PairingConfig,
  store: CredentialStore,
  opts: AccessTokenOptions = {},
): Promise<string> {
  const key = opts.key ?? DEFAULT_TOKEN_KEY;
  const forced = opts.forceRefresh === true;
  let flights = inFlight.get(store);
  if (!flights) inFlight.set(store, (flights = new Map()));
  const existing = flights.get(key);
  // A forced caller may only share a flight that is itself forced; a normal lookup might
  // return the stale token without refreshing. Wait it out, then (re)join a forced flight.
  if (existing && (existing.forced || !forced)) return existing.promise;
  const run = existing
    ? existing.promise.then(
        () => undefined,
        () => undefined,
      ).then(() => resolveAccessToken(config, store, key, opts))
    : resolveAccessToken(config, store, key, opts);
  const flight: Flight = {
    forced,
    promise: run.finally(() => {
      if (flights.get(key) === flight) flights.delete(key);
    }),
  };
  flights.set(key, flight);
  return flight.promise;
}

async function resolveAccessToken(
  config: PairingConfig,
  store: CredentialStore,
  key: string,
  opts: AccessTokenOptions,
): Promise<string> {
  const now = config.now ?? Date.now;
  let tokens = await loadTokens(store, key);
  if (!tokens) throw new PairingError("no_refresh_token", "no stored credentials; pair first");
  if (tokens.enrollmentReceipt) {
    tokens = await acknowledgeStoredEnrollment(config, store, tokens, { key, ...(opts.signal ? { signal: opts.signal } : {}) });
  }
  const fresh =
    !opts.forceRefresh && (tokens.expiresAt === undefined || tokens.expiresAt - (opts.skewMs ?? 60_000) > now());
  if (fresh) return tokens.accessToken;
  const attempted = tokens.refreshToken;
  const startedAt = generation(store, key);
  if (!attempted) throw new PairingError("no_refresh_token", "access token expired and no refresh token stored");
  try {
    const next = await refreshAccessToken(config, attempted, opts.signal ? { signal: opts.signal } : {});
    // Persist only if the credential we refreshed is still the current one: no clear, re-pair
    // or save happened meanwhile (generation), and no other holder rotated it (stored token).
    // Check and write are atomic under the lock; mutations queued behind us bump the
    // generation first, so they either precede this check or follow our write in order.
    await withLock(store, key, async () => {
      const current = await loadTokens(store, key);
      if (generation(store, key) !== startedAt || current?.refreshToken !== attempted) {
        throw new PairingError(
          "credentials_changed",
          "credentials changed during refresh; discarded refreshed tokens",
        );
      }
      await store.set(key, JSON.stringify(next));
    });
    return next.accessToken;
  } catch (err) {
    if (err instanceof PairingError && err.code === "invalid_grant") {
      const replaced = await withLock(store, key, async () => {
        const current = await loadTokens(store, key);
        if (current?.refreshToken !== attempted) return current !== null;
        bumpGeneration(store, key);
        await store.delete(key);
        return false;
      });
      // A newer credential is stored; the rejection was for the old one, so don't send the
      // caller back to pairing.
      if (replaced) {
        throw new PairingError("credentials_changed", "credentials changed during refresh; old refresh token was rejected");
      }
    }
    throw err;
  }
}

/** Convenience: poll result goes straight into the store. */
export async function pairAndStore(
  config: PairingConfig,
  store: CredentialStore,
  auth: Parameters<typeof pollForToken>[1],
  opts: { key?: string; signal?: AbortSignal } = {},
): Promise<TokenSet> {
  const tokens = await pollForToken(config, auth, opts.signal ? { signal: opts.signal } : {});
  await saveTokens(store, tokens, opts.key);
  return acknowledgeStoredEnrollment(config, store, tokens, opts);
}
