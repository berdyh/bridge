import { describe, expect, it, vi } from "vitest";
import { createEnrollmentCipher, createRunnerEnrollmentApp } from "./enrollment.js";
import { enrollmentFixture } from "../test/enrollment-fixture.js";

describe("public runner enrollment", () => {
  it("binds approval to the verified browser user and original request; stores only encrypted delivery", async () => {
    const f = await enrollmentFixture();
    const a = await f.start(); const b = await f.start();
    const { csrf } = await f.inspect(a.user_code);
    expect((await f.post("approve", { user_code: b.user_code, csrf }, "session")).status).toBe(403);
    expect((await f.post("approve", { user_code: a.user_code, csrf, userId: "user_mallory" }, "other")).status).toBe(400);
    const approved = await f.post("approve", { user_code: a.user_code, csrf, userId: "user_mallory" }, "session");
    expect(await approved.json()).toEqual({ approved: true });
    expect(f.issue).toHaveBeenCalledOnce();
    expect(f.issue.mock.calls[0]![0]).toMatchObject({ appId: "app-a", userId: "user_alice", device: { hostname: "Laptop" } });
    const serialized = JSON.stringify([...f.store.rows.values()]);
    for (const secret of [a.device_code, a.user_code, csrf, "ak_secret"]) expect(serialized).not.toContain(secret);
    f.advance(5000);
    const token = await f.poll(a.device_code);
    expect(token.headers.get("cache-control")).toBe("no-store");
    expect(await token.json()).toMatchObject({ access_token: "ak_secret", token_type: "Bearer", scope: "bridge:runner" });
  });

  it("issues only once under concurrent approvals and refuses replay", async () => {
    const f = await enrollmentFixture(); const a = await f.start(); const approval = { user_code: a.user_code, ...(await f.inspect(a.user_code)) };
    const result = await Promise.all([f.post("approve", approval, "session"), f.post("approve", approval, "session")]);
    expect(result.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(f.issue).toHaveBeenCalledOnce();
    expect((await f.post("approve", approval, "session")).status).toBe(400);
    expect(f.issue).toHaveBeenCalledOnce();
  });

  it("pins finite TTL, polling backoff, retry delivery count/window, and idempotent post-storage ack", async () => {
    const f = await enrollmentFixture(); const a = await f.start();
    expect(a).toMatchObject({ expires_in: 600, interval: 5 });
    expect(await (await f.poll(a.device_code)).json()).toEqual({ error: "slow_down" });
    f.advance(10_000);
    expect(await (await f.poll(a.device_code)).json()).toEqual({ error: "authorization_pending" });
    await f.approve(a.user_code); f.advance(10_000);
    const first = await (await f.poll(a.device_code)).json() as { enrollment_receipt: string };
    f.advance(10_000); expect(await (await f.poll(a.device_code)).json()).toEqual(first);
    f.advance(10_000); expect(await (await f.poll(a.device_code)).json()).toEqual(first);
    const ack = { client_id: f.options.clientId, device_code: a.device_code, enrollment_receipt: first.enrollment_receipt };
    expect(await (await f.post("ack", { ...ack, enrollment_receipt: "wrong" })).json()).toEqual({ error: "invalid_grant" });
    expect(await (await f.post("ack", ack)).json()).toEqual({ acknowledged: true });
    expect(await (await f.post("ack", ack)).json()).toEqual({ acknowledged: true });
    expect(await (await f.poll(a.device_code)).json()).toEqual({ error: "invalid_grant" });
    expect([...f.store.rows.values()][0]).not.toHaveProperty("sealedDelivery");
    f.advance(600_000); await f.app.cleanup(); expect(f.revoke).not.toHaveBeenCalled();
    const b = await f.start(); await f.approve(b.user_code); f.advance(5000);
    for (let i = 0; i < 3; i++) { expect((await f.poll(b.device_code)).status).toBe(200); f.advance(5000); }
    expect(await (await f.poll(b.device_code)).json()).toEqual({ error: "invalid_grant" });
  });

  it("supports explicit denial, runner cancellation and terminal replay refusal", async () => {
    const f = await enrollmentFixture(); const a = await f.start();
    expect(await (await f.post("deny", { user_code: a.user_code, ...(await f.inspect(a.user_code)) }, "session")).json()).toEqual({ denied: true });
    f.advance(5000); expect(await (await f.poll(a.device_code)).json()).toEqual({ error: "access_denied" });
    expect((await f.approve(a.user_code)).status).toBe(400);
    const b = await f.start(); await f.approve(b.user_code);
    expect(await (await f.post("cancel", { client_id: f.options.clientId, device_code: b.device_code })).json()).toEqual({ cancelled: true });
    expect(f.revoke).toHaveBeenCalledOnce();
    expect(await (await f.poll(b.device_code)).json()).toEqual({ error: "access_denied" });
  });

  it("expires pending requests and revokes unpolled/unacknowledged keys with retryable cleanup", async () => {
    const f = await enrollmentFixture(); const pending = await f.start(); const approved = await f.start(); await f.approve(approved.user_code);
    f.advance(600_000);
    expect(await (await f.poll(pending.device_code)).json()).toEqual({ error: "expired_token" });
    expect((await f.approve(pending.user_code)).status).toBe(400);
    f.revoke.mockRejectedValueOnce(new Error("provider down"));
    await f.app.cleanup(); f.advance(30_000); await f.app.cleanup();
    expect(f.revoke.mock.calls.some(([r]) => r.credentialId === "api_key:key1")).toBe(true);
    expect([...f.store.rows.values()].every((r) => !r.sealedDelivery)).toBe(true);
    const delivered = await f.start(); await f.approve(delivered.user_code); f.advance(5000); await f.poll(delivered.device_code);
    f.advance(30_000); await f.app.cleanup();
    expect(await (await f.poll(delivered.device_code)).json()).toEqual({ error: "expired_token" });
  });

  it("never remints after an ambiguous create failure; cleanup names the original issuance", async () => {
    const f = await enrollmentFixture(); const a = await f.start();
    f.issue.mockRejectedValueOnce(new Error("lost create response"));
    expect((await f.approve(a.user_code)).status).toBe(503);
    expect((await f.approve(a.user_code)).status).toBe(400);
    await f.app.cleanup();
    expect(f.issue).toHaveBeenCalledOnce();
    expect(f.revoke.mock.calls[0]![0]).toMatchObject({ enrollmentId: f.issue.mock.calls[0]![0].enrollmentId, userId: "user_alice" });
  });

  it("cancelling during an in-flight create cannot publish a credential and revokes its late result", async () => {
    const f = await enrollmentFixture(); const a = await f.start();
    let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
    f.issue.mockImplementationOnce(async () => { await hold; return { credentialId: "api_key:late", secret: "ak_late" }; });
    const approval = { user_code: a.user_code, ...(await f.inspect(a.user_code)) };
    const response = f.post("approve", approval, "session");
    await new Promise<void>((resolve) => { const check = () => f.issue.mock.calls.length ? resolve() : setTimeout(check, 0); check(); });
    await f.post("cancel", { client_id: f.options.clientId, device_code: a.device_code }); release();
    expect((await response).status).toBe(400);
    expect(f.revoke.mock.calls.some(([r]) => r.credentialId === "api_key:late")).toBe(true);
    expect(await (await f.poll(a.device_code)).json()).toEqual({ error: "access_denied" });
  });

  it("rejects missing/foreign origins, missing browser session, CSRF, foreign clients and browser token polling", async () => {
    const f = await enrollmentFixture(); const a = await f.start();
    for (const origin of [null, "https://evil.test"]) expect((await f.post("inspect", { user_code: a.user_code }, "session", origin)).status).toBe(403);
    expect((await f.post("inspect", { user_code: a.user_code }, undefined, f.options.origin)).status).toBe(401);
    expect((await f.post("approve", { user_code: a.user_code }, "session")).status).toBe(403);
    expect((await f.post("token", { client_id: f.options.clientId, device_code: a.device_code }, "session")).status).toBe(403);
    expect(await (await f.post("device", { client_id: "other" })).json()).toEqual({ error: "invalid_client" });
    f.rateLimit.mockResolvedValue(false);
    expect((await f.poll(a.device_code)).status).toBe(429);
    expect(f.issue).not.toHaveBeenCalled();
  });

  it("isolates app-scoped rows and encryption, including shared database/cipher key", async () => {
    const a = await enrollmentFixture(); const b = await enrollmentFixture({ appId: "app-b", origin: "https://b.test", clientId: "bridge-b", store: a.store });
    const grant = await a.start();
    expect(await (await b.poll(grant.device_code)).json()).toEqual({ error: "invalid_grant" });
    expect((await b.approve(grant.user_code)).status).toBe(400);
    const cipher = await createEnrollmentCipher(new Uint8Array(32).fill(3));
    const encrypted = await cipher.seal("ak_secret", "app-a/request");
    await expect(cipher.open(encrypted, "app-b/request")).rejects.toThrow();
    await expect(createEnrollmentCipher(new Uint8Array(16))).rejects.toThrow();
    expect(() => createRunnerEnrollmentApp({ ...a.options, approvalPath: "//evil.test" })).toThrow();
    expect(() => createRunnerEnrollmentApp({ ...a.options, ttlSeconds: Infinity })).toThrow();
  });

  it("bounds streamed bodies before parsing, emits no CORS and refuses redirects/query parameters", async () => {
    const f = await enrollmentFixture();
    const oversized = await f.post("device", { client_id: f.options.clientId, padding: "x".repeat(5000) });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.has("access-control-allow-origin")).toBe(false);
    expect((await f.app.fetch(new Request(f.options.origin + "/bridge/enrollment/device?client_id=bridge-a", { method: "POST" }))).status).toBe(404);
  });

  it("cleanup continues past a failed revoke, retaining a due retry; late ack cannot bypass delivery expiry", async () => {
    const f = await enrollmentFixture(); const a = await f.start(); await f.approve(a.user_code); f.advance(5000);
    const first = await (await f.poll(a.device_code)).json() as { enrollment_receipt: string };
    f.advance(30_000);
    expect(await (await f.post("ack", { client_id: f.options.clientId, device_code: a.device_code, enrollment_receipt: first.enrollment_receipt })).json()).toEqual({ error: "invalid_grant" });
    const b = await f.start(); await f.approve(b.user_code);
    f.advance(600_000);
    const aRow = [...f.store.rows.values()][0]!;
    await f.store.compareAndSet({ ...aRow, state: "failed", cleanupAt: f.now(), revision: aRow.revision + 1 }, aRow.revision);
    f.revoke.mockImplementation(async (r) => { if (r.enrollmentId === aRow.id) throw new Error("poisoned revoke"); });
    expect(await f.app.cleanup()).toBe(1);
    expect((await f.store.get(aRow.appId, aRow.id))?.cleanupAt).toBe(f.now() + 30_000);
    expect([...f.store.rows.values()][1]!.state).toBe("expired");
  });

  it("bounds backend creation time, never retries an ambiguous timeout, and revokes a late result", async () => {
    const f = await enrollmentFixture({ issuerTimeoutMs: 100 }); const a = await f.start();
    let release!: (value: { credentialId: string; secret: string }) => void;
    f.issue.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const body = { user_code: a.user_code, ...(await f.inspect(a.user_code)) };
    vi.useFakeTimers();
    try {
      const response = f.post("approve", body, "session");
      // Await the asynchronous WebCrypto CSRF hash and store CAS before advancing its deadline.
      await vi.waitFor(() => expect(f.issue).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(100);
      expect((await response).status).toBe(503);
      expect((await f.post("approve", body, "session")).status).toBe(400);
      release({ credentialId: "api_key:late", secret: "ak_late" });
      await Promise.resolve(); await Promise.resolve();
      expect(f.revoke).toHaveBeenCalledWith(expect.objectContaining({ credentialId: "api_key:late" }));
      expect([...f.store.rows.values()][0]!.state).toBe("failed");
    } finally { vi.useRealTimers(); }
  });

  it("in-flight issuance survives legal and fast polls, including a poll racing the completion CAS", async () => {
    const f = await enrollmentFixture(); const a = await f.start();
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
    f.issue.mockImplementationOnce(async () => { entered(); await hold; return { credentialId: "api_key:slow", secret: "ak_slow" }; });
    const body = { user_code: a.user_code, ...(await f.inspect(a.user_code)) };
    const response = f.post("approve", body, "session"); await started;
    f.advance(5000);
    expect(await (await f.poll(a.device_code)).json()).toEqual({ error: "authorization_pending" });
    expect(await (await f.poll(a.device_code)).json()).toEqual({ error: "slow_down" });
    expect((await f.post("approve", body, "session")).status).toBe(400);
    expect((await f.post("deny", body, "session")).status).toBe(400);
    f.advance(10_000);
    expect(await (await f.poll(a.device_code)).json()).toEqual({ error: "authorization_pending" });
    // Force one more ordinary poll after completion read but before its first CAS.
    const compareAndSet = f.store.compareAndSet.bind(f.store); let raced = false;
    vi.spyOn(f.store, "compareAndSet").mockImplementation(async (record, revision) => {
      if (record.state === "approved" && !raced) {
        raced = true; f.advance(10_000);
        expect(await (await f.poll(a.device_code)).json()).toEqual({ error: "authorization_pending" });
      }
      return compareAndSet(record, revision);
    });
    release(); expect(await (await response).json()).toEqual({ approved: true });
    const row = [...f.store.rows.values()][0]!;
    expect(row).toMatchObject({ state: "approved", intervalSeconds: 10, nextPollAt: f.now() + 10_000 });
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.revoke).not.toHaveBeenCalled(); expect(raced).toBe(true);
    f.advance(10_000);
    expect(await (await f.poll(a.device_code)).json()).toMatchObject({ access_token: "ak_slow" });
  });

  it.each(["cancel", "cleanup", "expiry"] as const)("poll revisions cannot let issuance override a winning %s", async (winner) => {
    const f = await enrollmentFixture(); const a = await f.start();
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
    f.issue.mockImplementationOnce(async () => { entered(); await hold; return { credentialId: "api_key:late", secret: "ak_late" }; });
    const response = f.post("approve", { user_code: a.user_code, ...(await f.inspect(a.user_code)) }, "session"); await started;
    f.advance(5000); await f.poll(a.device_code); await f.poll(a.device_code);
    if (winner === "cancel") expect((await f.post("cancel", { client_id: f.options.clientId, device_code: a.device_code })).status).toBe(200);
    else { f.advance(600_000); if (winner === "cleanup") await f.app.cleanup(); }
    release(); expect((await response).status).toBe(400);
    expect([...f.store.rows.values()][0]!.state).toBe(winner === "cancel" ? "cancelled" : "expired");
    expect([...f.store.rows.values()][0]).not.toHaveProperty("sealedDelivery");
    expect(f.revoke).toHaveBeenCalledWith(expect.objectContaining({ credentialId: "api_key:late" }));
    expect(f.issue).toHaveBeenCalledOnce();
  });

  it("poll revisions cannot leave failed backend issuance stuck in issuing", async () => {
    const f = await enrollmentFixture(); const a = await f.start();
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let fail!: () => void; const hold = new Promise<void>((_resolve, reject) => { fail = () => reject(new Error("ambiguous provider failure")); });
    f.issue.mockImplementationOnce(async () => { entered(); await hold; throw new Error("unreachable"); });
    const response = f.post("approve", { user_code: a.user_code, ...(await f.inspect(a.user_code)) }, "session"); await started;
    f.advance(5000); await f.poll(a.device_code); await f.poll(a.device_code);
    fail(); expect((await response).status).toBe(503);
    expect([...f.store.rows.values()][0]!.state).toBe("failed");
    expect([...f.store.rows.values()][0]!.cleanupAt).toBe(f.now());
    await f.app.cleanup(); expect(f.revoke).toHaveBeenCalledOnce(); expect(f.issue).toHaveBeenCalledOnce();
  });
});
