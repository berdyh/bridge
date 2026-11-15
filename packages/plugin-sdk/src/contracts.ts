/**
 * The API a local plugin sees. A plugin is an npm package whose entry module runs
 * as its own Node process, spawned by the runner's plugin host, and talks to the
 * host with JSON-RPC over stdio (`PLUGIN_RPC` in bridge-protocol). Plugin authors
 * only use `definePlugin` and the `PluginContext`; the wire is hidden.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ConfinedBroker, ConfinedExecution, SessionEndReason, SessionEvent, SessionQuiescence } from "@berdyh/bridge-protocol";

export type { SessionEndReason, SessionEvent, SessionQuiescence };
export { SESSION_END_REASONS, isContainedRequest } from "@berdyh/bridge-protocol";

/** Who is calling a plugin method. The host has already checked `appId` against the manifest's `app`. */
export interface PluginCaller {
  appId: string;
  /** The enrolled browser (key id) the call came from. */
  browserKeyId: string;
}

/**
 * Handles one extension method. The result (or the thrown error's message) goes
 * back to the browser as the JSON-RPC response. Params are untrusted input.
 */
export type MethodHandler = (params: unknown, caller: PluginCaller) => unknown | Promise<unknown>;

/**
 * The `data` of the error `startAgentSession` rejects with (`code` -32016, message `Contained session unavailable`) when
 * the contained session is refused because the claude adapter is not installed on the machine. `reason` is a fixed
 * code from a closed set (one member today; a plugin must treat an unknown one as "no reason") and `hint` the command the
 * user runs on that machine. Every other refusal has no `data`. The refusal's own detail (paths, exit codes, output)
 * never leaves the machine. The runner defines the same set (`ContainmentRefusalReason`).
 */
export interface ContainedSessionRefusal {
  reason: "adapter_missing" | "sandbox_unavailable" | "execution_unsupported" | "login_busy";
  hint: string;
}

export interface AgentSessionRequest {
  /** Linux x64 bundled Claude: scripts, private workspace/artifacts, exact consented HTTPS endpoints. No caller cwd. */
  execution?: ConfinedExecution;
  /** Broker-only host HTTP Unix service, relative to own pluginData and explicitly fs+execution-consented. */
  broker?: ConfinedBroker;
  /** An agent id from the manifest's `permissions.agents`; anything else is refused. */
  agent: string;
  /**
   * The folder of an ordinary session. Not allowed on a contained one: the runner makes an empty
   * private folder for it and sets the cwd itself, so a request that is contained (`tools.builtins:
   * "none"`) and names a `cwd` fails with -32602 rather than having it ignored.
   */
  cwd?: string;
  /**
   * The caller of the extension method being served, when this session is started
   * for one (pass the `caller` the `MethodHandler` received). It is the only place the
   * runner may forward the session's `ask` permission requests to: the enrolled
   * browser `onBehalfOf.browserKeyId`, provided its channel is open. The host checks
   * `appId` against the manifest. Without it, or when that browser is gone, requests
   * the runner's local policy does not answer are cancelled. The plugin itself never
   * sees or answers a permission request.
   */
  onBehalfOf?: PluginCaller;
  /**
   * Run the session **contained**: the agent has none of its built-in tools, only the MCP servers
   * this plugin declared in `permissions.mcpServers`, and only the tools in `tools.allow`. This is
   * the one definition of contained (`isContainedRequest`): `tools.builtins === "none"`. The fields
   * `mcpServers`, `secret`, `headless: true`, `budget` and a non-empty `tools.allow` belong to contained
   * sessions only; on any other session the request fails with error -32016 (containmentUnavailable).
   * A contained session the runner refuses fails with -32016 too, and when the cause is that the claude adapter is not
   * installed the error's `data` is a `ContainedSessionRefusal` (`{ reason: "adapter_missing", hint: "bridge agent install claude" }`);
   * any other refusal has no `data`.
   *
   * Other errors a start can fail with: -32012 the agent or model is not allowed, -32602 the request is
   * invalid (including a `cwd` on a contained session) or names a server or tool that is not declared and consented, -32019 no consent for this
   * plugin (install it again, or the grant was revoked), -32017 the session was killed for using a
   * tool outside its set (the call may already have run), -32018 the session budget was used up.
   *
   * The SDK runtime sends every field of this request (`tools`, `mcpServers`, `secret`, `model`, `budget`,
   * `headless`, besides `agent`, `cwd`, `onBehalfOf` and the call token) to the host, which passes it through
   * `validateStartAgentSessionParams`, then `containedRequestProblem` or `containedOnlyFieldsOf`, and refuses the
   * call on any problem. No field is dropped: a request the runner cannot honour fails, it does not start an
   * ordinary session with the agent's built-in tools.
   */
  tools?: {
    /** Exact `mcp__<server>__<tool>` names; must all be in the headless set the user approved at install. */
    allow?: string[];
    /** `"none"` makes the session contained. Default `"agent-default"`. */
    builtins?: "none" | "agent-default";
  };
  /** Names of this plugin's declared MCP servers to attach. Contained sessions only. */
  mcpServers?: string[];
  /**
   * A secret for the attached servers, at most 4 KiB of UTF-8. The runner writes it to a private file
   * whose path replaces `${SESSION_SECRET_FILE}` in a server's args; it never goes into an environment
   * variable, an argument, an event or a log. Contained sessions only.
   */
  secret?: string;
  /** An agent model name. The runner's local policy decides whether it is allowed (`models` allow-list; -32012 when not). */
  model?: string;
  /**
   * Limits of the session, contained sessions only (any other session fails with -32016). The runner
   * applies defaults (15 minutes, 200 tool calls) and refuses values above its own maxima (1 hour,
   * 500 calls). The user may set lower ceilings (`sessionBudget` in the runner's policy files), which clamp
   * both the defaults and what the plugin asks for.
   */
  budget?: { wallClockMs?: number; maxToolCalls?: number };
  /**
   * Says no person is present. A label only: the audit trigger is `headless` unless a verified
   * `onBehalfOf` exists, whatever this says. Contained sessions only; `headless: true` together with
   * `onBehalfOf` is rejected (-32602). It grants nothing by itself: the approval set is always the
   * headless tools the user consented to at install.
   */
  headless?: boolean;
}

/** A session the runner started for the plugin. Permission mode is the runner's local policy, not the plugin's. */
export interface AgentSession {
  /**
   * The runner's id of this session: the one `bridge plugin audit <plugin>` prints as `session <id>`; use it to find
   * the session's audit records and runner log lines.
   */
  readonly sessionId: string;
  /** Sends a prompt and resolves with the agent's final text and stop reason. */
  prompt(text: string): Promise<{ stopReason: string; text: string }>;
  cancel(): Promise<void>;
  /** Ends the session and kills its agent process. Idempotent. */
  close(): Promise<void>;
  /**
   * Watches what the session does: tool calls, text, plan and usage events, in order. `rawInput` and
   * `result` appear only on this plugin's own `mcp__` tools. Returns the unsubscribe. Optional until the
   * SDK runtime forwards events; absent reads as a session that emits nothing.
   */
  onUpdate?(handler: (event: SessionEvent) => void): () => void;
  /** Resolves once, when the session ends, with why. Optional until the SDK runtime provides it. */
  readonly ended?: Promise<{ reason: SessionEndReason }>;
  /**
   * Await before reusing the workspace or staged credentials. The current runtime always
   * supplies this promise; older embedders may omit it, which means cleanup is unverified.
   * Missing wire evidence or a host disconnect resolves incomplete, never quiescent.
   * close()/cancel()/ended alone do not establish quiescence or workflow success.
   */
  readonly quiescence?: Promise<SessionQuiescence>;
}

export type LogFn = (message: string, fields?: Record<string, unknown>) => void;

export interface PluginLogger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

/** A localhost HTTP server for the plugin's own UI. */
export interface LocalUiServer {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  close(): Promise<void>;
}

export interface PluginContext {
  /** The manifest id. */
  readonly pluginId: string;
  /** The plugin's own writable directory (`$PLUGIN_DATA`). The process's HOME and TMPDIR are inside it. */
  readonly dataDir: string;
  readonly log: PluginLogger;
  /**
   * Registers `_<pluginId>/<name>`. `name` must be the full method name and start
   * with the plugin's own prefix; anything else throws. Registering twice replaces.
   */
  registerMethod(name: string, handler: MethodHandler): void;
  /** Asks the runner for an agent session. Rejects if the manifest does not list `request.agent`. */
  startAgentSession(request: AgentSessionRequest): Promise<AgentSession>;
  readonly localUi: {
    /**
     * Binds 127.0.0.1 on a free port (`port: "auto"`; the manifest must declare
     * `localUi`) and tells the host the URL, which the runner relays to enrolled
     * browsers inside the E2EE channel. The content never touches the relay.
     */
    listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<LocalUiServer>;
  };
}

/** Called once at start-up. The process stays alive while handlers or servers are registered. */
export type PluginSetup = (context: PluginContext) => void | Promise<void>;
