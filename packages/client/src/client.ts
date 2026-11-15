import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import {
  createPlainLayer, isBase64Url, LOCAL_UI_METHOD, PROTOCOL_RANGE, selectProtocolVersion, validateDiscovery,
  type HandshakeIO, type JsonRpcMessage, type LocalUiParams, type MessageStream, type PresenceBody,
} from "@berdyh/bridge-protocol";

import type { BridgeClient, BridgeClientOptions, BridgeStatus, ClientE2eeContext, KeyStore } from "./contracts.js";
import { createChannel } from "./channel.js";
import { enroll, wrapClientLayer } from "./e2ee/index.js";
import { events } from "./events.js";
import { createBrowserKeyStore } from "./keystore.js";
import { createTransport } from "./transport.js";
import { runnerKeyName } from "./e2ee/wire.js";
import { deriveStatus } from "./status.js";

/** Fetches same-origin discovery and opens a browser or headless ACP client. */
// One wrapper per (underlying store, app), shared by every connection: enroll() serializes on the
// wrapper's identity, so two clients over one store must see the same object.
const scopedStores = new WeakMap<KeyStore, Map<string, KeyStore>>();
const KNOWN_RUNNERS = "__bridge/knownRunners";
// The relay replays online presence only; keep IDs independently of the saved trust keys.
const knownRunnerWrites = new WeakMap<KeyStore, Promise<void>>();
// Most recently seen first, capped, so a reinstall's stale IDs age out instead of piling up.
export const MAX_KNOWN_RUNNERS = 8;
function knownRunnerIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, MAX_KNOWN_RUNNERS) : [];
}
async function rememberRunner(store: KeyStore, runnerId: string): Promise<void> {
  const update = async () => {
    const ids = knownRunnerIds(await store.load(KNOWN_RUNNERS));
    const next = [runnerId, ...ids.filter((id) => id !== runnerId)].slice(0, MAX_KNOWN_RUNNERS);
    if (next.length !== ids.length || next.some((id, i) => id !== ids[i])) await store.save(KNOWN_RUNNERS, next);
  };
  // Serialize read/merge/write across clients sharing a store, and browser tabs.
  const write = (knownRunnerWrites.get(store) ?? Promise.resolve()).catch(() => {}).then(() => {
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request("bridge-known-runners", update) : update();
  });
  knownRunnerWrites.set(store, write);
  try { await write; }
  finally { if (knownRunnerWrites.get(store) === write) knownRunnerWrites.delete(store); }
}

function scopedKeyStore(store: KeyStore, scope: string): KeyStore {
  let byScope = scopedStores.get(store);
  if (!byScope) scopedStores.set(store, byScope = new Map());
  let scoped = byScope.get(scope);
  if (!scoped) byScope.set(scope, scoped = {
    load: (name) => store.load(`${scope}:${name}`),
    save: (name, value) => store.save(`${scope}:${name}`, value),
    delete: (name) => store.delete(`${scope}:${name}`),
  });
  return scoped;
}

export async function connectBridge(options: BridgeClientOptions): Promise<BridgeClient> {
  const discoveryUrl = new URL(options.discoveryUrl);
  if (discoveryUrl.username || discoveryUrl.password || !(discoveryUrl.protocol === "https:" ||
    (discoveryUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(discoveryUrl.hostname)))) {
    throw new Error("discovery requires HTTPS (HTTP only on loopback)");
  }
  if (globalThis.location && globalThis.location.origin !== discoveryUrl.origin) throw new Error("cross-origin discovery");
  const response = await (options.fetch ?? globalThis.fetch)(discoveryUrl.href, { redirect: "error", credentials: "same-origin" });
  if (!response.ok) throw new Error(`discovery fetch failed (${response.status})`);
  if (response.url && new URL(response.url).origin !== discoveryUrl.origin) throw new Error("cross-origin discovery response");
  const validated = validateDiscovery(await response.json(), { appUrl: discoveryUrl.href });
  if (!validated.ok) throw new Error(`invalid discovery: ${validated.errors.join("; ")}`);
  const discovery = validated.value;
  if (selectProtocolVersion(discovery.protocol, PROTOCOL_RANGE) === undefined) throw new Error("unsupported bridge protocol");
  // The plaintext layer can run headless without persistent keys. E2EE always needs an explicit Node store.
  const keyStore: KeyStore = options.keyStore ?? (options.e2ee === false && typeof indexedDB === "undefined"
    ? { load: async () => undefined, save: async () => {}, delete: async () => {} } : createBrowserKeyStore());
  // Keep stored names scoped to this app, even if a headless caller reuses one store.
  const scopedStore = scopedKeyStore(keyStore, `${discovery.origin}:${discovery.app.id}`);
  const storedId = await scopedStore.load("__bridge/browserKeyId");
  const browserKeyId = isBase64Url(storedId) && storedId.length >= 22 ? storedId : btoa(String.fromCharCode(...globalThis.crypto.getRandomValues(new Uint8Array(16))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const transport = createTransport({ relayUrl: discovery.relayUrl, browserKeyId,
    getSessionToken: options.getSessionToken, webSocket: options.webSocket });
  // `recent` orders runners most recently seen first; it decides which runner status() defaults to.
  const recent = knownRunnerIds(await scopedStore.load(KNOWN_RUNNERS));
  const online = new Map<string, PresenceBody>(recent.map((runnerId) => [runnerId, { runnerId, online: false }]));
  const touch = (runnerId: string) => {
    const at = recent.indexOf(runnerId);
    if (at !== -1) recent.splice(at, 1);
    recent.unshift(runnerId);
    for (const evicted of recent.splice(MAX_KNOWN_RUNNERS)) if (!online.get(evicted)?.online) online.delete(evicted);
  };
  const runnersChanged = events<PresenceBody[]>();
  const statusChanged = events<BridgeStatus>();
  // Immediately override in-flight key reads; deletion also preserves this across reloads.
  const untrusted = new Set<string>();
  const forgetting = new Map<string, Promise<void>>();
  const localUi = events<LocalUiParams>();
  let closed = false;
  let operation = 0;
  let enrolling = false;
  let statusRevision = 0;
  // There is no replay-complete message in the relay protocol. Allow a short initial
  // settle window before answering status, instead of emitting a transient install panel.
  let settlePresence!: () => void;
  let presenceSettled = false;
  const initialPresence = new Promise<void>((resolve) => { settlePresence = resolve; });
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  const finishPresence = () => { presenceSettled = true; clearTimeout(presenceTimer); settlePresence(); };
  const active = new Map<string, MessageStream<JsonRpcMessage>>();
  const closeChannels = () => {
    for (const channel of active.values()) channel.close();
    active.clear();
  };
  const snapshot = () => [...recent.flatMap((id) => online.get(id) ?? []),
    ...[...online.values()].filter((runner) => !recent.includes(runner.runnerId))].map((runner) => ({ ...runner,
    ...(runner.agents ? { agents: runner.agents.map((agent) => ({ ...agent })) } : {}) }));
  const isEnrolled = async (runnerId: string) => {
    if (untrusted.has(runnerId)) return false;
    const saved = await scopedStore.load(runnerKeyName(runnerId));
    return !untrusted.has(runnerId) && typeof saved === "string";
  };
  const status = async (runnerId?: string): Promise<BridgeStatus> => {
    if (!presenceSettled) await initialPresence;
    // Presence or trust can change during the asynchronous key-store read.
    for (;;) {
      const revision = statusRevision;
      const current = await deriveStatus({ runners: snapshot(), runnerId, isEnrolled });
      if (revision === statusRevision) return current;
    }
  };
  // Runner-scoped subscribers follow one runner's status, however many others are online.
  const scoped = new Set<{ runnerId: string; handler: (status: BridgeStatus) => void; previous?: string }>();
  const refreshStatus = () => {
    const revision = ++statusRevision;
    for (const sub of scoped) {
      void status(sub.runnerId).then((current) => {
        if (closed || revision !== statusRevision || !scoped.has(sub)) return;
        const serialized = JSON.stringify(current);
        if (serialized === sub.previous) return;
        sub.previous = serialized;
        try { sub.handler(structuredClone(current)); } catch { /* a subscriber's exception is its own */ }
      }).catch(() => { /* see below */ });
    }
    void status().then((current) => {
      if (closed || revision !== statusRevision) return;
      statusChanged.emit(current);
    }).catch(() => { /* Storage errors cannot imply ready; explicit status() reports them. */ });
  };
  const offPresence = transport.onPresence((runner) => {
    const stale = recent[0] !== runner.runnerId;
    online.set(runner.runnerId, runner);
    touch(runner.runnerId);
    if (stale) void rememberRunner(scopedStore, runner.runnerId).catch(() => {
      // Presence still works in memory if storage is unavailable. Enrollment awaits persistence.
    });
    runnersChanged.emit(snapshot());
    refreshStatus();
  });
  const offState = transport.onState((state) => {
    if (state === "open" || state === "connecting" || state === "idle") return;
    for (const [id, runner] of online) online.set(id, { ...runner, online: false });
    runnersChanged.emit(snapshot());
    refreshStatus();
  });
  const chooseRunner = (runnerId?: string) => {
    if (closed) throw new Error("client closed");
    if (runnerId) return runnerId;
    const candidates = [...online.values()].filter((runner) => runner.online);
    if (candidates.length !== 1) throw new Error("specify runnerId: expected exactly one online runner");
    return candidates[0]!.runnerId;
  };
  const context = (runnerId: string): ClientE2eeContext => ({
    runnerId, label: options.label, keyStore: scopedStore,
    get browserKeyId() { return transport.browserKeyId; },
    rebind: (id) => transport.rebind(id),
    handshakeFor(target): HandshakeIO {
      return {
        send: (message) => transport.sendPake(target, message),
        onMessage: (handler) => transport.onPake((from, message) => {
          if (from === target && message.t !== "session/close") handler(message);
        }),
      };
    },
  });
  const channel = async (runnerId?: string): Promise<MessageStream<JsonRpcMessage>> => {
    const target = chooseRunner(runnerId);
    if (enrolling) throw new Error("enrollment is in progress");
    ++operation;
    active.get(target)?.close("superseded");
    const plain = createPlainLayer();
    const wrapped = wrapClientLayer(plain, context(target));
    const opened = createChannel(transport, target, options.e2ee === false ? plain : wrapped, (message) => {
      if (message.method === LOCAL_UI_METHOD && !("id" in message) && validLocalUi(message.params)) localUi.emit(message.params);
    });
    active.set(target, opened);
    opened.onClose((reason) => {
      if (active.get(target) === opened) active.delete(target);
      if (reason === "not_trusted") {
        untrusted.add(target);
        refreshStatus();
        const forgotten = scopedStore.delete(runnerKeyName(target)).catch(() => {
          // Keep the in-memory denial even when persistent storage is unavailable.
        });
        forgetting.set(target, forgotten);
      }
    });
    return opened;
  };
  const stream = async (runnerId?: string): Promise<Stream> => {
    const source = await channel(runnerId);
    return toAcpStream(source);
  };
  try { await transport.connect(); } catch (error) {
    closed = true; finishPresence(); transport.close(); offPresence(); offState(); throw error;
  }
  presenceTimer = setTimeout(finishPresence, 100);
  refreshStatus();
  return {
    discovery, transport, runners: snapshot, onRunners: runnersChanged.on,
    async enroll(code, runnerId, opts) {
      const target = chooseRunner(runnerId);
      if (enrolling) throw new Error("enrollment is in progress");
      enrolling = true;
      const attempt = ++operation;
      closeChannels();
      try {
        const forgotten = forgetting.get(target);
        if (forgotten) await forgotten;
        if (closed || attempt !== operation) throw new Error("enrollment superseded");
        const result = await enroll(code, opts?.onBrowserKey ? { ...context(target), onBrowserKey: opts.onBrowserKey } : context(target));
        if (closed || attempt !== operation) throw new Error("enrollment superseded");
        await scopedStore.save("__bridge/browserKeyId", result.browserKeyId);
        await rememberRunner(scopedStore, target);
        if (closed || attempt !== operation) throw new Error("enrollment superseded");
        if (!online.has(target)) online.set(target, { runnerId: target, online: false });
        touch(target);
        runnersChanged.emit(snapshot());
        untrusted.delete(target);
        refreshStatus();
        return result;
      } finally { enrolling = false; }
    },
    status,
    onStatus(handler, runnerId) {
      if (closed) return () => {};
      if (runnerId !== undefined) {
        const sub = { runnerId, handler };
        scoped.add(sub);
        refreshStatus();
        return () => { scoped.delete(sub); };
      }
      let previous: string | undefined;
      const off = statusChanged.on((current) => {
        const serialized = JSON.stringify(current);
        if (serialized === previous) return;
        previous = serialized;
        handler(structuredClone(current));
      });
      refreshStatus();
      return off;
    },
    isEnrolled,
    channel, stream,
    acp: async (app, runnerId) => app.connect(await stream(runnerId)),
    onLocalUi: localUi.on,
    close() {
      if (closed) return;
      closed = true;
      finishPresence();
      ++operation;
      closeChannels();
      transport.close();
      offPresence(); offState();
      ++statusRevision;
      runnersChanged.clear(); statusChanged.clear(); scoped.clear(); localUi.clear();
    },
  };
}

function toAcpStream(source: MessageStream<JsonRpcMessage>): Stream {
  let offMessage = () => {};
  let offClose = () => {};
  let ended = false;
  const cleanup = () => { offMessage(); offClose(); };
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      offMessage = source.onMessage((message) => {
        if (!ended && message.method !== LOCAL_UI_METHOD) controller.enqueue(message as AnyMessage);
      });
      offClose = source.onClose(() => {
        if (ended) return;
        ended = true;
        cleanup();
        controller.close();
      });
    },
    cancel() { ended = true; cleanup(); source.close(); },
  });
  const writable = new WritableStream<AnyMessage>({
    write: (message) => source.send(message as JsonRpcMessage),
    close: () => source.close(),
    abort: () => source.close(),
  });
  return { readable, writable };
}

function validLocalUi(value: unknown): value is LocalUiParams {
  if (!value || typeof value !== "object") return false;
  const params = value as LocalUiParams;
  if (typeof params.pluginId !== "string" || !params.pluginId || typeof params.url !== "string") return false;
  try {
    const url = new URL(params.url);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
