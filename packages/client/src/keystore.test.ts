import { afterEach, describe, expect, it, vi } from "vitest";

import { createBrowserKeyStore } from "./keystore.js";

// A minimal IndexedDB: just enough of open/transaction/get/put/delete for the key store.
class FakeDatabase {
  onclose: (() => void) | null = null;
  onversionchange: (() => void) | null = null;
  closed = false;
  constructor(private readonly data: Map<string, unknown>) {}
  close() { this.closed = true; }
  transaction() {
    const transaction: { oncomplete?: () => void; onabort?: () => void; onerror?: () => void; error: null; objectStore(): unknown } = {
      error: null,
      objectStore: () => {
        const run = (work: () => unknown) => {
          const request: { result?: unknown } = {};
          queueMicrotask(() => { request.result = work(); transaction.oncomplete?.(); });
          return request;
        };
        return {
          get: (key: string) => run(() => this.data.get(key)),
          put: (value: unknown, key: string) => run(() => { this.data.set(key, value); }),
          delete: (key: string) => run(() => { this.data.delete(key); }),
        };
      },
    };
    return transaction;
  }
}

function stubIndexedDb(plan: ("fail" | "ok")[]) {
  const data = new Map<string, unknown>();
  const databases: FakeDatabase[] = [];
  const open = vi.fn(() => {
    const request: { result?: FakeDatabase; error?: Error; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {};
    queueMicrotask(() => {
      if ((plan.shift() ?? "ok") === "fail") { request.error = new Error("open failed"); request.onerror?.(); return; }
      const db = new FakeDatabase(data);
      databases.push(db);
      request.result = db;
      request.onsuccess?.();
    });
    return request;
  });
  vi.stubGlobal("indexedDB", { open });
  return { open, databases };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("browser key store", () => {
  it("retries after a rejected open instead of caching the failure", async () => {
    const { open } = stubIndexedDb(["fail", "ok"]);
    const store = createBrowserKeyStore();
    await expect(store.load("k")).rejects.toThrow("open failed");
    await store.save("k", "v");
    expect(await store.load("k")).toBe("v");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("reopens after the database closes", async () => {
    const { open, databases } = stubIndexedDb([]);
    const store = createBrowserKeyStore();
    await store.save("k", "v");
    databases[0]!.onclose?.();
    expect(await store.load("k")).toBe("v");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("closes and reopens on versionchange", async () => {
    const { open, databases } = stubIndexedDb([]);
    const store = createBrowserKeyStore();
    await store.save("k", "v");
    databases[0]!.onversionchange?.();
    expect(databases[0]!.closed).toBe(true);
    expect(await store.load("k")).toBe("v");
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("browser key store open races", () => {
  it("evicts a rejection from a synchronous indexedDB.open throw", async () => {
    let calls = 0;
    const data = new Map<string, unknown>();
    vi.stubGlobal("indexedDB", { open: () => {
      if (calls++ === 0) throw new Error("open threw");
      const request: { result?: FakeDatabase; onsuccess?: () => void } = {};
      queueMicrotask(() => { request.result = new FakeDatabase(data); request.onsuccess?.(); });
      return request;
    } });
    const store = createBrowserKeyStore();
    await expect(store.load("k")).rejects.toThrow("open threw");
    await store.save("k", "v");
    expect(await store.load("k")).toBe("v");
    expect(calls).toBe(2);
  });

  it("a stale attempt's late error does not evict the retry, and its late connection is closed", async () => {
    const data = new Map<string, unknown>();
    const requests: { result?: FakeDatabase; error?: Error; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void }[] = [];
    const open = vi.fn(() => { const r = {}; requests.push(r); return r; });
    vi.stubGlobal("indexedDB", { open });
    const store = createBrowserKeyStore();
    const a = store.load("k");
    const aSettled = expect(a).rejects.toThrow("blocked");
    requests[0]!.onblocked?.();
    await aSettled;
    const b = store.load("k");
    const late = new FakeDatabase(data);
    requests[1]!.result = new FakeDatabase(data); requests[1]!.onsuccess?.();
    expect(await b).toBeUndefined();
    // Request A errors late: B stays cached, so no third open.
    requests[0]!.error = new Error("late"); requests[0]!.onerror?.();
    await store.load("k");
    expect(open).toHaveBeenCalledTimes(2);
    // Request A also succeeds late: the connection is closed, not leaked.
    requests[0]!.result = late; requests[0]!.onsuccess?.();
    expect(late.closed).toBe(true);
  });
});
