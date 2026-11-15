import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type FileAuditLog, createAuditLog } from "../audit/index.js";

import { createAcpAgentAdapter, createDefaultAgentAdapters } from "./adapters.js";
import { CLAUDE_MEASURED_STACKS, claudeProfileOf } from "./containment/index.js";
import {
  type AgentAdapter,
  type AgentProcess,
  type AgentSessionBrokerRequest,
  type AgentSpawnOptions,
  type AuditRecord,
  type BrokeredSession,
  type BrowserChannel,
  ContainmentRefused,
  type ContainmentRefusalReason,
  type ContainmentProfile,
  type ExtensionCaller,
  type ExtensionRouter,
  type GrantResolution,
  type JsonRpcMessage,
  type LocalPolicy,
  type MessageStream,
  PROXY_ERROR,
  type PermissionRequestInfo,
  type PolicyDecision,
  type SessionEndReason,
  type SessionEvent,
  resolveGrantedServer,
} from "./contracts.js";
import { createLocalPolicy } from "./policy.js";
import { type ContainedSessionSupport, createAcpProxy } from "./proxy.js";
import { RPC_ERROR, RpcError, type RpcPeer, createRpcPeer, toWireError } from "./rpc.js";

// Every peer created in this file (browser clients and the proxy's own), so a test can assert none keeps a request.
const allPeers: RpcPeer[] = vi.hoisted(() => []);
vi.mock("./rpc.js", async (importActual) => {
  const actual = await importActual<typeof import("./rpc.js")>();
  return {
    ...actual,
    createRpcPeer: ((...args: Parameters<typeof actual.createRpcPeer>) => {
      const peer = actual.createRpcPeer(...args);
      allPeers.push(peer);
      return peer;
    }) as typeof actual.createRpcPeer,
  };
});
const pendingTotal = () => allPeers.reduce((n, p) => n + p.pendingCount, 0);

const STUB = fileURLToPath(new URL("./fixtures/stub-agent.mjs", import.meta.url));

let root: string;
let project: string;
let tmpBase: string;
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(async () => {
  allPeers.length = 0;
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-proxy-"));
  project = path.join(root, "project");
  tmpBase = path.join(root, "tmp");
  await Promise.all([project, tmpBase].map((d) => mkdir(d, { recursive: true })));
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await rm(root, { recursive: true, force: true });
});

function stubAdapter(id = "stub"): AgentAdapter {
  return createAcpAgentAdapter({
    id,
    command: process.execPath,
    args: [STUB],
    environment: { env: { PATH: path.dirname(process.execPath) }, homedir: root, tmpBase },
    killGraceMs: 200,
  });
}

function policyOf(decide: (info: PermissionRequestInfo) => PolicyDecision = () => ({ action: "ask" }), allow: LocalPolicy["allowSession"] = () => true) {
  const seen: PermissionRequestInfo[] = [];
  const policy: LocalPolicy = {
    mode: "ask",
    allowSession: allow,
    decidePermission(info) {
      seen.push(info);
      return decide(info);
    },
  };
  return { policy, seen };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("condition not met in time");
}

/** An in-memory browser channel plus the browser's side of it. */
function memoryChannel(opts: { appId?: string; channelId?: string; browserKeyId?: string; onSend?: (m: JsonRpcMessage, toProxy: (m: JsonRpcMessage) => void) => void } = {}) {
  const toBrowser = new Set<(m: JsonRpcMessage) => void>();
  const toProxy = new Set<(m: JsonRpcMessage) => void>();
  const proxyClosers = new Set<(r?: string) => void>();
  const browserClosers = new Set<(r?: string) => void>();
  let closed = false;
  const closeBoth = (reason?: string) => {
    if (closed) return;
    closed = true;
    [...proxyClosers, ...browserClosers].forEach((h) => h(reason));
  };
  const channel: BrowserChannel = {
    channelId: opts.channelId ?? `ch-${Math.random().toString(36).slice(2)}`,
    appId: opts.appId ?? "app-a",
    browserKeyId: opts.browserKeyId ?? "key-1",
    get closed() {
      return closed;
    },
    send(m) {
      if (closed) throw new Error("closed");
      opts.onSend?.(m, (reply) => [...toProxy].forEach((h) => h(reply)));
      queueMicrotask(() => [...toBrowser].forEach((h) => h(m)));
    },
    onMessage(h) {
      toProxy.add(h);
      return () => toProxy.delete(h);
    },
    onClose(h) {
      proxyClosers.add(h);
      return () => proxyClosers.delete(h);
    },
    close: closeBoth,
  };
  const browserStream = {
    get closed() {
      return closed;
    },
    send(m: JsonRpcMessage) {
      if (closed) throw new Error("closed");
      queueMicrotask(() => [...toProxy].forEach((h) => h(m)));
    },
    onMessage(h: (m: JsonRpcMessage) => void) {
      toBrowser.add(h);
      return () => toBrowser.delete(h);
    },
    onClose(h: (r?: string) => void) {
      browserClosers.add(h);
      return () => browserClosers.delete(h);
    },
    close: closeBoth,
  };
  const client = new BrowserClient(browserStream);
  return { channel, client };
}

class BrowserClient {
  peer: RpcPeer;
  updates: { sessionId: string; text: string }[] = [];
  asks: { sessionId: string; toolCall: { _meta?: unknown; toolCallId: string }; options: { optionId: string }[] }[] = [];
  pushed: JsonRpcMessage[] = [];
  onAsk: (params: unknown) => unknown = () => new Promise(() => undefined);
  constructor(private stream: MessageStream<JsonRpcMessage>) {
    this.peer = createRpcPeer(stream, {
      onRequest: (method, params) => {
        if (method === "session/request_permission") {
          this.asks.push(params as never);
          return this.onAsk(params);
        }
        throw new Error("unexpected");
      },
      onNotification: (method, params) => {
        if (method === "session/update") {
          const p = params as { sessionId: string; update: { content?: { text?: string } } };
          this.updates.push({ sessionId: p.sessionId, text: p.update.content?.text ?? "" });
        } else this.pushed.push({ jsonrpc: "2.0", method, params } as JsonRpcMessage);
      },
    });
  }
  request(method: string, params?: unknown) {
    return this.peer.request(method, params);
  }
  notify(method: string, params?: unknown) {
    this.peer.notify(method, params);
  }
  raw(message: unknown) {
    void this.stream.send(message as JsonRpcMessage);
  }
  close() {
    this.stream.close("browser left");
  }
  async newSession(extra: Record<string, unknown> = {}) {
    const res = (await this.request("session/new", { cwd: project, mcpServers: [], ...extra })) as { sessionId: string };
    return res.sessionId;
  }
  async prompt(sessionId: string, text: string) {
    return (await this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] })) as { stopReason: string };
  }
  textOf(sessionId: string) {
    return this.updates.filter((u) => u.sessionId === sessionId).map((u) => u.text);
  }
  async info(sessionId: string) {
    const before = this.updates.length;
    await this.prompt(sessionId, "info");
    return JSON.parse(this.updates[before]!.text) as {
      pid: number;
      newParams: Record<string, unknown>;
      initialize: { clientCapabilities: unknown };
      setMode: number;
      setConfig: { configId: string }[];
      prompts: { type: string; text?: string; _meta?: unknown }[][];
    };
  }
}

function setup(over: { appId?: string; policy?: LocalPolicy; adapters?: AgentAdapter[]; extensions?: ExtensionRouter } = {}) {
  const { policy, seen } = policyOf();
  const proxy = createAcpProxy({
    appId: over.appId ?? "app-a",
    adapters: over.adapters ?? [stubAdapter()],
    policy: over.policy ?? policy,
    extensions: over.extensions,
    defaultCwd: project,
  });
  cleanups.push(() => proxy.close());
  const open = (opts: Parameters<typeof memoryChannel>[0] = {}) => {
    const m = memoryChannel({ appId: over.appId ?? "app-a", ...opts });
    proxy.attach(m.channel);
    return m.client;
  };
  return { proxy, open, seen };
}

describe("session round trip", () => {
  it("answers initialize itself and forwards a prompt, with the session id remapped", async () => {
    const { open } = setup();
    const browser = open();
    const init = (await browser.request("initialize", { protocolVersion: 1, clientCapabilities: {} })) as { protocolVersion: number; agentCapabilities: { loadSession: boolean } };
    expect(init.protocolVersion).toBe(1);
    expect(init.agentCapabilities.loadSession).toBe(false);

    const sessionId = await browser.newSession();
    expect(sessionId).not.toBe("stub-1"); // the agent's id never leaves the proxy
    expect(await browser.prompt(sessionId, "hello")).toEqual({ stopReason: "end_turn" });
    expect(browser.textOf(sessionId)).toEqual(["echo: hello"]);
  });

  it("lists only the current mode in the session/new result, since the browser can never select another", async () => {
    const { open } = setup();
    const browser = open();
    const result = (await browser.request("session/new", { cwd: project, mcpServers: [] })) as { modes?: { currentModeId: string; availableModes: { id: string }[] } };
    expect(result.modes).toEqual({ currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] });
    expect(JSON.stringify(result)).not.toContain("bypassPermissions");
  });

  it("forwards only the prompt block types it advertises, and refuses the rest", async () => {
    const { open } = setup();
    const browser = open();
    const init = (await browser.request("initialize", { protocolVersion: 1, clientCapabilities: {} })) as { agentCapabilities: { promptCapabilities: Record<string, boolean> } };
    expect(init.agentCapabilities.promptCapabilities).toEqual({ image: false, audio: false, embeddedContext: false });
    const sessionId = await browser.newSession();
    const bad = [
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "audio", data: "AAAA", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///etc/passwd", text: "x" } },
      { type: "resource_link", uri: "file:///etc/passwd", name: "passwd" },
      { type: "text" },
      "text",
    ];
    for (const block of bad) {
      await expect(browser.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }, block] })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    }
    // Text goes through, stripped of anything the browser added to it.
    await browser.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello", _meta: { sneaky: true }, annotations: { audience: ["user"] } }] });
    const { prompts } = await browser.info(sessionId);
    expect(prompts).toEqual([[{ type: "text", text: "hello" }], [{ type: "text", text: "info" }]]);
  });

  it("keeps two sessions that the agent gave the same id apart", async () => {
    const { open, proxy } = setup();
    const browser = open();
    const a = await browser.newSession();
    const b = await browser.newSession();
    expect(a).not.toBe(b);
    await browser.prompt(a, "hello");
    expect(browser.textOf(a)).toEqual(["echo: hello"]);
    expect(browser.textOf(b)).toEqual([]);
    expect(proxy.sessionCount()).toBe(2);
  });

  it("picks the adapter by the _meta.agent hint, or the first available one", async () => {
    const { open } = setup({ adapters: [stubAdapter("first"), stubAdapter("second")] });
    const browser = open();
    const a = await browser.newSession();
    const b = await browser.newSession({ _meta: { agent: "second" } });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    await expect(browser.newSession({ _meta: { agent: "nope" } })).rejects.toMatchObject({ code: PROXY_ERROR.unknownAgent });
  });

  it("reports no available agent as unknownAgent, and an agent that cannot start as an error with no session left over", async () => {
    const broken = createAcpAgentAdapter({
      id: "broken",
      command: "not-installed-acp",
      environment: { env: { PATH: "" }, homedir: root, tmpBase },
    });
    const { open, proxy } = setup({ adapters: [broken] });
    const browser = open();
    await expect(browser.newSession()).rejects.toMatchObject({ code: PROXY_ERROR.unknownAgent });
    const failure = await browser.newSession({ _meta: { agent: "broken" } }).catch((e) => e as Error);
    expect(failure).toMatchObject({ code: RPC_ERROR.internal });
    // No local path or command name reaches the browser.
    expect((failure as Error).message).toBe("agent broken failed to start");
    expect(proxy.sessionCount()).toBe(0);
  });

  it("asks the local policy whether a session may start", async () => {
    const { policy } = policyOf(undefined, ({ cwd, agentId }) => agentId === "stub" && cwd.startsWith(project));
    const { open } = setup({ policy });
    const browser = open();
    await mkdir(path.join(project, "sub"));
    await expect(browser.newSession({ cwd: "/etc" })).rejects.toMatchObject({ code: PROXY_ERROR.sessionNotAllowed });
    expect(await browser.newSession({ cwd: path.join(project, "sub") })).toBeTruthy();
  });
});

describe("what a browser cannot make the agent do", () => {
  it("gives the agent no fs or terminal, and the empty server list only", async () => {
    const { open } = setup();
    const browser = open();
    const sessionId = await browser.newSession();
    const info = await browser.info(sessionId);
    expect(info.newParams).toEqual({ cwd: project, mcpServers: [] });
    expect(info.initialize.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  });

  /** The stub agent, counting spawns. */
  function countingStub() {
    const inner = stubAdapter();
    const counter = { spawns: 0 };
    const adapter: AgentAdapter = {
      ...inner,
      spawn: (o) => {
        counter.spawns += 1;
        return inner.spawn(o);
      },
    };
    return { adapter, counter };
  }

  it("refuses session/new that names MCP servers with -32602 and spawns nothing", async () => {
    const { adapter, counter } = countingStub();
    const { open } = setup({ adapters: [adapter] });
    const browser = open();
    for (const mcpServers of [[{ name: "evil", command: "sh", args: ["-c", "touch /tmp/pwned"], env: [] }], [{ name: "x", command: "y" }], "sh", {}]) {
      await expect(browser.request("session/new", { cwd: project, mcpServers })).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
        message: "MCP servers are set by installed plugins only",
      });
    }
    expect(counter.spawns).toBe(0);
  });

  it("refuses session/new with any _meta key but agent, such as _meta.claudeCode.options, with -32602 and spawns nothing", async () => {
    const { adapter, counter } = countingStub();
    const { open } = setup({ adapters: [adapter] });
    const browser = open();
    const metas = [
      { claudeCode: { options: { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } } },
      { agent: "stub", permissionMode: "bypassPermissions" },
      { claudeCode: {} },
      null,
      "x",
    ];
    for (const _meta of metas) {
      await expect(browser.request("session/new", { cwd: project, mcpServers: [], _meta })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    }
    expect(counter.spawns).toBe(0);
    // The empty list and the agent hint, which is all a browser may send, still start a session.
    const sessionId = await browser.newSession({ _meta: { agent: "stub" } });
    expect((await browser.info(sessionId)).newParams).toEqual({ cwd: project, mcpServers: [] });
    expect(counter.spawns).toBe(1);
  });

  it("answers an agent's fs request itself instead of sending it to the browser", async () => {
    const { open } = setup();
    const browser = open();
    const sessionId = await browser.newSession();
    await browser.prompt(sessionId, "fs");
    expect(browser.textOf(sessionId)).toEqual([`fs:${RPC_ERROR.methodNotFound}`]);
    expect(browser.asks).toHaveLength(0);
  });

  it("rejects a permission-mode change with a typed error and never forwards it", async () => {
    const { open } = setup();
    const browser = open();
    const sessionId = await browser.newSession();
    const forbidden = { code: PROXY_ERROR.permissionModeForbidden };
    await expect(browser.request("session/set_mode", { sessionId, modeId: "bypassPermissions" })).rejects.toMatchObject(forbidden);
    await expect(browser.request("session/set_mode", { sessionId, modeId: "default" })).rejects.toMatchObject(forbidden);
    await expect(browser.request("session/set_config_option", { sessionId, configId: "mode", value: "bypassPermissions" })).rejects.toMatchObject(forbidden);
    await expect(browser.request("session/set_config_option", { sessionId, configId: "permission_mode", value: "x" })).rejects.toMatchObject(forbidden);
    await expect(browser.request("session/set_config_option", { sessionId, configId: "whatever", value: "bypassPermissions" })).rejects.toMatchObject(forbidden);
    // Unrelated options still pass, including one whose id merely contains "mode".
    await browser.request("session/set_config_option", { sessionId, configId: "model", value: "fast" });
    // The agent's answer carries the full updated list; a second set keeps working.
    await browser.request("session/set_config_option", { sessionId, configId: "model", value: "default" });

    const info = await browser.info(sessionId);
    expect(info.setMode).toBe(0);
    expect(info.setConfig.map((c) => c.configId)).toEqual(["model", "model"]);
  });

  it("refuses the option the agent marks category \"mode\", whatever its id or value, and any undeclared option", async () => {
    const { open } = setup();
    const browser = open();
    const sessionId = await browser.newSession();
    const forbidden = { code: PROXY_ERROR.permissionModeForbidden };
    // "autopilot" matches none of the name patterns; the agent's declared category gives it away.
    await expect(browser.request("session/set_config_option", { sessionId, configId: "autopilot", value: "on" })).rejects.toMatchObject(forbidden);
    // Not declared by the agent: refused, however harmless the name.
    await expect(browser.request("session/set_config_option", { sessionId, configId: "yolo", value: true })).rejects.toMatchObject(forbidden);
    await expect(browser.request("session/set_config_option", { sessionId, configId: "never-declared", value: "x" })).rejects.toMatchObject(forbidden);
    // A bypass-looking id is refused on the id alone, even with an innocent value.
    await expect(browser.request("session/set_config_option", { sessionId, configId: "yolo-bypass-thing", value: "x" })).rejects.toMatchObject(forbidden);
    // Values other than string or boolean never reach the agent.
    for (const value of [{ a: 1 }, ["x"], 3, null]) {
      await expect(browser.request("session/set_config_option", { sessionId, configId: "model", value })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    }
    await expect(browser.request("session/set_config_option", { sessionId, configId: 5, value: "x" })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await browser.request("session/set_config_option", { sessionId, configId: "model", value: "fast" });
    expect((await browser.info(sessionId)).setConfig.map((c) => c.configId)).toEqual(["model"]);
  });

  it("lets a browser set only options in an allowlisted category, so an uncategorized autoApprove stays local", async () => {
    const { open } = setup();
    const browser = open();
    const sessionId = await browser.newSession();
    const forbidden = { code: PROXY_ERROR.permissionModeForbidden };
    // Declared by the agent, but with no category and a harmless-looking id and value.
    await expect(browser.request("session/set_config_option", { sessionId, configId: "autoApprove", value: "on" })).rejects.toMatchObject(forbidden);
    // Declared, harmless, but uncategorized: not on the allowlist either.
    await expect(browser.request("session/set_config_option", { sessionId, configId: "verbose", value: true })).rejects.toMatchObject(forbidden);
    // The allowlisted categories (model, thought_level) pass.
    await browser.request("session/set_config_option", { sessionId, configId: "model", value: "fast" });
    await browser.prompt(sessionId, "declare-option");
    await browser.request("session/set_config_option", { sessionId, configId: "thinking", value: "high" });
    expect((await browser.info(sessionId)).setConfig.map((c) => c.configId)).toEqual(["model", "thinking"]);
  });

  it("follows the options the agent declares later in config_option_update", async () => {
    const { open } = setup();
    const browser = open();
    const sessionId = await browser.newSession();
    const forbidden = { code: PROXY_ERROR.permissionModeForbidden };
    await expect(browser.request("session/set_config_option", { sessionId, configId: "thinking", value: "high" })).rejects.toMatchObject(forbidden);
    await browser.prompt(sessionId, "declare-option");
    await browser.request("session/set_config_option", { sessionId, configId: "thinking", value: "high" });
    // "yolo" is now declared, but as a mode option.
    await expect(browser.request("session/set_config_option", { sessionId, configId: "yolo", value: true })).rejects.toMatchObject(forbidden);
    // The declaration replaced the old list: "autoApprove" is gone.
    await expect(browser.request("session/set_config_option", { sessionId, configId: "autoApprove", value: "on" })).rejects.toMatchObject(forbidden);
  });

  it("does not support loading, listing or forking sessions, or any method it does not know", async () => {
    const { open } = setup();
    const browser = open();
    for (const method of ["session/load", "session/list", "session/fork", "session/resume", "authenticate", "fs/read_text_file", "terminal/create", "nonsense"]) {
      await expect(browser.request(method, {})).rejects.toMatchObject({ code: RPC_ERROR.methodNotFound });
    }
  });

  it("answers malformed messages with an error and keeps the channel alive", async () => {
    const { open } = setup();
    const browser = open();
    const sessionId = await browser.newSession();
    await expect(browser.request("session/prompt", "not an object")).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(browser.request("session/prompt", { sessionId, prompt: "not an array" })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(browser.request("session/prompt", { sessionId: 42, prompt: [] })).rejects.toMatchObject({ code: PROXY_ERROR.unknownSession });
    browser.raw({ jsonrpc: "2.0", id: 77, method: 123 });
    browser.raw({ jsonrpc: "2.0", id: 78 });
    browser.raw({ jsonrpc: "2.0", method: "session/cancel", params: "junk" });
    expect(await browser.prompt(sessionId, "hello")).toEqual({ stopReason: "end_turn" });
  });
});

describe("permissions", () => {
  it("never offers allow_always or reject_always to a browser, and treats an answer naming one as cancelled", async () => {
    const { open } = setup();
    const browser = open();
    browser.onAsk = () => ({ outcome: { outcome: "selected", optionId: "allow-always" } });
    const sessionId = await browser.newSession();
    await browser.prompt(sessionId, "ask:Bash");
    expect(browser.asks[0]?.options.map((o) => o.optionId)).toEqual(["allow-once", "reject-once"]);
    expect(browser.textOf(sessionId)).toEqual(['outcome:{"outcome":"cancelled"}']);
  });

  it("sends an ask to the browser with the proxy's session id, and gives the agent the browser's answer", async () => {
    const { open, seen } = setup();
    const browser = open();
    browser.onAsk = () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });
    const sessionId = await browser.newSession();
    await browser.prompt(sessionId, "ask:Bash");
    expect(browser.asks).toHaveLength(1);
    expect(browser.asks[0]?.sessionId).toBe(sessionId);
    expect(browser.asks[0]?.options.map((o) => o.optionId)).toContain("allow-once");
    expect(browser.textOf(sessionId)).toEqual(['outcome:{"outcome":"selected","optionId":"allow-once"}']);

    // The policy saw the tool identity the adapter read from the agent's _meta.
    expect(seen[0]).toMatchObject({
      appId: "app-a",
      agentId: "stub",
      sessionId,
      cwd: project,
      toolName: "Bash",
      toolKind: "execute",
      rawInput: { command: "ls" },
      origin: { kind: "browser" },
    });
  });

  it("treats an answer naming an option the agent never offered as a cancel", async () => {
    const { open } = setup();
    const browser = open();
    browser.onAsk = () => ({ outcome: { outcome: "selected", optionId: "allow-everything" } });
    const sessionId = await browser.newSession();
    await browser.prompt(sessionId, "ask:Bash");
    expect(browser.textOf(sessionId)).toEqual(['outcome:{"outcome":"cancelled"}']);
  });

  it("answers locally when the policy allows the tool, without asking the browser", async () => {
    const policy = createLocalPolicy({ allowedTools: ["Bash"], homedir: root });
    const { open } = setup({ policy });
    const browser = open();
    const sessionId = await browser.newSession();
    await browser.prompt(sessionId, "ask:Bash");
    expect(browser.asks).toHaveLength(0);
    expect(browser.textOf(sessionId)).toEqual(['outcome:{"outcome":"selected","optionId":"allow-once"}']);
  });

  it("still asks for a different tool, and for a request that names no tool", async () => {
    const policy = createLocalPolicy({ allowedTools: ["Bash"], homedir: root });
    const { open } = setup({ policy });
    const browser = open();
    browser.onAsk = () => ({ outcome: { outcome: "selected", optionId: "reject-once" } });
    const sessionId = await browser.newSession();
    await browser.prompt(sessionId, "ask:Edit");
    await browser.prompt(sessionId, "ask-noname");
    expect(browser.asks).toHaveLength(2);
  });

  it("lets the policy cancel, and treats a policy that throws or names a bad option as a cancel", async () => {
    for (const decide of [
      () => ({ action: "cancel" }) as PolicyDecision,
      () => ({ action: "select", optionId: "bogus" }) as PolicyDecision,
      () => {
        throw new Error("policy bug");
      },
    ]) {
      const { policy } = policyOf(decide);
      const { open } = setup({ policy });
      const browser = open();
      const sessionId = await browser.newSession();
      await browser.prompt(sessionId, "ask:Bash");
      expect(browser.asks).toHaveLength(0);
      expect(browser.textOf(sessionId)).toEqual(['outcome:{"outcome":"cancelled"}']);
    }
  });

  it("answers an approval that is waiting on the browser as cancelled when the turn is cancelled", async () => {
    const { open } = setup();
    const browser = open(); // onAsk never answers
    const sessionId = await browser.newSession();
    const turn = browser.prompt(sessionId, "ask:Bash");
    await until(() => browser.asks.length === 1);
    browser.notify("session/cancel", { sessionId });
    expect(await turn).toEqual({ stopReason: "end_turn" });
    expect(browser.textOf(sessionId)).toEqual(['outcome:{"outcome":"cancelled"}']);
  });
});

describe("cancel and cleanup", () => {
  it("forgets the approval when a synchronous channel delivers the cancel during send", async () => {
    const { proxy } = setup();
    let sessionId = "";
    let cancelled = false;
    const m = memoryChannel({
      onSend(msg, toProxy) {
        if (msg.method === "session/request_permission" && !cancelled) {
          cancelled = true;
          toProxy({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
        }
      },
    });
    proxy.attach(m.channel);
    const browser = m.client;
    sessionId = await browser.newSession();
    expect(await browser.prompt(sessionId, "ask:Bash")).toEqual({ stopReason: "end_turn" });
    expect(cancelled).toBe(true);
    expect(pendingTotal()).toBe(0);
  });

  it("leaves no pending browser request after cancelled turns or after the session closes", async () => {
    const { open } = setup();
    const browser = open(); // onAsk never answers
    const sessionId = await browser.newSession();
    for (let i = 1; i <= 3; i++) {
      const turn = browser.prompt(sessionId, "ask:Bash");
      await until(() => browser.asks.length === i);
      browser.notify("session/cancel", { sessionId });
      await turn;
    }
    expect(pendingTotal()).toBe(0);

    const turn = browser.prompt(sessionId, "ask:Bash").catch(() => undefined);
    await until(() => browser.asks.length === 4);
    expect(pendingTotal()).toBeGreaterThan(0);
    await browser.request("session/close", { sessionId });
    await turn;
    expect(pendingTotal()).toBe(0);
  });

  it("answers as cancelled a permission that was cancelled while local policy was still deciding", async () => {
    let release!: (d: PolicyDecision) => void;
    const { policy, seen } = policyOf(() => new Promise<PolicyDecision>((r) => (release = r)) as unknown as PolicyDecision);
    const { open } = setup({ policy });
    const browser = open();
    const sessionId = await browser.newSession();
    const turn = browser.prompt(sessionId, "ask:Bash");
    await until(() => seen.length === 1);
    browser.notify("session/cancel", { sessionId });
    await new Promise((r) => setTimeout(r, 50));
    // Policy answers late; the cancelled turn must not get its allow_once.
    release({ action: "select", optionId: "allow-once" });
    expect(await turn).toEqual({ stopReason: "end_turn" });
    expect(browser.textOf(sessionId)).toEqual(['outcome:{"outcome":"cancelled"}']);
    expect(browser.asks).toHaveLength(0);
  });

  it("answers a cancelled permission at once even when local policy never answers", async () => {
    const { policy, seen } = policyOf(() => new Promise<PolicyDecision>(() => undefined) as unknown as PolicyDecision);
    const { open } = setup({ policy });
    const browser = open();
    const sessionId = await browser.newSession();
    const turn = browser.prompt(sessionId, "ask:Bash");
    await until(() => seen.length === 1);
    browser.notify("session/cancel", { sessionId });
    // The policy promise is never released.
    expect(await turn).toEqual({ stopReason: "end_turn" });
    expect(browser.textOf(sessionId)).toEqual(['outcome:{"outcome":"cancelled"}']);
    expect(browser.asks).toHaveLength(0);
  });

  it("does not let a cancel that was already handled cancel a later permission", async () => {
    const { open } = setup();
    const browser = open();
    browser.onAsk = () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });
    const sessionId = await browser.newSession();
    browser.notify("session/cancel", { sessionId });
    await new Promise((r) => setTimeout(r, 30));
    await browser.prompt(sessionId, "ask:Bash");
    expect(browser.textOf(sessionId)).toEqual(['outcome:{"outcome":"selected","optionId":"allow-once"}']);
  });

  it("forwards session/cancel and the agent ends the turn as cancelled", async () => {
    const { open } = setup();
    const browser = open();
    const sessionId = await browser.newSession();
    const turn = browser.prompt(sessionId, "hang");
    await new Promise((r) => setTimeout(r, 50));
    browser.notify("session/cancel", { sessionId });
    expect(await turn).toEqual({ stopReason: "cancelled" });
  });

  it("kills a session's agent process when the channel closes", async () => {
    const { open, proxy } = setup();
    const browser = open();
    const sessionId = await browser.newSession();
    const { pid } = await browser.info(sessionId);
    expect(alive(pid)).toBe(true);
    browser.close();
    await until(() => !alive(pid));
    expect(proxy.sessionCount()).toBe(0);
  });

  it("fails the browser's in-flight prompt and cleans up when the agent dies", async () => {
    const { open, proxy } = setup();
    const browser = open();
    const sessionId = await browser.newSession();
    const { pid } = await browser.info(sessionId);
    const turn = browser.prompt(sessionId, "hang");
    await new Promise((r) => setTimeout(r, 30));
    process.kill(pid, "SIGKILL");
    await expect(turn).rejects.toBeDefined();
    await until(() => proxy.sessionCount() === 0);
    await expect(browser.prompt(sessionId, "hello")).rejects.toMatchObject({ code: PROXY_ERROR.unknownSession });
  });

  it("kills the descendants an agent left behind when the agent itself exits", async () => {
    const { open, proxy } = setup();
    const browser = open();
    const sessionId = await browser.newSession();
    await browser.prompt(sessionId, "leak");
    const { child, agent } = JSON.parse(browser.textOf(sessionId)[0]!.replace(/^leak:/, "")) as { child: number; agent: number };
    try {
      await until(() => !alive(agent));
      // Descendant death and adapter cleanup complete separately. Check both the
      // child shutdown and the eventual session removal without a close().
      await until(() => !alive(child));
      await until(() => proxy.sessionCount() === 0);
      expect(proxy.sessionCount()).toBe(0);
    } finally {
      if (alive(child)) process.kill(child, "SIGKILL");
    }
  });

  it("session/close ends one session and leaves the others", async () => {
    const { open, proxy } = setup();
    const browser = open();
    const a = await browser.newSession();
    const b = await browser.newSession();
    const { pid } = await browser.info(a);
    await browser.request("session/close", { sessionId: a });
    await until(() => !alive(pid));
    expect(proxy.sessionCount()).toBe(1);
    expect(await browser.prompt(b, "hello")).toEqual({ stopReason: "end_turn" });
  });

  it("proxy.close() kills every agent and detaches every channel", async () => {
    const { open, proxy } = setup();
    const one = open();
    const two = open();
    const pids = [await one.info(await one.newSession()), await two.info(await two.newSession())].map((i) => i.pid);
    await proxy.close();
    expect(pids.map(alive)).toEqual([false, false]);
    expect(proxy.sessionCount()).toBe(0);
    expect(() => proxy.attach(memoryChannel({ appId: "app-a" }).channel)).toThrow(/closed/);
  });

  it("kills an agent whose spawn is still running when its channel closes, before sending it anything", async () => {
    let started: { pid?: number; kill(): Promise<void> } | undefined;
    const inner = stubAdapter("late");
    const late: AgentAdapter = {
      id: "late",
      availability: async () => ({ id: "late", available: true }),
      spawn: async (o) => {
        await new Promise((r) => setTimeout(r, 250)); // credential staging, mkdtemp ...
        const proc = await inner.spawn({ cwd: o.cwd }); // ignores the signal, as a plain adapter may
        started = proc;
        return proc;
      },
    };
    const { open, proxy } = setup({ adapters: [late] });
    const browser = open();
    const opening = browser.newSession().catch((e) => e as Error);
    await new Promise((r) => setTimeout(r, 40));
    browser.close();
    await proxy.close(); // waits for the spawn to finish and for the kill
    expect(started).toBeDefined();
    expect(alive(started!.pid!)).toBe(false);
    expect(proxy.sessionCount()).toBe(0);
    void opening;
  });

  it("starts no agent for a session/new that was still choosing an adapter when its channel closed", async () => {
    let spawned = 0;
    const inner = stubAdapter("slow-pick");
    const slowPick: AgentAdapter = {
      id: "slow-pick",
      availability: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return { id: "slow-pick", available: true };
      },
      spawn: async (o) => {
        spawned += 1;
        return inner.spawn({ cwd: o.cwd });
      },
    };
    const { open, proxy } = setup({ adapters: [slowPick] });
    const browser = open();
    const opening = browser.newSession().catch((e) => e as Error);
    await new Promise((r) => setTimeout(r, 30));
    browser.close();
    await proxy.close();
    await new Promise((r) => setTimeout(r, 250));
    expect(spawned).toBe(0);
    expect(proxy.sessionCount()).toBe(0);
    void opening;
  });

  it("passes the proxy's app id to spawn", async () => {
    let seen: string | undefined;
    const inner = stubAdapter("appid");
    const adapter: AgentAdapter = {
      id: "appid",
      availability: async () => ({ id: "appid", available: true }),
      spawn: async (o) => {
        seen = o.appId;
        return inner.spawn(o);
      },
    };
    const { open } = setup({ appId: "app-a", adapters: [adapter] });
    await open().newSession();
    expect(seen).toBe("app-a");
  });

  it("passes an abort signal to spawn that fires when the channel closes", async () => {
    let signal: AbortSignal | undefined;
    const inner = stubAdapter("sig");
    const adapter: AgentAdapter = {
      id: "sig",
      availability: async () => ({ id: "sig", available: true }),
      spawn: async (o) => {
        signal = o.signal;
        await new Promise((r) => setTimeout(r, 150));
        if (o.signal?.aborted) throw new Error("spawn aborted");
        return inner.spawn(o);
      },
    };
    const { open, proxy } = setup({ adapters: [adapter] });
    const browser = open();
    const opening = browser.newSession().catch((e) => e as Error);
    await new Promise((r) => setTimeout(r, 30));
    browser.close();
    expect(await opening).toMatchObject({ code: RPC_ERROR.closed });
    expect(signal?.aborted).toBe(true);
    expect(proxy.sessionCount()).toBe(0);
  });

  it("kills an agent that is still starting when its channel closes", async () => {
    let spawnedPid = 0;
    const slow: AgentAdapter = {
      id: "slow",
      availability: async () => ({ id: "slow", available: true }),
      spawn: async (o) => {
        const proc = await createAcpAgentAdapter({
          id: "slow",
          command: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"], // never answers initialize
          environment: { env: { PATH: path.dirname(process.execPath) }, homedir: root, tmpBase },
          killGraceMs: 100,
        }).spawn(o);
        spawnedPid = proc.pid!;
        return proc;
      },
    };
    const { open } = setup({ adapters: [slow] });
    const browser = open();
    const starting = browser.newSession().catch((e) => e);
    await until(() => spawnedPid > 0);
    browser.close();
    await until(() => !alive(spawnedPid));
    expect(await starting).toBeInstanceOf(Error);
  });
});

describe("per-app scoping", () => {
  it("refuses a channel that belongs to another app connection", () => {
    const { proxy } = setup({ appId: "app-a" });
    expect(() => proxy.attach(memoryChannel({ appId: "app-b" }).channel)).toThrow(/another app/);
    expect(proxy.appId).toBe("app-a");
  });

  it("does not let one channel, or another app's proxy, see a session it did not start", async () => {
    const a = setup({ appId: "app-a" });
    const b = setup({ appId: "app-b" });
    const owner = a.open({ browserKeyId: "k1" });
    const sibling = a.open({ browserKeyId: "k2" });
    const stranger = b.open();
    const sessionId = await owner.newSession();
    const { pid } = await owner.info(sessionId);

    for (const other of [sibling, stranger]) {
      await expect(other.prompt(sessionId, "hello")).rejects.toMatchObject({ code: PROXY_ERROR.unknownSession });
      await expect(other.request("session/close", { sessionId })).rejects.toMatchObject({ code: PROXY_ERROR.unknownSession });
      other.notify("session/cancel", { sessionId }); // silently ignored
    }
    expect(alive(pid)).toBe(true);
    expect(await owner.prompt(sessionId, "hello")).toEqual({ stopReason: "end_turn" });
    expect(a.proxy.sessionCount()).toBe(1);
    expect(b.proxy.sessionCount()).toBe(0);
  });

  it("refuses a brokered session for another app connection", async () => {
    const { proxy } = setup({ appId: "app-a" });
    await expect(proxy.broker.start({ pluginId: "p", appId: "app-b", agent: "stub" })).rejects.toMatchObject({ code: PROXY_ERROR.sessionNotAllowed });
  });
});

describe("extension methods", () => {
  function fakeRouter() {
    const calls: { caller: ExtensionCaller; method: string; params: unknown; kind: "request" | "notify" }[] = [];
    let push: ((m: JsonRpcMessage) => void) | undefined;
    let unsubscribed = 0;
    const router: ExtensionRouter = {
      handles: (method) => method.startsWith("_known/"),
      async request(caller, method, params) {
        calls.push({ caller, method, params, kind: "request" });
        if (method === "_known/fail") throw { code: -32050, message: "plugin said no" };
        if (method === "_known/failData") throw { code: -32051, message: "plugin said no", data: { field: "title", hint: "too long" } };
        if (method === "_known/crash") throw new Error("internal path /home/x leaked");
        if (method === "_known/forbidden") throw { code: PROXY_ERROR.extensionForbidden, message: "wrong app" };
        return { echoed: params };
      },
      notify(caller, method, params) {
        calls.push({ caller, method, params, kind: "notify" });
      },
      subscribe(_caller, p) {
        push = p;
        return () => {
          unsubscribed += 1;
        };
      },
    };
    return { router, calls, push: (m: JsonRpcMessage) => push?.(m), unsubscribed: () => unsubscribed };
  }

  it("routes _<pluginId>/ requests and notifications to the router with the caller's identity", async () => {
    const fake = fakeRouter();
    const { open } = setup({ extensions: fake.router });
    const browser = open({ channelId: "chan-7", browserKeyId: "key-7" });
    expect(await browser.request("_known/echo", { a: 1 })).toEqual({ echoed: { a: 1 } });
    browser.notify("_known/ping", { b: 2 });
    await until(() => fake.calls.length === 2);
    expect(fake.calls[0]).toMatchObject({ kind: "request", method: "_known/echo", caller: { appId: "app-a", channelId: "chan-7", browserKeyId: "key-7" } });
    expect(fake.calls[1]).toMatchObject({ kind: "notify", method: "_known/ping", params: { b: 2 } });
  });

  it("passes plugin errors through with their codes and hides anything else", async () => {
    const fake = fakeRouter();
    const { open } = setup({ extensions: fake.router });
    const browser = open();
    await expect(browser.request("_known/fail")).rejects.toMatchObject({ code: -32050, message: "plugin said no" });
    await expect(browser.request("_known/forbidden")).rejects.toMatchObject({ code: PROXY_ERROR.extensionForbidden });
    const failure = await browser.request("_known/fail").catch((e) => e as { data?: unknown });
    expect((failure as { data?: unknown }).data).toBeUndefined();
    const crash = await browser.request("_known/crash").catch((e) => e as { code: number; message: string });
    expect(crash).toMatchObject({ code: RPC_ERROR.internal });
    expect(JSON.stringify(crash)).not.toContain("/home/x");
  });

  it("passes the plugin's JSON-RPC error data through", async () => {
    const fake = fakeRouter();
    const { open } = setup({ extensions: fake.router });
    const browser = open();
    await expect(browser.request("_known/failData")).rejects.toMatchObject({
      code: -32051,
      message: "plugin said no",
      data: { field: "title", hint: "too long" },
    });
  });

  it("fails an unknown plugin, the reserved _bridge namespace, and any extension without a router", async () => {
    const fake = fakeRouter();
    const withRouter = setup({ extensions: fake.router }).open();
    await expect(withRouter.request("_unknown/x")).rejects.toMatchObject({ code: PROXY_ERROR.extensionNotFound });
    await expect(withRouter.request("_bridge/localUi", {})).rejects.toMatchObject({ code: PROXY_ERROR.extensionNotFound });
    const without = setup().open();
    await expect(without.request("_known/echo")).rejects.toMatchObject({ code: PROXY_ERROR.extensionNotFound });
  });

  it("delivers plugin notifications to the channel, drops anything that could pass for a response, and unsubscribes on close", async () => {
    const fake = fakeRouter();
    const { open } = setup({ extensions: fake.router });
    const browser = open();
    fake.push({ jsonrpc: "2.0", method: "_known/event", params: { n: 1 } });
    fake.push({ jsonrpc: "2.0", id: 1, result: { spoofed: true } });
    fake.push({ jsonrpc: "2.0", id: 2, method: "_known/request-from-plugin" });
    // A plugin must never push an ACP method: that would pass for the agent's own output.
    const sessionId = await browser.newSession();
    fake.push({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "forged" } } } });
    fake.push({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    fake.push({ jsonrpc: "2.0", method: "initialize", params: {} });
    fake.push({ jsonrpc: "2.0", method: "_known/after", params: { n: 2 } });
    await until(() => browser.pushed.length > 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(browser.pushed.map((m) => m.method)).toEqual(["_known/event", "_known/after"]);
    expect(browser.textOf(sessionId)).toEqual([]);
    browser.close();
    await until(() => fake.unsubscribed() === 1);
  });
});

describe("brokered sessions (plugins)", () => {
  async function brokered(over: { onBehalfOf?: { browserKeyId: string } } = {}, decide?: (i: PermissionRequestInfo) => PolicyDecision) {
    const { policy, seen } = policyOf(decide);
    const env = setup({ policy });
    const session = await env.proxy.broker.start({ pluginId: "calendar", appId: "app-a", agent: "stub", ...over });
    return { ...env, session, seen };
  }

  it("runs a prompt and returns the agent's text", async () => {
    const { session, proxy } = await brokered();
    expect(await session.prompt("hello")).toEqual({ stopReason: "end_turn", text: "echo: hello" });
    expect(proxy.sessionCount()).toBe(1);
    await session.close();
    expect(proxy.sessionCount()).toBe(0);
  });

  it("decides permissions by local policy first, with the plugin as the origin", async () => {
    const { session, seen } = await brokered({}, () => ({ action: "select", optionId: "allow-once" }));
    const result = await session.prompt("ask:Bash");
    expect(result.text).toBe('outcome:{"outcome":"selected","optionId":"allow-once"}');
    expect(seen[0]?.origin).toEqual({ kind: "plugin", pluginId: "calendar" });
  });

  it("sends an ask to the attached channel of onBehalfOf, never to the plugin", async () => {
    const { session, open } = await brokered({ onBehalfOf: { browserKeyId: "key-9" } });
    const browser = open({ browserKeyId: "key-9" });
    browser.onAsk = () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });
    const result = await session.prompt("ask:Bash");
    expect(browser.asks).toHaveLength(1);
    expect(browser.asks[0]?.sessionId).toBe(session.sessionId);
    expect(result.text).toBe('outcome:{"outcome":"selected","optionId":"allow-once"}');
  });

  it("cancels an ask when the plugin acts for no browser", async () => {
    const { session, open } = await brokered();
    const browser = open({ browserKeyId: "key-9" });
    const result = await session.prompt("ask:Bash");
    expect(browser.asks).toHaveLength(0);
    expect(result.text).toBe('outcome:{"outcome":"cancelled"}');
  });

  it("cancels an ask when the named browser is not attached, or is a different browser", async () => {
    const { session, open } = await brokered({ onBehalfOf: { browserKeyId: "key-9" } });
    const other = open({ browserKeyId: "key-other" });
    const result = await session.prompt("ask:Bash");
    expect(other.asks).toHaveLength(0);
    expect(result.text).toBe('outcome:{"outcome":"cancelled"}');
  });

  it("cancels an ask that is waiting when the browser's channel closes", async () => {
    const { session, open } = await brokered({ onBehalfOf: { browserKeyId: "key-9" } });
    const browser = open({ browserKeyId: "key-9" });
    const turn = session.prompt("ask:Bash");
    await until(() => browser.asks.length === 1);
    browser.close();
    expect((await turn).text).toBe('outcome:{"outcome":"cancelled"}');
    // And a later ask finds no channel.
    expect((await session.prompt("ask:Bash")).text).toBe('outcome:{"outcome":"cancelled"}');
  });

  it("can be cancelled, and is killed by proxy.close()", async () => {
    const { session, proxy } = await brokered();
    const turn = session.prompt("hang");
    await new Promise((r) => setTimeout(r, 50));
    await session.cancel();
    expect((await turn).stopReason).toBe("cancelled");
    await proxy.close();
    expect(proxy.sessionCount()).toBe(0);
  });

  it("kills a brokered agent that is still starting as soon as proxy.close() is called", async () => {
    let spawnedPid = 0;
    const slow: AgentAdapter = {
      id: "slow",
      availability: async () => ({ id: "slow", available: true }),
      spawn: async (o) => {
        const proc = await createAcpAgentAdapter({
          id: "slow",
          command: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"], // never answers initialize
          environment: { env: { PATH: path.dirname(process.execPath) }, homedir: root, tmpBase },
          killGraceMs: 100,
        }).spawn(o);
        spawnedPid = proc.pid!;
        return proc;
      },
    };
    const { proxy } = setup({ adapters: [slow] });
    const starting = proxy.broker.start({ pluginId: "p", appId: "app-a", agent: "slow" }).catch((e) => e as Error);
    await until(() => spawnedPid > 0);
    // Not left to the 30 s start timeout: close() ends the agent and returns promptly.
    await proxy.close();
    expect(alive(spawnedPid)).toBe(false);
    expect(await starting).toBeInstanceOf(Error);
    expect(proxy.sessionCount()).toBe(0);
  }, 4000);

  it("is subject to the same local session policy and agent list", async () => {
    const { policy } = policyOf(undefined, () => false);
    const { proxy } = setup({ policy });
    await expect(proxy.broker.start({ pluginId: "p", appId: "app-a", agent: "stub" })).rejects.toMatchObject({ code: PROXY_ERROR.sessionNotAllowed });
    const second = setup();
    await expect(second.proxy.broker.start({ pluginId: "p", appId: "app-a", agent: "nope" })).rejects.toMatchObject({ code: PROXY_ERROR.unknownAgent });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Contained plugin sessions. The agent here is scripted in memory: no process, no claude.
// ---------------------------------------------------------------------------------------------------------------

type Frame = Record<string, unknown>;
type AgentOutcome = { outcome: { outcome: string; optionId?: string } };

/** The agent's side of one spawned session: what it was sent, and a way to talk back as the agent. */
interface ScriptedAgent {
  received: { method: string; params: unknown }[];
  isExited: boolean;
  exit(code: number | null, signal?: string | null): void;
  update(update: Frame): void;
  /** Sends `session/request_permission` and resolves with the proxy's answer. */
  ask(toolCall: Frame, options?: { optionId: string; name: string; kind: string }[]): Promise<AgentOutcome>;
}

interface ScriptedOptions {
  id?: string;
  /** `null`: the adapter has no containment profile (codex). */
  profile?: ContainmentProfile | null;
  /** The adapter's `containmentRefusalReason()`: why it has no profile, when the cause has a fixed code. */
  refusalReason?: ContainmentRefusalReason;
  /** `null`: the process returns no `sessionNew`. */
  sessionNew?: AgentProcess["sessionNew"] | null;
  spawnError?: Error;
  /** The spawn takes this long to return. */
  spawnDelayMs?: number;
  /** The process's `exited` never settles, even after a kill: nothing but the start's own failure path can release the session. */
  exitedNeverSettles?: boolean;
  newSession?: (params: unknown, agent: ScriptedAgent) => unknown;
  onPrompt?: (params: { prompt: { text: string }[] }, agent: ScriptedAgent) => Promise<unknown> | unknown;
}

const CLAUDE_PROFILE = claudeProfileOf(CLAUDE_MEASURED_STACKS[0]!);
const PROFILE_SESSION_NEW: NonNullable<AgentProcess["sessionNew"]> = {
  mcpServers: [{ name: "stub", command: "/usr/bin/node", args: ["/plugin/mcp.js", "--secret-file", "/run/secret/stub"], env: [] }],
  _meta: { claudeCode: { options: { tools: [], settingSources: [] } } },
};
const NEVER = new Promise<never>(() => undefined);

function linkedStreams(): [MessageStream<JsonRpcMessage>, MessageStream<JsonRpcMessage>] {
  let closed = false;
  const onMessage = [new Set<(m: JsonRpcMessage) => void>(), new Set<(m: JsonRpcMessage) => void>()] as const;
  const onClose = [new Set<(r?: string) => void>(), new Set<(r?: string) => void>()] as const;
  const side = (me: 0 | 1): MessageStream<JsonRpcMessage> => ({
    get closed() {
      return closed;
    },
    send(m) {
      if (closed) return;
      // What was sent while the pipe was open arrives even if it closes right after (a cancel followed by a kill).
      queueMicrotask(() => {
        for (const h of [...onMessage[me === 0 ? 1 : 0]]) h(m);
      });
    },
    onMessage(h) {
      onMessage[me].add(h);
      return () => onMessage[me].delete(h);
    },
    onClose(h) {
      onClose[me].add(h);
      return () => onClose[me].delete(h);
    },
    close(reason) {
      if (closed) return;
      closed = true;
      for (const h of [...onClose[0], ...onClose[1]]) h(reason);
    },
  });
  return [side(0), side(1)];
}

/** An agent adapter whose processes are in-memory scripts. `agents` and `spawns` record what happened. */
function scriptedAdapter(opts: ScriptedOptions = {}) {
  const id = opts.id ?? "claude";
  const agents: ScriptedAgent[] = [];
  const spawns: (AgentSpawnOptions & { secretText?: string })[] = [];
  const adapter: AgentAdapter = {
    id,
    availability: async () => ({ id, available: true }),
    ...(opts.profile === null ? {} : { containment: () => opts.profile ?? CLAUDE_PROFILE }),
    ...(opts.refusalReason !== undefined ? { containmentRefusalReason: () => opts.refusalReason } : {}),
    async spawn(o) {
      // The secret is read now: the proxy hands over a buffer it expects the adapter to zero.
      spawns.push({ ...o, ...(o.containment?.secret ? { secretText: Buffer.from(o.containment.secret).toString("utf8") } : {}) });
      if (opts.spawnError) throw opts.spawnError;
      if (opts.spawnDelayMs) await new Promise((r) => setTimeout(r, opts.spawnDelayMs));
      const [procSide, agentSide] = linkedStreams();
      let resolveExited!: (e: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) => (resolveExited = r));
      const agent: ScriptedAgent = {
        received: [],
        isExited: false,
        exit(code, signal = null) {
          if (agent.isExited) return;
          agent.isExited = true;
          agentSide.close("exit");
          resolveExited({ code, signal });
        },
        update(update) {
          peer.notify("session/update", { sessionId: "agent-1", update });
        },
        async ask(toolCall, options) {
          return (await peer.request("session/request_permission", {
            sessionId: "agent-1",
            toolCall,
            options: options ?? [
              { optionId: "allow-once", name: "Allow", kind: "allow_once" },
              { optionId: "reject-once", name: "Reject", kind: "reject_once" },
            ],
          })) as AgentOutcome;
        },
      };
      const peer = createRpcPeer(agentSide, {
        onRequest(method, params) {
          agent.received.push({ method, params });
          switch (method) {
            case "initialize":
              return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
            case "session/new":
              return opts.newSession
                ? opts.newSession(params, agent)
                : {
                    sessionId: "agent-1",
                    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
                    configOptions: [
                      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [] },
                      { id: "model", name: "Model", category: "model", type: "select", currentValue: "default", options: [] },
                    ],
                  };
            case "session/prompt":
              return opts.onPrompt ? opts.onPrompt(params as { prompt: { text: string }[] }, agent) : { stopReason: "end_turn" };
            case "session/set_config_option":
              return { configOptions: [] };
            default:
              throw new RpcError(RPC_ERROR.methodNotFound, `method not found: ${method}`);
          }
        },
        onNotification(method, params) {
          agent.received.push({ method, params });
        },
      });
      agents.push(agent);
      return {
        stream: procSide,
        exited: opts.exitedNeverSettles ? NEVER : exited,
        async kill() {
          agent.exit(null, "SIGTERM");
          if (!opts.exitedNeverSettles) await exited;
        },
        ...(opts.sessionNew === null ? {} : { sessionNew: opts.sessionNew ?? PROFILE_SESSION_NEW }),
      };
    },
  };
  return { adapter, agents, spawns, last: () => agents[agents.length - 1]! };
}

const PLUGIN = "calendar";
const SERVER_ENTRY = "mcp.js";
const INSTALL_DIR = "/opt/bridge/plugins/calendar/1.0.0";
const DATA_DIR = "/opt/bridge/data/calendar";
const RESOLUTION: GrantResolution = { installDir: INSTALL_DIR, dataDir: DATA_DIR, surfaceSha256Of: () => "surface-hash" };
const TOOL_READ = "mcp__stub__read";
const TOOL_WRITE = "mcp__stub__write";

/** A request that passes `containedRequestProblem`: one attached server `stub`, `mcp__stub__read` consented and approved. */
function containedRequest(over: Partial<AgentSessionBrokerRequest> & { withSecret?: boolean } = {}): AgentSessionBrokerRequest {
  const { withSecret = false, ...rest } = over;
  const item = { name: "stub", entry: SERVER_ENTRY, args: withSecret ? ["--secret-file", "${SESSION_SECRET_FILE}"] : [] };
  const surface = {
    items: [
      { kind: "mcpServer" as const, value: JSON.stringify(item) },
      { kind: "headlessTool" as const, value: TOOL_READ },
      { kind: "headlessTool" as const, value: TOOL_WRITE },
    ],
  };
  const server = resolveGrantedServer(item, process.execPath, RESOLUTION)!;
  return {
    pluginId: PLUGIN,
    appId: "app-a",
    agent: "claude",
    mcpServers: ["stub"],
    servers: [server],
    tools: { allow: [TOOL_READ], builtins: "none" },
    ...(withSecret ? { secret: "unset" } : {}),
    grant: { pluginId: PLUGIN, appId: "app-a", version: "1.0.0", surface, surfaceSha256: "surface-hash", time: "2026-11-03T00:00:00.000Z" },
    ...rest,
  };
}

function toolFrame(id: string, toolName: string | undefined, extra: Frame = {}): Frame {
  return {
    sessionUpdate: "tool_call",
    toolCallId: id,
    title: `Run ${toolName ?? "tool"}`,
    kind: "other",
    status: "pending",
    ...(toolName ? { _meta: { claudeCode: { toolName } } } : {}),
    ...extra,
  };
}

function sha256Of(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("contained plugin sessions", () => {
  let sessionsDir: string;
  let auditDir: string;
  let audits: Map<string, FileAuditLog>;
  let logCalls: { level: string; message: string; fields?: Record<string, unknown> }[];

  beforeEach(() => {
    sessionsDir = path.join(root, "sessions");
    auditDir = path.join(root, "audit");
    audits = new Map();
    logCalls = [];
  });

  const auditLogOf = (pluginId: string): FileAuditLog => {
    let log = audits.get(pluginId);
    if (!log) {
      log = createAuditLog(path.join(auditDir, `${pluginId}.jsonl`));
      audits.set(pluginId, log);
    }
    return log;
  };
  const auditLines = (pluginId = PLUGIN): AuditRecord[] => {
    try {
      return readFileSync(path.join(auditDir, `${pluginId}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AuditRecord);
    } catch {
      return [];
    }
  };

  function containedSetup(
    over: {
      adapters?: AgentAdapter[];
      policy?: LocalPolicy;
      ceiling?: { wallClockMs?: number; maxToolCalls?: number };
      contained?: ContainedSessionSupport | null;
      startTimeoutMs?: number;
      extensions?: ExtensionRouter;
    } = {},
  ) {
    const seen: PermissionRequestInfo[] = [];
    const containedCalls: unknown[] = [];
    const sessionCalls: unknown[] = [];
    const real = createLocalPolicy({
      homedir: root,
      auditFailed: (pluginId) => audits.get(pluginId)?.failed ?? false,
      ...(over.ceiling ? { sessionBudget: over.ceiling } : {}),
    });
    const policy: LocalPolicy = over.policy ?? {
      ...real,
      allowSession(request) {
        sessionCalls.push(request);
        return real.allowSession(request);
      },
      allowContainedSession(request) {
        containedCalls.push(request);
        return real.allowContainedSession!(request);
      },
      decidePermission(info) {
        seen.push(info);
        return real.decidePermission(info);
      },
    };
    const proxy = createAcpProxy({
      appId: "app-a",
      adapters: over.adapters ?? [],
      policy,
      extensions: over.extensions,
      defaultCwd: project,
      log: (level, message, fields) => logCalls.push({ level, message, ...(fields ? { fields } : {}) }),
      ...(over.startTimeoutMs !== undefined ? { startTimeoutMs: over.startTimeoutMs } : {}),
      ...(over.contained === null ? {} : { contained: over.contained ?? { sessionsDir, auditLogOf, resolutionOf: () => RESOLUTION } }),
    });
    cleanups.push(() => proxy.close());
    const open = (opts: Parameters<typeof memoryChannel>[0] = {}) => {
      const sent: JsonRpcMessage[] = [];
      const m = memoryChannel({ appId: "app-a", ...opts, onSend: (msg) => sent.push(msg) });
      proxy.attach(m.channel);
      return Object.assign(m.client, { sent });
    };
    return { proxy, open, seen, containedCalls, sessionCalls };
  }

  /** Starts a contained session and collects its events and its end. */
  async function startSession(env: ReturnType<typeof containedSetup>, over: Parameters<typeof containedRequest>[0] = {}) {
    const session = await env.proxy.broker.start(containedRequest(over));
    const events: SessionEvent[] = [];
    session.onUpdate!((e) => events.push(e));
    const ends: SessionEndReason[] = [];
    void session.ended!.then((e) => ends.push(e.reason));
    return { session, events, ends };
  }

  describe("start", () => {
    it("sends session/new with the profile's own parameters and the minted folder, and spawns through allowContainedSession", async () => {
      const stub = scriptedAdapter();
      // allowedCwds names another folder: allowSession would refuse the sessions dir, allowContainedSession does not look at it.
      const policy = createLocalPolicy({ homedir: root, allowedCwds: ["/elsewhere"], auditFailed: () => false, warn: () => undefined });
      const env = containedSetup({ adapters: [stub.adapter], policy });
      const { session } = await startSession(env, { withSecret: true, secret: "the-session-secret", model: "claude-test" });

      const cwd = path.join(sessionsDir, session.sessionId);
      expect(stub.spawns).toHaveLength(1);
      expect(stub.spawns[0]!.cwd).toBe(cwd);
      expect(stub.spawns[0]!.appId).toBe("app-a");
      expect(stub.spawns[0]!.containment).toMatchObject({
        sessionId: session.sessionId,
        allow: [TOOL_READ],
        model: "claude-test",
        servers: [{ name: "stub", command: process.execPath, args: [path.join(INSTALL_DIR, SERVER_ENTRY), "--secret-file", "${SESSION_SECRET_FILE}"] }],
      });
      expect(stub.spawns[0]!.secretText).toBe("the-session-secret");
      const sessionNew = stub.last().received.find((r) => r.method === "session/new")!;
      expect(sessionNew.params).toEqual({ cwd, ...PROFILE_SESSION_NEW });
      // No browser path: nothing but the profile's servers, no empty `mcpServers` of the browser kind.
      expect(env.proxy.sessionCount()).toBe(1);
    });

    it("asks allowContainedSession with the app and agent, never allowSession", async () => {
      const stub = scriptedAdapter();
      const env = containedSetup({ adapters: [stub.adapter] });
      await startSession(env, { model: "claude-test" });
      expect(env.containedCalls).toEqual([{ appId: "app-a", agentId: "claude", model: "claude-test" }]);
      expect(env.sessionCalls).toEqual([]);
    });

    it("refuses an agent without a containment profile (codex) with -32016 and spawns nothing", async () => {
      const codex = scriptedAdapter({ id: "codex", profile: null });
      const env = containedSetup({ adapters: [codex.adapter] });
      await expect(env.proxy.broker.start(containedRequest({ agent: "codex" }))).rejects.toMatchObject({ code: PROXY_ERROR.containmentUnavailable, message: "Contained session unavailable" });
      expect(codex.spawns).toHaveLength(0);
      expect(env.containedCalls).toEqual([]);
    });

    it("refuses a policy that cannot admit contained sessions, and a proxy without contained support, with -32016", async () => {
      const stub = scriptedAdapter();
      const noMember = containedSetup({ adapters: [stub.adapter], policy: { mode: "ask", allowSession: () => true, decidePermission: () => ({ action: "ask" }) } });
      await expect(noMember.proxy.broker.start(containedRequest())).rejects.toMatchObject({ code: PROXY_ERROR.containmentUnavailable });
      const noSupport = containedSetup({ adapters: [stub.adapter], contained: null });
      await expect(noSupport.proxy.broker.start(containedRequest())).rejects.toMatchObject({ code: PROXY_ERROR.containmentUnavailable });
      expect(stub.spawns).toHaveLength(0);
    });

    it("answers sessionNotAllowed, not a containment failure, when the policy refuses the agent or model", async () => {
      const stub = scriptedAdapter();
      const policy = createLocalPolicy({ homedir: root, agents: ["codex"], auditFailed: () => false });
      const env = containedSetup({ adapters: [stub.adapter], policy });
      await expect(env.proxy.broker.start(containedRequest())).rejects.toMatchObject({ code: PROXY_ERROR.sessionNotAllowed });
      expect(stub.spawns).toHaveLength(0);
    });

    it.each<[string, Partial<AgentSessionBrokerRequest>]>([
      ["mcpServers", { mcpServers: ["stub"] }],
      ["secret", { secret: "s" }],
      ["headless", { headless: true }],
      ["tools.allow", { tools: { allow: [TOOL_READ] } }],
      ["budget", { budget: { maxToolCalls: 3 } }],
    ])("refuses a request that is not contained but carries %s with -32016, before any spawn or policy call", async (_name, fields) => {
      const stub = scriptedAdapter();
      const env = containedSetup({ adapters: [stub.adapter] });
      await expect(env.proxy.broker.start({ pluginId: PLUGIN, appId: "app-a", agent: "claude", ...fields })).rejects.toMatchObject({ code: PROXY_ERROR.containmentUnavailable });
      expect(stub.spawns).toHaveLength(0);
      expect(env.sessionCalls).toEqual([]);
      expect(env.containedCalls).toEqual([]);
    });

    it("refuses a contained request that the consented grant does not back, before any spawn", async () => {
      const stub = scriptedAdapter();
      const env = containedSetup({ adapters: [stub.adapter] });
      await expect(env.proxy.broker.start(containedRequest({ grant: undefined }))).rejects.toMatchObject({ code: PROXY_ERROR.consentMissing });
      await expect(env.proxy.broker.start(containedRequest({ tools: { allow: ["mcp__stub__other"], builtins: "none" } }))).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
      await expect(env.proxy.broker.start(containedRequest({ cwd: "/home/me" }))).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
      await expect(env.proxy.broker.start(containedRequest({ budget: { maxToolCalls: 0 } }))).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
      expect(stub.spawns).toHaveLength(0);
    });

    it("maps an agent that errors on session/new, one that never answers, and one that exits 126 to -32016, killed and counted nowhere", async () => {
      const errors = scriptedAdapter({ newSession: () => { throw new RpcError(RPC_ERROR.internal, "boom", { details: "exited with code 126" }); } });
      const silent = scriptedAdapter({ newSession: () => NEVER });
      const exits = scriptedAdapter({ newSession: (_p, agent) => { agent.exit(126); return NEVER; } });
      const refused = scriptedAdapter({ newSession: () => ({ sessionId: "agent-1", modes: { currentModeId: "bypassPermissions", availableModes: [{ id: "bypassPermissions", name: "x" }] }, configOptions: [] }) });
      const cases = [errors, silent, exits, refused];
      for (const stub of cases) {
        const env = containedSetup({ adapters: [stub.adapter], startTimeoutMs: 150 });
        await expect(env.proxy.broker.start(containedRequest())).rejects.toMatchObject({ code: PROXY_ERROR.containmentUnavailable, message: "Contained session unavailable" });
        expect(stub.last().isExited).toBe(true);
        expect(env.proxy.sessionCount()).toBe(0);
      }
      // The detail is logged locally: the exit code of the one that died.
      expect(logCalls.some((c) => c.fields?.exitCode === 126)).toBe(true);
    });

    it("maps a spawn that throws, and a process with no session/new parameters, to -32016", async () => {
      const throws = scriptedAdapter({ spawnError: new ContainmentRefused("binary differs") });
      const noParams = scriptedAdapter({ sessionNew: null });
      for (const stub of [throws, noParams]) {
        const env = containedSetup({ adapters: [stub.adapter] });
        await expect(env.proxy.broker.start(containedRequest())).rejects.toMatchObject({ code: PROXY_ERROR.containmentUnavailable, message: "Contained session unavailable" });
        expect(env.proxy.sessionCount()).toBe(0);
      }
      expect(noParams.last().isExited).toBe(true);
    });

    describe("the reason code of a refusal", () => {
      const DETAIL = "/home/secret-user/.local/share/bridge/adapters exit 127 stderr: token=hunter2";
      const wireOf = async (promise: Promise<unknown>) => toWireError(await promise.then(() => undefined, (e: unknown) => e));

      it("a claude adapter that is not installed (no profile, reason adapter_missing) is -32016 with the reason and the hint", async () => {
        const stub = scriptedAdapter({ profile: null, refusalReason: "adapter_missing" });
        const env = containedSetup({ adapters: [stub.adapter] });
        expect(await wireOf(env.proxy.broker.start(containedRequest()))).toEqual({
          code: PROXY_ERROR.containmentUnavailable,
          message: "Contained session unavailable",
          data: { reason: "adapter_missing", hint: "bridge agent install claude" },
        });
        expect(stub.spawns).toHaveLength(0);
        expect(env.containedCalls).toEqual([]);
      });

      it("a spawn refused with the reason (the adapter vanished after the profile check) carries the reason, never the detail", async () => {
        const stub = scriptedAdapter({ spawnError: new ContainmentRefused(DETAIL, "adapter_missing") });
        const env = containedSetup({ adapters: [stub.adapter] });
        const wire = await wireOf(env.proxy.broker.start(containedRequest()));
        expect(wire).toEqual({ code: PROXY_ERROR.containmentUnavailable, message: "Contained session unavailable", data: { reason: "adapter_missing", hint: "bridge agent install claude" } });
        expect(JSON.stringify(wire)).not.toMatch(/secret-user|hunter2|127/);
        expect(env.proxy.sessionCount()).toBe(0);
      });

      it("every other refusal has no data, and the detail never reaches the caller", async () => {
        const noProfile = scriptedAdapter({ id: "codex", profile: null });
        const noParams = scriptedAdapter({ sessionNew: null });
        const spawnRefused = scriptedAdapter({ spawnError: new ContainmentRefused(DETAIL) });
        const spawnFailed = scriptedAdapter({ spawnError: new Error(DETAIL) });
        const sessionNewFails = scriptedAdapter({ newSession: () => { throw new RpcError(RPC_ERROR.internal, DETAIL, { details: DETAIL }); } });
        for (const [name, stub, agent] of [
          ["no profile and no reason", noProfile, "codex"],
          ["no session/new parameters", noParams, "claude"],
          ["a refusal without a reason", spawnRefused, "claude"],
          ["a spawn that fails", spawnFailed, "claude"],
          ["a session/new that fails", sessionNewFails, "claude"],
        ] as const) {
          const env = containedSetup({ adapters: [stub.adapter] });
          const wire = await wireOf(env.proxy.broker.start(containedRequest({ agent })));
          expect(wire, name).toEqual({ code: PROXY_ERROR.containmentUnavailable, message: "Contained session unavailable" });
          expect(JSON.stringify(wire), name).not.toMatch(/secret-user|hunter2/);
        }
      });

      it("a failing reason lookup reads as no reason", async () => {
        const stub = scriptedAdapter({ profile: null });
        stub.adapter.containmentRefusalReason = () => {
          throw new Error(DETAIL);
        };
        const env = containedSetup({ adapters: [stub.adapter] });
        expect(await wireOf(env.proxy.broker.start(containedRequest()))).toEqual({ code: PROXY_ERROR.containmentUnavailable, message: "Contained session unavailable" });
      });
    });

    it("still starts a non-contained plugin session as before, applying its model through the agent's own model option", async () => {
      const stub = scriptedAdapter();
      const { policy, seen } = policyOf();
      const allowSession = vi.fn(() => true);
      const env = setup({ adapters: [stub.adapter], policy: { ...policy, allowSession } });
      const session = await env.proxy.broker.start({ pluginId: PLUGIN, appId: "app-a", agent: "claude", model: "fast" });
      expect(allowSession).toHaveBeenCalledWith({ appId: "app-a", agentId: "claude", cwd: project, model: "fast" });
      expect(stub.last().received.find((r) => r.method === "session/set_config_option")?.params).toEqual({ sessionId: "agent-1", configId: "model", value: "fast" });
      expect(stub.spawns[0]!.containment).toBeUndefined();
      expect(seen).toHaveLength(0);
      await session.close();
    });
  });

  describe("frames: audit, breach, permissions", () => {
    it("audits an unprompted tool_call of an approved tool with decision none, counts it, and shows the plugin its own tool's input and result", async () => {
      const stub = scriptedAdapter({
        onPrompt: async (_p, agent) => {
          agent.update(toolFrame("c1", TOOL_READ, { rawInput: { query: "weekly" } }));
          agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: { rows: 2 } });
          agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
          return { stopReason: "end_turn" };
        },
      });
      const env = containedSetup({ adapters: [stub.adapter], ceiling: { maxToolCalls: 1 } });
      const { session, events, ends } = await startSession(env);
      expect(await session.prompt("go")).toEqual({ stopReason: "end_turn", text: "done" });

      const none = auditLines().filter((r) => r.decision === "none");
      expect(none).toHaveLength(1);
      expect(none[0]).toMatchObject({ pluginId: PLUGIN, appId: "app-a", sessionId: session.sessionId, toolCallId: "c1", toolName: TOOL_READ, status: "completed", servers: ["stub"], trigger: { kind: "headless" }, argsSha256: sha256Of({ query: "weekly" }) });
      expect(readFileSync(path.join(auditDir, `${PLUGIN}.jsonl`), "utf8")).not.toContain("weekly");
      // One call, the whole budget (1): it is counted, and the session is still up.
      expect(ends).toEqual([]);
      expect(events).toEqual([
        { type: "tool_call", id: "c1", toolName: TOOL_READ, kind: "other", status: "pending", title: `Run ${TOOL_READ}`, rawInput: { query: "weekly" } },
        { type: "tool_call_update", id: "c1", toolName: TOOL_READ, status: "completed", result: { rows: 2 } },
        { type: "text", text: "done" },
      ]);
    });

    it("kills the session when a tool outside the set is called: ended is breach, nothing more is delivered, the call is audited", async () => {
      const stub = scriptedAdapter({
        onPrompt: async (_p, agent) => {
          agent.update(toolFrame("c1", "Bash", { kind: "execute", rawInput: { command: "cat /etc/passwd" } }));
          agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after the breach" } });
          return NEVER;
        },
      });
      const env = containedSetup({ adapters: [stub.adapter] });
      const { session, events, ends } = await startSession(env);
      await expect(session.prompt("go")).rejects.toMatchObject({ code: PROXY_ERROR.containmentBreach });
      await until(() => ends.length === 1);
      expect(ends).toEqual(["breach"]);
      expect(stub.last().isExited).toBe(true);
      expect(events).toEqual([]);
      expect(env.proxy.sessionCount()).toBe(0);
      expect(auditLines()).toMatchObject([{ toolCallId: "c1", toolName: "Bash", status: "pending", sessionId: session.sessionId }]);
      const warn = logCalls.find((c) => c.level === "warn" && c.message.startsWith("containment breach"));
      expect(warn?.fields).toMatchObject({ toolName: "Bash" });
      expect(JSON.stringify(logCalls)).not.toContain("/etc/passwd");
    });

    it("treats an attached server's unlisted tool, a built-in kind with no name, and a frame with no id as breaches", async () => {
      const frames: Frame[] = [toolFrame("c1", "mcp__stub__other"), toolFrame("c1", undefined, { kind: "read" }), { sessionUpdate: "tool_call", status: "pending", _meta: { claudeCode: { toolName: TOOL_READ } } }];
      for (const frame of frames) {
        const stub = scriptedAdapter({ onPrompt: async (_p, agent) => { agent.update(frame); return NEVER; } });
        const env = containedSetup({ adapters: [stub.adapter] });
        const { session, ends } = await startSession(env);
        await expect(session.prompt("go")).rejects.toMatchObject({ code: PROXY_ERROR.containmentBreach });
        await until(() => ends.length === 1);
        expect(ends).toEqual(["breach"]);
      }
    });

    it("writes one digest-only audit record for a breach whatever frame showed it: initial, in-progress or terminal, with or without a call id", async () => {
      const raw = { command: "cat /etc/passwd" };
      const bash = { _meta: { claudeCode: { toolName: "Bash" } }, kind: "execute", rawInput: raw };
      const cases: [string, Frame, Partial<AuditRecord>][] = [
        ["an initial tool_call", { sessionUpdate: "tool_call", toolCallId: "c1", status: "pending", ...bash }, { toolCallId: "c1", toolName: "Bash", status: "pending" }],
        ["an in-progress update", { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress", ...bash }, { toolCallId: "c1", toolName: "Bash", status: "in_progress" }],
        ["a terminal update", { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", ...bash }, { toolCallId: "c1", toolName: "Bash", status: "completed" }],
        ["an update with no status", { sessionUpdate: "tool_call_update", toolCallId: "c1", ...bash }, { toolCallId: "c1", toolName: "Bash" }],
        ["a tool_call with no id", { sessionUpdate: "tool_call", status: "pending", ...bash }, { toolCallId: "tool_call_without_id", toolName: "Bash", status: "pending" }],
        ["an update with no id", { sessionUpdate: "tool_call_update", status: "in_progress", ...bash }, { toolCallId: "tool_call_update_without_id", toolName: "Bash", status: "in_progress" }],
        ["a frame with no id and no name", { sessionUpdate: "tool_call", status: "pending" }, { toolCallId: "tool_call_without_id", status: "pending" }],
      ];
      for (const [name, frame, expected] of cases) {
        const stub = scriptedAdapter({ onPrompt: async (_p, agent) => { agent.update(frame); return NEVER; } });
        const env = containedSetup({ adapters: [stub.adapter] });
        const { session, ends } = await startSession(env);
        await expect(session.prompt("go"), name).rejects.toMatchObject({ code: PROXY_ERROR.containmentBreach });
        await until(() => ends.length === 1);
        expect(ends, name).toEqual(["breach"]);
        const lines = auditLines().filter((r) => r.sessionId === session.sessionId);
        expect(lines, name).toHaveLength(1);
        expect(lines[0], name).toMatchObject({ pluginId: PLUGIN, appId: "app-a", trigger: { kind: "headless" }, servers: ["stub"], ...expected });
        if (frame.rawInput !== undefined) expect(lines[0], name).toMatchObject({ argsSha256: sha256Of(raw), argsBytes: JSON.stringify(raw).length });
        expect(readFileSync(path.join(auditDir, `${PLUGIN}.jsonl`), "utf8"), name).not.toContain("/etc/passwd");
        audits.clear();
      }
    });

    it("rejects an out-of-set mcp__ permission and audits it as reject, approves an in-set one as allow, and keeps the session up", async () => {
      let outcomes: AgentOutcome[] = [];
      const stub = scriptedAdapter({
        onPrompt: async (_p, agent) => {
          outcomes = [
            await agent.ask({ toolCallId: "p1", title: "x", kind: "other", rawInput: { a: 1 }, _meta: { claudeCode: { toolName: "mcp__stub__delete" } } }),
            await agent.ask({ toolCallId: "p2", title: "x", kind: "other", rawInput: { a: 2 }, _meta: { claudeCode: { toolName: TOOL_READ } } }),
          ];
          return { stopReason: "end_turn" };
        },
      });
      const env = containedSetup({ adapters: [stub.adapter] });
      const { session, ends } = await startSession(env);
      await session.prompt("go");
      expect(outcomes).toEqual([{ outcome: { outcome: "selected", optionId: "reject-once" } }, { outcome: { outcome: "selected", optionId: "allow-once" } }]);
      const decisions = Object.fromEntries(auditLines().map((r) => [r.toolCallId, r.decision]));
      expect(decisions).toEqual({ p1: "reject", p2: "allow" });
      expect(ends).toEqual([]);
      expect(env.seen[0]!.origin).toMatchObject({ kind: "plugin", pluginId: PLUGIN, contained: true, headless: true, allow: [TOOL_READ] });
    });

    describe("every permission outcome is audited where it is returned", () => {
      const decisionsOf = (toolCallId: string, sessionId?: string): (string | undefined)[] =>
        auditLines().filter((r) => r.toolCallId === toolCallId && (sessionId === undefined || r.sessionId === sessionId)).map((r) => r.decision);
      const TC = (id: string) => ({ toolCallId: id, title: "x", kind: "other", rawInput: { a: 1 }, _meta: { claudeCode: { toolName: TOOL_READ } } });
      /** A policy whose answer to a permission request is held until the test releases it. */
      function heldPolicy() {
        const real = createLocalPolicy({ homedir: root, auditFailed: (pluginId) => audits.get(pluginId)?.failed ?? false });
        let release!: (d: PolicyDecision) => void;
        let markAsked!: () => void;
        const asked = new Promise<void>((resolve) => (markAsked = resolve));
        const policy: LocalPolicy = {
          ...real,
          decidePermission: () =>
            new Promise<PolicyDecision>((resolve) => {
              release = resolve;
              markAsked();
            }),
        };
        return { policy, asked, release: (d: PolicyDecision) => release(d) };
      }

      it("records a cancel that wins over a policy still deciding, even when the session closes right after, and ignores the policy's late answer", async () => {
        for (const ending of ["cancel", "cancel then close"] as const) {
          const held = heldPolicy();
          let outcome: AgentOutcome | undefined;
          const stub = scriptedAdapter({ onPrompt: async (_p, agent) => { void agent.ask(TC("p1")).then((o) => (outcome = o), () => undefined); return NEVER; } });
          const env = containedSetup({ adapters: [stub.adapter], policy: held.policy });
          const { session } = await startSession(env);
          void session.prompt("go").catch(() => undefined);
          await held.asked;
          await session.cancel();
          if (ending === "cancel then close") await session.close();
          // The policy answers late, with an allow: it changes nothing that was returned or recorded.
          held.release({ action: "select", optionId: "allow-once" });
          await new Promise((r) => setTimeout(r, 50));
          expect(decisionsOf("p1", session.sessionId), ending).toEqual(["cancel"]);
          if (ending === "cancel") expect(outcome, ending).toEqual({ outcome: { outcome: "cancelled" } });
          audits.clear();
        }
      });

      it("records a cancel for a request with no options, and for a call over the budget", async () => {
        const outcomes: AgentOutcome[] = [];
        const stub = scriptedAdapter({
          onPrompt: async (_p, agent) => {
            outcomes.push(await agent.ask(TC("empty"), []));
            outcomes.push(await agent.ask(TC("c1")));
            outcomes.push(await agent.ask(TC("over")));
            return { stopReason: "end_turn" };
          },
        });
        const env = containedSetup({ adapters: [stub.adapter], ceiling: { maxToolCalls: 1 } });
        const { session, ends } = await startSession(env);
        await session.prompt("go").catch(() => undefined);
        await until(() => ends.length === 1);
        expect(ends).toEqual(["budget"]);
        expect(outcomes[0]).toEqual({ outcome: { outcome: "cancelled" } });
        expect(decisionsOf("empty")).toEqual(["cancel"]);
        expect(decisionsOf("c1")).toEqual(["allow"]);
        expect(decisionsOf("over")).toEqual(["cancel"]);
      });

      it("records exactly the outcome returned, for an allow, a reject and a policy that fails", async () => {
        const real = createLocalPolicy({ homedir: root, auditFailed: () => false });
        const answers: PolicyDecision[] = [{ action: "select", optionId: "allow-once" }, { action: "select", optionId: "reject-once" }, { action: "select", optionId: "no-such-option" }];
        let i = 0;
        const policy: LocalPolicy = { ...real, decidePermission: () => (i < answers.length ? answers[i++]! : Promise.reject(new Error("policy broke"))) };
        const outcomes: AgentOutcome[] = [];
        const stub = scriptedAdapter({ onPrompt: async (_p, agent) => { for (const id of ["a", "b", "c", "d"]) outcomes.push(await agent.ask(TC(id))); return { stopReason: "end_turn" }; } });
        const env = containedSetup({ adapters: [stub.adapter], policy });
        const { session } = await startSession(env);
        await session.prompt("go");
        expect(outcomes.map((o) => (o.outcome.outcome === "selected" ? o.outcome.optionId : "cancelled"))).toEqual(["allow-once", "reject-once", "cancelled", "cancelled"]);
        expect(["a", "b", "c", "d"].map((id) => decisionsOf(id))).toEqual([["allow"], ["reject"], ["cancel"], ["cancel"]]);
      });
    });

    it("never forwards an ask for a contained session to a browser: it is a rejection", async () => {
      let outcome: AgentOutcome | undefined;
      const stub = scriptedAdapter({ onPrompt: async (_p, agent) => { outcome = await agent.ask({ toolCallId: "p1", rawInput: { secretish: "RAW" }, _meta: { claudeCode: { toolName: TOOL_READ } } }); return { stopReason: "end_turn" }; } });
      const asking: LocalPolicy = { mode: "ask", allowSession: () => true, allowContainedSession: () => ({ allowed: true, budget: { wallClockMs: 60_000, maxToolCalls: 10 } }), decidePermission: () => ({ action: "ask" }) };
      const env = containedSetup({ adapters: [stub.adapter], policy: asking });
      const browser = env.open({ browserKeyId: "key-9" });
      browser.onAsk = () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });
      const { session } = await startSession(env, { onBehalfOf: { browserKeyId: "key-9" } });
      await session.prompt("go");
      expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
      expect(browser.asks).toHaveLength(0);
      expect(auditLines().find((r) => r.toolCallId === "p1")).toMatchObject({ decision: "reject" });
    });

    it("records a browser trigger when the request acts on behalf of a browser", async () => {
      const stub = scriptedAdapter({ onPrompt: async (_p, agent) => { agent.update(toolFrame("c1", TOOL_READ)); return { stopReason: "end_turn" }; } });
      const env = containedSetup({ adapters: [stub.adapter] });
      const { session } = await startSession(env, { onBehalfOf: { browserKeyId: "key-9" } });
      await session.prompt("go");
      expect(auditLines()[0]).toMatchObject({ trigger: { kind: "browser", browserKeyId: "key-9" } });
    });

    it("ends the session with breach when an audit write fails, and cancels the permission", async () => {
      writeFileSync(path.join(root, "audit-is-a-file"), "x");
      const broken = createAuditLog(path.join(root, "audit-is-a-file", `${PLUGIN}.jsonl`));
      let outcome: AgentOutcome | undefined;
      const stub = scriptedAdapter({ onPrompt: async (_p, agent) => { outcome = await agent.ask({ toolCallId: "p1", _meta: { claudeCode: { toolName: TOOL_READ } } }); return NEVER; } });
      const env = containedSetup({ adapters: [stub.adapter], contained: { sessionsDir, auditLogOf: () => broken, resolutionOf: () => RESOLUTION } });
      const { session, ends } = await startSession(env);
      await expect(session.prompt("go")).rejects.toMatchObject({ code: PROXY_ERROR.containmentBreach });
      await until(() => ends.length === 1);
      expect(ends).toEqual(["breach"]);
      expect(broken.failed).toBe(true);
      expect(outcome === undefined || outcome.outcome.outcome === "cancelled").toBe(true);
    });

    it("ends the session with breach when the frame itself cannot be audited", async () => {
      writeFileSync(path.join(root, "audit-is-a-file"), "x");
      const broken = createAuditLog(path.join(root, "audit-is-a-file", `${PLUGIN}.jsonl`));
      const stub = scriptedAdapter({ onPrompt: async (_p, agent) => { agent.update(toolFrame("c1", TOOL_READ)); return NEVER; } });
      const env = containedSetup({ adapters: [stub.adapter], contained: { sessionsDir, auditLogOf: () => broken, resolutionOf: () => RESOLUTION } });
      const { session, ends } = await startSession(env);
      await expect(session.prompt("go")).rejects.toMatchObject({ code: PROXY_ERROR.containmentBreach });
      await until(() => ends.length === 1);
      expect(ends).toEqual(["breach"]);
    });
  });

  describe("commands and slash prompts", () => {
    const commands = (...names: string[]): Frame => ({ sessionUpdate: "available_commands_update", availableCommands: names.map((name) => ({ name, description: "d" })) });

    it("kills the session on an available_commands_update naming init, and audits it", async () => {
      const stub = scriptedAdapter({ onPrompt: async (_p, agent) => { agent.update(commands("mcp", "remote-control", "init")); return NEVER; } });
      const env = containedSetup({ adapters: [stub.adapter] });
      const { session, ends } = await startSession(env);
      await expect(session.prompt("go")).rejects.toMatchObject({ code: PROXY_ERROR.containmentBreach });
      await until(() => ends.length === 1);
      expect(ends).toEqual(["breach"]);
      expect(stub.last().isExited).toBe(true);
      expect(auditLines()).toMatchObject([{ sessionId: session.sessionId, toolCallId: "available_commands_update", toolName: "/init" }]);
      expect(logCalls.find((c) => c.message.startsWith("containment breach"))?.fields).toMatchObject({ commands: ["init"] });
    });

    it("also treats an unreadable command list as outside, but not the two allowed names or a session with no update", async () => {
      const bad = scriptedAdapter({ onPrompt: async (_p, agent) => { agent.update({ sessionUpdate: "available_commands_update" }); return NEVER; } });
      const badEnv = containedSetup({ adapters: [bad.adapter] });
      const b = await startSession(badEnv);
      await expect(b.session.prompt("go")).rejects.toMatchObject({ code: PROXY_ERROR.containmentBreach });

      const ok = scriptedAdapter({ onPrompt: async (_p, agent) => { agent.update(commands("mcp", "remote-control")); return { stopReason: "end_turn" }; } });
      const okEnv = containedSetup({ adapters: [ok.adapter] });
      const g = await startSession(okEnv);
      expect((await g.session.prompt("go")).stopReason).toBe("end_turn");
      expect(g.ends).toEqual([]);

      const none = scriptedAdapter();
      const noneEnv = containedSetup({ adapters: [none.adapter] });
      const n = await startSession(noneEnv);
      expect((await n.session.prompt("go")).stopReason).toBe("end_turn");
      expect(n.ends).toEqual([]);
    });

    it("breaches on a command list that arrives while the session is still starting, with -32017 and nothing left running", async () => {
      const stub = scriptedAdapter({ newSession: (_p, agent) => { agent.update(commands("init")); return { sessionId: "agent-1", modes: { currentModeId: "default", availableModes: [] }, configOptions: [] }; } });
      const env = containedSetup({ adapters: [stub.adapter] });
      await expect(env.proxy.broker.start(containedRequest())).rejects.toMatchObject({ code: PROXY_ERROR.containmentBreach });
      expect(stub.last().isExited).toBe(true);
      expect(env.proxy.sessionCount()).toBe(0);
    });

    it.each(["/init", "  /init", "​/init", "\n/compact now"])("refuses the plugin prompt %j with -32602 and never forwards it", async (text) => {
      const stub = scriptedAdapter();
      const env = containedSetup({ adapters: [stub.adapter] });
      const { session } = await startSession(env);
      await expect(session.prompt(text)).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
      expect(stub.last().received.filter((r) => r.method === "session/prompt")).toEqual([]);
      // The session is fine, and an ordinary prompt goes through.
      expect((await session.prompt("hello /init")).stopReason).toBe("end_turn");
      expect(stub.last().received.filter((r) => r.method === "session/prompt")).toHaveLength(1);
    });

    it("does not refuse a slash prompt of a session that is not contained", async () => {
      const stub = scriptedAdapter();
      const env = setup({ adapters: [stub.adapter] });
      const session = await env.proxy.broker.start({ pluginId: PLUGIN, appId: "app-a", agent: "claude" });
      await session.prompt("/help");
      expect(stub.last().received.filter((r) => r.method === "session/prompt")).toHaveLength(1);
    });
  });

  describe("budget and the end of a session", () => {
    it("ends by calls when prompted and unprompted calls reach the limit: cancel, kill, budget, -32018", async () => {
      const stub = scriptedAdapter({
        onPrompt: async (_p, agent) => {
          await agent.ask({ toolCallId: "c1", _meta: { claudeCode: { toolName: TOOL_READ } } }); // permission before its frame
          agent.update(toolFrame("c1", TOOL_READ));
          agent.update(toolFrame("c2", TOOL_READ));
          await agent.ask({ toolCallId: "c2", _meta: { claudeCode: { toolName: TOOL_READ } } }); // permission after its frame
          agent.update(toolFrame("c3", TOOL_READ)); // unprompted: the third and last
          agent.update(toolFrame("c3", TOOL_READ, { sessionUpdate: "tool_call_update", status: "in_progress" })); // same id: not a new call
          agent.update(toolFrame("c4", TOOL_READ)); // over
          return NEVER;
        },
      });
      const env = containedSetup({ adapters: [stub.adapter] });
      const { session, ends } = await startSession(env, { budget: { maxToolCalls: 3 } });
      await expect(session.prompt("go")).rejects.toMatchObject({ code: PROXY_ERROR.budgetExceeded });
      await until(() => ends.length === 1);
      expect(ends).toEqual(["budget"]);
      expect(stub.last().received.some((r) => r.method === "session/cancel")).toBe(true);
      expect(stub.last().isExited).toBe(true);
      // callsLeft counts the requested call itself: 3 at the first, 2 at the second.
      expect(env.seen.map((i) => (i.origin as { callsLeft?: number }).callsLeft)).toEqual([3, 2]);
    });

    it("applies the app's ceiling to a larger request, and the default of 200 calls when none is named", async () => {
      const stub = scriptedAdapter({ onPrompt: async (_p, agent) => { await agent.ask({ toolCallId: "c1", _meta: { claudeCode: { toolName: TOOL_READ } } }); return { stopReason: "end_turn" }; } });
      const capped = containedSetup({ adapters: [stub.adapter], ceiling: { maxToolCalls: 5 } });
      await (await startSession(capped, { budget: { maxToolCalls: 400 } })).session.prompt("go");
      expect((capped.seen[0]!.origin as { callsLeft?: number }).callsLeft).toBe(5);
      const defaulted = containedSetup({ adapters: [stub.adapter] });
      await (await startSession(defaulted)).session.prompt("go");
      expect((defaulted.seen[0]!.origin as { callsLeft?: number }).callsLeft).toBe(200);
    });

    it("ends by time: the wall-clock timer runs from the start of the session", async () => {
      const stub = scriptedAdapter({ onPrompt: () => NEVER });
      const env = containedSetup({ adapters: [stub.adapter] });
      const { session, ends } = await startSession(env, { budget: { wallClockMs: 80 } });
      const turn = session.prompt("go");
      await expect(turn).rejects.toMatchObject({ code: PROXY_ERROR.budgetExceeded });
      await until(() => ends.length === 1);
      expect(ends).toEqual(["budget"]);
      expect(stub.last().isExited).toBe(true);
    });

    it("counts the wall-clock budget from the plugin's start request, so a slow start leaves less of it", async () => {
      const stub = scriptedAdapter({ onPrompt: () => NEVER, spawnDelayMs: 300 });
      const env = containedSetup({ adapters: [stub.adapter] });
      const requested = Date.now();
      const { ends } = await startSession(env, { budget: { wallClockMs: 500 } });
      await until(() => ends.length === 1, 3000);
      const elapsed = Date.now() - requested;
      expect(ends).toEqual(["budget"]);
      // From the request: about 500 ms. From the end of the start it would be about 800 ms.
      expect(elapsed).toBeLessThan(700);
      expect(elapsed).toBeGreaterThanOrEqual(480);
    });

    it("ends a start that outlasts the wall-clock budget with budgetExceeded: the process is killed and no handle is returned, in every step of the start", async () => {
      const slowNew = (ms: number) => () => new Promise((resolve) => setTimeout(() => resolve({ sessionId: "agent-1", modes: { currentModeId: "default", availableModes: [] }, configOptions: [] }), ms));
      const cases: [string, ReturnType<typeof scriptedAdapter>][] = [
        ["the spawn is still running", scriptedAdapter({ spawnDelayMs: 300 })],
        ["session/new is still running", scriptedAdapter({ newSession: slowNew(300) })],
        ["session/new is still running and the process never reports its exit", scriptedAdapter({ newSession: slowNew(300), exitedNeverSettles: true })],
      ];
      for (const [name, stub] of cases) {
        const env = containedSetup({ adapters: [stub.adapter] });
        const started = Date.now();
        await expect(env.proxy.broker.start(containedRequest({ budget: { wallClockMs: 80 } })), name).rejects.toMatchObject({ code: PROXY_ERROR.budgetExceeded });
        // At the deadline, not when the slow step finishes.
        if (!stub.spawns[0] || name.startsWith("session/new")) expect(Date.now() - started, name).toBeLessThan(250);
        expect(env.proxy.sessionCount(), name).toBe(0);
        await new Promise((r) => setTimeout(r, 350));
        // Whatever process was started is gone, and nothing was sent after the deadline.
        for (const agent of stub.agents) expect(agent.isExited, name).toBe(true);
        expect(stub.agents.every((a) => a.received.every((r) => r.method !== "session/prompt")), name).toBe(true);
        audits.clear();
      }
    });

    it("refuses a start whose budget was used up before the spawn, spawning nothing", async () => {
      const stub = scriptedAdapter();
      const real = createLocalPolicy({ homedir: root, auditFailed: () => false });
      const slowPolicy: LocalPolicy = { ...real, allowContainedSession: async (r) => { await new Promise((res) => setTimeout(res, 60)); return real.allowContainedSession!(r); } };
      const env = containedSetup({ adapters: [stub.adapter], policy: slowPolicy });
      await expect(env.proxy.broker.start(containedRequest({ budget: { wallClockMs: 20 } }))).rejects.toMatchObject({ code: PROXY_ERROR.budgetExceeded });
      expect(stub.spawns).toHaveLength(0);
    });

    it("drops the audit join state of a start that fails, on every way a start can fail, without waiting for the process to report its exit", async () => {
      const silent = { exitedNeverSettles: true };
      const cases: [string, ReturnType<typeof scriptedAdapter>][] = [
        ["session/new errors", scriptedAdapter({ ...silent, newSession: () => { throw new RpcError(RPC_ERROR.internal, "boom"); } })],
        ["session/new never answers", scriptedAdapter({ ...silent, newSession: () => NEVER })],
        ["the profile refuses the session/new result", scriptedAdapter({ ...silent, newSession: () => ({ sessionId: "agent-1", modes: { currentModeId: "bypassPermissions", availableModes: [{ id: "bypassPermissions", name: "x" }] }, configOptions: [] }) })],
      ];
      for (const [name, stub] of cases) {
        const env = containedSetup({ adapters: [stub.adapter], startTimeoutMs: 150 });
        const endSession = vi.spyOn(auditLogOf(PLUGIN), "endSession");
        await expect(env.proxy.broker.start(containedRequest()), name).rejects.toMatchObject({ code: PROXY_ERROR.containmentUnavailable });
        expect(endSession, name).toHaveBeenCalledWith(stub.spawns[0]!.containment!.sessionId);
        audits.clear();
      }
    });

    it("logs a failed start with a stage and a code, never with the agent's error text", async () => {
      const LEAK = "SECRET-IN-ERROR-TEXT";
      const stub = scriptedAdapter({ newSession: () => { throw new RpcError(RPC_ERROR.internal, `bad input ${LEAK}`); } });
      const env = containedSetup({ adapters: [stub.adapter] });
      await expect(env.proxy.broker.start(containedRequest())).rejects.toMatchObject({ code: PROXY_ERROR.containmentUnavailable });
      const entry = logCalls.find((c) => c.message === "contained session could not start");
      expect(entry?.fields).toMatchObject({ stage: "session/new", errorCode: RPC_ERROR.internal });
      expect(JSON.stringify(logCalls)).not.toContain(LEAK);
      // A spawn that fails with text of its own is held to the same rule.
      const spawnFail = scriptedAdapter({ spawnError: new Error(`spawn failed with ${LEAK}`) });
      const spawnEnv = containedSetup({ adapters: [spawnFail.adapter] });
      await expect(spawnEnv.proxy.broker.start(containedRequest())).rejects.toMatchObject({ code: PROXY_ERROR.containmentUnavailable });
      expect(logCalls.some((c) => c.message === "contained agent failed to start")).toBe(true);
      expect(JSON.stringify(logCalls)).not.toContain(LEAK);
    });

    it("resolves ended exactly once on every end path, after the process is gone, and drops the audit join state", async () => {
      type Path = [string, SessionEndReason, (env: ReturnType<typeof containedSetup>, s: BrokeredSession, agent: ScriptedAgent) => void | Promise<void>];
      const paths: Path[] = [
        ["close", "closed", (_e, s) => void s.close()],
        ["cancel then close", "cancelled", async (_e, s) => { await s.cancel(); await s.close(); }],
        ["plugin gone", "plugin_gone", (_e, s) => void (s.close as (r?: string) => Promise<void>)("plugin_gone")],
        ["agent exit", "agent_exited", (_e, _s, agent) => agent.exit(1)],
        ["breach", "breach", (_e, _s, agent) => agent.update(toolFrame("c1", "Bash"))],
        ["budget by time", "budget", () => undefined],
        ["proxy close", "runner_shutdown", (env) => void env.proxy.close()],
      ];
      for (const [name, reason, trigger] of paths) {
        const stub = scriptedAdapter({ onPrompt: () => NEVER });
        const env = containedSetup({ adapters: [stub.adapter] });
        const session = await env.proxy.broker.start(containedRequest({ budget: { wallClockMs: reason === "budget" ? 100 : 60_000 } }));
        const ended: { reason: SessionEndReason; exitedAtEnd: boolean }[] = [];
        void session.ended!.then((e) => ended.push({ reason: e.reason, exitedAtEnd: stub.last().isExited }));
        const endSession = vi.spyOn(auditLogOf(PLUGIN), "endSession");
        void session.prompt("go").catch(() => undefined);
        await until(() => stub.last().received.some((r) => r.method === "session/prompt"));
        await trigger(env, session, stub.last());
        await until(() => ended.length === 1, 3000);
        // A second end path after the first changes nothing.
        await session.close();
        await session.cancel();
        await new Promise((r) => setTimeout(r, 30));
        expect(ended, name).toEqual([{ reason, exitedAtEnd: true }]);
        expect(endSession, name).toHaveBeenCalledWith(session.sessionId);
        expect(env.proxy.sessionCount(), name).toBe(0);
        audits.clear();
      }
    });

    it("lets a prompt that ends with the session fail with the session's closing, not a hang", async () => {
      const stub = scriptedAdapter({ onPrompt: () => NEVER });
      const env = containedSetup({ adapters: [stub.adapter] });
      const { session } = await startSession(env);
      const turn = session.prompt("go");
      await until(() => stub.last().received.some((r) => r.method === "session/prompt"));
      await session.close();
      await expect(turn).rejects.toMatchObject({ code: RPC_ERROR.closed });
    });
  });

  describe("events", () => {
    it("gives the plugin text, plan and usage events, the tool name, kind and status of any tool, and raw fields only of its own tools", async () => {
      const stub = scriptedAdapter({
        onPrompt: async (_p, agent) => {
          agent.update(toolFrame("c1", "Bash", { kind: "execute", rawInput: { command: "ls" }, title: "Run ls" }));
          agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: "files", content: [{ type: "text", text: "files" }] });
          agent.update({ sessionUpdate: "plan", entries: [{ content: "step", status: "pending", priority: "high", extra: "dropped" }] });
          agent.update({ sessionUpdate: "usage_update", used: 42, size: 1000 });
          agent.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
          return { stopReason: "end_turn" };
        },
      });
      // Not contained: a built-in tool is allowed to run, and its events must still hide its arguments.
      const env = containedSetup({ adapters: [stub.adapter] });
      const browser = env.open({ browserKeyId: "key-9" });
      const session = await env.proxy.broker.start({ pluginId: PLUGIN, appId: "app-a", agent: "claude", onBehalfOf: { browserKeyId: "key-9" } });
      const events: SessionEvent[] = [];
      const off = session.onUpdate!((e) => events.push(e));
      await session.prompt("go");
      expect(events).toEqual([
        { type: "tool_call", id: "c1", toolName: "Bash", kind: "execute", status: "pending" },
        { type: "tool_call_update", id: "c1", status: "completed" },
        { type: "plan", entries: [{ content: "step", status: "pending", priority: "high" }] },
        { type: "usage", totalTokens: 42 },
      ]);
      // Nothing of a plugin's session goes to the browser it acts for.
      expect(browser.updates).toEqual([]);
      expect(browser.sent.some((m) => m.method === "session/update")).toBe(false);
      off();
      await session.prompt("again");
      expect(events).toHaveLength(4);
    });
  });

  describe("what a browser can and cannot reach", () => {
    it("does not let a browser reach a contained session of a plugin: its id is unknown on every channel", async () => {
      const stub = scriptedAdapter();
      const env = containedSetup({ adapters: [stub.adapter] });
      const browser = env.open({ browserKeyId: "key-9" });
      const { session } = await startSession(env, { onBehalfOf: { browserKeyId: "key-9" } });
      await expect(browser.prompt(session.sessionId, "hi")).rejects.toMatchObject({ code: PROXY_ERROR.unknownSession });
      await expect(browser.request("session/close", { sessionId: session.sessionId })).rejects.toMatchObject({ code: PROXY_ERROR.unknownSession });
      browser.notify("session/cancel", { sessionId: session.sessionId });
      await new Promise((r) => setTimeout(r, 30));
      expect(stub.last().received.filter((r) => r.method === "session/cancel")).toEqual([]);
    });

    it("never sends the agent logout, authenticate, session/set_mode or providers/set, from a browser or in a contained session", async () => {
      const forbidden = new Set(["logout", "authenticate", "session/set_mode", "providers/set"]);
      const stub = scriptedAdapter();
      const env = setup({ adapters: [stub.adapter] });
      const browser = env.open();
      const sessionId = await browser.newSession();
      for (const method of ["logout", "authenticate", "providers/set", "session/set_mode"]) {
        await expect(browser.request(method, { sessionId, modeId: "bypassPermissions", methodId: "x", provider: "x" })).rejects.toBeTruthy();
      }
      await browser.prompt(sessionId, "hello");
      expect(stub.last().received.map((r) => r.method).filter((m) => forbidden.has(m))).toEqual([]);

      const contained = scriptedAdapter();
      const cenv = containedSetup({ adapters: [contained.adapter] });
      const { session } = await startSession(cenv);
      await session.prompt("hello");
      await session.cancel();
      await session.close();
      const methods = new Set(contained.last().received.map((r) => r.method));
      expect([...methods].filter((m) => forbidden.has(m))).toEqual([]);
      expect([...methods].sort()).toEqual(["initialize", "session/cancel", "session/new", "session/prompt"]);
    });
  });

  describe("canary: the secret and a tool's arguments reach no browser, log or audit line", () => {
    const SECRET = "SECRET-CANARY-7f3a91c2";
    const RAW = "RAWINPUT-CANARY-91bc02d4";

    it("keeps both out of every browser frame, every log call and the audit file, on the normal path and on a breach", async () => {
      const clean = scriptedAdapter({
        onPrompt: async (_p, agent) => {
          await agent.ask({ toolCallId: "p1", title: `Read ${RAW}`, kind: "other", rawInput: { note: RAW }, _meta: { claudeCode: { toolName: TOOL_READ } } });
          agent.update(toolFrame("c1", TOOL_READ, { rawInput: { note: RAW } }));
          agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: { echoed: RAW } });
          agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
          return { stopReason: "end_turn" };
        },
      });
      const bad = scriptedAdapter({
        onPrompt: async (_p, agent) => {
          agent.update(toolFrame("c9", "Bash", { kind: "execute", title: `Run ${RAW}`, rawInput: { command: `echo ${RAW}` } }));
          return NEVER;
        },
      });
      const env = containedSetup({ adapters: [clean.adapter, bad.adapter].map((s, i) => (i === 1 ? { ...s, id: "bad", containment: () => CLAUDE_PROFILE } : s)) });
      const browser = env.open({ browserKeyId: "key-9" });
      browser.onAsk = () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });

      const first = await startSession(env, { withSecret: true, secret: SECRET, onBehalfOf: { browserKeyId: "key-9" } });
      await first.session.prompt("go");
      const second = await startSession(env, { agent: "bad", withSecret: true, secret: SECRET, onBehalfOf: { browserKeyId: "key-9" } });
      await expect(second.session.prompt("go")).rejects.toMatchObject({ code: PROXY_ERROR.containmentBreach });
      await until(() => second.ends.length === 1);
      // A start that fails also keeps the secret out of the log and out of the error.
      const failing = scriptedAdapter({ newSession: () => { throw new RpcError(RPC_ERROR.internal, "boom"); } });
      const failEnv = containedSetup({ adapters: [failing.adapter] });
      const failure = await failEnv.proxy.broker.start(containedRequest({ withSecret: true, secret: SECRET })).catch((e) => e as Error);

      // The test is live: the adapter was given the secret, and the plugin saw its own tool's arguments.
      expect(clean.spawns[0]!.secretText).toBe(SECRET);
      expect(JSON.stringify(first.events)).toContain(RAW);
      // And nothing else did.
      const everything = {
        browser: JSON.stringify(browser.sent),
        log: JSON.stringify([...logCalls]),
        audit: auditLines().length > 0 ? readFileSync(path.join(auditDir, `${PLUGIN}.jsonl`), "utf8") : "",
        error: (failure as Error).message,
        events: JSON.stringify([...first.events, ...second.events]).replaceAll(RAW, "<own-tool>"),
      };
      expect(auditLines().length).toBeGreaterThan(0);
      for (const [where, text] of Object.entries(everything)) {
        expect(text, where).not.toContain(SECRET);
        if (where !== "events") expect(text, where).not.toContain(RAW);
      }
      expect(browser.sent.filter((m) => m.method === "session/request_permission")).toEqual([]);
      expect(browser.asks).toEqual([]);
    });
  });
});

// Real claude is never started by the suite. To check the whole path by hand:
//   1. npm i -g @agentclientprotocol/claude-agent-acp   (old name: @zed-industries/claude-code-acp) and sign in to claude
//   2. BRIDGE_REAL_AGENT=1 pnpm --filter @berdyh/bridge-runner exec vitest run src/acp/proxy.test.ts
describe.skipIf(!process.env.BRIDGE_REAL_AGENT)("real claude (BRIDGE_REAL_AGENT=1)", () => {
  it("answers a prompt through the proxy", async () => {
    const policy = createLocalPolicy({ homedir: os.homedir(), allowedCwds: [process.cwd()] });
    const proxy = createAcpProxy({ appId: "real", adapters: createDefaultAgentAdapters(), policy, defaultCwd: process.cwd() });
    cleanups.push(() => proxy.close());
    const m = memoryChannel({ appId: "real" });
    proxy.attach(m.channel);
    await m.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const sessionId = await m.client.newSession({ cwd: process.cwd(), _meta: { agent: "claude" } });
    m.client.onAsk = () => ({ outcome: { outcome: "cancelled" } });
    const result = await m.client.prompt(sessionId, "Reply with exactly: pong");
    expect(result.stopReason).toBe("end_turn");
    expect(m.client.textOf(sessionId).join("")).toMatch(/pong/i);
  }, 120_000);
});
