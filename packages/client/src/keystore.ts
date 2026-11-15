import type { KeyStore } from "./contracts.js";

/** One database per deployment origin; structured clone preserves CryptoKeys. */
export function createBrowserKeyStore(): KeyStore {
  if (typeof indexedDB === "undefined") throw new Error("keyStore is required in Node");
  let database: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    if (database) return database;
    const attempt: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
      // Only this attempt's own failure, close or versionchange may evict it; a later retry stays cached.
      const reset = () => { if (database === attempt) database = undefined; };
      let request: IDBOpenDBRequest;
      try { request = indexedDB.open("bridge-client", 1); } catch (error) { reject(error); return; }
      request.onupgradeneeded = () => { request.result.createObjectStore("keys"); };
      request.onsuccess = () => {
        const db = request.result;
        // An abandoned attempt (blocked, then superseded) must not leak a late connection.
        if (database !== attempt) { db.close(); reject(new Error("bridge key store open was abandoned")); return; }
        db.onclose = reset;
        db.onversionchange = () => { reset(); db.close(); };
        resolve(db);
      };
      request.onerror = () => { reset(); reject(request.error); };
      request.onblocked = () => { reset(); reject(new Error("bridge key store is blocked")); };
    });
    database = attempt;
    // Evict any rejection, however it arose (including a synchronous throw from indexedDB.open).
    attempt.catch(() => { if (database === attempt) database = undefined; });
    return attempt;
  };
  const transact = async (mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<unknown> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("keys", mode);
      const request = operation(transaction.objectStore("keys"));
      transaction.oncomplete = () => { resolve(request.result); };
      transaction.onabort = transaction.onerror = () => { reject(transaction.error ?? request.error); };
    });
  };
  return {
    load: (name) => transact("readonly", (store) => store.get(name)),
    save: async (name, value) => { await transact("readwrite", (store) => store.put(value, name)); },
    delete: async (name) => { await transact("readwrite", (store) => store.delete(name)); },
  };
}
