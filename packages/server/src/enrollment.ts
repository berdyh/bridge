import type { AuthVerifier } from "./contracts.js";

export const ENROLLMENT_PATH = "/bridge/enrollment";
export const ENROLLMENT_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const ENROLLMENT_SCOPE = "bridge:runner";

/** JSON-only, app-scoped durable row. Codes and CSRF receipts are hashed; delivery is encrypted. */
export interface EnrollmentRecord {
  appId: string;
  /** SHA-256 of app id + private device code; primary key within appId. */
  id: string;
  /** SHA-256 of app id + public approval code; unique within appId. */
  userCodeHash: string;
  revision: number;
  state: "pending" | "issuing" | "approved" | "delivering" | "consumed" | "denied" | "cancelled" | "failed" | "expired";
  device: { hostname: string; os: string; runnerVersion: string };
  createdAt: number;
  expiresAt: number;
  /** Due cleanup time, epoch milliseconds. Index this with appId. */
  cleanupAt: number;
  intervalSeconds: number;
  nextPollAt: number;
  userId?: string;
  csrfHash?: string;
  /** Immutable ownership token while a backend create is in flight; polling may change revision. */
  issuanceId?: string;
  credentialId?: string;
  sealedDelivery?: string;
  receiptHash?: string;
  deliveryExpiresAt?: number;
  deliveryAttempts?: number;
  cleanupCompleted?: boolean;
}

/**
 * Every operation is app-scoped. create atomically enforces both id and userCodeHash
 * uniqueness. CAS must be one database operation, never read-then-write. Implementations
 * return copies. Keep terminal rows for replay prevention until delete is called.
 */
export interface EnrollmentStore {
  create(record: EnrollmentRecord): Promise<boolean>;
  get(appId: string, id: string): Promise<EnrollmentRecord | undefined>;
  getByUserCodeHash(appId: string, hash: string): Promise<EnrollmentRecord | undefined>;
  compareAndSet(record: EnrollmentRecord, expectedRevision: number): Promise<boolean>;
  listExpired(appId: string, now: number, limit: number): Promise<EnrollmentRecord[]>;
  delete(appId: string, id: string, expectedRevision: number): Promise<boolean>;
}

export interface EnrollmentCredentialIssuer {
  /** Called at most once per enrollment id. A timeout is ambiguous: never mint again. */
  issue(request: { appId: string; enrollmentId: string; userId: string; device: EnrollmentRecord["device"] }): Promise<{ credentialId: string; secret: string }>;
  /** Revoke ALL keys for this enrollment, including a create response lost in a crash. Idempotent. */
  revoke(request: { appId: string; enrollmentId: string; userId: string; credentialId?: string }): Promise<void>;
}

export interface EnrollmentCipher {
  /** Context binds ciphertext to app + original request, preventing row swapping. */
  seal(value: string, context: string): Promise<string>;
  open(value: string, context: string): Promise<string>;
}

/** Import a separate 32-byte, app-owned backend secret. Never use a browser/session key. */
export async function createEnrollmentCipher(key: Uint8Array): Promise<EnrollmentCipher> {
  if (key.byteLength !== 32) throw new Error("Enrollment encryption needs a 32-byte key");
  const aes = await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["encrypt", "decrypt"]);
  const encode = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const decode = (s: string) => {
    if (!/^(?:[a-f0-9]{2})+$/.test(s)) throw new Error("Invalid encrypted enrollment");
    return Uint8Array.from(s.match(/../g)!, (b) => Number.parseInt(b, 16));
  };
  return {
    async seal(value, context) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) }, aes, new TextEncoder().encode(value));
      return encode(iv) + encode(new Uint8Array(encrypted));
    },
    async open(value, context) {
      const bytes = decode(value);
      const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(context) }, aes, bytes.slice(12));
      return new TextDecoder().decode(decrypted);
    },
  };
}

export interface RunnerEnrollmentOptions {
  appId: string;
  origin: string;
  clientId: string;
  /** Same-origin app-owned UI page; the code is put in its fragment, never the device credential. */
  approvalPath: string;
  store: EnrollmentStore;
  verifier: Pick<AuthVerifier, "verifyBrowser">;
  issuer: EnrollmentCredentialIssuer;
  cipher: EnrollmentCipher;
  /** Required app-owned abuse control. Use trusted platform identity, never caller-supplied forwarding headers. */
  rateLimit(request: Request, action: "start" | "browser" | "poll"): Promise<boolean>;
  now?: () => number;
  /** 60..900 seconds, default 600. */
  ttlSeconds?: number;
  /** Backend create deadline, 100..30000 milliseconds, default 30000. Ambiguous timeout never remints. */
  issuerTimeoutMs?: number;
}

const random = (bytes = 32): string => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const TERMINAL_RETENTION_MS = 86_400_000;
const DELIVERY_RETRY_MS = 30_000;
const MAX_DELIVERIES = 3;
const hash = async (appId: string, value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([appId, value])));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "pragma": "no-cache", "referrer-policy": "no-referrer" } });
const error = (code: string, status = 400) => json({ error: code }, status);
const terminal = (r: EnrollmentRecord, state: EnrollmentRecord["state"], now: number): EnrollmentRecord => {
  const { sealedDelivery: _secret, csrfHash: _csrf, ...rest } = r;
  return { ...rest, state, revision: r.revision + 1, cleanupAt: now + TERMINAL_RETENTION_MS };
};

/**
 * Public app-hosted RFC8628-compatible endpoints. Mount fetch only at ENROLLMENT_PATH.
 * Browser: POST /inspect {user_code}, then POST /approve or /deny {user_code,csrf}.
 * Runner: POST /device, /token, /ack and /cancel. No cookies, CORS or redirects.
 * Run cleanup() from an app-owned scheduled job; it retries failed provider revokes.
 */
export function createRunnerEnrollmentApp(options: RunnerEnrollmentOptions): {
  fetch(request: Request): Promise<Response>;
  cleanup(limit?: number): Promise<number>;
} {
  const { appId, store, issuer, cipher } = options;
  const origin = new URL(options.origin).origin;
  if (origin !== options.origin || !options.appId || !options.clientId || new URL(origin).protocol !== "https:") throw new Error("Enrollment needs an app id, client id and HTTPS origin");
  const approval = new URL(options.approvalPath, origin);
  if (!options.approvalPath.startsWith("/") || approval.origin !== origin || approval.search || approval.hash || /[\\\s]/.test(options.approvalPath)) throw new Error("approvalPath must be a same-origin path");
  const ttl = options.ttlSeconds ?? 600;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 900) throw new Error("Enrollment TTL must be 60..900 seconds");
  const now = options.now ?? Date.now;
  const issuerTimeout = options.issuerTimeoutMs ?? 30_000;
  if (!Number.isInteger(issuerTimeout) || issuerTimeout < 100 || issuerTimeout > 30_000) throw new Error("Invalid issuer timeout");
  const context = (r: EnrollmentRecord) => JSON.stringify([appId, r.id]);
  const cas = (old: EnrollmentRecord, next: EnrollmentRecord) => store.compareAndSet(next, old.revision);
  const revoke = (r: EnrollmentRecord) => r.userId ? issuer.revoke({ appId, enrollmentId: r.id, userId: r.userId, ...(r.credentialId ? { credentialId: r.credentialId } : {}) }) : Promise.resolve();

  /** Poll/backoff writes keep issuance ownership; cancellation and cleanup remove it by changing state. */
  async function transitionIssuance(owner: EnrollmentRecord, update: (current: EnrollmentRecord) => EnrollmentRecord): Promise<EnrollmentRecord | undefined> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const current = await store.get(appId, owner.id);
      if (!current || current.state !== "issuing" || current.issuanceId !== owner.issuanceId || current.userId !== owner.userId) return undefined;
      const next = update(current);
      if (await cas(current, next)) return next;
    }
    throw new Error("Enrollment issuance contention");
  }

  async function cleanup(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid cleanup limit");
    let count = 0;
    for (const r of await store.listExpired(appId, now(), limit)) {
      if (r.state === "consumed" || r.state === "denied" || r.state === "cancelled" || r.state === "expired" || r.state === "failed") {
        // Recheck ambiguous issuance once more before deleting the tombstone.
        if (r.state === "failed" || r.state === "expired" || r.state === "cancelled") {
          try { await revoke(r); } catch {
            await cas(r, { ...r, revision: r.revision + 1, cleanupAt: now() + 30_000 });
            continue;
          }
          if (!r.cleanupCompleted) {
            if (await cas(r, { ...r, revision: r.revision + 1, cleanupCompleted: true, cleanupAt: now() + TERMINAL_RETENTION_MS })) count++;
            continue;
          }
        }
        if (await store.delete(appId, r.id, r.revision)) count++;
      } else {
        // Win the state transition before revoking. A concurrent acknowledgement then fails closed.
        const expired = terminal(r, "expired", now());
        if (await cas(r, expired)) {
          try { await revoke(expired); } catch {
            await store.compareAndSet({ ...expired, revision: expired.revision + 1, cleanupAt: now() + 30_000 }, expired.revision);
            continue;
          }
          await store.compareAndSet({ ...expired, cleanupCompleted: true, revision: expired.revision + 1 }, expired.revision);
          count++;
        }
      }
    }
    return count;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== origin || request.method !== "POST" || url.search || !url.pathname.startsWith(ENROLLMENT_PATH + "/")) return error("invalid_request", 404);
    let action = url.pathname.slice(ENROLLMENT_PATH.length + 1);
    const browser = ["inspect", "approve", "deny"].includes(action);
    if (!["device", "token", "ack", "cancel", "inspect", "approve", "deny"].includes(action)) return error("invalid_request", 404);
    // Runner endpoints accept no browser Origin; browser endpoints require exact Origin and bearer auth.
    const requestOrigin = request.headers.get("origin");
    if (browser ? requestOrigin !== origin : requestOrigin !== null) return error("access_denied", 403);
    if (!await options.rateLimit(request, browser ? "browser" : action === "device" ? "start" : "poll")) return error("slow_down", 429);
    if (Number(request.headers.get("content-length") ?? 0) > 4096) return error("invalid_request", 413);
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) { await reader.cancel(); return error("invalid_request", 413); }
      chunks.push(value);
    }
    const input = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.byteLength; }
    const raw = new TextDecoder().decode(input);
    let body: Record<string, unknown>;
    try {
      const type = request.headers.get("content-type")?.split(";")[0];
      if (type === "application/json") body = JSON.parse(raw) as Record<string, unknown>;
      else if (type === "application/x-www-form-urlencoded") body = Object.fromEntries(new URLSearchParams(raw));
      else return error("invalid_request", 415);
      if (!body || typeof body !== "object" || Array.isArray(body)) return error("invalid_request");
    } catch { return error("invalid_request"); }
    const str = (name: string) => typeof body[name] === "string" ? body[name] as string : "";
    if (action === "token" && str("grant_type") === "urn:berdyh:bridge:enrollment-ack") action = "ack";
    if (browser) {
      const token = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!token) return error("access_denied", 401);
      const principal = await options.verifier.verifyBrowser(token, { origin: requestOrigin });
      if (!principal || principal.revoked) return error("access_denied", 401);
      const code = str("user_code");
      if (!/^[A-F0-9]{16}$/.test(code)) return error("invalid_grant");
      const r = await store.getByUserCodeHash(appId, await hash(appId, code));
      if (!r || now() >= r.expiresAt) return error("expired_token");
      if (r.state !== "pending" || (r.userId && r.userId !== principal.userId)) return error("invalid_grant");
      if (action === "inspect") {
        const csrf = random();
        const next = { ...r, userId: principal.userId, csrfHash: await hash(appId, csrf), revision: r.revision + 1 };
        if (!await cas(r, next)) return error("invalid_grant", 409);
        return json({ appId, device: r.device, expiresAt: r.expiresAt, csrf });
      }
      if (r.userId !== principal.userId || !str("csrf") || r.csrfHash !== await hash(appId, str("csrf"))) return error("access_denied", 403);
      if (action === "deny") return await cas(r, terminal(r, "denied", now())) ? json({ denied: true }) : error("invalid_grant", 409);
      const issuing = { ...r, state: "issuing" as const, issuanceId: random(), revision: r.revision + 1 };
      if (!await cas(r, issuing)) return error("invalid_grant", 409);
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const issuance = issuer.issue({ appId, enrollmentId: r.id, userId: principal.userId, device: r.device });
        // The provider may complete after our deadline. Revoke its late result; the
        // durable failed row also retains a cleanup retry if this process disappears.
        void issuance.then(async (issued) => { if (timedOut) await revoke({ ...issuing, credentialId: issued.credentialId }); }).catch(() => {});
        const issued = await Promise.race([issuance, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { timedOut = true; reject(new Error("Enrollment issuance deadline")); }, issuerTimeout);
        })]);
        const receipt = random();
        const delivery = { credentialId: issued.credentialId, receiptHash: await hash(appId, receipt), sealedDelivery: await cipher.seal(JSON.stringify({ access_token: issued.secret, token_type: "Bearer", scope: ENROLLMENT_SCOPE, enrollment_receipt: receipt }), context(r)) };
        const completed = await transitionIssuance(issuing, (current) => now() >= current.expiresAt
          ? { ...terminal(current, "expired", now()), cleanupAt: now() }
          : { ...current, ...delivery, state: "approved", revision: current.revision + 1 });
        if (completed?.state !== "approved") {
          await revoke({ ...issuing, credentialId: issued.credentialId });
          return error("expired_token");
        }
        // Deliberately no secret, device code, receipt, or credential id in browser responses.
        return json({ approved: true });
      } catch {
        await transitionIssuance(issuing, (current) => ({ ...terminal(current, "failed", now()), cleanupAt: now() }));
        return error("server_error", 503);
      } finally { clearTimeout(timer); }
    }
    if (str("client_id") !== options.clientId) return error("invalid_client");
    if (action === "device") {
      if (str("scope") && str("scope") !== ENROLLMENT_SCOPE) return error("invalid_scope");
      const device = { hostname: str("device_name"), os: str("device_os"), runnerVersion: str("runner_version") };
      if (Object.values(device).some((v) => !v || v.length > 128 || /[\x00-\x1f\x7f]/.test(v))) return error("invalid_request");
      const deviceCode = random();
      const userCode = random(8).toUpperCase();
      const time = now();
      const r: EnrollmentRecord = { appId, id: await hash(appId, deviceCode), userCodeHash: await hash(appId, userCode), revision: 0, state: "pending", device, createdAt: time, expiresAt: time + ttl * 1000, cleanupAt: time + ttl * 1000, intervalSeconds: 5, nextPollAt: time + 5000 };
      if (!await store.create(r)) return error("server_error", 503);
      return json({ device_code: deviceCode, user_code: userCode, verification_uri: approval.href, verification_uri_complete: approval.href + "#code=" + userCode, expires_in: ttl, interval: 5 });
    }
    const code = str("device_code");
    if (!/^[a-f0-9]{64}$/.test(code)) return error("invalid_grant");
    const r = await store.get(appId, await hash(appId, code));
    if (!r) return error("invalid_grant");
    if (action === "ack") {
      if (!str("enrollment_receipt") || r.receiptHash !== await hash(appId, str("enrollment_receipt"))) return error("invalid_grant");
      if (r.state === "consumed") return json({ acknowledged: true });
      if (now() >= r.expiresAt || r.deliveryExpiresAt === undefined || now() >= r.deliveryExpiresAt || r.state !== "delivering") return error("invalid_grant");
      return await cas(r, terminal(r, "consumed", now())) ? json({ acknowledged: true }) : error("authorization_pending", 409);
    }
    if (now() >= r.expiresAt || r.state === "expired") return error("expired_token");
    if (action === "cancel") {
      if (r.state === "consumed") return error("invalid_grant");
      if (["denied", "cancelled"].includes(r.state)) return json({ cancelled: true });
      const cancelled = { ...terminal(r, "cancelled", now()), cleanupAt: now() };
      if (!await cas(r, cancelled)) return error("invalid_grant", 409);
      await revoke(cancelled);
      return json({ cancelled: true });
    }
    if (str("grant_type") !== ENROLLMENT_GRANT) return error("unsupported_grant_type");
    if (r.state === "denied" || r.state === "cancelled") return error("access_denied");
    if (["consumed", "failed"].includes(r.state)) return error("invalid_grant");
    if (now() < r.nextPollAt) {
      const next = { ...r, revision: r.revision + 1, intervalSeconds: Math.min(60, r.intervalSeconds + 5), nextPollAt: now() + Math.min(60, r.intervalSeconds + 5) * 1000 };
      await cas(r, next);
      return error("slow_down");
    }
    const next: EnrollmentRecord = { ...r, revision: r.revision + 1, nextPollAt: now() + r.intervalSeconds * 1000 };
    if (r.state === "approved" || r.state === "delivering") {
      if (!r.sealedDelivery || (r.deliveryExpiresAt !== undefined && now() >= r.deliveryExpiresAt) || (r.deliveryAttempts ?? 0) >= MAX_DELIVERIES) return error("invalid_grant");
      next.state = "delivering";
      next.deliveryExpiresAt = r.deliveryExpiresAt ?? Math.min(r.expiresAt, now() + DELIVERY_RETRY_MS);
      next.cleanupAt = next.deliveryExpiresAt;
      next.deliveryAttempts = (r.deliveryAttempts ?? 0) + 1;
      if (!await cas(r, next)) return error("authorization_pending");
      return json(JSON.parse(await cipher.open(r.sealedDelivery, context(r))) as unknown);
    }
    if (!await cas(r, next)) return error("authorization_pending");
    return error("authorization_pending");
  }
  return { fetch: async (r) => { try { return await handle(r); } catch { return error("server_error", 503); } }, cleanup };
}
