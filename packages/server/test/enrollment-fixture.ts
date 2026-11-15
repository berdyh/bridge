import { vi, type Mock } from "vitest";
import { createEnrollmentCipher, createRunnerEnrollmentApp, type EnrollmentCredentialIssuer, type EnrollmentRecord, type EnrollmentStore, type RunnerEnrollmentOptions } from "../src/enrollment.js";

/** Test-only adapter. Production callers must supply a transactional durable store. */
export class MemoryEnrollmentStore implements EnrollmentStore {
  rows = new Map<string, EnrollmentRecord>();
  key(appId: string, id: string) { return JSON.stringify([appId, id]); }
  async create(r: EnrollmentRecord) {
    if (this.rows.has(this.key(r.appId, r.id)) || [...this.rows.values()].some((old) => old.appId === r.appId && old.userCodeHash === r.userCodeHash)) return false;
    this.rows.set(this.key(r.appId, r.id), structuredClone(r)); return true;
  }
  async get(appId: string, id: string) { return structuredClone(this.rows.get(this.key(appId, id))); }
  async getByUserCodeHash(appId: string, hash: string) { return structuredClone([...this.rows.values()].find((r) => r.appId === appId && r.userCodeHash === hash)); }
  async compareAndSet(r: EnrollmentRecord, revision: number) {
    if (this.rows.get(this.key(r.appId, r.id))?.revision !== revision || r.revision !== revision + 1) return false;
    this.rows.set(this.key(r.appId, r.id), structuredClone(r)); return true;
  }
  async listExpired(appId: string, now: number, limit: number) { return structuredClone([...this.rows.values()].filter((r) => r.appId === appId && r.cleanupAt <= now).slice(0, limit)); }
  async delete(appId: string, id: string, revision: number) {
    if (this.rows.get(this.key(appId, id))?.revision !== revision) return false;
    return this.rows.delete(this.key(appId, id));
  }
}

type Authorization = { device_code: string; user_code: string; interval: number; expires_in: number };
interface EnrollmentFixture {
  app: ReturnType<typeof createRunnerEnrollmentApp>;
  options: RunnerEnrollmentOptions;
  store: MemoryEnrollmentStore;
  issue: Mock<EnrollmentCredentialIssuer["issue"]>;
  revoke: Mock<EnrollmentCredentialIssuer["revoke"]>;
  rateLimit: Mock<() => Promise<boolean>>;
  post(action: string, body: Record<string, unknown>, session?: string, origin?: string | null): Promise<Response>;
  start(): Promise<Authorization>;
  inspect(user_code: string, session?: string): Promise<{ csrf: string }>;
  approve(user_code: string): Promise<Response>;
  poll(device_code: string): Promise<Response>;
  advance(ms: number): void;
  now(): number;
}
export async function enrollmentFixture(overrides: Partial<RunnerEnrollmentOptions> = {}): Promise<EnrollmentFixture> {
  let time = 1_800_000_000_000;
  const store = new MemoryEnrollmentStore();
  const issue = vi.fn<EnrollmentCredentialIssuer["issue"]>().mockResolvedValue({ credentialId: "api_key:key1", secret: "ak_secret" });
  const revoke = vi.fn<EnrollmentCredentialIssuer["revoke"]>().mockResolvedValue();
  const rateLimit = vi.fn().mockResolvedValue(true);
  const options: RunnerEnrollmentOptions = {
    appId: "app-a", origin: "https://a.test", clientId: "bridge-a", approvalPath: "/connect",
    store, issuer: { issue, revoke }, cipher: await createEnrollmentCipher(new Uint8Array(32).fill(7)),
    verifier: { verifyBrowser: async (token) => token === "session" ? { userId: "user_alice" } : token === "other" ? { userId: "user_bob" } : undefined },
    rateLimit, now: () => time, ...overrides,
  };
  const app = createRunnerEnrollmentApp(options);
  const post = (action: string, body: Record<string, unknown>, session?: string, origin?: string | null) => app.fetch(new Request(options.origin + "/bridge/enrollment/" + action, {
    method: "POST", headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}), ...(origin === null ? {} : origin || session ? { origin: origin ?? options.origin } : {}) }, body: JSON.stringify(body),
  }));
  const start = async () => (await post("device", { client_id: options.clientId, device_name: "Laptop", device_os: "linux", runner_version: "0.2.0" })).json() as Promise<{ device_code: string; user_code: string; interval: number; expires_in: number }>;
  const inspect = async (user_code: string, session = "session") => (await post("inspect", { user_code }, session)).json() as Promise<{ csrf: string }>;
  const approve = async (user_code: string) => post("approve", { user_code, ...(await inspect(user_code)) }, "session");
  const poll = (device_code: string) => post("token", { client_id: options.clientId, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code });
  return { app, options, store, issue, revoke, rateLimit, post, start, inspect, approve, poll, advance: (ms: number) => { time += ms; }, now: () => time };
}
