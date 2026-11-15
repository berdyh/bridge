/**
 * Contracts of the runner's ACP proxy (the conductor). The runner is not a new
 * API: it terminates each browser's ACP connection, checks it, and forwards
 * sessions to an agent's ACP connection over stdio.
 *
 *   BrowserChannel ──► AcpProxy ──► AgentAdapter.spawn() ──► agent process (ACP over stdio)
 *                         │  _<pluginId>/...
 *                         └──► ExtensionRouter ──► plugin host
 *
 * These interfaces are message-level on purpose: they do not mention the ACP SDK,
 * so a thin JSON-RPC shim can stand in if the SDK's connection classes cannot take
 * an arbitrary stream. (They can: `Stream` in the SDK is a pair of Web streams of
 * JSON-RPC messages.)
 */
import path from "node:path";

import type {
  ConfinedBroker,
  ConfinedExecution,
  AgentAvailability,
  JsonRpcMessage,
  MessageStream,
  SessionEndReason,
  SessionEvent,
  Unsubscribe,
} from "@berdyh/bridge-protocol";

import {
  PLUGIN_LIMITS,
  isConfinedBroker,
  SESSION_SECRET_FILE_PLACEHOLDER,
  containedForbiddenFieldsOf,
  isContainedRequest,
  hasForeignPlaceholder,
  parseMcpToolName,
  quoteUntrusted,
  substituteArgPlaceholders,
} from "@berdyh/bridge-protocol";

import type { ConsentedGrant, GrantSurface } from "../plugins/contracts.js";

export type { JsonRpcMessage, MessageStream, SessionEndReason, SessionEvent, Unsubscribe };

/**
 * One enrolled browser's JSON-RPC stream, as the proxy sees it. In E2EE mode the
 * stream is the decrypted side of the secure layer, so every message on it
 * already belongs to the enrolled key `browserKeyId`.
 *
 * Invariants: ids are stable for the channel's life; `appId` is the id of the app
 * connection the channel arrived on and never changes; closing the channel (from
 * either end) must end its sessions and kill their agent processes.
 */
export interface BrowserChannel extends MessageStream<JsonRpcMessage> {
  /** Unique per channel on this runner. */
  readonly channelId: string;
  /** The app connection this channel belongs to (`BridgeDiscovery.app.id`). */
  readonly appId: string;
  /** The enrolled long-term key id, or the browser's chosen id in plaintext mode. */
  readonly browserKeyId: string;
}

export interface AgentExit {
  code: number | null;
  signal: string | null;
}

/** A running agent. `stream` is the agent's ACP connection over stdio. */
export interface AgentProcess {
  /** Messages written to the agent and read from it. Closes when the process exits. */
  readonly stream: MessageStream<JsonRpcMessage>;
  readonly pid?: number;
  readonly exited: Promise<AgentExit>;
  /** Terminates the process (SIGTERM, then SIGKILL after a grace period) and resolves after exit. Idempotent. */
  kill(): Promise<void>;
  /** Bounded process-tree evidence; ordinary process groups cannot prove all descendants gone. */
  cleanup?(): Promise<import("./cleanup.js").ProcessCleanupResult>;
  /**
   * Contained spawns only (`AgentSpawnOptions.containment` was set): the exact `session/new` params
   * besides `cwd`, with the secret file's path already substituted into `args`. The proxy sends
   * `session/new {cwd, ...sessionNew}` verbatim. Optional because a non-contained spawn has none;
   * a contained spawn that returns none is a `containmentUnavailable` failure in the proxy.
   */
  readonly sessionNew?: {
    /** ACP stdio servers. `env` is the empty tuple: a session's servers never get an env entry (the secret travels as a file). */
    mcpServers: { name: string; command: string; args: string[]; env: [] }[];
    /**
     * The profile's options. For claude: `{ claudeCode: { options: ClaudeContainmentOptions } }`
     * and nothing else, so `mcpServers` and `_meta` are all the profile needs; the type stays open for other adapters.
     */
    _meta?: Record<string, unknown>;
  };
}

/** One MCP server of a contained session, resolved by the plugin host. The plugin never supplies `command`. */
export interface ResolvedMcpServer {
  /** The declared server name. */
  name: string;
  secretTransport?: "fd3";
  /**
   * The runner's own Node binary (`process.execPath` of the runner), set by the host. It is free text in
   * the type, so the proxy must not trust it: `containedRequestProblem` refuses any other value before
   * the adapter turns it into a `session/new` command line.
   */
  command: string;
  /**
   * Absolute `entry` path first, then the manifest's args with `${PLUGIN_DATA}` resolved. The
   * `${SESSION_SECRET_FILE}` placeholder is still literal here: the adapter substitutes the secret
   * file's path. There is deliberately no `env` member: the secret is never in an env map.
   */
  args: string[];
}

/** What the proxy asks the adapter to apply to a contained session. */
export interface ContainmentRequest {
  /** Runner-resolved host service, private to the external broker sandbox. */
  hostBroker?: { socketPath: string; dataDir: string };
  execution?: ConfinedExecution;
  /** Broker transport enforces this separately, even when scripts call it directly. */
  maxToolCalls?: number;
  /** Runner-only trusted MCP dispatch accounting; never serialized or supplied by a plugin. */
  brokerTools?: { before(callId: string, toolName: string, args: unknown): Promise<boolean>; after(callId: string, toolName: string, failed: boolean): Promise<void> };
  /** The proxy-minted session id; names the secret directory `bridge-acp-secrets-<sessionId>`. */
  sessionId: string;
  servers: ResolvedMcpServer[];
  /** The exact approval set: `mcp__<server>__<tool>` names. Built from `sessionAllowSetOf(request)`, the one definition shared with `PermissionOrigin.allow`. */
  allow: string[];
  /** The session secret as bytes. The adapter writes it to a private file and zeroes this buffer. */
  secret?: Uint8Array;
  /** Requested model, already allowed by `LocalPolicy.allowContainedSession`. */
  model?: string;
}

/**
 * The claude stack the containment profile was measured on. This is the lowest supported stack, not the only one. A
 * contained claude session runs on an adapter and a `claude --version` at or above `adapter` and `binary`
 * (`CLAUDE_MIN_SUPPORTED` in `containment/claude.ts`), identified by version, not by the sha256 of one build; a newer
 * version is accepted and logged, an older one is `containmentUnavailable`. `sdk` and `platformPackage` are what was
 * measured, recorded and not checked. "Measured on", never "proven".
 */
export const MEASURED_CLAUDE_STACK = {
  /** `@agentclientprotocol/claude-agent-acp`, the version the CLI pins. */
  adapter: "0.94.0",
  /** `@anthropic-ai/claude-agent-sdk`, pinned by the adapter. */
  sdk: "0.3.303",
  /** `@anthropic-ai/claude-agent-sdk-linux-x64`, the package that ships the claude binary. */
  platformPackage: "0.3.303",
  /** `claude --version` of that binary (2.1.303 (Claude Code)). */
  binary: "2.1.303",
} as const;

/**
 * The 54 `BUILTIN_TOOL_NAMES` of the SDK's `sdk.mjs`, in the order the measurement recorded them, sent as
 * `disallowedTools`. The SDK says the list is not complete (the full list is only in `system/init`, which the
 * adapter does not forward over ACP) and `Task` is not on it, so the deny-list is a second layer: `tools: []`
 * is what removes the built-ins, and no measured run called a tool other than the declared server's.
 * `AskUserQuestion` is also added by the SDK, so it appears twice in the real argv.
 */
export const CLAUDE_BUILTIN_TOOL_NAMES: readonly string[] = [
  "Agent",
  "Artifact",
  "AskUserQuestion",
  "Bash",
  "ClaudeDesign",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EndConversation",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "ListAgents",
  "ListMcpResourcesTool",
  "LSP",
  "Monitor",
  "NotebookEdit",
  "OfferChromeSetup",
  "PowerShell",
  "Projects",
  "propose_skills",
  "ProposeGoal",
  "PushNotification",
  "Read",
  "ReadMcpResourceDirTool",
  "ReadMcpResourceTool",
  "ReadNotifications",
  "RemoteTrigger",
  "ReportFindings",
  "ScheduleWakeup",
  "SendFeedback",
  "SendMessage",
  "SendUserFile",
  "SendUserMessage",
  "ShareOnboardingGuide",
  "ShowOnboardingRolePicker",
  "Skill",
  "SubagentHandback",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "ToolSearch",
  "WaitForMcpServers",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
];

/**
 * `_meta.claudeCode.options` of the contained profile, exactly as measured on `MEASURED_CLAUDE_STACK`,
 * plus `model` when one is chosen. Logged in, it let the declared server's tools run, each
 * behind a permission request, and showed no built-in tool call, no planted CLAUDE.md canary, server, hook,
 * skill or command, and no `--allow-dangerously-skip-permissions`. `extraArgs.restricted: null` is a bare
 * `--restricted`; without it every contained MCP server inherits `CLAUDE_CODE_MESSAGING_SOCKET` and
 * `CLAUDE_CODE_MESSAGING_TOKEN`. `allowDangerouslySkipPermissions: false` is required: the adapter passes bypass
 * through for non-root users unless the client says `false`.
 *
 * `extraArgs["disable-slash-commands"]: null` (a bare `--disable-slash-commands`, right after
 * `--restricted`) is part of the profile and the argv must carry it exactly once. With the flag the CLI advertises
 * 2 commands (`mcp`, `remote-control`, both adapter-synthesized) instead of 51, which is what
 * lets `ContainmentProfile.commandsOutsideSet` detect a skill or command that should not be there. Contained 8 of 8,
 * the stub still starts. Not measured: whether a typed bundled command (`/init`) runs under this profile with the flag.
 */
export interface ClaudeContainmentOptions {
  tools: [];
  settingSources: [];
  strictMcpConfig: true;
  persistSession: false;
  allowDangerouslySkipPermissions: false;
  allowedTools: [];
  disallowedTools: string[];
  extraArgs: { restricted: null; "disable-slash-commands": null };
  model?: string;
}

/** The contained profile without a model. Build the real options as `{ ...CLAUDE_CONTAINMENT_OPTIONS, ...(model ? { model } : {}) }` with fresh arrays. */
export const CLAUDE_CONTAINMENT_OPTIONS: Readonly<ClaudeContainmentOptions> = {
  tools: [],
  settingSources: [],
  strictMcpConfig: true,
  persistSession: false,
  allowDangerouslySkipPermissions: false,
  allowedTools: [],
  disallowedTools: [...CLAUDE_BUILTIN_TOOL_NAMES],
  extraArgs: { restricted: null, "disable-slash-commands": null },
};

/**
 * What an adapter knows about running one agent contained. The claude profile's pins are `MEASURED_CLAUDE_STACK`.
 * The three version members are the versions the session runs on (at or above the measured ones), not the measured
 * ones. `checkNewSession` takes `unknown` and narrows the measured result itself; it tests the result only, and
 * `commandsOutsideSet` checks the command list (see each member).
 */
export interface ContainmentProfile {
  readonly id: string;
  /** The adapter package version the session runs on, at or above the measured one (claude: `0.94.0` measured, from the adapter's `package.json`). */
  readonly adapterVersion: string;
  /** The binary's `--version`, at or above the measured one (claude: `2.1.303` measured), resolved the way the adapter does and read at every contained spawn (the answer is cached per file identity). */
  readonly binaryVersion: string;
  /** The package that ships the binary (claude: `@anthropic-ai/claude-agent-sdk-linux-x64`, `0.3.303` measured). Recorded for the doctor and the log; not checked. */
  readonly platformPackageVersion: string;
  /**
   * Checks the `session/new` result. Throws `ContainmentRefused` when the session is not contained. The measured
   * claude result (default mode) has `modes.currentModeId` `"default"` with modes default, acceptEdits, plan
   * and auto, and `configOptions` mode, model, effort and fast. `configOptions.model` reads `"default"` whatever
   * model was requested, so the requested model cannot be checked here.
   *
   * This tests the result and nothing else. It refuses if ANY check
   * fails: `modes.currentModeId` is not `"default"`, OR any offered mode id is outside {default, acceptEdits, plan,
   * auto} (for example `bypassPermissions`), OR any `configOptions` id is outside {mode, model, effort, fast} (for example an
   * `agent` option). It does not look at commands: the list is never in the `session/new` result;
   * the adapter emits it as a `session/update` `available_commands_update` after setup and on every
   * `commands_changed`, so commands are checked by `commandsOutsideSet`.
   */
  checkNewSession(result: unknown): void;
  /**
   * The names in an `available_commands_update` outside the allow set {`mcp`, `remote-control`}, in the order
   * listed; `[]` when all are inside or the list is empty. Pure; no I/O. `update` is the `session/update` payload
   * (`availableCommands: [{ name, ... }]`). Entries carry no skill marker, so the check is by name. The two allowed
   * names are adapter-synthesized and are the only ones left when the profile passes `--disable-slash-commands`
   * (2 listed against 51 without the flag). A name like `mcp:foo` is outside (exact match). The proxy runs this on every
   * `available_commands_update` frame of a contained session in the same breach path as `toolOutsideSet` (kill,
   * `ended` `breach`, audited). Detection only: a session that never sends an update is not a failure.
   */
  commandsOutsideSet(update: { availableCommands?: ReadonlyArray<{ name: string }> }): string[];
  /**
   * True when the tool call is not in the session's exact `allow` set (a breach: `toolName` absent,
   * or any name not in `allow`, or a built-in `kind` with no name). Pure; no I/O. For claude `toolName`
   * is `_meta.claudeCode.toolName` of the `tool_call` frame: present on all 24 claude tool calls seen in
   * the measurement. A codex frame carries none, which is moot: codex has no profile.
   */
  toolOutsideSet(tool: { toolName?: string; kind?: string }, allow: ReadonlySet<string>): boolean;
}

/**
 * The closed set of causes of a refused contained session that may reach the caller (browser, plugin, and through
 * it the app). A reason is a fixed code, never text from the machine. The plugin SDK mirrors this set
 * (`ContainedSessionRefusal`).
 */
export type ContainmentRefusalReason = "adapter_missing" | "sandbox_unavailable" | "execution_unsupported" | "login_busy";

/** The fixed install hint per reason: the command the user runs on this machine. The CLI's `INSTALL_ADAPTER_COMMAND` is the same string (a test keeps them equal). */
export const CONTAINMENT_REFUSAL_HINT: Readonly<Record<ContainmentRefusalReason, string>> = {
  adapter_missing: "bridge agent install claude",
  login_busy: "Wait for the active agent session to finish; run bridge doctor --paths",
  sandbox_unavailable: "Install bubblewrap, socat, ripgrep and util-linux; enable unprivileged user namespaces; run bridge doctor --containment",
  execution_unsupported: "confined-v1 requires Linux x64 and the bundled Claude adapter",
};

/** The `data` of a -32016 error: a reason from the closed set and its fixed hint. */
export interface ContainmentRefusalData {
  reason: ContainmentRefusalReason;
  hint: string;
}

/** The `data` for a reason. */
export function containmentRefusalDataOf(reason: ContainmentRefusalReason): ContainmentRefusalData {
  return { reason, hint: CONTAINMENT_REFUSAL_HINT[reason] };
}

/** True for exactly the `data` `containmentRefusalDataOf` makes: a known reason, its own hint, no other key. */
export function isContainmentRefusalData(value: unknown): value is ContainmentRefusalData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const { reason, hint } = value as { reason?: unknown; hint?: unknown };
  return keys.length === 2 && typeof reason === "string" && Object.hasOwn(CONTAINMENT_REFUSAL_HINT, reason) && hint === CONTAINMENT_REFUSAL_HINT[reason as ContainmentRefusalReason];
}

/**
 * Thrown by a profile or an adapter when a contained session cannot be started safely. The proxy
 * returns `PROXY_ERROR.containmentUnavailable` with the generic `message`; `detail` (an exit code, a
 * stderr line, a path) is for the local log only and never reaches a browser or a plugin. The optional `reason`
 * is different: a fixed code from `ContainmentRefusalReason`, not text from the machine, so the proxy returns it
 * (with its fixed hint) as the error's `data`. Every refusal without a reason carries no `data`.
 */
export class ContainmentRefused extends Error {
  readonly code = PROXY_ERROR.containmentUnavailable;
  readonly detail: string;
  readonly reason: ContainmentRefusalReason | undefined;
  constructor(detail: string, reason?: ContainmentRefusalReason) {
    super("Contained session unavailable");
    this.name = "ContainmentRefused";
    this.detail = detail;
    this.reason = reason;
  }
}

export interface AgentSpawnOptions {
  /** Working directory of the session. Already vetted by `LocalPolicy.allowSession`. */
  cwd: string;
  signal?: AbortSignal;
  /**
   * The app this session belongs to (the proxy passes its own `appId`). An adapter uses it for
   * per-app state such as the session sandbox's parent folder. Optional so existing fixtures
   * compile.
   */
  appId?: string;
  /**
   * Contained sessions only: the proxy mints the session id, sets `cwd = <sessionsDir>/<id>` and
   * passes this. The adapter creates the empty cwd, writes the secret file, and returns
   * `AgentProcess.sessionNew`. Absent means a non-contained session. A contained spawn for an adapter
   * without a profile throws `ContainmentRefused` before any process starts.
   */
  containment?: ContainmentRequest;
}

/**
 * A backend the proxy can drive: claude, codex, or any ACP agent. The adapter owns
 * discovery, credential staging and the env sandbox (`../sandbox`), so the proxy
 * never sees a secret.
 */
export interface AgentAdapter {
  /** Protocol agent id, as in `AgentAvailability.id` ("claude", "codex"). */
  readonly id: string;
  availability(): Promise<AgentAvailability>;
  /** Spawns the agent and returns once its stdio is connected. Rejects if it is not installed or signed in. */
  spawn(options: AgentSpawnOptions): Promise<AgentProcess>;
  /**
   * The containment profile for the adapter and binary in use, or undefined when this agent cannot
   * run contained (codex; claude with another adapter or binary version). Absent member and
   * `undefined` read the same: a contained request is refused with `containmentUnavailable`.
   */
  containment?(): ContainmentProfile | undefined;
  execution?(): ContainmentProfile | undefined;
  /**
   * Why `containment()` is `undefined`, when the cause has a fixed reason code (claude: the adapter is not
   * installed). `undefined` for any other cause; the proxy then returns the generic error with no `data`.
   */
  containmentRefusalReason?(): ContainmentRefusalReason | undefined;
}

/** Who is behind a permission request. */
export type PermissionOrigin =
  /** A browser's own session (`session/new` on its channel). */
  | { kind: "browser"; channelId: string; browserKeyId: string }
  /** An agent session a plugin started through the `AgentSessionBroker`. */
  | {
      kind: "plugin";
      pluginId: string;
      onBehalfOf?: { browserKeyId: string };
      /** The session is contained (`isContainedRequest`). Absent reads as not contained: no automatic approval. */
      contained?: boolean;
      /** Runner-verified OS sandbox profile with explicit install-time script consent. */
      execution?: "confined-v1";
      /** The audit trigger is `headless`: no verified `onBehalfOf` (`AuditTrigger`). Not the plugin's own flag. Absent reads as false. */
      headless?: boolean;
      /** Tool calls left in the session's budget when this request was made. Absent: unknown. */
      callsLeft?: number;
      /**
       * The session's exact approval set (`mcp__<server>__<tool>`), the same value as `ContainmentRequest.allow`:
       * runner state set by the proxy (`sessionAllowSetOf`), never read from a frame or the plugin. Absent reads
       * as empty: no automatic approval. Always within the consented headless set and the attached servers,
       * because `containedRequestProblem` refuses the start otherwise.
       */
      allow?: readonly string[];
    };

/**
 * What the agent asks to be approved (`session/request_permission`), with enough of
 * the tool call to enforce a local allowlist. The adapter fills the tool fields from
 * the ACP `ToolCallUpdate` of the request and from agent-specific `_meta`; the
 * proxy never trusts a browser or a plugin for any of it.
 */
export interface PermissionRequestInfo {
  appId: string;
  agentId: string;
  sessionId: string;
  /** Working directory of the session. */
  cwd: string;
  origin: PermissionOrigin;
  /** ACP `ToolCallUpdate.toolCallId`. */
  toolCallId: string;
  /**
   * The tool's name as the agent calls it ("Bash", "Edit", "mcp__server__tool"), when
   * the adapter can tell: ACP has no standard field, so adapters read it from the
   * agent's `_meta` (for claude, `_meta.claudeCode.toolName`). Absent when unknown;
   * then NO allowlist entry matches (see `LocalPolicy.allowedTools`).
   */
  toolName?: string;
  /** Short human title of the tool call, if the agent gave one. Display only; never match on it. */
  title?: string;
  /** ACP tool kind (read, edit, execute, ...), if given. */
  toolKind?: string;
  /** The tool's raw input (a command line, a file path, ...), if given. Untrusted JSON. */
  rawInput?: unknown;
  /** Files the tool call touches, if the agent listed them (ACP `locations`). */
  locations?: { path: string; line?: number }[];
  /** The options the agent offered, with their ACP kinds (allow_once, reject_once, ...). */
  options: { optionId: string; name: string; kind: string }[];
}

export type PolicyDecision =
  /** Do not decide locally: forward the request to the browser and relay its answer. For a brokered session see `AgentSessionBrokerRequest`. */
  | { action: "ask" }
  /** Answer with this option without asking the browser. */
  | { action: "select"; optionId: string }
  /** Cancel the request. */
  | { action: "cancel" };

export type PermissionMode = "ask" | "read-only" | "accept-edits" | "bypass";

/** A whole session budget: both fields present, positive integers. */
export interface SessionBudget {
  readonly wallClockMs: number;
  readonly maxToolCalls: number;
}

/**
 * The `sessionBudget` key of `policy.json` and of an app `config.json` `policy` block. Each field is optional: an absent field does not narrow.
 */
export type SessionBudgetCeiling = Partial<SessionBudget>;

/**
 * The runner's own ceiling, the widest budget any policy can grant (1 hour, 500 tool calls). Built from
 * `PLUGIN_LIMITS`, the same numbers `validateStartAgentSessionParams` caps a request at, so there is one
 * source of the number.
 */
export const SESSION_BUDGET_CEILING: SessionBudget = Object.freeze({
  wallClockMs: PLUGIN_LIMITS.maxWallClockMs,
  maxToolCalls: PLUGIN_LIMITS.maxToolCalls,
});

/**
 * Per-field `min(outer, inner)`; an absent `inner` field keeps `outer`. It never widens, whatever `inner`
 * says, so a ceiling that skipped `validateSessionBudgetCeiling` still cannot raise the budget (an inner
 * value that is not a positive integer is ignored, as if absent). The rule
 * for one app: `verdict.budget = narrowSessionBudget(narrowSessionBudget(SESSION_BUDGET_CEILING,
 * policy.json sessionBudget), config.json policy.sessionBudget)` (a policy ceiling only narrows the runner
 * ceiling, an app ceiling only narrows the policy's).
 */
export function narrowSessionBudget(outer: SessionBudget, inner?: SessionBudgetCeiling): SessionBudget {
  const pick = (o: number, i: number | undefined): number => (typeof i === "number" && Number.isInteger(i) && i >= 1 && i < o ? i : o);
  return { wallClockMs: pick(outer.wallClockMs, inner?.wallClockMs), maxToolCalls: pick(outer.maxToolCalls, inner?.maxToolCalls) };
}

/**
 * Shape and range of a `sessionBudget` value, for the loaders of `policy.json` and an app `config.json`:
 * an object with at most the keys `wallClockMs` and `maxToolCalls`, each optional and an integer
 * `1..SESSION_BUDGET_CEILING.<field>`. One single-line message per fault, prefixed with `where` (the file
 * key); an empty list means valid. A value above the ceiling is a fault here and is clamped anyway by
 * `narrowSessionBudget`.
 */
export function validateSessionBudgetCeiling(value: unknown, where: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${where} must be an object {wallClockMs?, maxToolCalls?}`];
  }
  const errors: string[] = [];
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "wallClockMs" && key !== "maxToolCalls") errors.push(`${where} has an unknown key ${quoteUntrusted(key)}`);
  }
  for (const field of ["wallClockMs", "maxToolCalls"] as const) {
    const v = record[field];
    if (v === undefined) continue;
    const max = SESSION_BUDGET_CEILING[field];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) {
      errors.push(`${where}.${field} must be an integer 1..${max} (at most ${max}), got ${quoteUntrusted(v)}`);
    }
  }
  return errors;
}

/**
 * The answer of `LocalPolicy.allowContainedSession`. A refusal carries a `reason` for the local log only;
 * it never goes on the wire. An admission carries the app's budget ceiling, already narrowed and whole
 * (never a `Partial`), so the proxy cannot admit a session without getting the ceiling with it.
 */
export type ContainedSessionVerdict =
  | { allowed: false; reason?: string }
  | { allowed: true; budget: SessionBudget };

/**
 * Permission policy. It comes from the runner's **local** config only and is never
 * settable from a browser: the proxy rejects `session/set_mode`-style requests that
 * would change the permission mode or enable bypass with `PROXY_ERROR.permissionModeForbidden`.
 * Bypass defaults off.
 */
export interface LocalPolicy {
  readonly mode: PermissionMode;
  /**
   * Tool names (`PermissionRequestInfo.toolName`) this runner approves without
   * asking, from local config only. Exact match, case-sensitive; a request without a
   * `toolName` never matches, so it falls through to `ask` (or the mode's rule),
   * never to an automatic allow. It selects an `allow_once` option, never
   * `allow_always`.
   */
  readonly allowedTools?: readonly string[];
  /**
   * Whether a session for this agent and directory may start. `model` is set only for a non-contained
   * plugin session that named one (a plugin-named model is applied only through the `models`
   * allow-list, in contained and non-contained sessions alike); an implementation that has a configured
   * list refuses a model outside it. Absent for browser sessions. A policy that ignores the field
   * would let any model through.
   */
  allowSession(request: { appId: string; agentId: string; cwd: string; model?: string }): boolean | Promise<boolean>;
  /**
   * Whether a contained plugin session may start. There is no `cwd` input (the runner chooses it) and
   * the machine `allowedTools` and `mode` are not inputs either: the approval set is the consented
   * headless set. Decides on the machine and app `agents` lists and, when given, the `models` allow-list
   * (a refusal is `sessionNotAllowed`, not a containment failure). An absent `model` while a `models`
   * list is configured is refused too, unless the app's `agent.model` supplies one (which is then checked
   * like a named one): the runner cannot name the agent's own default, so it cannot vouch for it.
   * `allowSession` stays for every other session. Optional; absent reads as a refusal (`containmentUnavailable`).
   *
   * The verdict carries the app's budget ceiling: `budget =
   * narrowSessionBudget(narrowSessionBudget(SESSION_BUDGET_CEILING, policy.json sessionBudget), config.json
   * policy.sessionBudget)`. The policy ceiling may only narrow the runner ceiling (1 h / 500 calls) and an
   * app `config.json` may only narrow the policy ceiling. A refusal's `reason` is
   * logged locally and never sent.
   */
  allowContainedSession?(request: { appId: string; agentId: string; model?: string }): ContainedSessionVerdict | Promise<ContainedSessionVerdict>;
  /** Called for every permission request before it goes to the browser. */
  decidePermission(request: PermissionRequestInfo): PolicyDecision | Promise<PolicyDecision>;
}

/** Who is making an extension call. */
export interface ExtensionCaller {
  appId: string;
  channelId: string;
  browserKeyId: string;
}

/**
 * Routes ACP extension methods `_<pluginId>/<name>` to plugins (implemented by the
 * plugin host). A plugin belongs to one app: calls from another app's channel
 * are refused with `PROXY_ERROR.extensionForbidden`, an unknown plugin with
 * `PROXY_ERROR.extensionNotFound`. Both are thrown as errors from `request`.
 */
export interface ExtensionRouter {
  /** True when `method` is an extension method this router owns (a known `_<id>/` prefix). */
  handles(method: string): boolean;
  /** Calls the plugin and resolves with its result, or rejects with a JSON-RPC style error `{code, message}`. */
  request(caller: ExtensionCaller, method: string, params: unknown): Promise<unknown>;
  /** Delivers a notification to the plugin; never throws. */
  notify(caller: ExtensionCaller, method: string, params: unknown): void;
  /**
   * Registers a sink for messages that plugins push to this channel: their own
   * notifications and the `_bridge/localUi` notification. Returns the unsubscribe.
   */
  subscribe(caller: ExtensionCaller, push: (message: JsonRpcMessage) => void): Unsubscribe;
}

/**
 * JSON-RPC error codes the proxy returns to browsers and plugins (server error range). When each of
 * the plugin-session codes is returned:
 *
 *  - `sessionNotAllowed` (-32012): `allowContainedSession` refuses (agent not in the narrowed
 *    `agents`, model not in `models`), or the manifest does not list the agent (`restrictBroker`).
 *  - `invalidParams` (-32602, JSON-RPC): the params fail `validateStartAgentSessionParams` (this includes a
 *    `cwd` on a contained request, which `containedRequestProblem` also refuses); `headless: true`
 *    together with `onBehalfOf`; a secret placeholder without a secret or the reverse; an attached server
 *    that is not declared or whose command line differs from the consented one; a grant of another
 *    plugin or app, or whose hash does not match its surface; `tools.allow` outside the consented set or the attached servers.
 *  - `containmentUnavailable` (-32016): a contained-only field on a non-contained request
 *    (`containedOnlyFieldsOf`); no profile for the agent or its versions (codex; claude with another
 *    adapter or binary version); no `allowContainedSession` on the policy; any failure between spawn and
 *    the end of `checkNewSession`. The detail is logged locally, never returned. The one exception: when the
 *    claude adapter is not installed the error carries `data: { reason: "adapter_missing", hint }`
 *    (`ContainmentRefusalData`); no other refusal has `data`.
 *  - `containmentBreach` (-32017): a session killed after start because a frame showed a tool outside
 *    the set, or because an audit write failed. The call may already have run.
 *  - `budgetExceeded` (-32018): `maxToolCalls` reached or `wallClockMs` elapsed; the session ends with
 *    reason `budget`.
 *  - `consentMissing` (-32019): no consent record, a record behind a link, a record whose hash differs
 *    from the installed manifest, a revoked grant, or a contained request without `grant`.
 */
export const PROXY_ERROR = {
  permissionModeForbidden: -32010,
  unknownAgent: -32011,
  sessionNotAllowed: -32012,
  extensionNotFound: -32013,
  extensionForbidden: -32014,
  unknownSession: -32015,
  containmentUnavailable: -32016,
  containmentBreach: -32017,
  budgetExceeded: -32018,
  consentMissing: -32019,
} as const;

/** An agent session started on behalf of a plugin (see `AgentSessionBroker`). */
export interface BrokeredSession {
  /**
   * The runner's session id: the plugin receives it unchanged as the `sessionId` of `host/startAgentSession`,
   * `host/sessionUpdate` and `host/sessionEnded`; it is the `sessionId` of every `AuditRecord` of the session, the
   * `sessionId` field of the runner log, and the name of the session folder `<sessionsDir>/<id>`. Unique per
   * session, never reused.
   */
  readonly sessionId: string;
  prompt(text: string): Promise<{ stopReason: string; text: string }>;
  cancel(): Promise<void>;
  /**
   * Ends the session. `plugin_gone` is for the plugin host to say when the plugin's process went away (a crash or a
   * stop): `ended` then resolves with that reason. Without a reason it is a plain close (`closed`, or `cancelled`
   * after a `cancel()` that no prompt followed).
   */
  close(reason?: "plugin_gone"): Promise<void>;
  /**
   * Subscribes to the session's events; returns the unsubscribe. Raw tool input and results
   * appear only on the plugin's own `mcp__` tools. Optional;
   * absent reads as a session that emits nothing.
   */
  onUpdate?(handler: (event: SessionEvent) => void): Unsubscribe;
  /**
   * Resolves once, when the session ends, with why. Optional;
   * absent reads as a session that ends only through `close()` or `plugin_gone`.
   */
  readonly ended?: Promise<{ reason: SessionEndReason }>;
  /** Process descendants gone and broker capability/resources closed, or explicit incomplete evidence. */
  readonly quiescence?: Promise<import("@berdyh/bridge-protocol").SessionQuiescence>;
}

/**
 * What `AgentSessionBroker.start` is given. The request holds the same facts in several fields
 * (`mcpServers`, `servers`, `tools.allow`, `secret`, `grant`), and the source of truth is `grant`: the
 * user's consent. The proxy trusts nothing else and must call `containedRequestProblem` before it
 * spawns anything; the plugin host builds a request that passes it, and a fake in a test does too.
 */
export interface AgentSessionBrokerRequest {
  broker?: ConfinedBroker;
  execution?: ConfinedExecution;
  pluginId: string;
  appId: string;
  agent: string;
  /**
   * The folder of a non-contained session. A contained request carries none: the proxy runs the
   * agent in `<sessionsDir>/<session id>`, an empty folder it makes itself, and `containedRequestProblem`
   * refuses a request that names a cwd rather than ignoring it.
   */
  cwd?: string;
  /**
   * The browser whose extension call led to this request (the `caller` of the
   * `plugin/call` being served), when there is one. It is the only place an
   * `ask` permission decision can go; see `AgentSessionBroker`.
   */
  onBehalfOf?: { browserKeyId: string };
  /** Declared MCP server names to attach, after host validation. Contained sessions only (`isContainedRequest`). */
  mcpServers?: string[];
  /**
   * The same servers resolved by the host from the manifest and the installed version dir (absolute
   * `entry`, `${PLUGIN_DATA}` substituted), one per name in `mcpServers`. The plugin never supplies
   * a command. The proxy passes them on as `ContainmentRequest.servers`.
   */
  servers?: ResolvedMcpServer[];
  tools?: { allow?: string[]; builtins?: "none" | "agent-default" };
  /**
   * The session secret, at most 4 KiB. A string from the wire; the proxy converts it to bytes for
   * `ContainmentRequest.secret`. Never logged, never in an event.
   */
  secret?: string | Uint8Array;
  model?: string;
  /**
   * Contained sessions only (`containedOnlyFieldsOf`): the proxy counts and times only contained sessions,
   * so a budget on any other request is refused with `containmentUnavailable`. Per field, the effective
   * budget is `min(this request's value, or the proxy's default of 15 minutes / 200 calls when the request names
   * none, verdict.budget)`, where `verdict` is `LocalPolicy.allowContainedSession`'s admission: the app's
   * ceiling, which a policy.json `sessionBudget` and an app config.json `policy.sessionBudget` may only
   * narrow below the runner's 1 hour / 500 calls (`SESSION_BUDGET_CEILING`). The request validator does not
   * see the ceiling: an over-ceiling request is valid on the wire and clamped at start, never rejected.
   * The session ends with `budget` / `budgetExceeded` against the effective values.
   */
  budget?: { wallClockMs?: number; maxToolCalls?: number };
  /** The plugin's label (`StartAgentSessionParams.headless`). The audit trigger does not read it: see `AuditTrigger`. */
  headless?: boolean;
  /**
   * What the user consented to at install (from the consent store, read at each start). Optional until
   * The plugin host sets it and the proxy reads it; a contained request without it is refused with
   * `consentMissing`.
   */
  grant?: ConsentedGrant;
}

/**
 * How plugins reach agents: through the proxy, under the same local policy and
 * sandbox, never directly. Implemented by the proxy, consumed by the plugin
 * host, which checks the manifest's `permissions.agents` first.
 *
 * Permission requests of a brokered session. A plugin session has no browser
 * channel of its own, and the plugin must never approve its own agent's tool use.
 * So `session/request_permission` for it is decided in this order:
 *  1. `LocalPolicy.decidePermission` with `origin.kind = "plugin"`;
 *  2. on `ask`: if `onBehalfOf` names a browser whose channel is attached to this
 *     proxy and open, the request is forwarded to that channel as
 *     `session/request_permission` (carrying the brokered `sessionId`), and its
 *     answer is returned to the agent;
 *  3. otherwise (no `onBehalfOf`, the channel is gone, or the browser does not
 *     answer before the channel closes) the request is answered `cancel`.
 * Nothing is ever sent to the plugin process, and a session never outlives the
 * channel it asks through for the purpose of approvals.
 */
export interface AgentSessionBroker {
  start(request: AgentSessionBrokerRequest): Promise<BrokeredSession>;
}

export interface AcpProxyOptions {
  /** The app connection this proxy serves. Sessions of other app connections are invisible to it. */
  appId: string;
  adapters: readonly AgentAdapter[];
  policy: LocalPolicy;
  /** Absent means every `_`-prefixed method fails with `extensionNotFound`. */
  extensions?: ExtensionRouter;
  /** Used when `session/new` gives no usable cwd. */
  defaultCwd: string;
  log?: (level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Behaviour:
 *  - one ACP agent-side connection per attached channel;
 *  - `session/new` picks the adapter (the `_meta.agent` hint or the first available);
 *  - prompts and updates are forwarded both ways; `session/request_permission` goes
 *    to the browser unless `LocalPolicy` answers first;
 *  - requests to change the permission mode or enable bypass are rejected;
 *  - `session/cancel` is forwarded; a closed channel kills its agents;
 *  - `_<pluginId>/...` goes to the `ExtensionRouter`.
 */
export interface AcpProxy {
  readonly appId: string;
  /** Starts serving a channel. Throws if `channel.appId !== this.appId`. */
  attach(channel: BrowserChannel): void;
  readonly broker: AgentSessionBroker;
  sessionCount(): number;
  /** Closes every channel and kills every agent. */
  close(): Promise<void>;
}

/**
 * Who started the session whose tool call is audited. `headless` unless a verified `onBehalfOf` exists:
 * the plugin's `headless` flag is not an input, so a plugin cannot relabel a browser-triggered session
 * as headless or the reverse by setting it. The `browser` kind is only as good as the host's check of
 * `onBehalfOf`: one plugin process sees every call token, so the host cannot bind the claim to the
 * call actually being served (`process.ts`, the `startAgentSession` handler), and a plugin can name
 * another browser that has a live call. The audit records what the plugin asserted about the browser.
 */
export type AuditTrigger = { kind: "headless" } | { kind: "browser"; browserKeyId: string };

/**
 * One tool call of a contained session, written from `tool_call` / `tool_call_update` frames with the
 * permission decision joined by `(sessionId, toolCallId)`. No raw arguments and no secret: only a digest and a size.
 */
export interface AuditRecord {
  /** ISO 8601, UTC. */
  time: string;
  /** Absent only on a decision record written before any frame of its session (the session's context is not known yet). */
  appId?: string;
  pluginId: string;
  sessionId: string;
  /** Absent with `appId`: a trigger that is not known is not guessed. */
  trigger?: AuditTrigger;
  /** The attached server names. Absent with `appId`. */
  servers?: string[];
  toolCallId: string;
  toolName?: string;
  /** The frame's status (pending, in_progress, completed, failed). */
  status?: string;
  /** What happened to the permission request; `"none"` means no request was made (the call was not prompted). */
  decision?: "allow" | "reject" | "cancel" | "none";
  /** Hex SHA-256 of the raw input's JSON text. */
  argsSha256?: string;
  argsBytes?: number;
}

/**
 * Where audit records go (the proxy calls it for every tool call). A throw or a
 * rejection from `append` ends the session with `containmentBreach`: an unaudited call is a breach.
 */
export interface AuditSink {
  append(record: AuditRecord): void | Promise<void>;
}

/** What `AuditLog.recordFrame` needs to know about the session a frame belongs to. */
export interface AuditFrameContext {
  appId: string;
  pluginId: string;
  sessionId: string;
  trigger: AuditTrigger;
  /** The attached server names. */
  servers: string[];
}

/**
 * The audit log of one plugin. One log serves every session of that plugin,
 * so decisions and pending state are keyed by session: a call id is unique within a session only (two
 * sessions of one plugin may both have a `tc1`). A tool call is recorded from its frames whether or not a
 * permission request came first: `recordDecision` joins the decision by `(sessionId, toolCallId)`, and a
 * call with none is recorded with `decision: "none"`. A write failure fails closed and is state of the log,
 * not of a session: the next decision of any session of that plugin is `cancel`, and the proxy ends the
 * session that hit it with `containmentBreach`.
 */
export interface AuditLog extends AuditSink {
  /** Records a `tool_call` frame or a terminal `tool_call_update` frame of a contained session. */
  recordFrame(frame: JsonRpcMessage, context: AuditFrameContext): void | Promise<void>;
  /** Remembers the decision made for a permission request, joined to the record of `(sessionId, toolCallId)`; a call id is unique within a session only. */
  recordDecision(sessionId: string, toolCallId: string, decision: "allow" | "reject" | "cancel"): void;
  /** Drops the pending join state of a session that ended; later frames of it are recorded with `decision: "none"`. */
  endSession(sessionId: string): void;
}

/**
 * The one definition of a session's approval set, for `ContainmentRequest.allow`, `ContainmentProfile.toolOutsideSet`
 * and `PermissionOrigin.allow`, so the three cannot drift apart. Call only after `containedRequestProblem` returned
 * undefined: only then is every entry a consented headless tool on an attached server. Empty for a request that is
 * not contained (an approval set exists only in contained sessions). Duplicates collapse.
 */
export function sessionAllowSetOf(request: AgentSessionBrokerRequest): ReadonlySet<string> {
  return new Set(isContainedRequest(request) ? (request.tools?.allow ?? []) : []);
}

/** Why `containedRequestProblem` refused a request: the proxy returns `code` with `message` (never the secret). */
export interface ContainedRequestProblem {
  /** `PROXY_ERROR.consentMissing` (no grant) or `-32602` (the fields disagree with the grant or with each other). */
  code: number;
  message: string;
}

const INVALID_PARAMS = -32602;

/** One `mcpServer` item of a grant, read back: the consented server, its package-relative entry and its argument templates. */
export interface GrantedMcpServer {
  secretTransport?: "fd3";
  name: string;
  /** Relative to the installed version dir, as the manifest wrote it. */
  entry: string;
  /** Templates: `${PLUGIN_DATA}` and `${SESSION_SECRET_FILE}` unresolved. */
  args: string[];
}

/**
 * Reads the `value` of an `mcpServer` grant item (JSON `{"name","entry","args"}`). Undefined when it is
 * unreadable or has another shape: an item the reader cannot understand grants nothing. `args` may be absent
 * (read as none); any other key makes the item unreadable.
 */
export function parseGrantedMcpServer(value: string): GrantedMcpServer | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const item = parsed as Record<string, unknown>;
  if (Object.keys(item).some((k) => k !== "name" && k !== "entry" && k !== "args" && k !== "secretTransport")) return undefined;
  const { name, entry, args = [] } = item;
  if (typeof name !== "string" || typeof entry !== "string") return undefined;
  if (!Array.isArray(args) || !args.every((a): a is string => typeof a === "string")) return undefined;
  if (item.secretTransport !== undefined && item.secretTransport !== "fd3") return undefined;
  return { name, entry, args, ...(item.secretTransport === "fd3" ? { secretTransport: "fd3" } : {}) };
}

/** Where a plugin version lives on this machine, and how the runner hashes a surface: what `containedRequestProblem` needs to bind a command line to the grant. */
export interface GrantResolution {
  /** Absolute. The installed version dir (`InstalledPlugin.installDir`); a server's `entry` is relative to it. */
  installDir: string;
  /** Absolute. The plugin's data dir (`InstalledPlugin.dataDir`): the value of `${PLUGIN_DATA}`. */
  dataDir: string;
  /**
   * SHA-256 (hex) of the canonical JSON of a surface: the consent module's `surfaceSha256Of`. Injected, not imported, so
   * this contract does not depend on the consent module; the caller must pass the real one.
   */
  surfaceSha256Of(surface: GrantSurface): string;
}

const countOf = (text: string, part: string): number => text.split(part).length - 1;

/**
 * The command line the runner starts for one consented server: its own Node (`runnerNode`) on the entry
 * resolved against the install dir, then the consented args with `${PLUGIN_DATA}` replaced by the data dir.
 * `${SESSION_SECRET_FILE}` stays in place: the adapter fills it. The ONE place the line is built, shared by
 * the plugin host (building `servers`) and by `containedRequestProblem` (checking them), so the two
 * cannot disagree. Pure. Undefined when it cannot be built safely: a relative `installDir` or `dataDir`, an
 * absolute entry, or an entry that leaves the install dir.
 */
export function resolveGrantedServer(server: GrantedMcpServer, runnerNode: string, resolution: Pick<GrantResolution, "installDir" | "dataDir">): ResolvedMcpServer | undefined {
  const { installDir, dataDir } = resolution;
  if (!path.isAbsolute(installDir) || !path.isAbsolute(dataDir) || path.isAbsolute(server.entry)) return undefined;
  const entry = path.resolve(installDir, server.entry);
  const inside = path.relative(path.resolve(installDir), entry);
  // Outside is a parent component (`..` alone or followed by a separator), never a child name that merely
  // begins with two dots (`..mcp.js` is a file inside the install dir).
  if (inside === "" || inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) return undefined;
  const args = server.args.map((a) => substituteArgPlaceholders(a, { secretFile: SESSION_SECRET_FILE_PLACEHOLDER, pluginData: dataDir }));
  return { name: server.name, command: runnerNode, args: [entry, ...args], ...(server.secretTransport ? { secretTransport: server.secretTransport } : {}) };
}

/**
 * The trust boundary between the plugin host and the proxy, written once: for a contained
 * request, whether everything the proxy would act on agrees with the consented `grant`. Returns the first
 * problem, or undefined. Pure. It checks that
 *  - a `grant` is present (else `consentMissing`);
 *  - no field the runner alone chooses is set (`containedForbiddenFieldsOf`: a `cwd`; the proxy makes the
 *    session folder itself, so a named one is refused, not ignored);
 *  - the grant is this plugin's and this app's (`grant.pluginId`, `grant.appId` equal the request's) and
 *    is whole: `resolution.surfaceSha256Of(grant.surface)` equals `grant.surfaceSha256`;
 *  - every attached server (`mcpServers`, no duplicates) is a `mcpServer` item of `grant.surface`, and
 *    `servers` has exactly one entry per name;
 *  - each of those command lines IS the consented one: `resolveGrantedServer` of the grant's item (the
 *    runner's own Node, on the entry inside the install dir, with the consented args), with no argument
 *    added, dropped or changed, so no plugin- or broker-supplied command line reaches the adapter;
 *  - every `tools.allow` entry is a `headlessTool` item of the grant on an attached server;
 *  - `secret` is at most 4096 bytes, and `${SESSION_SECRET_FILE}` appears in a server's args exactly when
 *    a secret was given, judged on the consented args (the template), not on the resolved line; a consented
 *    arg holds no other `${...}` placeholder, and a resolved path (install or data dir) is data: it may hold a
 *    `${`, but not the secret-file placeholder, which the adapter would fill in.
 * A request that is not contained is not this function's concern (`containedOnlyFieldsOf` handles it).
 */
export function containedRequestProblem(request: AgentSessionBrokerRequest, runnerNode: string, resolution: GrantResolution): ContainedRequestProblem | undefined {
  if (!isContainedRequest(request)) return undefined;
  const bad = (message: string): ContainedRequestProblem => ({ code: INVALID_PARAMS, message });
  const grant = request.grant;
  if (!grant) return { code: PROXY_ERROR.consentMissing, message: "No consent is recorded for this plugin's contained sessions" };
  const forbidden = containedForbiddenFieldsOf(request);
  if (forbidden.length > 0) return bad(`A contained request must not set ${forbidden.join(", ")}: the runner chooses it`);
  if (grant.pluginId !== request.pluginId || grant.appId !== request.appId) return bad("The consented grant belongs to another plugin or app");
  let surfaceSha256: string | undefined;
  try {
    surfaceSha256 = resolution.surfaceSha256Of(grant.surface);
  } catch {
    /* a surface that cannot be hashed is not vouched for */
  }
  if (surfaceSha256 === undefined || surfaceSha256 !== grant.surfaceSha256) return bad("The consented grant does not match its recorded hash");
  if (request.execution) {
    if (request.tools?.builtins === "none") return bad("execution and builtins none are separate profiles");
    const consented = grant.surface.items.filter((i) => i.kind === "execution");
    const wanted = JSON.stringify({ profile: request.execution.profile, network: [...request.execution.network].sort(), ...(request.execution.broker ? { broker: request.execution.broker } : {}) });
    if (consented.length !== 1 || consented[0]?.value !== wanted) return bad("Execution scope differs from the consented script/workspace/network profile");
  }
  if (request.broker) {
    if (!isConfinedBroker(request.broker) || request.execution?.broker !== "http-unix") return bad("Host broker transport is not consented");
    const socket = path.resolve(resolution.dataDir, request.broker.socket);
    const inside = path.relative(resolution.dataDir, socket);
    if (!inside || inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) return bad("Host broker socket leaves plugin data");
    const approved = grant.surface.items.some((item) => {
      if (item.kind !== "fs" || !(item.value === "$PLUGIN_DATA" || item.value.startsWith("$PLUGIN_DATA/"))) return false;
      const root = path.resolve(resolution.dataDir, item.value.slice("$PLUGIN_DATA".length).replace(/^\//, ""));
      const grantInside = path.relative(resolution.dataDir, root);
      if (grantInside === ".." || grantInside.startsWith(".." + path.sep) || path.isAbsolute(grantInside)) return false;
      const relative = path.relative(root, socket);
      return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
    });
    if (!approved) return bad("Host broker socket is outside consented $PLUGIN_DATA filesystem scope");
  }
  const granted = new Map<string, GrantedMcpServer | null>();
  const grantedTools = new Set<string>();
  for (const item of grant.surface.items) {
    if (item.kind === "headlessTool") grantedTools.add(item.value);
    else if (item.kind === "mcpServer") {
      const server = parseGrantedMcpServer(item.value);
      // An unreadable item grants nothing; two items of one name are ambiguous and grant nothing either.
      if (server) granted.set(server.name, granted.has(server.name) ? null : server);
    }
  }
  const names = request.mcpServers ?? [];
  if (new Set(names).size !== names.length) return bad("A server is attached twice");
  for (const name of names) if (!granted.get(name)) return bad(`Server ${quoteUntrusted(name)} is not in the consented grant`);
  const servers = request.servers ?? [];
  if (servers.length !== names.length || servers.some((srv, i) => srv.name !== names[i])) return bad("The resolved servers do not match the attached server names");
  let usesSecretFile = false;
  for (const srv of servers) {
    const item = granted.get(srv.name)!;
    if (srv.command !== runnerNode) return bad("A server must run the runner's own Node");
    if (srv.args.length === 0 || !path.isAbsolute(srv.args[0]!)) return bad("A server's first argument must be its absolute entry path");
    // Placeholders are judged on the consented template. The resolved args are data (a path may hold a `${`),
    // and are only compared with what the template resolves to.
    if (item.args.some(hasForeignPlaceholder)) return bad("A consented server's arguments hold a placeholder that is not allowed");
    const consented = resolveGrantedServer(item, runnerNode, resolution);
    if (!consented) return bad("A consented server's entry cannot be placed inside the installed plugin");
    if (srv.args.length !== consented.args.length || srv.args.some((arg, i) => arg !== consented.args[i])) return bad("A server's entry or arguments differ from the consented ones");
    if (srv.secretTransport !== item.secretTransport) return bad("Server secret transport differs from consent");
    if (request.execution && (item.args.some((a) => a.includes(SESSION_SECRET_FILE_PLACEHOLDER)) || item.secretTransport !== "fd3")) return bad("confined-v1 requires secretTransport fd3, never a secret file");
    const wanted = item.args.reduce((n, arg) => n + countOf(arg, SESSION_SECRET_FILE_PLACEHOLDER), 0);
    // A path that spells the placeholder would be filled with the secret file's path by the adapter.
    if (consented.args.reduce((n, arg) => n + countOf(arg, SESSION_SECRET_FILE_PLACEHOLDER), 0) !== wanted) return bad("A server's entry or data path holds a placeholder of its own");
    if (wanted > 0) usesSecretFile = true;
  }
  const attached = new Set(names);
  for (const tool of request.tools?.allow ?? []) {
    const parsed = parseMcpToolName(tool);
    if (!parsed || !attached.has(parsed.server)) return bad("An allowed tool is not on an attached server");
    if (!grantedTools.has(tool)) return bad("An allowed tool is not in the consented headless set");
  }
  const secret = request.secret;
  if (secret !== undefined) {
    const bytes = typeof secret === "string" ? Buffer.byteLength(secret, "utf8") : secret.byteLength;
    if (bytes > PLUGIN_LIMITS.maxSecretBytes) return bad(`The secret is over ${PLUGIN_LIMITS.maxSecretBytes} bytes`);
  }
  if (request.execution) return undefined;
  if (secret !== undefined && !usesSecretFile) return bad("A secret was given but no server reads ${SESSION_SECRET_FILE}");
  if (secret === undefined && usesSecretFile) return bad("A server reads ${SESSION_SECRET_FILE} but no secret was given");
  return undefined;
}

