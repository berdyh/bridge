import { CONFINED_BUILTINS, confinedExecutionSupport } from "./confined.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { containedOnlyFieldsOf, isContainedRequest, isSessionQuiescence, parseMcpToolName, type SessionQuiescence } from "@berdyh/bridge-protocol";

import {
  type AcpProxy,
  type AcpProxyOptions,
  type AgentAdapter,
  type AgentExit,
  type AgentProcess,
  type AgentSessionBroker,
  type AgentSessionBrokerRequest,
  type AuditFrameContext,
  type AuditLog,
  type AuditTrigger,
  type BrokeredSession,
  type BrowserChannel,
  ContainmentRefused,
  type ContainmentRefusalReason,
  type ContainmentProfile,
  type ContainmentRequest,
  type ExtensionCaller,
  type GrantResolution,
  type JsonRpcMessage,
  PROXY_ERROR,
  type PermissionOrigin,
  type PermissionRequestInfo,
  type PolicyDecision,
  type SessionBudget,
  type SessionEndReason,
  type SessionEvent,
  type Unsubscribe,
  containedRequestProblem,
  containmentRefusalDataOf,
  narrowSessionBudget,
  sessionAllowSetOf,
} from "./contracts.js";
import { RPC_ERROR, RpcError, type RpcPeer, createRpcPeer } from "./rpc.js";

/** ACP wire version the runner speaks to browsers and to agents. */
const ACP_PROTOCOL_VERSION = 1;
const START_TIMEOUT_MS = 30_000;
/** What a contained session may use when its request names no budget (per field, `narrowSessionBudget` then caps it at the app's ceiling). */
const DEFAULT_SESSION_BUDGET: SessionBudget = Object.freeze({ wallClockMs: 15 * 60_000, maxToolCalls: 200 });
/** The only message a plugin or a browser gets for a contained start that cannot be made safely; the detail stays in the local log. */
const CONTAINED_UNAVAILABLE = "Contained session unavailable";

/**
 * The -32016 error of a refused contained session: the generic message, and `data` only for a refusal with a
 * reason code (`ContainmentRefused.reason`, a fixed set). The refusal's detail never goes in.
 */
function containedUnavailable(reason?: ContainmentRefusalReason): RpcError {
  return new RpcError(PROXY_ERROR.containmentUnavailable, CONTAINED_UNAVAILABLE, reason === undefined ? undefined : containmentRefusalDataOf(reason));
}
/** The first non-space, non-format character of a prompt is `/`: a slash command in the agent's eyes. */
const SLASH_PROMPT = /^[\s\p{Cf}]*\//u;
const RUNNER_INFO = { name: "bridge-runner", version: "0.2.2" };

/**
 * The prompt content the runner advertises to browsers, and so all it forwards. ACP's
 * `promptCapabilities` flags cover image, audio and embedded context; none is advertised.
 * `resource_link` is not forwarded either: its uri would have the agent read a local path
 * on a remote browser's say-so, outside the tool-permission flow.
 */
const ADVERTISED_PROMPT_CAPABILITIES = { image: false, audio: false, embeddedContext: false } as const;
const ADVERTISED_PROMPT_BLOCK_TYPES: ReadonlySet<string> = new Set(["text"]);

/** Rebuilds a prompt from advertised block types only; refuses the whole prompt on any other. */
function filterPromptBlocks(prompt: unknown[]): Json[] {
  return prompt.map((block) => {
    if (!isObject(block) || typeof block.type !== "string" || !ADVERTISED_PROMPT_BLOCK_TYPES.has(block.type)) {
      throw new RpcError(RPC_ERROR.invalidParams, "prompt content type not supported: only text blocks are accepted");
    }
    if (typeof block.text !== "string") throw new RpcError(RPC_ERROR.invalidParams, "text block needs a text string");
    // Whitelist: annotations and _meta a browser adds never reach the agent.
    return { type: "text", text: block.text };
  });
}

/** Of the modes an agent lists, only the current one: the browser can never select another. */
function currentModeOnly(modes: unknown): Json | undefined {
  if (!isObject(modes) || !str(modes.currentModeId)) return undefined;
  const available = Array.isArray(modes.availableModes) ? modes.availableModes : [];
  return {
    currentModeId: modes.currentModeId,
    availableModes: available.filter((m) => isObject(m) && m.id === modes.currentModeId),
  };
}

type Json = Record<string, unknown>;
type Outcome = { outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } };
const CANCELLED: Outcome = { outcome: { outcome: "cancelled" } };

interface ChannelState {
  channel: BrowserChannel;
  peer: RpcPeer;
  caller: ExtensionCaller;
  sessions: Map<string, Session>;
  /** Sessions whose agent is still starting: a channel that closes meanwhile kills them. */
  starting: Set<Session>;
  /** Spawns still inside `adapter.spawn()`: a channel that closes meanwhile aborts them. */
  spawning: Set<AbortController>;
  unsubscribe?: () => void;
  closed: boolean;
}

type SessionOwner =
  | { kind: "channel"; state: ChannelState }
  | { kind: "plugin"; pluginId: string; onBehalfOf?: { browserKeyId: string } };

/**
 * What the proxy needs to start contained plugin sessions and that `AcpProxyOptions` does not carry. Optional:
 * without it every contained request is refused with `containmentUnavailable`. The caller (the CLI's `run`) builds
 * it per app; nothing here is per plugin except what the two functions look up.
 */
export interface ContainedSessionSupport {
  /** `AppPaths.sessionsDir`. A session runs in `<sessionsDir>/<session id>`; the adapter creates that folder empty. */
  sessionsDir: string;
  /** The audit log of one plugin; one object per plugin for the life of the proxy (its failed state is the plugin's). */
  auditLogOf(pluginId: string): AuditLog;
  /** Where the plugin's version lives and how a surface is hashed, for `containedRequestProblem`. Undefined: not installed. */
  resolutionOf(pluginId: string): GrantResolution | undefined;
  /** The Node binary a server must run (`ResolvedMcpServer.command`). Default `process.execPath`. */
  runnerNode?: string;
  /**
   * The model of a contained session whose request names none (the app's `agent.model`). It is resolved once, in
   * `startContained`, and that one value is what the policy admits and what the agent is launched with.
   */
  defaultModel?: string;
}

/** `AcpProxyOptions` plus the pieces of the contained start that are left to the proxy's caller. */
export interface AcpProxyBuildOptions extends AcpProxyOptions {
  contained?: ContainedSessionSupport;
  /** How long the agent gets to answer `initialize` and `session/new`. Default 30 s. */
  startTimeoutMs?: number;
}

/** What the proxy keeps for one contained session: the set it enforces, the budget it counts, the audit it feeds. */
interface ContainedState {
  profile: ContainmentProfile;
  /** The exact approval set (`sessionAllowSetOf`), the same one the adapter and the policy were given. */
  allow: ReadonlySet<string>;
  /** The attached server names. */
  servers: ReadonlySet<string>;
  pluginId: string;
  trigger: AuditTrigger;
  audit: AuditLog;
  budget: SessionBudget;
  /** Tool call ids counted against `budget.maxToolCalls`: each id once, at its first frame or permission request. */
  counted: Set<string>;
  /** The tool name of each call id, from the frame that gave it (an update may leave it out). */
  names: Map<string, string>;
}

/** What a brokered session adds to `Session`. */
interface BrokeredState {
  listeners: Set<(event: SessionEvent) => void>;
  ended: Promise<{ reason: SessionEndReason }>;
  resolveEnded(value: { reason: SessionEndReason }): void;
  quiescence: Promise<SessionQuiescence>;
  resolveQuiescence(value: SessionQuiescence): void;
  /** Set once, synchronously, by the first end path to run; later ones do nothing. */
  endReason?: SessionEndReason;
  /** Resolves after the process group is gone and `ended` has been resolved. */
  endedDone?: Promise<void>;
  /** `cancel()` was called and no prompt has started since: a `close()` now ends the session as `cancelled`. */
  cancelRequested: boolean;
  timer?: NodeJS.Timeout;
  contained?: ContainedState;
}

interface Session {
  /** The id browsers and plugins see. Minted here, so two agents' ids can never collide. */
  id: string;
  /** The id the agent knows it by. Never leaves the proxy. */
  agentSessionId: string;
  agentId: string;
  cwd: string;
  process: AgentProcess;
  peer: RpcPeer;
  owner: SessionOwner;
  /** Cancels every approval still waiting on a browser. */
  asks: Set<() => void>;
  /** Collects the agent's text while a brokered prompt runs. */
  textSink?: (text: string) => void;
  closed: boolean;
  newSessionResult: Json;
  /** The config options the agent declared, by id (from `session/new` and `config_option_update`). */
  configOptions: Map<string, Json>;
  /** Present on a session a plugin started. */
  brokered?: BrokeredState;
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expectObject(params: unknown): Json {
  if (!isObject(params)) throw new RpcError(RPC_ERROR.invalidParams, "params must be an object");
  return params;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RpcError(RPC_ERROR.internal, `${what} timed out`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Config options that change the permission mode. ACP has no standard field for it, so
 * this looks at the option's id and value. It is deliberately broad: an unneeded refusal
 * costs a settings toggle, a missed one costs bypass.
 */
const MODE_CONFIG_ID = /(^|[^a-z])mode([^a-z]|$)|permission|bypass|approval|sandbox|autoaccept|auto_accept/i;
const BYPASS_VALUE = /bypass|dangerous|yolo|full[-_ ]?access|never[-_ ]?ask/i;

function isPermissionModeChange(params: Json, declared: Json | undefined): boolean {
  const configId = str(params.configId) ?? "";
  // ACP marks the permission-mode option with `category: "mode"`, whatever its id is.
  if (declared?.category === "mode") return true;
  if (MODE_CONFIG_ID.test(configId) || BYPASS_VALUE.test(configId)) return true;
  return typeof params.value === "string" && BYPASS_VALUE.test(params.value);
}

/**
 * The only option categories a browser may set (ACP's standard `model` and `thought_level`).
 * An allowlist, not a denylist: an option with no category, a custom `_` category or any
 * other one (an adapter's own `autoApprove`, say) cannot be told apart from a permission
 * switch by its name, so it is set in the runner's local config or not at all.
 */
const BROWSER_SETTABLE_CATEGORIES: ReadonlySet<string> = new Set(["model", "thought_level"]);

function isBrowserSettable(declared: Json | undefined): boolean {
  return declared !== undefined && typeof declared.category === "string" && BROWSER_SETTABLE_CATEGORIES.has(declared.category);
}

/** Records the options an agent declares, replacing what it declared before. */
function recordConfigOptions(session: { configOptions: Map<string, Json> }, options: unknown): void {
  if (!Array.isArray(options)) return;
  session.configOptions.clear();
  for (const option of options) {
    if (isObject(option) && str(option.id)) session.configOptions.set(option.id as string, option);
  }
}

/** `allow_always` and `reject_always` make the agent stop asking: only local config may do that. */
const ALWAYS_KINDS = new Set(["allow_always", "reject_always"]);

function toolNameOf(toolCall: Json): string | undefined {
  const meta = isObject(toolCall._meta) ? toolCall._meta : undefined;
  const claude = meta && isObject(meta.claudeCode) ? meta.claudeCode : undefined;
  return str(claude?.toolName) ?? str(meta?.toolName);
}

interface ParsedPermission {
  toolCall: Json;
  options: { optionId: string; name: string; kind: string }[];
}

function parsePermission(params: unknown): ParsedPermission {
  const p = expectObject(params);
  if (!isObject(p.toolCall) || !str(p.toolCall.toolCallId) || !Array.isArray(p.options)) {
    throw new RpcError(RPC_ERROR.invalidParams, "malformed permission request");
  }
  const options = p.options.flatMap((o) =>
    isObject(o) && str(o.optionId) && typeof o.name === "string" && str(o.kind)
      ? [{ optionId: o.optionId as string, name: o.name, kind: o.kind as string }]
      : [],
  );
  return { toolCall: p.toolCall, options };
}

function validOutcome(answer: unknown, options: ParsedPermission["options"]): Outcome {
  if (isObject(answer) && isObject(answer.outcome) && answer.outcome.outcome === "selected") {
    const optionId = answer.outcome.optionId;
    if (typeof optionId === "string" && options.some((o) => o.optionId === optionId)) {
      return { outcome: { outcome: "selected", optionId } };
    }
  }
  return CANCELLED;
}

/**
 * What a log line may say about a failure of a contained session: the error's class and its code, never its message.
 * A message can carry what the agent or a tool wrote, and so a secret or a tool's arguments.
 */
function failureFields(error: unknown): { errorName: string; errorCode?: number | string } {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return {
    errorName: error instanceof Error && /^\w{1,60}$/.test(error.name) ? error.name : "unknown",
    ...(typeof code === "number" || (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(code)) ? { errorCode: code } : {}),
  };
}

/** The ACP conductor. See `AcpProxy`. */
export function createAcpProxy(options: AcpProxyBuildOptions): AcpProxy {
  const { appId, adapters, policy, extensions } = options;
  const log = options.log ?? (() => undefined);
  const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const channels = new Map<string, ChannelState>();
  const brokered = new Map<string, Session>();
  const kills = new Set<Promise<void>>();
  const failedKills = new WeakSet<AgentProcess>();
  /** Every `openSession` still running, so `close()` can wait for it to finish and clean up. */
  const opens = new Set<Promise<unknown>>();
  /** Spawn controllers of brokered sessions (a channel's are on its `ChannelState`). */
  const brokerSpawning = new Set<AbortController>();
  /** Brokered sessions between spawn and the end of initialize/session/new: `close()` kills them at once. */
  const brokerStarting = new Set<Session>();
  let closed = false;

  const trackProcessKill = (proc: AgentProcess): Promise<void> => {
    const p = Promise.resolve().then(() => proc.kill()).catch(() => { failedKills.add(proc); });
    kills.add(p);
    void p.finally(() => kills.delete(p));
    return p;
  };
  const trackKill = (session: Session): Promise<void> => trackProcessKill(session.process);

  function cancelAsks(session: Session): void {
    for (const cancel of [...session.asks]) cancel();
  }

  function dropSession(session: Session): void {
    session.closed = true;
    cancelAsks(session);
    if (session.owner.kind === "channel") session.owner.state.sessions.delete(session.id);
    else brokered.delete(session.id);
  }

  /** Every end of a session comes through here, a failed start included: the process group goes and a contained session's audit join state is released. */
  function killSession(session: Session): Promise<void> {
    dropSession(session);
    const killed = trackKill(session);
    try {
      session.brokered?.contained?.audit.endSession(session.id);
    } catch {
      /* the log is already failed or gone: nothing more to drop */
    }
    return killed;
  }

  /**
   * The one end of a brokered session: records why (the first reason wins), kills the process group, drops the audit
   * join state and resolves `ended` once the group is gone. Every end path of a plugin's session comes through here.
   */
  function finish(session: Session, reason: SessionEndReason): Promise<void> {
    const b = session.brokered;
    if (!b) return killSession(session);
    if (b.endedDone) return b.endedDone;
    b.endReason = reason;
    if (b.timer) clearTimeout(b.timer);
    b.listeners.clear();
    const killed = killSession(session);
    b.endedDone = killed.then(() => b.resolveEnded({ reason }));
    // Closing the logical session revokes proxy access first. A separate, bounded
    // receipt additionally requires the adapter's descendant AND broker teardown.
    let deadline: NodeJS.Timeout | undefined;
    const receipt = Promise.race<SessionQuiescence>([
      Promise.resolve().then(async (): Promise<SessionQuiescence> => {
        if (!session.process.cleanup) return { status: "incomplete", mechanism: "unknown", reason: "cleanup-unavailable" };
        const [, evidence] = await Promise.all([killed, session.process.cleanup()]);
        if (failedKills.has(session.process) || !isSessionQuiescence(evidence)) {
          return { status: "incomplete", mechanism: "unknown", reason: "termination-failed" };
        }
        return evidence;
      }).catch((): SessionQuiescence => ({ status: "incomplete", mechanism: "unknown", reason: "termination-failed" })),
      new Promise<SessionQuiescence>((resolve) => {
        deadline = setTimeout(() => resolve({ status: "incomplete", mechanism: "unknown", reason: "timeout" }), 30_000);
      }),
    ]).then((result) => { clearTimeout(deadline); b.resolveQuiescence(result); });
    kills.add(receipt);
    void receipt.finally(() => kills.delete(receipt));
    return b.endedDone;
  }

  /** What a plugin's call gets when its session was ended by the runner for `breach` or `budget`; otherwise the error as it was. */
  function endedError(session: Session, fallback: unknown): unknown {
    const reason = session.brokered?.endReason;
    if (reason === "breach") return new RpcError(PROXY_ERROR.containmentBreach, "Contained session ended: containment breach");
    if (reason === "budget") return budgetError();
    return fallback;
  }

  function usableCwd(cwd: unknown): string {
    return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : options.defaultCwd;
  }

  async function allowed(agentId: string, cwd: string, model?: string): Promise<boolean> {
    try {
      return await policy.allowSession({ appId, agentId, cwd, ...(model !== undefined ? { model } : {}) });
    } catch {
      return false;
    }
  }

  async function pickAdapter(hint: string | undefined): Promise<AgentAdapter> {
    if (hint) {
      const adapter = adapters.find((a) => a.id === hint);
      if (!adapter) throw new RpcError(PROXY_ERROR.unknownAgent, `unknown agent: ${hint}`);
      return adapter;
    }
    for (const adapter of adapters) {
      const availability = await adapter.availability().catch(() => undefined);
      if (availability?.available) return adapter;
    }
    throw new RpcError(PROXY_ERROR.unknownAgent, "no agent is available on this machine");
  }

  /** What a plugin's session needs at open beyond a browser's: the pre-minted id, the containment, the brokered state, the model. */
  interface OpenExtra {
    /** Minted by the caller before the spawn (the contained start names the folder and the secret directory after it). */
    id?: string;
    contained?: { request: ContainmentRequest; profile: ContainmentProfile };
    brokered?: BrokeredState;
    /** A non-contained session's model, set through the agent's own `model` config option. */
    model?: string;
    /** When a contained session's wall-clock budget runs out (ms since the epoch). The deadline is armed before the spawn, so start-up counts. */
    deadlineAt?: number;
  }

  /** What the deadline of a start can end, set by the start itself as soon as there is something to end. */
  interface StartHooks {
    expire?: () => void;
  }

  const budgetError = (): RpcError => new RpcError(PROXY_ERROR.budgetExceeded, "Contained session ended: budget exceeded");

  function openSession(adapter: AgentAdapter, cwd: string, owner: SessionOwner, extra?: OpenExtra): Promise<Session> {
    const p = openSessionNow(adapter, cwd, owner, extra);
    const tracked = p.then(
      () => undefined,
      () => undefined,
    );
    opens.add(tracked);
    void tracked.finally(() => opens.delete(tracked));
    return p;
  }

  const ownerClosed = (owner: SessionOwner): boolean => closed || (owner.kind === "channel" && owner.state.closed);

  /** Sets the model of a session that is not contained, through the agent's declared `model` option. */
  async function applyModel(session: Session, model: string): Promise<void> {
    const option = [...session.configOptions.values()].find((o) => o.category === "model");
    const configId = option ? str(option.id) : undefined;
    if (!configId) throw new RpcError(RPC_ERROR.invalidParams, "this agent does not offer a model option");
    const result = await withTimeout(
      session.peer.request("session/set_config_option", { sessionId: session.agentSessionId, configId, value: model }),
      startTimeoutMs,
      "agent set model",
    );
    if (isObject(result)) recordConfigOptions(session, result.configOptions);
  }

  /**
   * Opens a session. A contained one has its wall-clock deadline armed first, so the ceiling bounds the session from the
   * plugin's start request: it ends the start (spawn, initialize, session/new) with `budgetExceeded` and never returns
   * a handle that is already expired.
   */
  async function openSessionNow(adapter: AgentAdapter, cwd: string, owner: SessionOwner, extra: OpenExtra = {}): Promise<Session> {
    const b = extra.brokered;
    const hooks: StartHooks = {};
    let timer: NodeJS.Timeout | undefined;
    if (b && extra.deadlineAt !== undefined) {
      timer = setTimeout(() => {
        if (!b.endReason) hooks.expire?.();
      }, Math.max(0, extra.deadlineAt - Date.now()));
      timer.unref();
      b.timer = timer;
    }
    try {
      return await startSession(adapter, cwd, owner, extra, hooks);
    } catch (error) {
      // A failed start has no session to end later: its deadline goes with it.
      if (timer) clearTimeout(timer);
      throw error;
    }
  }

  /** Spawns an agent, initialises it as a client with no fs or terminal, and opens its session. */
  async function startSession(adapter: AgentAdapter, cwd: string, owner: SessionOwner, extra: OpenExtra, hooks: StartHooks): Promise<Session> {
    const b = extra.brokered;
    const spawning = owner.kind === "channel" ? owner.state.spawning : brokerSpawning;
    const controller = new AbortController();
    spawning.add(controller);
    if (ownerClosed(owner)) controller.abort();
    if (b) {
      // Before the process exists the deadline ends the start by aborting the spawn; nothing has been sent to anything yet.
      hooks.expire = () => {
        b.endReason = "budget";
        log("warn", "session budget used up", { agentId: adapter.id, ...(extra.id !== undefined ? { sessionId: extra.id } : {}), limit: "time" });
        controller.abort();
      };
    }
    const contained = extra.contained;
    let proc: AgentProcess;
    try {
      proc = await adapter.spawn({ cwd, signal: controller.signal, appId, ...(contained ? { containment: contained.request } : {}) });
    } catch (error) {
      // The real message can hold local paths; it goes to the log, not to the browser.
      // A contained session's line names the failure by class and code only: the message may hold a secret or a tool's arguments.
      log("warn", contained ? "contained agent failed to start" : "agent failed to start", {
        agentId: adapter.id,
        ...(contained ? failureFields(error) : { error: (error as Error).message }),
      });
      if (ownerClosed(owner)) throw new RpcError(RPC_ERROR.closed, "connection closed");
      if (b?.endReason === "budget") throw budgetError();
      if (contained) throw containedUnavailable(error instanceof ContainmentRefused ? error.reason : (error as { code?: unknown })?.code === "AGENT_LOGIN_BUSY" ? "login_busy" : undefined);
      throw new RpcError(RPC_ERROR.internal, `agent ${adapter.id} failed to start`);
    } finally {
      spawning.delete(controller);
    }
    if (controller.signal.aborted || ownerClosed(owner)) {
      // Closed while the agent was starting: end it before it is sent anything.
      await trackProcessKill(proc);
      throw b?.endReason === "budget" ? budgetError() : new RpcError(RPC_ERROR.closed, "connection closed");
    }
    const session: Session = {
      id: extra.id ?? randomUUID(),
      agentSessionId: "",
      agentId: adapter.id,
      cwd,
      process: proc,
      peer: undefined as unknown as RpcPeer,
      owner,
      asks: new Set(),
      closed: false,
      newSessionResult: {},
      configOptions: new Map(),
      ...(extra.brokered ? { brokered: extra.brokered } : {}),
    };
    const startingSet = owner.kind === "channel" ? owner.state.starting : brokerStarting;
    startingSet.add(session);
    session.peer = createRpcPeer(proc.stream, {
      onRequest: (method, params) => handleAgentRequest(session, method, params),
      onNotification: (method, params) => handleAgentNotification(session, method, params),
    });
    let exit: AgentExit | undefined;
    void proc.exited.then((result) => {
      exit = result;
      if (!session.closed) log("info", "agent exited", { agentId: session.agentId, sessionId: session.id });
      // The leader is gone but it may have left descendants in its process group: kill()
      // sweeps the group even after exit, and `close()` waits for it.
      if (session.brokered) void finish(session, "agent_exited");
      else void killSession(session);
    });
    // A start that is waiting on an agent that has already gone fails now, not at the timeout.
    let failStart!: (error: unknown) => void;
    const gone = new Promise<never>((_, reject) => {
      failStart = reject;
      void proc.exited.then(() => reject(new RpcError(RPC_ERROR.closed, "agent exited")));
    });
    gone.catch(() => undefined);
    // From here the deadline ends the session (the process group goes) and fails the start step that is waiting.
    if (b) {
      hooks.expire = () => {
        endBudget(session, "time");
        failStart(budgetError());
      };
    }

    let stage = "initialize";
    try {
      await Promise.race([
        withTimeout(
          session.peer.request("initialize", {
            protocolVersion: ACP_PROTOCOL_VERSION,
            // No fs and no terminal: the agent must never send those to a remote browser.
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: RUNNER_INFO,
          }),
          startTimeoutMs,
          "agent initialize",
        ),
        gone,
      ]);
      stage = "session/new";
      let sessionNewParams: Json = { cwd, mcpServers: [] };
      if (contained) {
        // The profile's own parameters, verbatim: a start without them is not contained.
        if (!proc.sessionNew) throw new RpcError(PROXY_ERROR.containmentUnavailable, "the adapter returned no session/new parameters");
        sessionNewParams = { ...proc.sessionNew, cwd };
      }
      const result = await Promise.race([
        withTimeout(
          // Browser-supplied MCP servers are never forwarded: a stdio entry is a command line.
          session.peer.request("session/new", sessionNewParams),
          startTimeoutMs,
          "agent session/new",
        ),
        gone,
      ]);
      if (!isObject(result) || !str(result.sessionId)) throw new RpcError(RPC_ERROR.internal, "agent returned no sessionId");
      session.agentSessionId = result.sessionId as string;
      session.newSessionResult = result;
      recordConfigOptions(session, result.configOptions);
      stage = "check session/new";
      contained?.profile.checkNewSession(result);
      stage = "set model";
      if (extra.model !== undefined) await applyModel(session, extra.model);
    } catch (error) {
      await killSession(session);
      if (contained) {
        if (ownerClosed(owner)) throw new RpcError(RPC_ERROR.closed, "connection closed");
        // For the local log: the step, the class and code of the failure and how the process ended; never the message (it may echo the agent).
        log("warn", "contained session could not start", {
          agentId: adapter.id,
          sessionId: session.id,
          stage,
          ...failureFields(error),
          ...(exit ? { exitCode: exit.code, exitSignal: exit.signal } : {}),
        });
        throw endedError(session, containedUnavailable(error instanceof ContainmentRefused ? error.reason : undefined));
      }
      if (error instanceof RpcError) throw error;
      throw new RpcError(RPC_ERROR.internal, `agent ${adapter.id} failed to start`);
    } finally {
      startingSet.delete(session);
    }
    if (session.closed || (owner.kind === "channel" && owner.state.closed) || closed) {
      await killSession(session);
      throw endedError(session, new RpcError(RPC_ERROR.closed, "connection closed"));
    }
    if (owner.kind === "channel") owner.state.sessions.set(session.id, session);
    else brokered.set(session.id, session);
    return session;
  }

  // ---- agent -> proxy -------------------------------------------------------------------

  function openChannelFor(origin: SessionOwner): ChannelState | undefined {
    if (origin.kind === "channel") return origin.state.closed ? undefined : origin.state;
    const key = origin.onBehalfOf?.browserKeyId;
    if (!key) return undefined;
    let found: ChannelState | undefined;
    for (const state of channels.values()) {
      if (!state.closed && !state.channel.closed && state.channel.browserKeyId === key) found = state;
    }
    return found;
  }

  function askBrowser(session: Session, state: ChannelState, req: ParsedPermission): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      let done = false;
      const finish = (outcome: Outcome) => {
        if (done) return;
        done = true;
        session.asks.delete(cancel);
        resolve(outcome);
      };
      let request: Promise<unknown> | undefined;
      const cancel = () => {
        finish(CANCELLED);
        // The browser's pending approval is dropped from the peer, not left to pile up.
        if (request) state.peer.forget(request);
      };
      session.asks.add(cancel);
      // The browser may only pick a once-only option: no `*_always` ever reaches it.
      const offered = req.options.filter((o) => !ALWAYS_KINDS.has(o.kind));
      if (offered.length === 0) {
        finish(CANCELLED);
        return;
      }
      request = state.peer.request("session/request_permission", { sessionId: session.id, toolCall: req.toolCall, options: offered });
      request.then(
        (answer) => finish(validOutcome(answer, offered)),
        () => finish(CANCELLED),
      );
      // A synchronous channel can deliver the cancel while the request is being sent, before
      // `request` is assigned: that cancel had nothing to forget.
      if (done) state.peer.forget(request);
    });
  }

  async function handlePermission(session: Session, params: unknown): Promise<Outcome> {
    const req = parsePermission(params);
    const contained = session.brokered?.contained;
    // The outcome the agent gets is fixed once, here, and a contained session's audit join records that same outcome in the
    // same step. Every path that answers goes through `settle`, so no outcome (a cancel, an empty option list, an over-budget
    // call included) is returned unrecorded, and a policy that completes late cannot replace the answer already given.
    let settled: Outcome | undefined;
    const settle = (outcome: Outcome): Outcome => {
      if (settled) return settled;
      const recorded = contained ? auditOutcome(session, contained, req, outcome) : outcome;
      settled = recorded ?? CANCELLED;
      if (recorded === undefined) breach(session, "audit write failed");
      return settled;
    };
    if (req.options.length === 0 || session.closed) return settle(CANCELLED);
    // Registered before the policy await: a cancel that arrives while local policy is still
    // deciding must win over whatever it decides.
    let cancelled = false;
    let wake!: (outcome: Outcome) => void;
    const cancelledNow = new Promise<Outcome>((resolve) => (wake = resolve));
    const onCancel = () => {
      cancelled = true;
      // Settled here, where the cancel is: the session's cleanup (which drops the audit join state) runs right after.
      wake(settle(CANCELLED));
    };
    session.asks.add(onCancel);
    try {
      // Raced against the cancel: a policy that never answers must not keep the agent's
      // permission request (and so its turn) pending after the browser cancelled.
      const deciding = decidePermission(session, req, () => cancelled).then(settle);
      deciding.catch(() => undefined);
      return await Promise.race([deciding, cancelledNow]);
    } finally {
      session.asks.delete(onCancel);
    }
  }

  async function decidePermission(session: Session, req: ParsedPermission, isCancelled: () => boolean): Promise<Outcome> {
    const contained = session.brokered?.contained;
    let origin: PermissionOrigin =
      session.owner.kind === "channel"
        ? { kind: "browser", channelId: session.owner.state.channel.channelId, browserKeyId: session.owner.state.channel.browserKeyId }
        : { kind: "plugin", pluginId: session.owner.pluginId, ...(session.owner.onBehalfOf ? { onBehalfOf: session.owner.onBehalfOf } : {}) };
    const tc = req.toolCall;
    if (contained && origin.kind === "plugin") {
      // A call that asks for permission before (or without) a `tool_call` frame is counted here, once.
      if (!(contained.profile.id === "claude-confined-v1" && parseMcpToolName(toolNameOf(tc))) && !countCall(session, contained, tc.toolCallId as string)) return CANCELLED;
      origin = {
        ...origin,
        contained: true,
        ...(contained.profile.id === "claude-confined-v1" ? { execution: "confined-v1" as const } : {}),
        headless: contained.trigger.kind === "headless",
        // Calls still allowed including this one: the request itself is already counted.
        callsLeft: contained.budget.maxToolCalls - contained.counted.size + 1,
        allow: [...contained.allow],
      };
    }
    const toolName = toolNameOf(tc);
    const info: PermissionRequestInfo = {
      appId,
      agentId: session.agentId,
      sessionId: session.id,
      cwd: session.cwd,
      origin,
      toolCallId: tc.toolCallId as string,
      ...(toolName !== undefined ? { toolName } : {}),
      ...(typeof tc.title === "string" ? { title: tc.title } : {}),
      ...(typeof tc.kind === "string" ? { toolKind: tc.kind } : {}),
      ...(tc.rawInput !== undefined ? { rawInput: tc.rawInput } : {}),
      ...(Array.isArray(tc.locations)
        ? {
            locations: tc.locations.flatMap((l) =>
              isObject(l) && typeof l.path === "string"
                ? [{ path: l.path, ...(typeof l.line === "number" ? { line: l.line } : {}) }]
                : [],
            ),
          }
        : {}),
      options: req.options,
    };

    let decision: PolicyDecision;
    try {
      decision = await policy.decidePermission(info);
    } catch {
      decision = { action: "cancel" };
    }
    if (session.closed) return CANCELLED;
    if (contained) return decideContained(req, decision, isCancelled());
    if (isCancelled()) return CANCELLED;
    if (decision.action === "cancel") return CANCELLED;
    if (decision.action === "select") {
      return req.options.some((o) => o.optionId === decision.optionId)
        ? { outcome: { outcome: "selected", optionId: decision.optionId } }
        : CANCELLED;
    }
    // ask: a browser session asks its own channel; a plugin session asks the browser it
    // acts for, if that channel is attached and open. Never the plugin.
    const target = openChannelFor(session.owner);
    if (!target) return CANCELLED;
    return askBrowser(session, target, req);
  }

  /**
   * The answer to a permission request of a contained session. The policy decided; this only turns it into an outcome.
   * A contained session never asks a browser: `ask` is a rejection. Its audit record is written by `handlePermission`, at
   * the point where the outcome is returned.
   */
  function decideContained(req: ParsedPermission, decision: PolicyDecision, cancelledNow: boolean): Outcome {
    const pick = decision.action === "select" ? req.options.find((o) => o.optionId === decision.optionId) : decision.action === "ask" ? req.options.find((o) => o.kind === "reject_once") : undefined;
    return pick && !cancelledNow ? { outcome: { outcome: "selected", optionId: pick.optionId } } : CANCELLED;
  }

  /**
   * Records the outcome that is about to be returned to a contained agent in the audit join. Undefined when it cannot be
   * written down: that is a breach, and the agent gets a cancel. A session that has already ended has nothing left to join
   * later frames to, so its state is dropped again.
   */
  function auditOutcome(session: Session, c: ContainedState, req: ParsedPermission, outcome: Outcome): Outcome | undefined {
    const answer = outcome.outcome;
    const picked = answer.outcome === "selected" ? req.options.find((o) => o.optionId === answer.optionId) : undefined;
    const kind = picked ? (picked.kind.startsWith("allow") ? "allow" : "reject") : "cancel";
    try {
      c.audit.recordDecision(session.id, req.toolCall.toolCallId as string, kind);
      if (session.closed) c.audit.endSession(session.id);
    } catch {
      return undefined;
    }
    return outcome;
  }

  /**
   * Writes the audit record of a detected breach, before the session is ended: whatever frame revealed it. The record is
   * built from names and a digest of the arguments, never the arguments; a write that fails changes nothing, since the
   * session is ended as a breach either way.
   */
  function auditBreach(session: Session, c: ContainedState, what: { toolCallId: string; toolName?: string | undefined; status?: string | undefined; rawInput?: unknown; decision?: "none" }): void {
    let digest: { argsSha256: string; argsBytes: number } | undefined;
    if (what.rawInput !== undefined) {
      try {
        const text = JSON.stringify(what.rawInput);
        if (text !== undefined) digest = { argsSha256: createHash("sha256").update(text, "utf8").digest("hex"), argsBytes: Buffer.byteLength(text, "utf8") };
      } catch {
        /* arguments that cannot be written down have no digest */
      }
    }
    try {
      const written = c.audit.append({
        time: new Date().toISOString(),
        appId,
        pluginId: c.pluginId,
        sessionId: session.id,
        trigger: c.trigger,
        servers: [...c.servers],
        toolCallId: what.toolCallId,
        ...(what.toolName !== undefined ? { toolName: what.toolName } : {}),
        ...(what.status !== undefined ? { status: what.status } : {}),
        // Only the command list says `none`: a tool call's breach record does not guess whether a request was made.
        ...(what.decision !== undefined ? { decision: what.decision } : {}),
        ...digest,
      });
      if (isThenable(written)) written.then(undefined, () => undefined);
    } catch {
      /* the session is ended as a breach either way */
    }
  }

  /** Ends a contained session for a containment breach. `why` is a fixed phrase and `fields` hold names only, never arguments. */
  function breach(session: Session, why: string, fields: Record<string, unknown> = {}): void {
    if (session.brokered?.endReason) return;
    log("warn", `containment breach: ${why}`, { agentId: session.agentId, sessionId: session.id, ...fields });
    void finish(session, "breach");
  }

  /** Ends a contained session whose budget is used up: the turn is cancelled first, then the process group goes. */
  function endBudget(session: Session, limit: "calls" | "time"): void {
    if (session.brokered?.endReason) return;
    log("warn", "session budget used up", { agentId: session.agentId, sessionId: session.id, limit });
    try {
      // A start that ran out of time has no agent session to cancel yet.
      if (session.agentSessionId) session.peer.notify("session/cancel", { sessionId: session.agentSessionId });
    } catch {
      /* the process is going away anyway */
    }
    void finish(session, "budget");
  }

  /**
   * Counts a tool call id once. Calls up to `maxToolCalls` are allowed (`callsLeft` is 1 at the last one); the call after
   * that is over the budget, and the session has been ended for it when this returns false.
   */
  function countCall(session: Session, c: ContainedState, toolCallId: string): boolean {
    if (c.counted.has(toolCallId)) return true;
    if (c.counted.size >= c.budget.maxToolCalls) {
      endBudget(session, "calls");
      return false;
    }
    c.counted.add(toolCallId);
    return true;
  }

  const isThenable = (v: unknown): v is PromiseLike<unknown> => typeof (v as { then?: unknown } | null)?.then === "function";

  /**
   * The one path every frame of a contained session takes: audit, then breach, then budget. Returns false when the
   * session was ended by this frame (nothing more of it may be delivered). The call may already have run: a kill is
   * detection, not prevention.
   */
  function handleContainedFrame(session: Session, c: ContainedState, params: Json, update: Json): boolean {
    const kind = update.sessionUpdate;
    if (kind === "available_commands_update") {
      let outside: string[];
      try {
        outside = c.profile.commandsOutsideSet(update as { availableCommands?: { name: string }[] });
      } catch {
        outside = ["?"]; // a check that cannot run cannot show the list is inside
      }
      if (outside.length === 0) return true;
      auditBreach(session, c, { toolCallId: "available_commands_update", toolName: `/${outside[0]}`, decision: "none" });
      breach(session, "commands outside the allowed set", { pluginId: c.pluginId, commands: outside.slice(0, 8) });
      return false;
    }
    if (kind !== "tool_call" && kind !== "tool_call_update") return true;

    const toolCallId = str(update.toolCallId);
    const own = toolNameOf(update);
    if (!toolCallId) {
      // No id to record it under: the frame's kind stands in for it, as the command breach's does.
      auditBreach(session, c, { toolCallId: `${kind}_without_id`, toolName: own, status: str(update.status), rawInput: update.rawInput });
      breach(session, "tool call frame without an id", { pluginId: c.pluginId });
      return false;
    }
    const toolName = own ?? c.names.get(toolCallId);
    if (own !== undefined) c.names.set(toolCallId, own);

    // An outside tool is judged before the frame is recorded: the audit file records only an initial and a terminal frame,
    // so a breach first shown by an in-progress update would leave no line. The breach writes its own, once, for any frame.
    let outside: boolean;
    try {
      outside = c.profile.toolOutsideSet({ ...(toolName !== undefined ? { toolName } : {}), ...(str(update.kind) ? { kind: str(update.kind)! } : {}) }, c.allow);
    } catch {
      outside = true; // a check that cannot run cannot show the tool is inside
    }
    if (outside) {
      auditBreach(session, c, { toolCallId, toolName, status: str(update.status), rawInput: update.rawInput });
      breach(session, "tool outside the approved set", { pluginId: c.pluginId, ...(toolName !== undefined ? { toolName: toolName.slice(0, 200) } : {}) });
      return false;
    }

    // Confined MCP calls are counted and audited at the trusted broker dispatch boundary.
    if (c.profile.id === "claude-confined-v1" && parseMcpToolName(toolName)) return true;
    const context: AuditFrameContext = { appId, pluginId: c.pluginId, sessionId: session.id, trigger: c.trigger, servers: [...c.servers] };
    const frame = { jsonrpc: "2.0", method: "session/update", params } as JsonRpcMessage;
    try {
      const written = c.audit.recordFrame(frame, context);
      if (isThenable(written)) written.then(undefined, () => breach(session, "audit write failed", { pluginId: c.pluginId }));
    } catch {
      breach(session, "audit write failed", { pluginId: c.pluginId });
      return false;
    }

    return countCall(session, c, toolCallId);
  }

  /** The part of a frame a plugin may see. Raw input and results only for the plugin's own attached `mcp__` tools. */
  function eventOf(session: Session, update: Json): SessionEvent | undefined {
    const c = session.brokered?.contained;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content;
        return isObject(content) && content.type === "text" && typeof content.text === "string" ? { type: "text", text: content.text } : undefined;
      }
      case "tool_call":
      case "tool_call_update": {
        const id = str(update.toolCallId);
        if (!id) return undefined;
        const toolName = toolNameOf(update) ?? c?.names.get(id);
        const parsed = parseMcpToolName(toolName);
        const own = parsed !== undefined && c !== undefined && c.servers.has(parsed.server);
        const result = update.rawOutput !== undefined ? update.rawOutput : update.content;
        return {
          type: update.sessionUpdate === "tool_call" ? "tool_call" : "tool_call_update",
          id,
          ...(toolName !== undefined ? { toolName } : {}),
          ...(str(update.kind) ? { kind: str(update.kind)! } : {}),
          ...(str(update.status) ? { status: str(update.status)! } : {}),
          // The title and the arguments can carry what a tool was asked: only the plugin's own tools show them.
          ...(own && typeof update.title === "string" ? { title: update.title } : {}),
          ...(own && update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
          ...(own && result !== undefined ? { result } : {}),
        };
      }
      case "plan": {
        if (!Array.isArray(update.entries)) return undefined;
        return {
          type: "plan",
          entries: update.entries.flatMap((e) =>
            isObject(e) && typeof e.content === "string"
              ? [{ content: e.content, ...(typeof e.status === "string" ? { status: e.status } : {}), ...(typeof e.priority === "string" ? { priority: e.priority } : {}) }]
              : [],
          ),
        };
      }
      case "usage_update":
        return typeof update.used === "number" ? { type: "usage", totalTokens: update.used } : undefined;
      default:
        return undefined;
    }
  }

  function handleAgentRequest(session: Session, method: string, params: unknown): Promise<unknown> | unknown {
    if (method === "session/request_permission") return handlePermission(session, params);
    // fs/*, terminal/*, elicitation/*, mcp/*: not advertised, never forwarded to a browser.
    throw new RpcError(RPC_ERROR.methodNotFound, `method not supported: ${method}`);
  }

  function handleAgentNotification(session: Session, method: string, params: unknown): void {
    if (method !== "session/update" || !isObject(params) || !isObject(params.update)) return;
    // A plugin's session that has ended (a breach included) takes no further frame.
    if (session.closed && session.brokered) return;
    if (params.update.sessionUpdate === "config_option_update") recordConfigOptions(session, params.update.configOptions);
    if (session.owner.kind === "channel") {
      session.owner.state.peer.notify("session/update", { ...params, sessionId: session.id });
      return;
    }
    const update = params.update;
    const c = session.brokered?.contained;
    if (c && !handleContainedFrame(session, c, params, update)) return;
    if (session.textSink && update.sessionUpdate === "agent_message_chunk" && isObject(update.content)) {
      const text = update.content.type === "text" ? update.content.text : undefined;
      if (typeof text === "string") session.textSink(text);
    }
    const listeners = session.brokered?.listeners;
    if (listeners && listeners.size > 0) {
      const event = eventOf(session, update);
      if (event) {
        for (const handler of [...listeners]) {
          try {
            handler(event);
          } catch {
            /* a plugin's handler must not break the session */
          }
        }
      }
    }
  }

  // ---- browser -> proxy -----------------------------------------------------------------

  function sessionOf(state: ChannelState, sessionId: unknown): Session {
    const session = typeof sessionId === "string" ? state.sessions.get(sessionId) : undefined;
    if (!session || session.closed) throw new RpcError(PROXY_ERROR.unknownSession, "unknown session");
    return session;
  }

  async function handleBrowserRequest(state: ChannelState, method: string, params: unknown): Promise<unknown> {
    if (method.startsWith("_")) {
      if (!extensions || !extensions.handles(method)) {
        throw new RpcError(PROXY_ERROR.extensionNotFound, `no extension handles ${method}`);
      }
      try {
        return (await extensions.request(state.caller, method, params)) ?? null;
      } catch (error) {
        const e = error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
        if (e && typeof e.code === "number" && typeof e.message === "string") throw new RpcError(e.code, e.message, e.data);
        throw new RpcError(RPC_ERROR.internal, "extension call failed");
      }
    }
    switch (method) {
      case "initialize":
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { ...ADVERTISED_PROMPT_CAPABILITIES },
            mcpCapabilities: { http: false, sse: false },
            sessionCapabilities: { close: {} },
          },
          agentInfo: RUNNER_INFO,
          authMethods: [],
        };
      case "session/new": {
        const p = isObject(params) ? params : {};
        if (p.execution !== undefined) throw new RpcError(RPC_ERROR.invalidParams, "Execution profiles are set by installed plugins only");
        // MCP servers and agent options are set by installed plugins only (through the broker): a browser naming either is refused, not ignored.
        if (p.mcpServers !== undefined && !(Array.isArray(p.mcpServers) && p.mcpServers.length === 0)) {
          throw new RpcError(RPC_ERROR.invalidParams, "MCP servers are set by installed plugins only");
        }
        if (p._meta !== undefined && (!isObject(p._meta) || Object.keys(p._meta).some((key) => key !== "agent"))) {
          throw new RpcError(RPC_ERROR.invalidParams, "MCP servers are set by installed plugins only");
        }
        const hint = isObject(p._meta) ? str(p._meta.agent) : undefined;
        const adapter = await pickAdapter(hint);
        const cwd = usableCwd(p.cwd);
        if (!(await allowed(adapter.id, cwd))) throw new RpcError(PROXY_ERROR.sessionNotAllowed, "session not allowed by local policy");
        // The awaits above may have outlived the channel; openSession registers itself synchronously from here.
        if (state.closed || closed) throw new RpcError(RPC_ERROR.closed, "connection closed");
        const session = await openSession(adapter, cwd, { kind: "channel", state });
        const { sessionId: _agentId, _meta: _drop, modes, ...rest } = session.newSessionResult;
        // `session/set_mode` is refused, so the modes a browser could never select are not listed.
        const currentMode = currentModeOnly(modes);
        return { ...rest, ...(currentMode ? { modes: currentMode } : {}), sessionId: session.id };
      }
      case "session/prompt": {
        const p = expectObject(params);
        const session = sessionOf(state, p.sessionId);
        if (!Array.isArray(p.prompt)) throw new RpcError(RPC_ERROR.invalidParams, "prompt must be an array");
        // Whitelist: nothing else a browser adds (_meta, extra fields) reaches the agent.
        return session.peer.request("session/prompt", {
          sessionId: session.agentSessionId,
          prompt: filterPromptBlocks(p.prompt),
          ...(typeof p.messageId === "string" ? { messageId: p.messageId } : {}),
        });
      }
      case "session/set_mode":
        throw new RpcError(PROXY_ERROR.permissionModeForbidden, "the permission mode is set in the runner's local config only");
      case "session/set_config_option": {
        const p = expectObject(params);
        const session = sessionOf(state, p.sessionId);
        const configId = str(p.configId);
        if (!configId) throw new RpcError(RPC_ERROR.invalidParams, "configId must be a string");
        if (typeof p.value !== "string" && typeof p.value !== "boolean") {
          throw new RpcError(RPC_ERROR.invalidParams, "value must be a string or a boolean");
        }
        const declared = session.configOptions.get(configId);
        // Only declared options in an allowlisted category may be set (model, thought level),
        // and never one that looks like the permission mode. Anything else could be a
        // permission switch under another name: same refusal.
        if (!isBrowserSettable(declared) || isPermissionModeChange(p, declared)) {
          throw new RpcError(PROXY_ERROR.permissionModeForbidden, "the permission mode is set in the runner's local config only");
        }
        const result = await session.peer.request("session/set_config_option", {
          sessionId: session.agentSessionId,
          configId,
          value: p.value,
        });
        if (isObject(result)) recordConfigOptions(session, result.configOptions);
        return result;
      }
      case "session/close": {
        const p = expectObject(params);
        await killSession(sessionOf(state, p.sessionId));
        return {};
      }
      default:
        throw new RpcError(RPC_ERROR.methodNotFound, `method not supported: ${method}`);
    }
  }

  function handleBrowserNotification(state: ChannelState, method: string, params: unknown): void {
    if (method.startsWith("_")) {
      if (extensions?.handles(method)) extensions.notify(state.caller, method, params);
      return;
    }
    if (method !== "session/cancel" || !isObject(params)) return;
    const session = typeof params.sessionId === "string" ? state.sessions.get(params.sessionId) : undefined;
    if (!session || session.closed) return;
    // ACP: a cancelled turn must answer its pending permission requests as cancelled.
    cancelAsks(session);
    session.peer.notify("session/cancel", { sessionId: session.agentSessionId });
  }

  function closeChannel(state: ChannelState, reason: string): void {
    if (state.closed) return;
    state.closed = true;
    channels.delete(state.channel.channelId);
    state.unsubscribe?.();
    log("info", "channel closed", { channelId: state.channel.channelId, reason });
    for (const controller of [...state.spawning]) controller.abort();
    for (const session of [...state.sessions.values(), ...state.starting]) void killSession(session);
    // Approvals a plugin session was waiting on from this channel are answered `cancel`
    // by their own pending request failing when the channel closes.
    if (!state.channel.closed) state.channel.close(reason);
  }

  // ---- brokered sessions ----------------------------------------------------------------

  /**
   * Refuses a contained start that cannot be made safely. `why` goes to the local log; the caller gets the generic
   * error, plus `data` when the refusal has a fixed reason code.
   */
  function unavailable(why: string, fields: Record<string, unknown> = {}, reason?: ContainmentRefusalReason): never {
    log("warn", `contained session refused: ${why}`, fields);
    throw containedUnavailable(reason);
  }

  function newBrokeredState(contained?: ContainedState): BrokeredState {
    let resolveEnded!: BrokeredState["resolveEnded"];
    const ended = new Promise<{ reason: SessionEndReason }>((resolve) => (resolveEnded = resolve));
    let resolveQuiescence!: BrokeredState["resolveQuiescence"];
    const quiescence = new Promise<SessionQuiescence>((resolve) => (resolveQuiescence = resolve));
    return { listeners: new Set(), ended, resolveEnded, quiescence, resolveQuiescence, cancelRequested: false, ...(contained ? { contained } : {}) };
  }

  /** The handle a plugin gets for a session that is open. */
  function brokeredSessionOf(session: Session, b: BrokeredState): BrokeredSession {
    const contained = b.contained !== undefined;
    return {
      sessionId: session.id,
      ended: b.ended,
      quiescence: b.quiescence,
      onUpdate(handler): Unsubscribe {
        if (!session.closed) b.listeners.add(handler);
        return () => {
          b.listeners.delete(handler);
        };
      },
      async prompt(text) {
        if (session.closed) throw new RpcError(PROXY_ERROR.unknownSession, "session closed");
        if (session.textSink) throw new RpcError(RPC_ERROR.invalidRequest, "a prompt is already running");
        // Slash commands are off in a contained session; a prompt that starts one is refused, not forwarded.
        if (contained && SLASH_PROMPT.test(text)) throw new RpcError(RPC_ERROR.invalidParams, "a prompt of a contained session must not start with '/'");
        let collected = "";
        session.textSink = (t) => {
          collected += t;
        };
        b.cancelRequested = false;
        try {
          const result = await session.peer.request("session/prompt", {
            sessionId: session.agentSessionId,
            prompt: [{ type: "text", text }],
          });
          const ended = endedError(session, undefined);
          if (ended) throw ended;
          const stopReason = isObject(result) && typeof result.stopReason === "string" ? result.stopReason : "end_turn";
          return { stopReason, text: collected };
        } catch (error) {
          throw endedError(session, error);
        } finally {
          session.textSink = undefined;
        }
      },
      async cancel() {
        if (session.closed) return;
        b.cancelRequested = true;
        cancelAsks(session);
        session.peer.notify("session/cancel", { sessionId: session.agentSessionId });
      },
      /** `plugin_gone` is for the plugin host to say when the plugin's process went away; without a reason this is a plain close. */
      async close(reason?: "plugin_gone") {
        await finish(session, reason === "plugin_gone" ? "plugin_gone" : b.cancelRequested ? "cancelled" : "closed");
      },
    };
  }

  /** Whether `budget` of the request is a positive whole number per field (the wire validator checks this too). */
  function requestedBudgetOf(req: AgentSessionBrokerRequest): Partial<SessionBudget> {
    const out: { wallClockMs?: number; maxToolCalls?: number } = {};
    for (const field of ["wallClockMs", "maxToolCalls"] as const) {
      const v = req.budget?.[field];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new RpcError(RPC_ERROR.invalidParams, `budget.${field} must be a positive whole number`);
      out[field] = v;
    }
    return out;
  }

  /** The start of a contained plugin session: everything between the request and a handle is decided or refused here. */
  async function startContained(req: AgentSessionBrokerRequest): Promise<BrokeredSession> {
    const requestedAt = Date.now();
    const support = options.contained;
    if (!support) unavailable("this proxy has no contained-session support", { pluginId: req.pluginId });
    const runnerNode = support!.runnerNode ?? process.execPath;
    // The trust boundary: nothing below acts on a field of the request that the consented grant does not back.
    const resolution = support!.resolutionOf(req.pluginId);
    if (!resolution) {
      if (!req.grant) throw new RpcError(PROXY_ERROR.consentMissing, "No consent is recorded for this plugin's contained sessions");
      unavailable("the plugin is not installed", { pluginId: req.pluginId });
    }
    const problem = containedRequestProblem(req, runnerNode, resolution!);
    if (problem) throw new RpcError(problem.code, problem.message);
    const requested = requestedBudgetOf(req);

    const adapter = await pickAdapter(req.agent);
    let profile: ContainmentProfile | undefined;
    try {
      profile = req.execution ? adapter.execution?.() : adapter.containment?.();
    } catch {
      profile = undefined;
    }
    if (!profile) {
      let reason: ContainmentRefusalReason | undefined;
      try {
        reason = req.execution ? (adapter.id !== "claude" ? "execution_unsupported" : adapter.containmentRefusalReason?.() ?? confinedExecutionSupport().reason ?? "execution_unsupported") : adapter.containmentRefusalReason?.();
      } catch {
        reason = undefined;
      }
      unavailable("the agent has no containment profile for this install", { agentId: adapter.id, ...(reason !== undefined ? { reason } : {}) }, reason);
    }
    if (!policy.allowContainedSession) unavailable("the policy cannot admit contained sessions", { agentId: adapter.id });
    // The effective model, resolved once: what the policy admits is what the agent is launched with.
    const model = req.model ?? support!.defaultModel;
    let verdict;
    try {
      verdict = await policy.allowContainedSession!({ appId, agentId: adapter.id, ...(model !== undefined ? { model } : {}) });
    } catch {
      verdict = { allowed: false as const, reason: "the policy failed" };
    }
    if (!verdict.allowed) {
      log("info", "contained session not allowed by local policy", { agentId: adapter.id, reason: verdict.reason });
      throw new RpcError(PROXY_ERROR.sessionNotAllowed, "session not allowed by local policy");
    }
    if (closed) throw new RpcError(RPC_ERROR.closed, "proxy closed");

    // The id is minted first: the folder and the secret directory are named after it.
    const id = randomUUID();
    const cwd = path.join(path.resolve(support!.sessionsDir), id);
    const allow = sessionAllowSetOf(req);
    const servers = req.mcpServers ?? [];
    let audit: AuditLog;
    try {
      audit = support!.auditLogOf(req.pluginId);
    } catch {
      return unavailable("the plugin's audit log cannot be opened", { pluginId: req.pluginId });
    }
    const state: ContainedState = {
      profile: profile!,
      allow: req.execution ? new Set([...allow, ...CONFINED_BUILTINS]) : allow,
      servers: new Set(servers),
      pluginId: req.pluginId,
      trigger: req.onBehalfOf ? { kind: "browser", browserKeyId: req.onBehalfOf.browserKeyId } : { kind: "headless" },
      audit,
      budget: narrowSessionBudget(verdict.budget, { ...DEFAULT_SESSION_BUDGET, ...requested }),
      counted: new Set(),
      names: new Map(),
    };
    // The deadline is the plugin's start request plus the budget, whatever the start-up takes.
    const deadlineAt = requestedAt + state.budget.wallClockMs;
    if (Date.now() >= deadlineAt) {
      log("warn", "session budget used up", { agentId: adapter.id, sessionId: id, limit: "time" });
      throw budgetError();
    }
    // A copy: the adapter zeroes what it is given, and the caller's own value is not ours to wipe.
    const secret = req.secret === undefined ? undefined : typeof req.secret === "string" ? new Uint8Array(Buffer.from(req.secret, "utf8")) : Uint8Array.from(req.secret);
    let brokerSession: Session | undefined;
    const request: ContainmentRequest = {
      sessionId: id,
      ...(req.execution ? { execution: req.execution } : {}),
      ...(req.broker ? { hostBroker: { socketPath: path.resolve(resolution!.dataDir, req.broker.socket), dataDir: resolution!.dataDir } } : {}),
      servers: (req.servers ?? []).map((srv) => ({ name: srv.name, command: srv.command, args: [...srv.args], ...(srv.secretTransport ? { secretTransport: srv.secretTransport } : {}) })),
      allow: [...allow],
      ...(req.execution ? { maxToolCalls: state.budget.maxToolCalls, brokerTools: {
        async before(callId: string, toolName: string, args: unknown): Promise<boolean> {
          const session = brokerSession;
          if (!session || session.closed || !state.allow.has(toolName) || !countCall(session, state, `broker:${callId}`)) return false;
          try {
            const text = JSON.stringify(args) ?? "null";
            await state.audit.append({ time: new Date().toISOString(), appId, pluginId: state.pluginId, sessionId: id, trigger: state.trigger, servers: [...state.servers], toolCallId: `broker:${callId}`, toolName, status: "pending", decision: "allow", argsSha256: createHash("sha256").update(text).digest("hex"), argsBytes: Buffer.byteLength(text) });
            return !session.closed;
          } catch { breach(session, "broker audit write failed", { pluginId: state.pluginId }); return false; }
        },
        async after(callId: string, toolName: string, failed: boolean): Promise<void> {
          try { await state.audit.append({ time: new Date().toISOString(), appId, pluginId: state.pluginId, sessionId: id, trigger: state.trigger, servers: [...state.servers], toolCallId: `broker:${callId}`, toolName, status: failed ? "failed" : "completed", decision: "allow" }); }
          catch { if (brokerSession) breach(brokerSession, "broker audit write failed", { pluginId: state.pluginId }); throw new Error("broker audit unavailable"); }
        },
      } } : {}),
      ...(secret ? { secret } : {}),
      ...(model !== undefined ? { model } : {}),
    };
    const b = newBrokeredState(state);
    let session: Session;
    try {
      session = await openSession(adapter, cwd, { kind: "plugin", pluginId: req.pluginId, ...(req.onBehalfOf ? { onBehalfOf: req.onBehalfOf } : {}) }, { id, contained: { request, profile: profile! }, brokered: b, deadlineAt });
    } finally {
      secret?.fill(0);
    }
    brokerSession = session;
    return brokeredSessionOf(session, b);
  }

  const broker: AgentSessionBroker = {
    async start(req): Promise<BrokeredSession> {
      if (closed) throw new RpcError(RPC_ERROR.closed, "proxy closed");
      if (req.appId !== appId) throw new RpcError(PROXY_ERROR.sessionNotAllowed, "app mismatch");
      if (isContainedRequest(req)) return startContained(req);
      // One definition: a field only a contained session may carry, on any other request, is refused before anything else.
      const containedOnly = containedOnlyFieldsOf(req);
      if (containedOnly.length > 0) unavailable("contained-only fields on a session that is not contained", { pluginId: req.pluginId, fields: containedOnly });
      const adapter = await pickAdapter(req.agent);
      const cwd = usableCwd(req.cwd);
      if (!(await allowed(adapter.id, cwd, req.model))) throw new RpcError(PROXY_ERROR.sessionNotAllowed, "session not allowed by local policy");
      if (closed) throw new RpcError(RPC_ERROR.closed, "proxy closed");
      const b = newBrokeredState();
      const session = await openSession(
        adapter,
        cwd,
        {
          kind: "plugin",
          pluginId: req.pluginId,
          ...(req.onBehalfOf ? { onBehalfOf: req.onBehalfOf } : {}),
        },
        { brokered: b, ...(req.model !== undefined ? { model: req.model } : {}) },
      );
      return brokeredSessionOf(session, b);
    },
  };

  return {
    appId,
    broker,
    attach(channel) {
      if (closed) throw new Error("proxy closed");
      if (channel.appId !== appId) throw new Error(`channel belongs to another app connection (${channel.appId})`);
      if (channels.has(channel.channelId)) throw new Error(`channel already attached: ${channel.channelId}`);
      const state: ChannelState = {
        channel,
        peer: undefined as unknown as RpcPeer,
        caller: { appId, channelId: channel.channelId, browserKeyId: channel.browserKeyId },
        sessions: new Map(),
        starting: new Set(),
        spawning: new Set(),
        closed: false,
      };
      channels.set(channel.channelId, state);
      state.peer = createRpcPeer(channel, {
        onRequest: (method, params) => handleBrowserRequest(state, method, params),
        onNotification: (method, params) => handleBrowserNotification(state, method, params),
      });
      channel.onClose((reason) => closeChannel(state, reason ?? "closed"));
      if (extensions) {
        try {
          state.unsubscribe = extensions.subscribe(state.caller, (message) => {
            // Plugins may push notifications only: a response or request from a plugin could
            // masquerade as an answer to the browser's own request. And only extension
            // notifications (`_...`): a plugin must never be able to push `session/update` or
            // any other ACP method, which would pass for an agent's output.
            if (state.closed || typeof message.method !== "string" || !message.method.startsWith("_") || message.id !== undefined) return;
            try {
              const sent = channel.send(message);
              if (sent) void sent.catch(() => undefined);
            } catch {
              // channel is closing
            }
          });
        } catch (error) {
          log("warn", "extension subscribe failed", { error: (error as Error).message });
        }
      }
    },
    sessionCount() {
      let n = brokered.size;
      for (const state of channels.values()) n += state.sessions.size;
      return n;
    },
    async close() {
      closed = true;
      for (const state of [...channels.values()]) closeChannel(state, "proxy closed");
      for (const controller of [...brokerSpawning]) controller.abort();
      for (const session of [...brokered.values(), ...brokerStarting]) void finish(session, "runner_shutdown");
      while (kills.size > 0 || opens.size > 0) await Promise.all([...kills, ...opens]);
    },
  };
}
