import path from "node:path";
import { validateHostBrokerSocket } from "../acp/confined.js";
import {
  containedOnlyFieldsOf,
  isContainedRequest,
  quoteUntrusted,
  validateStartAgentSessionParams,
  type StartAgentSessionParams,
} from "@berdyh/bridge-protocol";
import {
  PROXY_ERROR,
  containedRequestProblem,
  parseGrantedMcpServer,
  resolveGrantedServer,
  type AgentSessionBroker,
  type AgentSessionBrokerRequest,
  type GrantedMcpServer,
  type ResolvedMcpServer,
} from "../acp/contracts.js";
import { surfaceSha256Of } from "./consent.js";
import type { ConsentedGrant, InstalledPlugin } from "./contracts.js";
import { assertNoSymlinks } from "./package.js";
import { rpcError } from "./rpc.js";

const INVALID_PARAMS = -32602;

/**
 * Wraps a broker so that a plugin may only start sessions for agents its manifest
 * lists. The check lives here, not in the proxy, which knows nothing of manifests.
 */
export function restrictBroker(broker: AgentSessionBroker, allowedAgents: readonly string[]): AgentSessionBroker {
  const allowed = new Set(allowedAgents);
  return {
    async start(request) {
      if (!allowed.has(request.agent)) {
        throw Object.assign(new Error(`Plugin may not use agent '${request.agent}'`), { code: PROXY_ERROR.sessionNotAllowed });
      }
      return broker.start(request);
    },
  };
}

/**
 * The untrusted params of `host/startAgentSession`, validated. Unknown keys are refused at every level and the
 * message never carries the secret (the protocol validator guarantees it). Throws -32602.
 */
export function parseStartParams(raw: unknown): StartAgentSessionParams {
  const result = validateStartAgentSessionParams(raw);
  if (!result.ok) throw rpcError(`Invalid session request: ${result.errors.join("; ")}`, INVALID_PARAMS);
  return result.value;
}

/** What the host needs, besides the params, to turn them into a broker request. */
export interface SessionRequestContext {
  installed: InstalledPlugin;
  /** The runner's own Node: what every attached server runs on. */
  runnerNode: string;
  /** Canonical boundary below which no path of the plugin may be a link. */
  pathBoundary: string;
  /** `PluginHostWithGrants.grantOf`: the consent, read at each contained start. Absent reads as no consent. */
  grantOf?(pluginId: string): Promise<ConsentedGrant | undefined>;
  /** Local diagnostics. Never given the params, so never the secret. */
  log?(level: string, message: string, fields?: Record<string, unknown>): void;
}

/** The granted server of that name, or undefined when the grant holds none or two (ambiguous grants nothing). */
function grantedServerNamed(grant: ConsentedGrant, name: string): GrantedMcpServer | undefined {
  const found: GrantedMcpServer[] = [];
  for (const item of grant.surface.items) {
    if (item.kind !== "mcpServer") continue;
    const server = parseGrantedMcpServer(item.value);
    if (server?.name === name) found.push(server);
  }
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Turns validated params into the request the proxy gets, or throws the refusal. Nothing reaches the broker
 * before this returns, and no validated field is dropped on the way (a field the plugin set is either carried
 * or the request is refused):
 *  - the agent must be one the manifest lists (-32012);
 *  - a request that is not contained (`isContainedRequest`) must carry no contained-only field
 *    (`containedOnlyFieldsOf`: `mcpServers`, `secret`, `headless: true`, `tools.allow`, `budget`): -32016;
 *  - a contained request needs the consent read now from the consent store (`consentMissing` -32019 when there is none),
 *    names only declared servers, gets its servers built from the grant with the one shared
 *    `resolveGrantedServer` (absolute entry inside the install dir, `${PLUGIN_DATA}` replaced, links refused),
 *    and must pass `containedRequestProblem`, the same check the proxy repeats;
 *  - `headless: true` needs a consented headless set (-32019 when the grant holds none).
 * `onBehalfOf` is the browser the caller already proved live; it is not part of this function's checks.
 */
export async function brokerRequestOf(params: StartAgentSessionParams, onBehalfOf: { browserKeyId: string } | undefined, ctx: SessionRequestContext): Promise<AgentSessionBrokerRequest> {
  const { installed } = ctx;
  const manifest = installed.manifest;
  if (!(manifest.permissions.agents ?? []).includes(params.agent)) {
    throw rpcError(`Plugin may not use agent '${params.agent}'`, PROXY_ERROR.sessionNotAllowed);
  }
  const request: AgentSessionBrokerRequest = {
    ...(params.broker ? { broker: params.broker } : {}),
    ...(params.execution ? { execution: params.execution } : {}),
    pluginId: manifest.id, appId: manifest.app, agent: params.agent,
    ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    ...(onBehalfOf ? { onBehalfOf } : {}),
    ...(params.mcpServers !== undefined ? { mcpServers: params.mcpServers } : {}),
    ...(params.tools !== undefined ? { tools: params.tools } : {}),
    ...(params.secret !== undefined ? { secret: params.secret } : {}),
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.budget !== undefined ? { budget: params.budget } : {}),
    ...(params.headless !== undefined ? { headless: params.headless } : {}),
  };
  if (!isContainedRequest(params)) {
    const fields = containedOnlyFieldsOf(params);
    if (fields.length > 0) {
      throw rpcError(`${fields.join(", ")} need a contained session (tools.builtins 'none')`, PROXY_ERROR.containmentUnavailable);
    }
    return request;
  }
  const declared = Object.keys(manifest.permissions.mcpServers ?? {});
  for (const name of params.mcpServers ?? []) {
    if (!declared.includes(name)) throw rpcError(`Server ${quoteUntrusted(name)} is not declared by this plugin`, INVALID_PARAMS);
  }
  let grant: ConsentedGrant | undefined;
  try { grant = await ctx.grantOf?.(manifest.id); } catch { grant = undefined; }
  if (!grant) throw rpcError("No consent is recorded for this plugin's contained sessions", PROXY_ERROR.consentMissing);
  const resolution = { installDir: installed.installDir, dataDir: installed.dataDir, surfaceSha256Of };
  const servers: ResolvedMcpServer[] = [];
  for (const name of params.mcpServers ?? []) {
    const granted = grantedServerNamed(grant, name);
    if (!granted) throw rpcError(`Server ${quoteUntrusted(name)} is not in the consented grant`, INVALID_PARAMS);
    const resolved = resolveGrantedServer(granted, ctx.runnerNode, resolution);
    if (!resolved) throw rpcError(`Server ${quoteUntrusted(name)} cannot be placed inside the installed plugin`, INVALID_PARAMS);
    servers.push(resolved);
  }
  try {
    // The entries are what the agent will run: no link anywhere on the way, now, not only at install.
    for (const server of servers) await assertNoSymlinks(server.args[0]!, ctx.pathBoundary);
    await assertNoSymlinks(installed.dataDir, ctx.pathBoundary);
  } catch (error) {
    try { ctx.log?.("warn", "Refused a contained session start: a server path is not safe", { error: (error as Error).message }); } catch { /* Optional logger. */ }
    throw rpcError("A contained session cannot start: a server path is not safe", PROXY_ERROR.containmentUnavailable);
  }
  request.servers = servers;
  request.grant = grant;
  const problem = containedRequestProblem(request, ctx.runnerNode, resolution);
  if (problem) throw rpcError(problem.message, problem.code);
  if (params.headless === true && !grant.surface.items.some((item) => item.kind === "headlessTool")) {
    throw rpcError("headless needs a consented headless tool set; this plugin has none", PROXY_ERROR.consentMissing);
  }
  if (request.broker) {
    try { await validateHostBrokerSocket({ socketPath: path.resolve(installed.dataDir, request.broker.socket), dataDir: installed.dataDir }); }
    catch { throw rpcError("Host broker socket is not a live owned socket beneath plugin data", PROXY_ERROR.containmentUnavailable); }
  }
  return request;
}
