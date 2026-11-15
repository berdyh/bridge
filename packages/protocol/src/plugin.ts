import { isInt, isNonEmpty, isObj, isStr, optional, type ValidationResult } from "./guards.js";

/**
 * The manifest of a local plugin (`bridge-plugin.json` in the package root). See the
 * plan's Plugins section. Network and extra fs permissions are declared and shown
 * to the user, but not yet enforced; the env/path sandbox is.
 */
export type PluginManifest = {
  /** Lowercase id, e.g. "app-a.mail-sync". It is the `_<id>/` method prefix. */
  id: string;
  /** Only this app's enrolled browsers may call the plugin. Matches `BridgeDiscovery.app.id`. */
  app: string;
  /** Path of the entry module inside the package, spawned as its own Node process. */
  entry: string;
  permissions: PluginPermissions;
};

export type PluginPermissions = {
  /** Host names the plugin will contact. */
  network?: string[];
  /** Paths the plugin may touch; "$PLUGIN_DATA" is its own data dir. Nothing declared means nothing else. */
  fs?: string[];
  /** Agent ids ("claude", "codex") it may request sessions for through the runner. */
  agents?: string[];
  /** Ask for a localhost UI. The runner hands the URL to the app inside the E2EE channel. */
  localUi?: { port: "auto" | number };
  /**
   * MCP servers the plugin ships, by name, for its contained agent sessions. The runner runs
   * its own Node on `entry` (inside the package); a manifest names no command, no env and no
   * cwd. A session attaches a server by its declared name only.
   */
  mcpServers?: Record<string, PluginMcpServer>;
  /** Explicit consent for scripts in a runner-owned workspace and exact HTTPS endpoints. */
  execution?: ConfinedExecution;
  /**
   * The tools a headless (unattended) contained session may call without asking anyone:
   * the consent surface approved at install. Every entry is `mcp__<declared server>__<tool>`.
   */
  headless?: { tools: string[] };
};

/** One MCP server a plugin ships. No `command`, no `env`: the runner always runs its own Node on `entry`. */
export type ConfinedExecution = { profile: "confined-v1"; network: string[]; broker?: "http-unix" };
export type ConfinedBroker = { transport: "http-unix"; socket: string };
export function isConfinedBroker(value: unknown): value is ConfinedBroker {
  return isObj(value) && Object.keys(value).every((key) => key === "transport" || key === "socket") && value.transport === "http-unix" && typeof value.socket === "string" && value.socket.length <= 512 && !CONTROL.test(value.socket) && safeRelPath(value.socket);
}

/** Only fully qualified public DNS names on HTTPS port 443; no wildcard, IP or localhost aliases. */
export function isConfinedEndpoint(value: unknown): value is string {
  return typeof value === "string" && value.length <= 253 && /^(?=.{1,247}:443$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}:443$/.test(value) && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|home|lan):443$/.test(value);
}

export function isConfinedExecution(value: unknown): value is ConfinedExecution {
  return isObj(value) && Object.keys(value).every((k) => k === "profile" || k === "network" || k === "broker") && value.profile === "confined-v1" && (value.broker === undefined || value.broker === "http-unix") && Array.isArray(value.network) && value.network.length <= 32 && value.network.every(isConfinedEndpoint) && new Set(value.network).size === value.network.length;
}

export type PluginMcpServer = {
  /** Path of the server module inside the package (checked to exist by the plugin host). */
  entry: string;
  /** New execution mode delivers the broker secret on descriptor 3, never a file. */
  secretTransport?: "fd3";
  /** Printable arguments; the only placeholders are `${SESSION_SECRET_FILE}` and `${PLUGIN_DATA}`. */
  args?: string[];
};

export const PLUGIN_MANIFEST_FILE = "bridge-plugin.json";
export const PLUGIN_DATA_VAR = "$PLUGIN_DATA";

const ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const HOST = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

/** Same charset as the CLI's app ids, which become file names and keychain keys. */
const APP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** An MCP server's declared name. No `_`, so `mcp__<name>__<tool>` parses one way. */
const MCP_SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** The tool part of `mcp__<server>__<tool>`. */
const MCP_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MCP_TOOL_FULL = /^mcp__([a-z][a-z0-9-]{0,31})__([A-Za-z0-9_-]{1,64})$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A UTF-16 string with an unpaired surrogate (not valid UTF-8 once encoded). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The only placeholders an MCP server argument may use. Substituted by the runner, never by the plugin. */
export const SESSION_SECRET_FILE_PLACEHOLDER = "${SESSION_SECRET_FILE}";
export const PLUGIN_DATA_PLACEHOLDER = "${PLUGIN_DATA}";

/** Limits of the manifest's MCP surface and of a session request. */
export const PLUGIN_LIMITS = {
  maxMcpServers: 16,
  maxServerArgs: 32,
  maxArgLength: 512,
  maxEntryLength: 512,
  maxHeadlessTools: 256,
  maxSessionMcpServers: 16,
  maxAllowTools: 256,
  /** The session secret, in UTF-8 bytes. */
  maxSecretBytes: 4096,
  maxModelLength: 128,
  /** `cwd`, `callToken` and the two `onBehalfOf` ids, in UTF-16 code units. */
  maxCwdLength: 4096,
  maxCallTokenLength: 128,
  maxCallerIdLength: 256,
  /**
   * The runner's hard ceiling on one session's budget, chosen to be what a person would approve for an
   * unattended session (1 hour, 500 tool calls). The consented grant carries no budget, so these
   * constants are the whole bound until a user-set ceiling exists. The
   * effective budget is the request clamped to them, else the defaults (15 minutes, 200 calls).
   */
  maxWallClockMs: 3_600_000,
  maxToolCalls: 500,
} as const;

/** `mcp__<server>__<tool>`, or undefined when `name` is not exactly that. The server has no `_`, so the first `__` splits it. */
export function parseMcpToolName(name: unknown): { server: string; tool: string } | undefined {
  if (!isStr(name)) return undefined;
  const m = MCP_TOOL_FULL.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : undefined;
}

const CONTROL_ALL = new RegExp(CONTROL.source, "g");

/**
 * Replaces every forbidden control character (`CONTROL`: C0, DEL, C1, U+2028, U+2029) in `text` with its
 * `\uXXXX` escape. `JSON.stringify` escapes only the C0 range, so a diagnostic that echoes a rejected value
 * goes through this too, or the message would carry the very characters the rule rejects.
 */
export function escapeControlChars(text: string): string {
  return text.replace(CONTROL_ALL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Quotes an untrusted value for a diagnostic: JSON text with every forbidden control character escaped
 * (`escapeControlChars`), so it is one printable line, then cut to at most 64 characters. The ONE formatter
 * for a rejected value, in the protocol validators and in the runner's (`validateSessionBudgetCeiling`,
 * `containedRequestProblem`).
 */
export function quoteUntrusted(v: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(v) ?? String(v);
  } catch {
    text = typeof v;
  }
  const chars = [...escapeControlChars(text)];
  return chars.length > 64 ? `${chars.slice(0, 64).join("")}...` : chars.join("");
}

/** Quotes an untrusted string for an error message: one line, escaped, at most 64 characters. Any other type is named, not echoed. */
function quote(v: unknown): string {
  return isStr(v) ? quoteUntrusted(v) : typeof v;
}

export function isPluginId(v: unknown): v is string {
  return isStr(v) && v.length <= 100 && ID.test(v);
}

const strList = (v: unknown, each: (s: string) => boolean): boolean =>
  Array.isArray(v) && v.every((s) => isStr(s) && each(s));

function safeRelPath(p: string): boolean {
  if (p.length === 0 || p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p) || p.includes("\0")) return false;
  return !p.split(/[\\/]/).includes("..");
}


const EXPECTED_ARG_PLACEHOLDERS = "only ${SESSION_SECRET_FILE} and ${PLUGIN_DATA} are allowed";

/**
 * The one pattern for the two placeholders. It has no `g` or `y` flag, so it keeps no `lastIndex`: `test`,
 * `exec` and `match` give the same answer on every call, for any consumer. Replacement goes through
 * a private global copy and classification through a private sticky one, both over the original string, so
 * the validator (here), the substituter and every other reader agree on what a placeholder is.
 */
export const ARG_PLACEHOLDER = /\$\{(?:SESSION_SECRET_FILE|PLUGIN_DATA)\}/;
const ARG_PLACEHOLDER_ALL = new RegExp(ARG_PLACEHOLDER.source, "g");
/** Private and sticky: matches only at `lastIndex`, which `hasForeignPlaceholder` sets before every test. */
const ARG_PLACEHOLDER_AT = new RegExp(ARG_PLACEHOLDER.source, "y");

/**
 * Replaces each exact placeholder in `arg` with its value in one pass. A value is inserted literally
 * and never rescanned, so a value that itself contains `${...}` is not substituted again.
 */
export function substituteArgPlaceholders(arg: string, values: { secretFile: string; pluginData: string }): string {
  return arg.replace(ARG_PLACEHOLDER_ALL, (m) => (m === SESSION_SECRET_FILE_PLACEHOLDER ? values.secretFile : values.pluginData));
}

/**
 * Whether a manifest `arg` (a template, never a substituted value) holds a `${` that is not one of the two
 * exact placeholders: any other, nested or broken placeholder. Every `${` is classified where it stands in
 * the original string: it is allowed only when an exact placeholder starts right there. Nothing is removed
 * or rewritten first, so literal characters around a placeholder (`$${PLUGIN_DATA}{`) can never join into a
 * `${` that the template does not hold.
 */
export function hasForeignPlaceholder(arg: string): boolean {
  for (let i = arg.indexOf("${"); i !== -1; i = arg.indexOf("${", i + 1)) {
    ARG_PLACEHOLDER_AT.lastIndex = i;
    if (!ARG_PLACEHOLDER_AT.test(arg)) return true;
  }
  return false;
}

/** An arg is a template: the placeholders are checked on the manifest string, never after any substitution. */
function argProblem(arg: unknown): string | undefined {
  if (!isStr(arg)) return "must be a string";
  if (arg.length > PLUGIN_LIMITS.maxArgLength) return `must be at most ${PLUGIN_LIMITS.maxArgLength} characters`;
  if (CONTROL.test(arg)) return "must be printable (no control characters)";
  if (hasForeignPlaceholder(arg)) return `uses a placeholder that is not allowed (${EXPECTED_ARG_PLACEHOLDERS})`;
  return undefined;
}

/** Validates `permissions.mcpServers`; returns the declared names: every key, broken or not (empty only when the value is not an object). */
function mcpServerErrors(v: unknown, errors: string[]): Set<string> {
  const declared = new Set<string>();
  if (v === undefined) return declared;
  if (!isObj(v)) {
    errors.push("permissions.mcpServers must be an object of server name to {entry, args?}");
    return declared;
  }
  const names = Object.keys(v);
  // Every key is a declared name, however broken: a headless tool that names it must not also be reported as
  // naming an "undeclared server". Whether the declaration is usable is reported once, below.
  for (const name of names) declared.add(name);
  if (names.length > PLUGIN_LIMITS.maxMcpServers) errors.push(`permissions.mcpServers may declare at most ${PLUGIN_LIMITS.maxMcpServers} servers`);
  for (const name of names) {
    const where = `permissions.mcpServers[${quote(name)}]`;
    if (!MCP_SERVER_NAME.test(name)) {
      errors.push(`${where}: server name must be lowercase letters, digits and '-', starting with a letter (max 32; no '_')`);
      continue;
    }
    const server = v[name];
    if (!isObj(server)) {
      errors.push(`${where} must be an object {entry, args?}`);
      continue;
    }
    for (const key of Object.keys(server)) {
      if (key !== "entry" && key !== "args" && key !== "secretTransport") {
        errors.push(`${where}: unknown key ${quote(key)}; the runner runs its own Node on 'entry', so a server has no command, env or cwd`);
      }
    }
    if (server.secretTransport !== undefined && server.secretTransport !== "fd3") errors.push(`${where}: secretTransport must be fd3`);
    const entry = server.entry;
    if (!isStr(entry) || entry.length > PLUGIN_LIMITS.maxEntryLength || CONTROL.test(entry) || !safeRelPath(entry)) {
      errors.push(`${where}: entry must be a printable relative path inside the package (max ${PLUGIN_LIMITS.maxEntryLength})`);
    }
    const args = server.args;
    if (args !== undefined) {
      if (!Array.isArray(args)) {
        errors.push(`${where}: args must be a list of strings`);
      } else {
        if (args.length > PLUGIN_LIMITS.maxServerArgs) {
          errors.push(`${where}: args may have at most ${PLUGIN_LIMITS.maxServerArgs} entries`);
        }
        for (const [i, arg] of args.slice(0, PLUGIN_LIMITS.maxServerArgs).entries()) {
          const problem = argProblem(arg);
          if (problem) {
            errors.push(`${where}: args[${i}] ${problem}${isStr(arg) ? ` (${quote(arg)})` : ""}`);
          }
        }
      }
    }
  }
  return declared;
}

/** Validates `permissions.headless` against the declared server names. */
function headlessErrors(v: unknown, declared: ReadonlySet<string>, hasServers: boolean, errors: string[]): void {
  if (v === undefined) return;
  if (!isObj(v)) {
    errors.push("permissions.headless must be an object {tools: string[]}");
    return;
  }
  for (const key of Object.keys(v)) if (key !== "tools") errors.push(`permissions.headless: unknown key ${quote(key)}`);
  const tools = v.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    errors.push("permissions.headless.tools must be a non-empty list of mcp__<server>__<tool> names");
    return;
  }
  if (tools.length > PLUGIN_LIMITS.maxHeadlessTools) errors.push(`permissions.headless.tools may list at most ${PLUGIN_LIMITS.maxHeadlessTools} tools`);
  if (!hasServers) errors.push("permissions.headless needs permissions.mcpServers: no server is declared, so no tool can be named");
  const seen = new Set<string>();
  for (const tool of tools.slice(0, PLUGIN_LIMITS.maxHeadlessTools)) {
    const parsed = parseMcpToolName(tool);
    if (!parsed) {
      errors.push(`permissions.headless.tools: ${quote(tool)} is not mcp__<server>__<tool> (server: lowercase letters, digits, '-'; tool: letters, digits, '_', '-', max 64)`);
      continue;
    }
    if (seen.has(tool as string)) errors.push(`permissions.headless.tools: ${quote(tool)} is listed twice`);
    seen.add(tool as string);
    if (hasServers && !declared.has(parsed.server)) errors.push(`permissions.headless.tools: ${quote(tool)} names the undeclared server ${quote(parsed.server)}`);
  }
}

/**
 * Validates untrusted manifest JSON. Rejects unknown permission keys, because a
 * permission the host does not understand must not be silently ignored.
 */
export function validatePluginManifest(v: unknown): ValidationResult<PluginManifest> {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ["manifest must be an object"] };
  if (!isPluginId(v.id)) errors.push("id must be lowercase letters, digits, '.', '-' or '_' (max 100)");
  if (v.id === "bridge") errors.push("id 'bridge' is reserved");
  if (!isStr(v.app) || !APP.test(v.app)) errors.push("app must be letters, digits, '.', '-' or '_' (max 64)");
  if (!isStr(v.entry) || !safeRelPath(v.entry)) errors.push("entry must be a relative path inside the package");
  const p = v.permissions;
  if (!isObj(p)) {
    errors.push("permissions must be an object");
  } else {
    const known = new Set(["network", "fs", "agents", "localUi", "mcpServers", "headless", "execution"]);
    for (const k of Object.keys(p)) if (!known.has(k)) errors.push(`unknown permission ${quote(k)}`);
    if (!optional(p.network, (x) => strList(x, (h) => HOST.test(h)))) errors.push("permissions.network must be a list of host names");
    if (!optional(p.fs, (x) => strList(x, (s) => s.length > 0 && s.length <= 512 && !CONTROL.test(s)))) errors.push("permissions.fs must be a list of printable paths (no control characters, max 512)");
    if (!optional(p.agents, (x) => strList(x, (s) => AGENT_ID.test(s)))) errors.push("permissions.agents must be a list of agent ids (letters, digits, '.', '-' or '_')");
    if (
      !optional(
        p.localUi,
        (x) =>
          isObj(x) &&
          (x.port === "auto" || (Number.isInteger(x.port) && (x.port as number) >= 1024 && (x.port as number) <= 65535)),
      )
    ) {
      errors.push("permissions.localUi.port must be 'auto' or a port 1024-65535");
    }
    if (p.execution !== undefined && !isConfinedExecution(p.execution)) errors.push("permissions.execution must be confined-v1 with exact public host:443 network endpoints");
    const declared = mcpServerErrors(p.mcpServers, errors);
    headlessErrors(p.headless, declared, isObj(p.mcpServers) && Object.keys(p.mcpServers).length > 0, errors);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: v as PluginManifest };
}

export function isPluginManifest(v: unknown): v is PluginManifest {
  return validatePluginManifest(v).ok;
}

/**
 * JSON-RPC methods between the runner (host) and a plugin process, over the
 * plugin's stdio. Requests carry ids; the `host/` notifications do not.
 *
 *  - host -> plugin request `plugin/call`: run a registered method for a caller.
 *  - plugin -> host request `host/startAgentSession`: params `StartAgentSessionParams`
 *    (`{agent, cwd?, onBehalfOf?, ...}`), result `{sessionId}` (the runner's session id, the
 *    same id the audit log and runner log carry); refused unless the manifest lists the
 *    agent. `onBehalfOf` is the `caller` of the extension call that led to this
 *    request, when there was one (see `AgentSessionBrokerRequest` in the runner): it
 *    names the browser that may be asked to approve the session's permission
 *    requests. The plugin never approves them itself.
 *  - plugin -> host notification `host/log`: params `{level, message, fields?}`.
 *  - plugin -> host notification `host/localUi`: params `{url}`, after `localUi.listen()`.
 *  - host -> plugin notification `host/sessionUpdate`: params `SessionUpdateParams`, one
 *    `SessionEvent` of a session the plugin started (the plugin sees its own session).
 *  - host -> plugin notification `host/sessionEnded`: params `SessionEndedParams`, once, when the
 *    session ends for any `SessionEndReason`.
 *  - host -> plugin notification `host/sessionQuiescence`: cleanup evidence independently of
 *    the logical ended event, including a cleanup timeout while process termination is hung.
 */
export const PLUGIN_RPC = {
  call: "plugin/call",
  startAgentSession: "host/startAgentSession",
  log: "host/log",
  localUi: "host/localUi",
  sessionUpdate: "host/sessionUpdate",
  sessionEnded: "host/sessionEnded",
  sessionQuiescence: "host/sessionQuiescence",
} as const;

/** Params of `plugin/call`. `method` is the full `_<pluginId>/<name>` ACP extension method. */
export type PluginCallParams = {
  method: string;
  params?: unknown;
  caller: { appId: string; browserKeyId: string };
  /**
   * Issued by the host for this one call (a random UUID, valid until the call returns) and copied by
   * the SDK onto any `host/startAgentSession` it makes while serving the call (`callToken` there).
   * It is the only thing the host has to check an `onBehalfOf` claim against: the claim is accepted
   * when the token is live and was issued for that `browserKeyId`. Known limit: one plugin process
   * sees every live token, so the check cannot bind the request to the call actually being served;
   * a plugin can name any browser that has a call in flight. The token is not a secret from the
   * plugin and not a credential for anything else. Private to the SDK and host pair; absent on a
   * host that predates it.
   */
  callToken?: string;
};

/** Why a session ended. Fixed list; `host/sessionEnded` and `BrokeredSession.ended` carry exactly one. */
export const SESSION_END_REASONS = [
  "closed",
  "cancelled",
  "budget",
  "breach",
  "agent_exited",
  "plugin_gone",
  "runner_shutdown",
] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/**
 * What a plugin sees of its own session. `rawInput` and `result` appear only on events of the
 * plugin's own `mcp__` tools (the runner filters; the type allows them). Nothing here is addressed
 * to a browser, and no secret ever appears in an event.
 */
export type SessionEvent =
  | {
      type: "tool_call" | "tool_call_update";
      /** The agent's tool call id. */
      id: string;
      toolName?: string;
      kind?: string;
      title?: string;
      status?: string;
      rawInput?: unknown;
      result?: unknown;
    }
  | { type: "text"; text: string }
  | { type: "plan"; entries: { content: string; status?: string; priority?: string }[] }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; totalTokens?: number };

/** Params of the host-to-plugin notification `host/sessionUpdate`. */
export type SessionUpdateParams = { sessionId: string; event: SessionEvent };
/**
 * Completion evidence for safe workspace/credential reuse. A successful workflow, cancel
 * acknowledgement or ended reason is never evidence. Quiescent means the kit has observed
 * namespace teardown AND revoked the session capability/closed its server resources.
 */
export type SessionQuiescence =
  | { status: "quiescent"; mechanism: "linux-pid-namespace" }
  | {
      status: "incomplete";
      mechanism: "linux-pid-namespace" | "process-group" | "unknown";
      reason: "descendants-unverified" | "timeout" | "termination-failed" | "cleanup-unavailable" | "disconnected";
    };

/** Strict discriminants keep malformed/older wire receipts from authorizing reuse. */
export function isSessionQuiescence(value: unknown): value is SessionQuiescence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt);
  if (!keys.includes("status") || !keys.includes("mechanism")) return false;
  if (receipt.status === "quiescent") return keys.length === 2 && receipt.mechanism === "linux-pid-namespace";
  return receipt.status === "incomplete"
    && keys.length === 3 && keys.includes("reason")
    && ["linux-pid-namespace", "process-group", "unknown"].includes(receipt.mechanism as string)
    && ["descendants-unverified", "timeout", "termination-failed", "cleanup-unavailable", "disconnected"].includes(receipt.reason as string);
}

/** Params of `host/sessionEnded`; hosts predating cleanup receipts omit quiescence. */
export type SessionEndedParams = { sessionId: string; reason: SessionEndReason; quiescence?: SessionQuiescence };
/** Independent cleanup completion; does not assign or synthesize a logical end reason. */
export type SessionQuiescenceParams = { sessionId: string; quiescence: SessionQuiescence };

/**
 * Params of `host/startAgentSession`. Everything after `onBehalfOf` is optional and describes a
 * **contained** session (see `isContainedRequest`): one with no built-in agent tools, whose only
 * tools are the plugin's own MCP servers. Browsers never send these: this is the plugin wire only.
 */
export type StartAgentSessionParams = {
  /** A live HTTP Unix socket under this plugin's consented $PLUGIN_DATA filesystem scope. */
  broker?: ConfinedBroker;
  execution?: ConfinedExecution;
  agent: string;
  /**
   * The folder of a non-contained session. A contained session has none to name: the runner makes an empty
   * private folder for it and sets the cwd itself, so `cwd` on a contained request is rejected
   * (`containedForbiddenFieldsOf`).
   */
  cwd?: string;
  /** The `caller` of the extension call being served, if any. */
  onBehalfOf?: { appId: string; browserKeyId: string };
  /**
   * The `callToken` of the `plugin/call` being served (`PluginCallParams.callToken`), copied by the SDK.
   * The host accepts `onBehalfOf` only when this token is live and was issued for that `browserKeyId`;
   * without `onBehalfOf` it is ignored. It does not bind the request to the serving call (see
   * `PluginCallParams.callToken`). Private to the SDK and host pair; not a plugin-author field.
   */
  callToken?: string;
  /** Declared `permissions.mcpServers` names to attach. Contained sessions only. */
  mcpServers?: string[];
  tools?: {
    /** Exact `mcp__<server>__<tool>` names. Must be inside the consented headless set. Contained only. */
    allow?: string[];
    /** `"none"` makes the session contained. Default `"agent-default"`: today's behaviour. */
    builtins?: "none" | "agent-default";
  };
  /** At most 4 KiB of UTF-8, written by the runner to a private file for the attached servers. Contained only. */
  secret?: string;
  /** An agent model name; the runner's policy decides whether it is allowed. */
  model?: string;
  /** Contained only: the runner counts and times only contained sessions. */
  budget?: { wallClockMs?: number; maxToolCalls?: number };
  /**
   * The plugin's statement that no person is present. A label only: the audit trigger does not read it
   * (it is `headless` unless a verified `onBehalfOf` exists, see `AuditTrigger`). Contained only;
   * `headless: true` together with `onBehalfOf` is rejected by `validateStartAgentSessionParams`.
   */
  headless?: boolean;
};

/** A field only a contained session may carry. */
export type ContainedOnlyField = "broker" | "execution" | "mcpServers" | "secret" | "headless" | "tools.allow" | "budget";

/**
 * THE definition of a contained session: `tools.builtins === "none"`. The SDK, the plugin
 * host and the proxy import this one rule; a second copy anywhere is a bug.
 */
export function isContainedRequest(p: Pick<StartAgentSessionParams, "tools" | "execution">): boolean {
  return p.tools?.builtins === "none" || p.execution?.profile === "confined-v1";
}

/** A field a contained session must not carry: a value the plugin names that only the runner may choose. */
export type ContainedForbiddenField = "cwd";

/**
 * The fields present on a **contained** request that the runner alone may choose: today only `cwd`.
 * The proxy runs a contained agent in `<sessionsDir>/<session id>`, an empty folder it makes, so no plugin-
 * supplied value may name that cwd: a plugin that could would run the agent beside a `.mcp.json`,
 * `.claude/settings.json` or `CLAUDE.md` of its choosing. For a request that is not contained the answer is
 * empty (`cwd` is the ordinary session folder there). The validator and `containedRequestProblem` both read
 * this one list, so a field added here is refused on the wire and at the proxy alike. `cwd` counts whenever
 * it is present, even as an empty string.
 */
export function containedForbiddenFieldsOf(p: Pick<StartAgentSessionParams, "tools" | "cwd" | "execution">): ContainedForbiddenField[] {
  if (!isContainedRequest(p)) return [];
  const found: ContainedForbiddenField[] = [];
  if (p.cwd !== undefined) found.push("cwd");
  return found;
}

/**
 * The contained-only fields present on `p`, in a fixed order. For a contained request the answer is
 * always empty; for any other request a non-empty answer means `containmentUnavailable`. A field
 * counts when it would do something: a non-empty `mcpServers`, a `secret`, `headless: true`, a
 * non-empty `tools.allow` (an approval set exists only in contained sessions), a `budget` with a limit
 * (only contained sessions are counted and timed). `model` is not one: it is checked against the
 * `models` allow-list in every session.
 */
export function containedOnlyFieldsOf(
  // `secret` is tested for presence only, so its type is open: the wire carries a string and the broker's
  // request a string or bytes, and every designated consumer (SDK, host, proxy) must call this one rule with
  // its own request type, without a cast or a second copy of the rule.
  p: Pick<StartAgentSessionParams, "tools" | "mcpServers" | "headless" | "budget" | "execution" | "broker"> & { secret?: unknown },
): ContainedOnlyField[] {
  if (isContainedRequest(p)) return [];
  const found: ContainedOnlyField[] = [];
  if (p.execution !== undefined) found.push("execution");
  if (p.broker !== undefined) found.push("broker");
  if (p.mcpServers !== undefined && p.mcpServers.length > 0) found.push("mcpServers");
  if (p.secret !== undefined) found.push("secret");
  if (p.headless === true) found.push("headless");
  if (p.tools?.allow !== undefined && p.tools.allow.length > 0) found.push("tools.allow");
  if (p.budget !== undefined && (p.budget.wallClockMs !== undefined || p.budget.maxToolCalls !== undefined)) found.push("budget");
  return found;
}

const noUnknownKeys = (v: Record<string, unknown>, known: readonly string[], where: string, errors: string[]): void => {
  for (const key of Object.keys(v)) if (!known.includes(key)) errors.push(`${where}: unknown key ${quote(key)}`);
};

/** Validates a list of unique `mcp__` tool names; reports into `errors`. */
function toolListErrors(v: unknown, where: string, max: number, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push(`${where} must be a list of mcp__<server>__<tool> names`);
    return;
  }
  if (v.length > max) errors.push(`${where} may list at most ${max} tools`);
  const seen = new Set<unknown>();
  for (const name of v.slice(0, max)) {
    if (!parseMcpToolName(name)) errors.push(`${where}: ${quote(name)} is not mcp__<server>__<tool>`);
    else if (seen.has(name)) errors.push(`${where}: ${quote(name)} is listed twice`);
    seen.add(name);
  }
}

/**
 * Validates the untrusted params of `host/startAgentSession`. Unknown keys are rejected at every level, and
 * so is a `cwd` on a contained request (`containedForbiddenFieldsOf`).
 * Whether the named servers and tools are declared and consented is the host's check: this function has
 * no manifest. An error message never carries the value of `secret`.
 */
export function validateStartAgentSessionParams(v: unknown): ValidationResult<StartAgentSessionParams> {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ["params must be an object"] };
  noUnknownKeys(v, ["agent", "cwd", "onBehalfOf", "callToken", "mcpServers", "tools", "secret", "model", "budget", "headless", "execution", "broker"], "params", errors);
  if (v.broker !== undefined && (!isConfinedBroker(v.broker) || !isObj(v.execution) || v.execution.broker !== "http-unix")) errors.push("broker requires confined-v1 http-unix broker consent and a relative plugin-data socket path");
  if (v.execution !== undefined && !isConfinedExecution(v.execution)) errors.push("execution must be confined-v1 with exact public host:443 network endpoints");
  if (v.execution !== undefined && isObj(v.tools) && v.tools.builtins === "none") errors.push("execution and tools.builtins none are separate profiles");
  if (!isStr(v.agent) || !AGENT_ID.test(v.agent)) errors.push("agent must be an agent id (letters, digits, '.', '-' or '_')");
  if (!optional(v.cwd, (x) => isStr(x) && x.length <= PLUGIN_LIMITS.maxCwdLength)) errors.push(`cwd must be a string of at most ${PLUGIN_LIMITS.maxCwdLength} characters`);
  if (!optional(v.callToken, (x) => isStr(x) && x.length <= PLUGIN_LIMITS.maxCallTokenLength)) errors.push(`callToken must be a string of at most ${PLUGIN_LIMITS.maxCallTokenLength} characters`);
  if (v.onBehalfOf !== undefined) {
    const caller = v.onBehalfOf;
    const id = (x: unknown) => isNonEmpty(x) && x.length <= PLUGIN_LIMITS.maxCallerIdLength;
    if (!isObj(caller) || !id(caller.appId) || !id(caller.browserKeyId)) errors.push("onBehalfOf must be {appId, browserKeyId}");
    else noUnknownKeys(caller, ["appId", "browserKeyId"], "onBehalfOf", errors);
  }
  if (v.mcpServers !== undefined) {
    const list = v.mcpServers;
    if (!Array.isArray(list)) {
      errors.push("mcpServers must be a list of declared server names");
    } else {
      if (list.length > PLUGIN_LIMITS.maxSessionMcpServers) errors.push(`mcpServers may name at most ${PLUGIN_LIMITS.maxSessionMcpServers} servers`);
      const seen = new Set<unknown>();
      for (const name of list.slice(0, PLUGIN_LIMITS.maxSessionMcpServers)) {
        if (!isStr(name) || !MCP_SERVER_NAME.test(name)) errors.push(`mcpServers: ${quote(name)} is not a server name (lowercase letters, digits, '-'; max 32)`);
        else if (seen.has(name)) errors.push(`mcpServers: ${quote(name)} is listed twice`);
        seen.add(name);
      }
    }
  }
  if (v.tools !== undefined) {
    if (!isObj(v.tools)) {
      errors.push("tools must be an object {allow?, builtins?}");
    } else {
      noUnknownKeys(v.tools, ["allow", "builtins"], "tools", errors);
      if (v.tools.allow !== undefined) toolListErrors(v.tools.allow, "tools.allow", PLUGIN_LIMITS.maxAllowTools, errors);
      if (!optional(v.tools.builtins, (x) => x === "none" || x === "agent-default")) errors.push("tools.builtins must be 'none' or 'agent-default'");
    }
  }
  // The runner chooses a contained session's folder; a plugin-named cwd would defeat that.
  if (containedForbiddenFieldsOf({ execution: v.execution as ConfinedExecution | undefined, tools: isObj(v.tools) ? (v.tools as StartAgentSessionParams["tools"]) : undefined, cwd: v.cwd as string | undefined }).includes("cwd")) {
    errors.push("cwd must not be set on a contained session (tools.builtins 'none'): the runner chooses its folder");
  }
  if (v.secret !== undefined) {
    // Never quote the secret in a message.
    if (!isStr(v.secret)) errors.push("secret must be a string");
    // A UTF-16 unit encodes to at least one byte, so a longer string is over the limit: check before scanning it.
    else if (v.secret.length > PLUGIN_LIMITS.maxSecretBytes) errors.push(`secret must be at most ${PLUGIN_LIMITS.maxSecretBytes} bytes (4 KiB) of UTF-8`);
    else if (v.secret.includes("\0")) errors.push("secret must not contain a NUL character");
    else if (LONE_SURROGATE.test(v.secret)) errors.push("secret must be well-formed text (no unpaired surrogates)");
    else if (new TextEncoder().encode(v.secret).length > PLUGIN_LIMITS.maxSecretBytes) errors.push(`secret must be at most ${PLUGIN_LIMITS.maxSecretBytes} bytes (4 KiB) of UTF-8`);
  }
  if (!optional(v.model, (x) => isStr(x) && MODEL.test(x))) errors.push(`model must be a model name (letters, digits, '.', '_', '-'; max ${PLUGIN_LIMITS.maxModelLength})`);
  if (v.budget !== undefined) {
    if (!isObj(v.budget)) {
      errors.push("budget must be an object {wallClockMs?, maxToolCalls?}");
    } else {
      noUnknownKeys(v.budget, ["wallClockMs", "maxToolCalls"], "budget", errors);
      const inRange = (x: unknown, max: number) => isInt(x) && x >= 1 && x <= max;
      if (!optional(v.budget.wallClockMs, (x) => inRange(x, PLUGIN_LIMITS.maxWallClockMs))) errors.push(`budget.wallClockMs must be an integer 1..${PLUGIN_LIMITS.maxWallClockMs}`);
      if (!optional(v.budget.maxToolCalls, (x) => inRange(x, PLUGIN_LIMITS.maxToolCalls))) errors.push(`budget.maxToolCalls must be an integer 1..${PLUGIN_LIMITS.maxToolCalls}`);
    }
  }
  if (!optional(v.headless, (x) => typeof x === "boolean")) errors.push("headless must be a boolean");
  else if (v.headless === true && v.onBehalfOf !== undefined) errors.push("headless: true contradicts onBehalfOf (a browser is waiting on this session)");
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: rebuildStartParams(v) };
}

/** A copy of already-validated params holding only the known keys, so nothing unvalidated travels on to the consumer. */
function rebuildStartParams(v: Record<string, unknown>): StartAgentSessionParams {
  const out: StartAgentSessionParams = { agent: v.agent as string };
  if (v.execution !== undefined) out.execution = { profile: "confined-v1", network: [...(v.execution as ConfinedExecution).network], ...((v.execution as ConfinedExecution).broker ? { broker: "http-unix" as const } : {}) };
  if (v.broker !== undefined) out.broker = { transport: "http-unix", socket: (v.broker as ConfinedBroker).socket };
  if (v.cwd !== undefined) out.cwd = v.cwd as string;
  if (v.onBehalfOf !== undefined) {
    const c = v.onBehalfOf as { appId: string; browserKeyId: string };
    out.onBehalfOf = { appId: c.appId, browserKeyId: c.browserKeyId };
  }
  if (v.callToken !== undefined) out.callToken = v.callToken as string;
  if (v.mcpServers !== undefined) out.mcpServers = [...(v.mcpServers as string[])];
  if (v.tools !== undefined) {
    const t = v.tools as NonNullable<StartAgentSessionParams["tools"]>;
    out.tools = {};
    if (t.allow !== undefined) out.tools.allow = [...t.allow];
    if (t.builtins !== undefined) out.tools.builtins = t.builtins;
  }
  if (v.secret !== undefined) out.secret = v.secret as string;
  if (v.model !== undefined) out.model = v.model as string;
  if (v.budget !== undefined) {
    const b = v.budget as NonNullable<StartAgentSessionParams["budget"]>;
    out.budget = {};
    if (b.wallClockMs !== undefined) out.budget.wallClockMs = b.wallClockMs;
    if (b.maxToolCalls !== undefined) out.budget.maxToolCalls = b.maxToolCalls;
  }
  if (v.headless !== undefined) out.headless = v.headless as boolean;
  return out;
}
