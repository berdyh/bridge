import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { LOCAL_UI_METHOD, PLUGIN_RPC, isSessionQuiescence, parseExtensionMethod, type JsonRpcMessage, type SessionEndReason, type StartAgentSessionParams } from "@berdyh/bridge-protocol";
import { PROXY_ERROR, type AgentSessionBroker, type BrokeredSession } from "../acp/contracts.js";
import { buildAgentEnv, prepareRunDirs } from "../sandbox/index.js";
import type { ConsentedGrant, InstalledPlugin, PluginProcess, PluginStatus } from "./contracts.js";
import { brokerRequestOf, parseStartParams, restrictBroker } from "./broker.js";
import { RpcPeer, rpcError } from "./rpc.js";
import { assertNoSymlinks } from "./package.js";

export interface ProcessOptions {
  /** Canonical boundary containing all host-owned paths. */
  pathBoundary: string;
  nodePath?: string;
  env?: Record<string, string | undefined>;
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Running this long resets exponential restart backoff. Default one minute. */
  healthyAfterMs?: number;
  /** Signal sender for process groups; injectable for tests. Defaults to process.kill. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  broker(): AgentSessionBroker | undefined;
  /**
   * The consent record of a plugin, read at each contained session start (`PluginHostWithGrants.grantOf`).
   * Absent, or resolving undefined, refuses a contained start with `consentMissing`.
   */
  grantOf?(pluginId: string): Promise<ConsentedGrant | undefined>;
  log?: (pluginId: string, level: string, message: string, fields?: Record<string, unknown>) => void;
}

export class ManagedPlugin implements PluginProcess {
  readonly pluginId: string;
  restarts = 0;
  private child?: ChildProcessWithoutNullStreams;
  private peer?: RpcPeer;
  private stopping = false;
  private restartTimer?: NodeJS.Timeout;
  private healthyTimer?: NodeJS.Timeout;
  private terminate?: () => Promise<void>;
  private starting?: Promise<void>;
  private stoppingPromise?: Promise<void>;
  private listeners = new Set<(message: JsonRpcMessage) => void>();
  private callers = new Map<string, string>();
  private sessionCleanup: Promise<void> = Promise.resolve();
  constructor(readonly installed: InstalledPlugin, private options: ProcessOptions) { this.pluginId = installed.manifest.id; }
  get status(): PluginStatus { return this.installed.status; }
  onNotification(handler: (message: JsonRpcMessage) => void): () => void {
    this.listeners.add(handler);
    return () => { this.listeners.delete(handler); };
  }
  private push(message: JsonRpcMessage): void {
    for (const handler of this.listeners) { try { handler(message); } catch { /* Isolate subscribers. */ } }
  }
  async call(method: string, params: unknown, caller: { appId: string; browserKeyId: string }): Promise<unknown> {
    if (caller.appId !== this.installed.manifest.app) throw rpcError("Plugin belongs to another app", PROXY_ERROR.extensionForbidden);
    if (parseExtensionMethod(method)?.pluginId !== this.pluginId) throw rpcError("Unknown plugin method", PROXY_ERROR.extensionNotFound);
    if (this.starting) await this.starting;
    if (this.status !== "running" || !this.peer) throw rpcError("Plugin is not running");
    const key = caller.browserKeyId;
    const callToken = randomUUID();
    this.callers.set(callToken, key);
    try {
      return await this.peer.request(PLUGIN_RPC.call, { method, params, callToken, caller: { appId: caller.appId, browserKeyId: key } }, this.options.requestTimeoutMs ?? null);
    } finally {
      this.callers.delete(callToken);
    }
  }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.status === "running") return Promise.resolve();
    if (this.stoppingPromise) return this.stoppingPromise.then(() => this.start());
    this.stopping = false;
    clearTimeout(this.restartTimer);
    this.installed.status = "starting";
    this.starting = this.launch().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async launch(): Promise<void> {
    const sandbox = path.join(this.installed.dataDir, "sandbox");
    try {
      await this.sessionCleanup;
      await assertNoSymlinks(path.resolve(this.installed.installDir, this.installed.manifest.entry), this.options.pathBoundary);
      for (const dir of [sandbox, ...["home", "xdg-config", "xdg-cache", "xdg-data"].map((name) => path.join(sandbox, name))]) {
        await assertNoSymlinks(dir, this.options.pathBoundary);
      }
      await prepareRunDirs(sandbox);
    }
    catch (error) { this.installed.status = "crashed"; throw error; }
    if (this.stopping) { this.installed.status = "stopped"; return; }
    delete this.installed.localUiUrl;
    const child = spawn(this.options.nodePath ?? process.execPath, [path.resolve(this.installed.installDir, this.installed.manifest.entry)], {
      cwd: this.installed.installDir,
      env: {
        ...buildAgentEnv(sandbox, this.options.env ?? process.env),
        PLUGIN_DATA: this.installed.dataDir,
        BRIDGE_PLUGIN_MANIFEST: JSON.stringify(this.installed.manifest),
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.child = child;
    const leaderExited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      // A failed spawn emits error without exit.
      child.once("error", () => resolve());
    });
    let termination: Promise<void> | undefined;
    const kill = this.options.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => { process.kill(pid, signal); });
    // Returns true when the group is known to be gone (ESRCH). EPERM means
    // members remain that this user cannot signal; it is logged, never thrown.
    const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
      if (child.pid === undefined) return true;
      try { kill(-child.pid, signal); return false; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return true;
        try { this.options.log?.(this.pluginId, "warn", `Could not signal plugin process group (${String(code)})`, { signal }); }
        catch { /* Logging must not affect shutdown. */ }
        return false;
      }
    };
    const terminate = () => termination ??= (async () => {
      try {
        signalGroup("SIGTERM");
        // The leader exiting does not mean its descendants exited. Always finish
        // the grace period and signal the original group, including on crashes.
        await new Promise<void>((resolve) => setTimeout(resolve, this.options.stopTimeoutMs ?? 1_000));
        // Skip SIGKILL when the group is gone, so a reused PGID is never signalled.
        if (!signalGroup(0)) signalGroup("SIGKILL");
      } catch { /* Shutdown must never reject. */ }
      await leaderExited;
      // Escaped descendants can inherit these pipes without remaining in the
      // group. Release them locally rather than waiting for child 'close'.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    })();
    this.terminate = terminate;
    const peer = new RpcPeer(child.stdout, child.stdin, this.options.requestTimeoutMs);
    this.peer = peer;
    // Handles belong to this process generation: a later generation starts with none, whatever ids a broker reuses.
    const sessions = new Map<string, { session: BrokeredSession; unsubscribe(): void; finish(reason: SessionEndReason): void }>();
    const brokerOperations = new Set<Promise<unknown>>();
    function track<T>(operation: Promise<T>): Promise<T> {
      brokerOperations.add(operation);
      void operation.then(() => brokerOperations.delete(operation), () => brokerOperations.delete(operation));
      return operation;
    }
    let exited = false;
    let failed = false;
    let settleReady: (error?: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => { settleReady = (error) => error ? reject(error) : resolve(); });
    const startup = setTimeout(() => {
      failed = true;
      clearTimeout(this.healthyTimer);
      settleReady(rpcError("Plugin startup timed out"));
      void terminate();
    }, this.options.startupTimeoutMs ?? 10_000);
    const closeSessions = () => {
      // A start may still be creating an agent, and an explicit close may have
      // removed its handle already. Both must finish before stop/relaunch.
      const closing = [...sessions.values()].map(({ session, unsubscribe }) => {
        unsubscribe();
        // The plugin is gone: the session's end says so, whatever the agent was doing.
        return Promise.resolve().then(() => session.close("plugin_gone"));
      });
      this.sessionCleanup = Promise.allSettled([...brokerOperations, ...closing]).then(() => {});
      sessions.clear();
    };
    // Diagnostics go only to the local host logger, never browser channels.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      try { this.options.log?.(this.pluginId, "error", chunk.slice(0, 16_384), { stream: "stderr" }); }
      catch { /* Logging must not affect the protocol or lifecycle. */ }
    });
    peer.onRequest = async (method, raw) => {
      const p = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      if (method === PLUGIN_RPC.startAgentSession) {
        const logLocal = (level: string, message: string, fields?: Record<string, unknown>) => {
          try { this.options.log?.(this.pluginId, level, message, fields); } catch { /* Logging is optional. */ }
        };
        // Every refusal is logged by code and reason only: the params, which may hold the secret, are never passed on.
        const refuse = (error: unknown): never => {
          const failure = error as { code?: number; message?: string };
          logLocal("warn", "Refused a session start", { code: failure.code, reason: failure.message });
          throw error;
        };
        let params: StartAgentSessionParams;
        try { params = parseStartParams(raw); } catch (error) { return refuse(error); }
        let onBehalfOf: { browserKeyId: string } | undefined;
        if (params.onBehalfOf !== undefined) {
          // Validate the asserted live call. One plugin process sees all its
          // tokens, so this cannot bind the request to its actual serving call.
          const caller = params.onBehalfOf;
          if (caller.appId !== this.installed.manifest.app || typeof params.callToken !== "string" ||
            this.callers.get(params.callToken) !== caller.browserKeyId) {
            return refuse(rpcError("Browser does not own this plugin call", PROXY_ERROR.extensionForbidden));
          }
          onBehalfOf = { browserKeyId: caller.browserKeyId };
        }
        const broker = this.options.broker();
        if (!broker) throw rpcError("No agent broker for this app", PROXY_ERROR.unknownAgent);
        return track((async () => {
          let session: BrokeredSession;
          try {
            const request = await brokerRequestOf(params, onBehalfOf, {
              installed: this.installed, runnerNode: this.options.nodePath ?? process.execPath,
              pathBoundary: this.options.pathBoundary, grantOf: this.options.grantOf, log: logLocal,
            });
            session = await restrictBroker(broker, this.installed.manifest.permissions.agents ?? []).start(request);
          } catch (error) { return refuse(error); }
          if (exited || this.stopping || failed) { await session.close(); throw rpcError("Plugin stopped"); }
          // The plugin's handle is the runner's session id, so the audit log and the runner log name the same
          // session. A broker that reuses an id is a runner bug: refuse it rather than overwrite a live session.
          if (typeof session.sessionId !== "string" || session.sessionId.length === 0 || session.sessionId.length > 128 ||
            sessions.has(session.sessionId)) {
            await session.close();
            return refuse(rpcError("Broker returned an unusable session id", -32603));
          }
          const handle = session.sessionId;
          // Events and the end reach the plugin through this process's peer only, in the order the session
          // produced them, and stop for good once the process is gone or the session has ended. They are held
          // until the start's response is on the wire (a session that ends at once must not announce itself
          // to a plugin that has no handle yet).
          let ended = false;
          let released = false;
          const held: Array<[string, unknown]> = [];
          const alive = () => !exited && this.peer === peer;
          const send = (name: string, body: unknown) => {
            if (!alive()) return;
            if (!released) { held.push([name, body]); return; }
            try { peer.notify(name, body); } catch { /* The plugin is gone or the frame is too large; nothing to deliver. */ }
          };
          setImmediate(() => { released = true; for (const [name, body] of held.splice(0)) send(name, body); });
          let unsubscribe: () => void = () => {};
          // Subscribe as soon as the handle exists: automatic shutdown can produce
          // a bounded cleanup timeout even when kill()/ended never settle.
          const cleanup = session.quiescence?.then((evidence) => {
            const quiescence = isSessionQuiescence(evidence) ? evidence : { status: "incomplete" as const, mechanism: "unknown" as const, reason: "termination-failed" as const };
            send(PLUGIN_RPC.sessionQuiescence, { sessionId: handle, quiescence });
            return quiescence;
          }, () => {
            const quiescence = { status: "incomplete" as const, mechanism: "unknown" as const, reason: "termination-failed" as const };
            send(PLUGIN_RPC.sessionQuiescence, { sessionId: handle, quiescence });
            return quiescence;
          });
          const finish = (reason: SessionEndReason) => {
            if (ended) return;
            ended = true;
            unsubscribe();
            sessions.delete(handle);
            // Older brokers have no cleanup contract. Omit evidence rather than infer
            // success from their ended event; the SDK maps the absence to incomplete.
            if (cleanup) {
              let completed = false;
              const complete = (evidence: unknown) => {
                if (completed) return;
                completed = true;
                clearTimeout(deadline);
                send(PLUGIN_RPC.sessionEnded, { sessionId: handle, reason, quiescence: isSessionQuiescence(evidence) ? evidence : { status: "incomplete", mechanism: "unknown", reason: "termination-failed" } });
              };
              const deadline = setTimeout(() => complete({ status: "incomplete", mechanism: "unknown", reason: "timeout" }), 30_000);
              deadline.unref();
              void cleanup.then(
                complete,
                () => complete({ status: "incomplete", mechanism: "unknown", reason: "termination-failed" }),
              );
            } else send(PLUGIN_RPC.sessionEnded, { sessionId: handle, reason });
          };
          try {
            const stop = session.onUpdate?.((event) => { if (!ended) send(PLUGIN_RPC.sessionUpdate, { sessionId: handle, event }); });
            if (stop) unsubscribe = () => { try { stop(); } catch { /* A broker's unsubscribe must not break shutdown. */ } };
          } catch (error) { await session.close(); return refuse(error); }
          sessions.set(handle, { session, unsubscribe: () => unsubscribe(), finish });
          void session.ended?.then((result) => finish(result.reason), () => {});
          return { sessionId: handle };
        })());
      }
      if (["host/sessionPrompt", "host/sessionCancel", "host/sessionClose"].includes(method)) {
        const live = typeof p.sessionId === "string" ? sessions.get(p.sessionId) : undefined;
        if (!live) throw rpcError("Unknown plugin session", PROXY_ERROR.unknownSession);
        const { session } = live;
        if (method === "host/sessionPrompt") {
          if (typeof p.text !== "string") throw rpcError("Invalid prompt", -32602);
          return session.prompt(p.text);
        }
        if (method === "host/sessionCancel") return session.cancel();
        // The handle goes before the close starts, so a plugin crash during it closes nothing twice.
        sessions.delete(p.sessionId as string);
        return track(Promise.resolve().then(async () => {
          try { await session.close(); }
          finally {
            // A session that cannot say when it ended ends here.
            if (!session.ended) live.finish("closed");
          }
        }));
      }
      throw rpcError("Method not found", -32601);
    };
    peer.onNotification = (method, raw) => {
      const p = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      if (method === "plugin/ready" && !failed && !this.stopping) {
        if (this.installed.status === "running") return;
        clearTimeout(startup);
        this.installed.status = "running";
        this.healthyTimer = setTimeout(() => {
          if (!failed && !exited && !this.stopping && this.status === "running") this.restarts = 0;
        }, this.options.healthyAfterMs ?? 60_000);
        settleReady();
      } else if (method === PLUGIN_RPC.localUi && this.installed.manifest.permissions.localUi && typeof p.url === "string") {
        let url: URL;
        try {
          url = new URL(p.url);
          if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) throw new Error("Invalid loopback URL");
        } catch {
          try { this.options.log?.(this.pluginId, "warn", "Ignoring invalid plugin local UI URL"); } catch { /* Optional logger. */ }
          return;
        }
        this.installed.localUiUrl = url.href;
        this.push({ jsonrpc: "2.0", method: LOCAL_UI_METHOD, params: { pluginId: this.pluginId, url: url.href } });
      } else if (method === PLUGIN_RPC.log && typeof p.level === "string" && typeof p.message === "string") {
        try { this.options.log?.(this.pluginId, p.level, p.message, p.fields as Record<string, unknown> | undefined); } catch { /* Logging is optional. */ }
      } else if (parseExtensionMethod(method)?.pluginId === this.pluginId) {
        this.push({ jsonrpc: "2.0", method, params: raw });
      }
    };
    peer.onClose = () => {
      if (!exited) {
        failed = true;
        clearTimeout(this.healthyTimer);
        this.installed.status = this.stopping ? "stopped" : "crashed";
        void terminate();
      }
    };
    const onExit = (error?: Error) => {
      if (exited) return;
      exited = true;
      clearTimeout(startup);
      clearTimeout(this.healthyTimer);
      peer.close();
      closeSessions();
      this.sessionCleanup = Promise.all([this.sessionCleanup, terminate()]).then(() => {});
      delete this.installed.localUiUrl;
      this.child = undefined;
      this.peer = undefined;
      settleReady(error ?? rpcError("Plugin exited before ready"));
      if (this.stopping) this.installed.status = "stopped";
      else {
        this.installed.status = "crashed";
        const delay = Math.min(this.options.maxRestartDelayMs ?? 30_000,
          (this.options.restartDelayMs ?? 100) * 2 ** Math.min(this.restarts, 20));
        this.installed.status = "backoff";
        this.restartTimer = setTimeout(() => {
          this.restarts++;
          void this.start().catch(() => {});
        }, delay);
      }
    };
    child.once("error", onExit);
    // close can be held open by a descendant inheriting stdio.
    child.once("exit", () => onExit());
    await ready;
  }
  stop(): Promise<void> {
    if (this.stoppingPromise) return this.stoppingPromise;
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.healthyTimer);
    this.stoppingPromise = (async () => {
      await this.terminate?.();
      if (this.starting) await this.starting.catch(() => {});
      // launch may have been preparing paths when stop began.
      await this.terminate?.();
      await this.sessionCleanup;
      this.installed.status = "stopped";
      delete this.installed.localUiUrl;
    })().finally(() => { this.stoppingPromise = undefined; });
    return this.stoppingPromise;
  }
}
