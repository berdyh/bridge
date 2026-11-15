import { describe, expect, expectTypeOf, it } from "vitest";

import { PLUGIN_LIMITS, type SessionEndReason } from "@berdyh/bridge-protocol";

import type { GrantSurface } from "../plugins/contracts.js";
import {
  CLAUDE_BUILTIN_TOOL_NAMES,
  CLAUDE_CONTAINMENT_OPTIONS,
  ContainmentRefused,
  containmentRefusalDataOf,
  isContainmentRefusalData,
  MEASURED_CLAUDE_STACK,
  PROXY_ERROR,
  SESSION_BUDGET_CEILING,
  containedRequestProblem,
  narrowSessionBudget,
  parseGrantedMcpServer,
  resolveGrantedServer,
  sessionAllowSetOf,
  validateSessionBudgetCeiling,
  type AgentAdapter,
  type AgentProcess,
  type AgentSessionBroker,
  type AgentSessionBrokerRequest,
  type AgentSpawnOptions,
  type AuditFrameContext,
  type AuditLog,
  type AuditRecord,
  type AuditSink,
  type ClaudeContainmentOptions,
  type BrokeredSession,
  type ContainmentProfile,
  type ContainedSessionVerdict,
  type GrantResolution,
  type ContainmentRequest,
  type LocalPolicy,
  type PermissionOrigin,
  type PermissionRequestInfo,
  type ResolvedMcpServer,
  type SessionBudget,
  type SessionBudgetCeiling,
} from "./contracts.js";

describe("permission request identity", () => {
  it("carries the tool identity and data a local allowlist needs", () => {
    expectTypeOf<PermissionRequestInfo>().toHaveProperty("toolCallId");
    expectTypeOf<PermissionRequestInfo["toolName"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PermissionRequestInfo["rawInput"]>().toEqualTypeOf<unknown>();
    expectTypeOf<PermissionRequestInfo["cwd"]>().toEqualTypeOf<string>();
    expectTypeOf<LocalPolicy["allowedTools"]>().toEqualTypeOf<readonly string[] | undefined>();
  });

  it("is a local-only setting: nothing a browser or plugin sends can type as a policy", () => {
    expectTypeOf<LocalPolicy>().not.toHaveProperty("setMode");
  });
});

describe("brokered sessions", () => {
  it("say where an `ask` goes: the browser on whose behalf the plugin acts, or nowhere", () => {
    expectTypeOf<AgentSessionBrokerRequest["onBehalfOf"]>().toEqualTypeOf<{ browserKeyId: string } | undefined>();
    expectTypeOf<AgentSessionBroker["start"]>().parameters.toEqualTypeOf<[AgentSessionBrokerRequest]>();
    const origin: PermissionOrigin = { kind: "plugin", pluginId: "p" };
    expect(origin.kind).toBe("plugin");
  });
});

describe("plugin-session error codes", () => {
  it("fixes the four codes and keeps every code distinct", () => {
    expect(PROXY_ERROR.containmentUnavailable).toBe(-32016);
    expect(PROXY_ERROR.containmentBreach).toBe(-32017);
    expect(PROXY_ERROR.budgetExceeded).toBe(-32018);
    expect(PROXY_ERROR.consentMissing).toBe(-32019);
    const values = Object.values(PROXY_ERROR);
    expect(new Set(values).size).toBe(values.length);
  });
  it("ContainmentRefused answers with the generic code and keeps its detail to itself", () => {
    const refused = new ContainmentRefused("shim exited 126: /home/u/secret-path");
    expect(refused).toBeInstanceOf(Error);
    expect(refused.code).toBe(PROXY_ERROR.containmentUnavailable);
    expect(refused.detail).toContain("126");
    expect(refused.message).not.toContain("126");
    expect(refused.message).not.toContain("secret-path");
    expect(refused.reason).toBeUndefined();
  });
  it("ContainmentRefused may carry a reason code from the closed set, with its fixed hint", () => {
    const refused = new ContainmentRefused("no adapter under /home/u/.local/share", "adapter_missing");
    expect(refused.reason).toBe("adapter_missing");
    expect(refused.message).toBe("Contained session unavailable");
    expect(containmentRefusalDataOf(refused.reason!)).toEqual({ reason: "adapter_missing", hint: "bridge agent install claude" });
    expect(JSON.stringify(containmentRefusalDataOf("adapter_missing"))).not.toContain("/home/u");
  });
  it("isContainmentRefusalData accepts exactly the data the runner makes", () => {
    expect(isContainmentRefusalData(containmentRefusalDataOf("adapter_missing"))).toBe(true);
    for (const bad of [undefined, null, "adapter_missing", [], {}, { reason: "adapter_missing" }, { reason: "other", hint: "bridge agent install claude" }, { reason: "adapter_missing", hint: "run rm -rf" }, { reason: "adapter_missing", hint: "bridge agent install claude", detail: "/home/u" }, { reason: "toString", hint: "x" }]) {
      expect(isContainmentRefusalData(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the containment seam", () => {
  it("has no env on a resolved server, and an empty env tuple on the session/new entry", () => {
    expectTypeOf<ResolvedMcpServer>().toEqualTypeOf<{ name: string; command: string; args: string[]; secretTransport?: "fd3" }>();
    expectTypeOf<ResolvedMcpServer>().not.toHaveProperty("env");
    type SessionNew = NonNullable<AgentProcess["sessionNew"]>;
    expectTypeOf<SessionNew["mcpServers"][number]["env"]>().toEqualTypeOf<[]>();
    expectTypeOf<AgentProcess["sessionNew"]>().not.toEqualTypeOf<SessionNew>(); // optional: non-contained spawns have none
  });
  it("hands the adapter servers, the exact allow list, the secret as bytes and the model", () => {
    expectTypeOf<ContainmentRequest["servers"]>().toEqualTypeOf<ResolvedMcpServer[]>();
    expectTypeOf<ContainmentRequest["allow"]>().toEqualTypeOf<string[]>();
    expectTypeOf<ContainmentRequest["secret"]>().toEqualTypeOf<Uint8Array | undefined>();
    expectTypeOf<ContainmentRequest["model"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ContainmentRequest["sessionId"]>().toEqualTypeOf<string>();
    expectTypeOf<AgentSpawnOptions["containment"]>().toEqualTypeOf<ContainmentRequest | undefined>();
    expectTypeOf<AgentAdapter["containment"]>().toEqualTypeOf<(() => ContainmentProfile | undefined) | undefined>();
  });
  it("pins the profile's checks", () => {
    expectTypeOf<ContainmentProfile["toolOutsideSet"]>().parameters.toEqualTypeOf<
      [{ toolName?: string; kind?: string }, ReadonlySet<string>]
    >();
    expectTypeOf<ContainmentProfile["toolOutsideSet"]>().returns.toEqualTypeOf<boolean>();
    expectTypeOf<ContainmentProfile["checkNewSession"]>().returns.toEqualTypeOf<void>();
    // The commands check is its own member, pure, names in and out.
    expectTypeOf<ContainmentProfile["commandsOutsideSet"]>().parameters.toEqualTypeOf<
      [{ availableCommands?: ReadonlyArray<{ name: string }> }]
    >();
    expectTypeOf<ContainmentProfile["commandsOutsideSet"]>().returns.toEqualTypeOf<string[]>();
    // A profile that omits `commandsOutsideSet` is not a ContainmentProfile: the member is required.
    const withoutCommandsCheck = {
      id: "x",
      adapterVersion: "0",
      binaryVersion: "0",
      platformPackageVersion: "0",
      checkNewSession: () => undefined,
      toolOutsideSet: () => false,
    };
    // @ts-expect-error `commandsOutsideSet` is required
    const notAProfile: ContainmentProfile = withoutCommandsCheck;
    expect(notAProfile.id).toBe("x");
    expectTypeOf<ContainmentProfile>().toHaveProperty("adapterVersion");
    expectTypeOf<ContainmentProfile>().toHaveProperty("binaryVersion");
    expectTypeOf<ContainmentProfile["platformPackageVersion"]>().toEqualTypeOf<string>();
  });
  it("gives the contained policy check no cwd, no mode and no allowed tools", () => {
    type Check = NonNullable<LocalPolicy["allowContainedSession"]>;
    expectTypeOf<Check>().parameters.toEqualTypeOf<[{ appId: string; agentId: string; model?: string }]>();
    expectTypeOf<Parameters<Check>[0]>().not.toHaveProperty("cwd");
    expectTypeOf<Parameters<Check>[0]>().not.toHaveProperty("mode");
    expectTypeOf<Parameters<Check>[0]>().not.toHaveProperty("allowedTools");
  });
  it("answers the contained policy check with a verdict, not a bare boolean", () => {
    type Check = NonNullable<LocalPolicy["allowContainedSession"]>;
    expectTypeOf<Check>().returns.toEqualTypeOf<ContainedSessionVerdict | Promise<ContainedSessionVerdict>>();
    // @ts-expect-error a bare `true` is no longer an answer
    const bare: ReturnType<Check> = true;
    expect(bare).toBe(true);
  });
  it("lets a plugin-named model reach the allow-list in a non-contained session too", () => {
    expectTypeOf<Parameters<LocalPolicy["allowSession"]>[0]>().toEqualTypeOf<{ appId: string; agentId: string; cwd: string; model?: string }>();
  });
  it("carries the contained, headless and callsLeft facts on the plugin origin, absent meaning not contained", () => {
    const unchanged: PermissionOrigin = { kind: "plugin", pluginId: "p" };
    const contained: PermissionOrigin = { kind: "plugin", pluginId: "p", contained: true, headless: true, callsLeft: 3 };
    expect([unchanged.kind, contained.kind]).toEqual(["plugin", "plugin"]);
    type PluginOrigin = Extract<PermissionOrigin, { kind: "plugin" }>;
    expectTypeOf<PluginOrigin["contained"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<PluginOrigin["callsLeft"]>().toEqualTypeOf<number | undefined>();
  });
  it("carries the session's approval set as runner state on the plugin origin, absent meaning no automatic approval", () => {
    type PluginOrigin = Extract<PermissionOrigin, { kind: "plugin" }>;
    expectTypeOf<PluginOrigin["allow"]>().toEqualTypeOf<readonly string[] | undefined>();
    const unchanged: PermissionOrigin = { kind: "plugin", pluginId: "p" };
    const withSet: PermissionOrigin = { kind: "plugin", pluginId: "p", contained: true, callsLeft: 1, allow: ["mcp__corpus__read"] };
    expect(unchanged).not.toHaveProperty("allow");
    expect(withSet).toHaveProperty("allow", ["mcp__corpus__read"]);
    // The browser origin has no approval set to carry.
    expectTypeOf<Extract<PermissionOrigin, { kind: "browser" }>>().not.toHaveProperty("allow");
    // One definition feeds ContainmentRequest.allow, toolOutsideSet and origin.allow.
    expectTypeOf(sessionAllowSetOf).parameters.toEqualTypeOf<[AgentSessionBrokerRequest]>();
    expectTypeOf(sessionAllowSetOf).returns.toEqualTypeOf<ReadonlySet<string>>();
    expectTypeOf<ReadonlySet<string>>().toExtend<Parameters<ContainmentProfile["toolOutsideSet"]>[1]>();
  });
});

// Written out by hand from the measurement, independent of contracts.ts.
const MEASURED_BUILTIN_TOOL_NAMES: readonly string[] = [
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

describe("the measured claude profile", () => {
  it("pins the stack that was measured: adapter 0.94.0, SDK and platform package 0.3.303, binary 2.1.303", () => {
    expect(MEASURED_CLAUDE_STACK).toEqual({ adapter: "0.94.0", sdk: "0.3.303", platformPackage: "0.3.303", binary: "2.1.303" });
  });
  it("lists the 54 built-in tool names, in the recorded order, without duplicates", () => {
    expect(MEASURED_BUILTIN_TOOL_NAMES).toHaveLength(54);
    expect(new Set(MEASURED_BUILTIN_TOOL_NAMES).size).toBe(54);
    // Exact equality with the independent literal: a substitution, a missing name or an extra one fails.
    expect([...CLAUDE_BUILTIN_TOOL_NAMES].sort()).toEqual([...MEASURED_BUILTIN_TOOL_NAMES].sort());
    expect(CLAUDE_BUILTIN_TOOL_NAMES).toHaveLength(54);
    expect(new Set(CLAUDE_BUILTIN_TOOL_NAMES).size).toBe(54);
    expect(CLAUDE_BUILTIN_TOOL_NAMES.slice(0, 4)).toEqual(["Agent", "Artifact", "AskUserQuestion", "Bash"]);
    expect(CLAUDE_BUILTIN_TOOL_NAMES.at(-1)).toBe("Write");
    // The tools the stage-2 controls called are all on the list; `Task` is not.
    for (const called of ["Agent", "Bash", "Read", "Skill", "ToolSearch", "WebFetch", "WebSearch", "Write"]) {
      expect(CLAUDE_BUILTIN_TOOL_NAMES).toContain(called);
    }
    expect(CLAUDE_BUILTIN_TOOL_NAMES).not.toContain("Task");
    // No built-in name can collide with an approval-set entry.
    expect(CLAUDE_BUILTIN_TOOL_NAMES.some((n) => n.startsWith("mcp__"))).toBe(false);
  });
  it("is the contained profile exactly: no tools, no setting sources, strict MCP, no bypass, --restricted, --disable-slash-commands", () => {
    expect(CLAUDE_CONTAINMENT_OPTIONS).toEqual({
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      allowDangerouslySkipPermissions: false,
      allowedTools: [],
      disallowedTools: [...MEASURED_BUILTIN_TOOL_NAMES],
      extraArgs: { restricted: null, "disable-slash-commands": null },
    });
    expect(Object.keys(CLAUDE_CONTAINMENT_OPTIONS)).not.toContain("model");
    expect(CLAUDE_CONTAINMENT_OPTIONS.disallowedTools).not.toBe(CLAUDE_BUILTIN_TOOL_NAMES);
    expectTypeOf<ClaudeContainmentOptions["allowDangerouslySkipPermissions"]>().toEqualTypeOf<false>();
    expectTypeOf<ClaudeContainmentOptions["extraArgs"]>().toEqualTypeOf<{ restricted: null; "disable-slash-commands": null }>();
    expectTypeOf<ClaudeContainmentOptions["model"]>().toEqualTypeOf<string | undefined>();
  });
  it("needs nothing in the session/new params beyond mcpServers and _meta", () => {
    type SessionNew = NonNullable<AgentProcess["sessionNew"]>;
    expectTypeOf<keyof SessionNew>().toEqualTypeOf<"mcpServers" | "_meta">();
  });
});

describe("brokered sessions: events, ending, grant", () => {
  it("let the plugin watch its session and learn why it ended", () => {
    expectTypeOf<BrokeredSession["ended"]>().toEqualTypeOf<Promise<{ reason: SessionEndReason }> | undefined>();
    expectTypeOf<NonNullable<BrokeredSession["onUpdate"]>>().returns.toEqualTypeOf<() => void>();
  });
  it("close with no reason, or with plugin_gone when the plugin's process went away", () => {
    expectTypeOf<BrokeredSession["close"]>().parameters.toEqualTypeOf<[reason?: "plugin_gone"]>();
    expectTypeOf<BrokeredSession["close"]>().returns.toEqualTypeOf<Promise<void>>();
  });
  it("carry the validated session options, the resolved servers and the consented grant", () => {
    expectTypeOf<AgentSessionBrokerRequest["mcpServers"]>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<AgentSessionBrokerRequest["servers"]>().toEqualTypeOf<ResolvedMcpServer[] | undefined>();
    expectTypeOf<AgentSessionBrokerRequest["model"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AgentSessionBrokerRequest>().toHaveProperty("grant");
    expectTypeOf<AgentSessionBrokerRequest>().not.toHaveProperty("command");
    expectTypeOf<AgentSessionBrokerRequest>().not.toHaveProperty("env");
  });
});

describe("audit records", () => {
  it("hold a digest and a size, never the arguments or the secret", () => {
    expectTypeOf<AuditRecord>().not.toHaveProperty("rawInput");
    expectTypeOf<AuditRecord>().not.toHaveProperty("args");
    expectTypeOf<AuditRecord>().not.toHaveProperty("secret");
    expectTypeOf<AuditRecord["argsSha256"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AuditRecord["argsBytes"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<AuditRecord["decision"]>().toEqualTypeOf<"allow" | "reject" | "cancel" | "none" | undefined>();
    // appId, trigger and servers are absent together on a decision recorded before its session's first frame.
    expectTypeOf<AuditRecord["trigger"]>().toEqualTypeOf<{ kind: "headless" } | { kind: "browser"; browserKeyId: string } | undefined>();
    expectTypeOf<AuditRecord["appId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AuditRecord["servers"]>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<AuditLog>().toExtend<AuditSink>();
  });
  it("joins a decision to the record of (sessionId, toolCallId) and drops a session's join state when it ends", () => {
    expectTypeOf<AuditLog["recordDecision"]>().parameters.toEqualTypeOf<[string, string, "allow" | "reject" | "cancel"]>();
    expectTypeOf<AuditLog["recordDecision"]>().returns.toEqualTypeOf<void>();
    expectTypeOf<AuditLog["endSession"]>().toEqualTypeOf<(sessionId: string) => void>();
    // Required, not optional: a log that cannot end a session would keep one session's state forever.
    expectTypeOf<AuditLog>().not.toEqualTypeOf<Omit<AuditLog, "endSession">>();
    // A record names its session, so two sessions of one plugin that both have a call "tc1" stay apart.
    expectTypeOf<AuditRecord["sessionId"]>().toEqualTypeOf<string>();
    expectTypeOf<AuditFrameContext["sessionId"]>().toEqualTypeOf<string>();
  });
  it("models two sessions with the same call id taking different decisions", () => {
    // A minimal in-test log obeying the contract: the join key is the pair, so "tc1" of s1 and of s2 do not meet.
    const pending = new Map<string, "allow" | "reject" | "cancel">();
    const log: Pick<AuditLog, "recordDecision" | "endSession"> = {
      recordDecision: (sessionId, toolCallId, decision) => void pending.set(JSON.stringify([sessionId, toolCallId]), decision),
      endSession: (sessionId) => {
        for (const key of [...pending.keys()]) if ((JSON.parse(key) as [string, string])[0] === sessionId) pending.delete(key);
      },
    };
    log.recordDecision("s1", "tc1", "allow");
    log.recordDecision("s2", "tc1", "reject");
    expect(pending.get(JSON.stringify(["s1", "tc1"]))).toBe("allow");
    expect(pending.get(JSON.stringify(["s2", "tc1"]))).toBe("reject");
    log.endSession("s1");
    expect(pending.has(JSON.stringify(["s1", "tc1"]))).toBe(false);
    expect(pending.get(JSON.stringify(["s2", "tc1"]))).toBe("reject");
  });
});

describe("containedRequestProblem: the proxy's check of the parallel broker fields against the grant", () => {
  const NODE = "/usr/bin/node";
  const INSTALL = "/data/p/1.0.0";
  const DATA = "/data/p-data";
  // A stand-in for the consent module's surfaceSha256Of: any deterministic function of the surface will do here.
  const hashOf = (surface: GrantSurface): string => `h:${JSON.stringify(surface)}`;
  const resolution: GrantResolution = { installDir: INSTALL, dataDir: DATA, surfaceSha256Of: hashOf };
  type ServerItem = { name: string; entry?: string; args?: string[] };
  const grant = (over: { servers?: (string | ServerItem)[]; tools?: string[]; pluginId?: string; appId?: string; hash?: string } = {}): NonNullable<AgentSessionBrokerRequest["grant"]> => {
    const surface = {
      items: [
        ...(over.servers ?? ["corpus"]).map((s) => {
          const item = typeof s === "string" ? { name: s } : s;
          return { kind: "mcpServer" as const, value: JSON.stringify({ name: item.name, entry: item.entry ?? "dist/c.js", args: item.args ?? ["${SESSION_SECRET_FILE}"] }) };
        }),
        ...(over.tools ?? ["mcp__corpus__read"]).map((value) => ({ kind: "headlessTool" as const, value })),
      ],
    };
    return { pluginId: over.pluginId ?? "p", appId: over.appId ?? "app", version: "1.0.0", surfaceSha256: over.hash ?? hashOf(surface), time: "2026-10-30T00:00:00Z", surface };
  };
  const good = (over: Partial<AgentSessionBrokerRequest> = {}): AgentSessionBrokerRequest => ({
    pluginId: "p",
    appId: "app",
    agent: "claude",
    tools: { builtins: "none", allow: ["mcp__corpus__read"] },
    mcpServers: ["corpus"],
    servers: [{ name: "corpus", command: NODE, args: [`${INSTALL}/dist/c.js`, "${SESSION_SECRET_FILE}"] }],
    secret: "s3cret",
    grant: grant(),
    ...over,
  });
  /** A request for one server `corpus` with the grant's args `template` and the resolved `args` after the entry. */
  const withArgs = (template: string[], args: string[], entry = "dist/c.js", over: Partial<AgentSessionBrokerRequest> = {}): AgentSessionBrokerRequest =>
    good({
      grant: grant({ servers: [{ name: "corpus", entry, args: template }] }),
      servers: [{ name: "corpus", command: NODE, args: [`${INSTALL}/${entry}`, ...args] }],
      ...over,
    });
  const problem = (r: AgentSessionBrokerRequest) => containedRequestProblem(r, NODE, resolution);

  it("accepts a request whose fields all agree with the grant", () => {
    expect(problem(good())).toBeUndefined();
    expect(problem(withArgs([], [], "dist/c.js", { secret: undefined }))).toBeUndefined();
    expect(problem(good({ secret: new Uint8Array(4096) }))).toBeUndefined();
  });
  it("is not concerned with a request that is not contained", () => {
    expect(problem({ pluginId: "p", appId: "app", agent: "claude" })).toBeUndefined();
  });
  it("answers consentMissing for no grant", () => {
    expect(problem(good({ grant: undefined }))?.code).toBe(PROXY_ERROR.consentMissing);
  });
  it("refuses a cwd on a contained request, whatever it names", () => {
    for (const cwd of ["/work", "", "/state/sessions/other", ".", "/home/me/project-with-mcp-json"]) {
      const r = problem(good({ cwd }));
      expect(r?.code, JSON.stringify(cwd)).toBe(-32602);
      expect(r?.message, JSON.stringify(cwd)).toContain("must not set cwd");
    }
    expect(problem(good({ cwd: undefined }))).toBeUndefined();
    // Not contained: cwd is the ordinary session folder and is not this function's concern.
    expect(problem({ pluginId: "p", appId: "app", agent: "claude", cwd: "/work" })).toBeUndefined();
    expect(problem({ pluginId: "p", appId: "app", agent: "claude", tools: { builtins: "agent-default" }, cwd: "/work" })).toBeUndefined();
    // consentMissing still comes first for a request with no grant.
    expect(problem(good({ cwd: "/work", grant: undefined }))?.code).toBe(PROXY_ERROR.consentMissing);
  });
  it("refuses a command line that is not the runner's own Node", () => {
    for (const command of ["/bin/sh", "node", "", "/usr/bin/node "]) {
      expect(problem(good({ servers: [{ name: "corpus", command, args: [`${INSTALL}/dist/c.js`, "${SESSION_SECRET_FILE}"] }] }))?.message, command).toContain("runner's own Node");
    }
    for (const args of [[], ["relative.js", "${SESSION_SECRET_FILE}"]]) {
      expect(problem(good({ servers: [{ name: "corpus", command: NODE, args }] }))?.message, JSON.stringify(args)).toContain("absolute entry");
    }
  });
  it("refuses a command line other than the consented one: another entry, an added, dropped, changed or reordered argument", () => {
    const e = `${INSTALL}/dist/c.js`;
    const S = "${SESSION_SECRET_FILE}";
    const lines: [string, string[]][] = [
      ["another file in the install dir", [`${INSTALL}/dist/other.js`, S]],
      ["an entry outside the install dir", ["/elsewhere/dist/c.js", S]],
      ["a sibling version's entry", [`/data/p/2.0.0/dist/c.js`, S]],
      ["an entry with a dot-dot", [`${INSTALL}/dist/../dist/c.js`, S]],
      ["an extra argument", [e, S, "--extra"]],
      ["an extra argument first", [e, "--extra", S]],
      ["a dropped argument", [e]],
      ["a changed argument", [e, "${SESSION_SECRET_FILE} "]],
      ["a lookalike argument", [e, "$SESSION_SECRET_FILE"]],
      ["a doubled argument", [e, S, S]],
    ];
    for (const [label, args] of lines) {
      const r = problem(good({ servers: [{ name: "corpus", command: NODE, args }] }));
      expect(r?.code, label).toBe(-32602);
      expect(r?.message, label).toBeDefined();
    }
    // The same rule across a grant with several servers: each line is checked against its own item.
    const two = good({
      mcpServers: ["corpus", "notes"],
      tools: { builtins: "none", allow: ["mcp__corpus__read"] },
      grant: grant({ servers: [{ name: "corpus" }, { name: "notes", entry: "dist/n.js", args: ["--k"] }] }),
      servers: [
        { name: "corpus", command: NODE, args: [e, S] },
        { name: "notes", command: NODE, args: [`${INSTALL}/dist/n.js`, "--k"] },
      ],
    });
    expect(problem(two)).toBeUndefined();
    for (const swap of [{ name: "notes", command: NODE, args: [e, S] }, { name: "notes", command: NODE, args: [`${INSTALL}/dist/n.js`, "--k", "x"] }]) {
      expect(problem({ ...two, servers: [two.servers![0]!, swap] })?.code).toBe(-32602);
    }
    expect(problem({ ...two, servers: [{ name: "corpus", command: NODE, args: [`${INSTALL}/dist/n.js`, "--k"] }, two.servers![1]!] })?.code).toBe(-32602);
  });
  it("substitutes ${PLUGIN_DATA} into the consented arguments before comparing", () => {
    expect(problem(withArgs(["--data=${PLUGIN_DATA}/corpus", "${SESSION_SECRET_FILE}"], [`--data=${DATA}/corpus`, "${SESSION_SECRET_FILE}"]))).toBeUndefined();
    expect(problem(withArgs(["--data=${PLUGIN_DATA}/corpus", "${SESSION_SECRET_FILE}"], ["--data=/data/other/corpus", "${SESSION_SECRET_FILE}"]))?.message).toContain("differ from the consented");
    expect(problem(withArgs(["--data=${PLUGIN_DATA}/corpus", "${SESSION_SECRET_FILE}"], ["--data=${PLUGIN_DATA}/corpus", "${SESSION_SECRET_FILE}"]))?.code).toBe(-32602);
  });
  it("refuses a grant of another plugin or app, or one whose recorded hash is not its surface's", () => {
    expect(problem(good({ grant: grant({ pluginId: "q" }) }))?.message).toContain("another plugin or app");
    expect(problem(good({ grant: grant({ appId: "other-app" }) }))?.message).toContain("another plugin or app");
    expect(problem(good({ pluginId: "q" }))?.message).toContain("another plugin or app");
    expect(problem(good({ appId: "other-app" }))?.message).toContain("another plugin or app");
    expect(problem(good({ grant: grant({ hash: "0".repeat(64) }) }))?.message).toContain("recorded hash");
    // A grant whose surface was edited after the hash was recorded.
    const g = grant();
    const edited = { ...g, surface: { items: [...g.surface.items, { kind: "headlessTool" as const, value: "mcp__corpus__write" }] } };
    expect(problem(good({ grant: edited }))?.message).toContain("recorded hash");
    // A hash that cannot be computed is not vouched for.
    const throwing = containedRequestProblem(good(), NODE, { ...resolution, surfaceSha256Of: () => { throw new Error("not implemented"); } });
    expect(throwing?.message).toContain("recorded hash");
  });
  it("reads a grant item strictly: an unreadable or ambiguous item grants nothing", () => {
    const withItems = (...values: string[]) => {
      const g = grant({ servers: [] });
      const surface = { items: [...g.surface.items, ...values.map((value) => ({ kind: "mcpServer" as const, value }))] };
      return { ...g, surface, surfaceSha256: hashOf(surface) };
    };
    const item = (o: object) => JSON.stringify({ name: "corpus", entry: "dist/c.js", args: ["${SESSION_SECRET_FILE}"], ...o });
    expect(problem(good({ grant: withItems(item({})) }))).toBeUndefined();
    for (const value of ["not json", "[]", "null", item({ extra: 1 }), item({ entry: 5 }), item({ args: "x" }), item({ args: [1] }), item({ name: 5 })]) {
      expect(problem(good({ grant: withItems(value) }))?.message, value).toContain("not in the consented grant");
    }
    expect(problem(good({ grant: withItems(item({}), item({ entry: "dist/other.js" })) }))?.message).toContain("not in the consented grant");
    expect(parseGrantedMcpServer(JSON.stringify({ name: "a", entry: "e.js" }))).toEqual({ name: "a", entry: "e.js", args: [] });
  });
  it("builds the consented command line in one pure place, shared with the host", () => {
    const server = { name: "corpus", entry: "dist/c.js", args: ["--d=${PLUGIN_DATA}", "${SESSION_SECRET_FILE}"] };
    expect(resolveGrantedServer(server, NODE, resolution)).toEqual({ name: "corpus", command: NODE, args: [`${INSTALL}/dist/c.js`, `--d=${DATA}`, "${SESSION_SECRET_FILE}"] });
    for (const bad of [{ ...server, entry: "../x.js" }, { ...server, entry: "/abs.js" }, { ...server, entry: "" }, { ...server, entry: "." }]) {
      expect(resolveGrantedServer(bad, NODE, resolution), bad.entry).toBeUndefined();
    }
    expect(resolveGrantedServer(server, NODE, { installDir: "rel/dir", dataDir: DATA })).toBeUndefined();
    expect(resolveGrantedServer(server, NODE, { installDir: INSTALL, dataDir: "rel" })).toBeUndefined();
    // The data dir is data: a `${` in it is inserted as it is and not substituted again.
    expect(resolveGrantedServer(server, NODE, { installDir: INSTALL, dataDir: "/d/${PLUGIN_DATA}" })?.args[1]).toBe("--d=/d/${PLUGIN_DATA}");
  });
  it("refuses servers that are not attached, not granted or not one-to-one", () => {
    expect(problem(good({ mcpServers: ["other"], servers: [{ name: "other", command: NODE, args: [`${INSTALL}/dist/c.js`, "${SESSION_SECRET_FILE}"] }] }))?.message).toContain("not in the consented grant");
    expect(problem(good({ servers: [{ name: "other", command: NODE, args: [`${INSTALL}/dist/c.js`, "${SESSION_SECRET_FILE}"] }] }))?.message).toContain("do not match");
    expect(problem(good({ servers: undefined }))?.message).toContain("do not match");
    expect(problem(good({ mcpServers: ["corpus", "corpus"] }))?.message).toContain("twice");
    expect(problem(good({ grant: grant({ servers: [] }) }))?.message).toContain("not in the consented grant");
  });
  it("refuses an allowed tool outside the grant or the attached servers", () => {
    expect(problem(good({ tools: { builtins: "none", allow: ["mcp__corpus__write"] } }))?.message).toContain("consented headless set");
    expect(problem(good({ tools: { builtins: "none", allow: ["mcp__other__read"] }, grant: grant({ tools: ["mcp__other__read"] }) }))?.message).toContain("attached server");
    expect(problem(good({ tools: { builtins: "none", allow: ["Bash"] } }))?.message).toContain("attached server");
  });
  it("bounds the secret and ties it to the placeholder, without echoing it", () => {
    expect(problem(good({ secret: "x".repeat(4097) }))?.message).toContain("4096");
    expect(problem(good({ secret: new Uint8Array(4097) }))?.message).toContain("4096");
    expect(problem(good({ secret: "é".repeat(2049) }))?.message).toContain("4096");
    expect(problem(good({ secret: undefined }))?.message).toContain("no secret was given");
    expect(problem(withArgs(["${SESSION_SECRET_FILE}"], ["${SESSION_SECRET_FILE}"], "dist/c.js", { secret: undefined }))?.message).toContain("no secret was given");
    expect(problem(withArgs([], []))?.message).toContain("no server reads");
    expect(problem(good({ secret: "CANARY-1" + "x".repeat(5000) }))?.message).not.toContain("CANARY");
  });
  it("refuses a consented argument that holds another placeholder, and an unresolved one in the line", () => {
    for (const arg of ["${HOME}", "--x=${", "${PLUGIN_${SESSION_SECRET_FILE}DATA}"]) {
      const r = problem(withArgs(["${SESSION_SECRET_FILE}", arg], ["${SESSION_SECRET_FILE}", arg]));
      expect(r?.message, arg).toContain("placeholder that is not allowed");
    }
    // A leftover ${PLUGIN_DATA} in the line is not what the template resolves to.
    expect(problem(good({ servers: [{ name: "corpus", command: NODE, args: [`${INSTALL}/dist/c.js`, "${SESSION_SECRET_FILE}", "${PLUGIN_DATA}"] }] }))?.message).toContain("differ from the consented");
  });
  it("treats a resolved path as data: a ${ in the install or data dir is not an unresolved placeholder", () => {
    for (const [installDir, dataDir] of [["/data/we${ird}/1.0.0", "/data/p-data"], ["/data/p/1.0.0", "/data/${HOME}/d"], ["/data/${x", "/data/x${"], ["/d/${PLUGIN_DATA}/i", "/d/${PLUGIN_DATA}/d"]] as const) {
      const res = { ...resolution, installDir, dataDir };
      const request = good({
        grant: grant({ servers: [{ name: "corpus", args: ["--d=${PLUGIN_DATA}", "${SESSION_SECRET_FILE}"] }] }),
        servers: [{ name: "corpus", command: NODE, args: [`${installDir}/dist/c.js`, `--d=${dataDir}`, "${SESSION_SECRET_FILE}"] }],
      });
      expect(containedRequestProblem(request, NODE, res), `${installDir} ${dataDir}`).toBeUndefined();
    }
  });
  it("refuses a path that spells the secret-file placeholder, which the adapter would fill", () => {
    const res = { ...resolution, dataDir: "/data/${SESSION_SECRET_FILE}" };
    const request = good({
      grant: grant({ servers: [{ name: "corpus", args: ["--d=${PLUGIN_DATA}", "${SESSION_SECRET_FILE}"] }] }),
      servers: [{ name: "corpus", command: NODE, args: [`${INSTALL}/dist/c.js`, `--d=${res.dataDir}`, "${SESSION_SECRET_FILE}"] }],
    });
    expect(containedRequestProblem(request, NODE, res)?.message).toContain("placeholder of its own");
  });

  describe("sessionAllowSetOf: the one approval set", () => {
    it("equals tools.allow for an accepted contained request, without duplicates", () => {
      const request = good({ tools: { builtins: "none", allow: ["mcp__corpus__read", "mcp__corpus__read", "mcp__corpus__list"] }, grant: grant({ tools: ["mcp__corpus__read", "mcp__corpus__list"] }) });
      expect(containedRequestProblem(request, NODE, resolution)).toBeUndefined();
      expect([...sessionAllowSetOf(request)]).toEqual(["mcp__corpus__read", "mcp__corpus__list"]);
      expect(sessionAllowSetOf(good())).toEqual(new Set(["mcp__corpus__read"]));
    });
    it("is empty without an allow list, and for a request that is not contained, whatever tools.allow says", () => {
      expect(sessionAllowSetOf(good({ tools: { builtins: "none" } })).size).toBe(0);
      expect(sessionAllowSetOf(good({ tools: undefined })).size).toBe(0);
      expect(sessionAllowSetOf(good({ tools: { builtins: "agent-default", allow: ["mcp__corpus__read"] } })).size).toBe(0);
      expect(sessionAllowSetOf(good({ tools: { allow: ["mcp__corpus__read"] } })).size).toBe(0);
    });
    it("is never reached for an entry outside the consented headless set or on an unattached server: the start is refused first", () => {
      for (const allow of [["mcp__corpus__write"], ["mcp__other__read"], ["mcp__corpus__read", "Bash"]]) {
        const request = good({ tools: { builtins: "none", allow } });
        expect(containedRequestProblem(request, NODE, resolution)?.code, allow.join()).toBe(-32602);
      }
    });
    it("is a copy: changing the request afterwards does not change a set already taken", () => {
      const request = good();
      const set = sessionAllowSetOf(request);
      request.tools!.allow!.push("mcp__corpus__write");
      expect([...set]).toEqual(["mcp__corpus__read"]);
    });
  });
});

describe("the session budget ceiling", () => {
  const C = SESSION_BUDGET_CEILING;
  const W = "policy.sessionBudget";

  it("is the runner default built from PLUGIN_LIMITS", () => {
    expect(C).toEqual({ wallClockMs: 3_600_000, maxToolCalls: 500 });
    expect(C.wallClockMs).toBe(PLUGIN_LIMITS.maxWallClockMs);
    expect(C.maxToolCalls).toBe(PLUGIN_LIMITS.maxToolCalls);
    expect(Object.isFrozen(C)).toBe(true);
  });

  it("narrows per field, keeps an absent field, never widens", () => {
    expect(narrowSessionBudget(C, undefined)).toEqual(C);
    expect(narrowSessionBudget(C, {})).toEqual(C);
    expect(narrowSessionBudget(C, { wallClockMs: 1_800_000 })).toEqual({ wallClockMs: 1_800_000, maxToolCalls: 500 });
    expect(narrowSessionBudget(C, { wallClockMs: 7_200_000, maxToolCalls: 1000 })).toEqual(C);
    expect(narrowSessionBudget(C, { wallClockMs: 1, maxToolCalls: 1 })).toEqual({ wallClockMs: 1, maxToolCalls: 1 });
  });

  it("ignores an unvalidated inner value that is not a positive integer, never widening", () => {
    const junk = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1" as unknown as number];
    for (const v of junk) expect(narrowSessionBudget(C, { wallClockMs: v, maxToolCalls: v })).toEqual(C);
  });

  it("returns a new object and leaves the outer untouched", () => {
    const out = narrowSessionBudget(C, {});
    expect(out).not.toBe(C);
    expect(C).toEqual({ wallClockMs: 3_600_000, maxToolCalls: 500 });
  });

  it("lets each level narrow and the app never lift the policy's value", () => {
    const policy: SessionBudgetCeiling = { maxToolCalls: 100 };
    const app: SessionBudgetCeiling = { wallClockMs: 60_000, maxToolCalls: 300 };
    expect(narrowSessionBudget(narrowSessionBudget(C, policy), app)).toEqual({ wallClockMs: 60_000, maxToolCalls: 100 });
  });

  it("is order independent and idempotent", () => {
    const tuples: [SessionBudgetCeiling, SessionBudgetCeiling][] = [
      [{ wallClockMs: 10 }, { maxToolCalls: 5 }],
      [{ wallClockMs: 10, maxToolCalls: 400 }, { wallClockMs: 20, maxToolCalls: 300 }],
      [{}, { wallClockMs: 3_600_000 }],
      [{ wallClockMs: 9_999_999 }, { maxToolCalls: 9999 }],
    ];
    for (const [a, b] of tuples) {
      expect(narrowSessionBudget(narrowSessionBudget(C, a), b)).toEqual(narrowSessionBudget(narrowSessionBudget(C, b), a));
      const once = narrowSessionBudget(C, a);
      expect(narrowSessionBudget(once, a)).toEqual(once);
    }
  });

  it("accepts an empty value and values up to the ceiling", () => {
    expect(validateSessionBudgetCeiling({}, W)).toEqual([]);
    expect(validateSessionBudgetCeiling({ wallClockMs: 1 }, W)).toEqual([]);
    expect(validateSessionBudgetCeiling({ wallClockMs: 3_600_000 }, W)).toEqual([]);
    expect(validateSessionBudgetCeiling({ maxToolCalls: 500 }, W)).toEqual([]);
    expect(validateSessionBudgetCeiling({ wallClockMs: 3_600_000, maxToolCalls: 500 }, W)).toEqual([]);
  });

  it("rejects a value above the ceiling, naming the key, the value and the ceiling", () => {
    const wall = validateSessionBudgetCeiling({ wallClockMs: 3_600_001 }, W);
    expect(wall).toHaveLength(1);
    expect(wall[0]).toContain(`${W}.wallClockMs`);
    expect(wall[0]).toContain("3600001");
    expect(wall[0]).toContain("at most 3600000");
    const calls = validateSessionBudgetCeiling({ maxToolCalls: 501 }, W);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`${W}.maxToolCalls`);
    expect(calls[0]).toContain("at most 500");
  });

  it("rejects a non-positive, fractional, non-numeric or non-finite field with one message per field", () => {
    for (const bad of [0, -1, 1.5, "1", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateSessionBudgetCeiling({ wallClockMs: bad }, W)).toHaveLength(1);
      expect(validateSessionBudgetCeiling({ maxToolCalls: bad }, W)).toHaveLength(1);
      expect(validateSessionBudgetCeiling({ wallClockMs: bad, maxToolCalls: bad }, W)).toHaveLength(2);
    }
  });

  it("rejects an unknown key and a value that is not an object", () => {
    const unknown = validateSessionBudgetCeiling({ maxTokens: 1 }, W);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain("maxTokens");
    for (const bad of [[], "1h", null, 5, undefined]) {
      const out = validateSessionBudgetCeiling(bad, W);
      expect(out).toHaveLength(1);
      expect(out[0]).toContain("must be an object {wallClockMs?, maxToolCalls?}");
    }
  });

  it("keeps every message one line, prefixed with where, with a quoted value of at most 64 characters", () => {
    const nasty = "x\n\u0000\u202e" + "y".repeat(200);
    const out = validateSessionBudgetCeiling({ wallClockMs: nasty, maxToolCalls: -1, ["k\nz"]: 1 }, W);
    expect(out).toHaveLength(3);
    for (const m of out) {
      expect(m.startsWith(W)).toBe(true);
      expect(m).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    }
    const wall = out.find((m) => m.includes("wallClockMs"));
    const quoted = wall!.slice(wall!.lastIndexOf("got ") + 4);
    expect([...quoted].length).toBeLessThanOrEqual(67);
  });

  it("types a verdict as a refusal with an optional reason or an admission with a whole budget", () => {
    expectTypeOf<{ allowed: false }>().toExtend<ContainedSessionVerdict>();
    expectTypeOf<{ allowed: false; reason: string }>().toExtend<ContainedSessionVerdict>();
    expectTypeOf<{ allowed: true; budget: SessionBudget }>().toExtend<ContainedSessionVerdict>();
    expectTypeOf<{ allowed: true }>().not.toExtend<ContainedSessionVerdict>();
    expectTypeOf<{ allowed: true; budget: { wallClockMs: number } }>().not.toExtend<ContainedSessionVerdict>();
    expectTypeOf<{ allowed: true; budget: SessionBudgetCeiling }>().not.toExtend<ContainedSessionVerdict>();
    const refusal: ContainedSessionVerdict = { allowed: false, reason: "x" };
    expect(refusal.allowed).toBe(false);
  });
});
