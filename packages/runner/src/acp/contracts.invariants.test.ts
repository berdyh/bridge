import { createHash } from "node:crypto";

import { containedOnlyFieldsOf } from "@berdyh/bridge-protocol";
import { describe, expect, expectTypeOf, it } from "vitest";

import { appPathsOf, defaultBaseDirs } from "../paths.js";
import { grantWidened, installAnswerProblem, type GrantSurface } from "../plugins/contracts.js";
import {
  SESSION_BUDGET_CEILING,
  containedRequestProblem,
  narrowSessionBudget,
  resolveGrantedServer,
  sessionAllowSetOf,
  type AgentSessionBrokerRequest,
  type AuditLog,
  type PermissionOrigin,
} from "./contracts.js";

const hash = (surface: GrantSurface) => createHash("sha256").update(JSON.stringify(surface)).digest("hex");
const resolution = { installDir: "/plugins/p/1", dataDir: "/data/p", surfaceSha256Of: hash };
function request(): AgentSessionBrokerRequest {
  const server = { name: "corpus", entry: "..mcp.js", args: ["$${PLUGIN_DATA}{", "${SESSION_SECRET_FILE}"] };
  const surface: GrantSurface = { items: [
    { kind: "mcpServer", value: JSON.stringify(server) },
    { kind: "headlessTool", value: "mcp__corpus__read" },
  ] };
  return {
    appId: "app", pluginId: "p", agent: "claude", secret: "secret-canary",
    tools: { builtins: "none", allow: ["mcp__corpus__read"] }, mcpServers: ["corpus"],
    servers: [resolveGrantedServer(server, process.execPath, resolution)!],
    grant: { appId: "app", pluginId: "p", version: "1", surface, surfaceSha256: hash(surface), time: "2026-11-01T00:00:00Z" },
  };
}

describe("restart and independent writers of a contained request (contract layer, not stores/proxy)", () => {
  it("restart: serialized grant and request preserve their command and approval set", () => {
    const before = request();
    const after: AgentSessionBrokerRequest = JSON.parse(JSON.stringify(before));
    for (const r of [before, after]) {
      expect(containedRequestProblem(r, process.execPath, resolution)).toBeUndefined();
      expect([...sessionAllowSetOf(r)]).toEqual(["mcp__corpus__read"]);
    }
  });

  it("rollback/revocation: an absent grant is never silently treated as old-session authority", () => {
    const r = request();
    expect(containedRequestProblem({ ...r, grant: undefined }, process.execPath, resolution)?.code).toBe(-32019);
    const bytes: AgentSessionBrokerRequest = { appId: "app", pluginId: "p", agent: "claude", secret: new Uint8Array() };
    expectTypeOf<AgentSessionBrokerRequest>().toExtend<Parameters<typeof containedOnlyFieldsOf>[0]>();
    expect(containedOnlyFieldsOf(bytes)).toEqual(["secret"]);
    expect(sessionAllowSetOf({ ...r, tools: { allow: r.tools!.allow } }).size).toBe(0);
  });

  it("second writer: reloaded or another app's authority cannot change an existing set", () => {
    const first = request();
    const set = sessionAllowSetOf(first);
    const second: AgentSessionBrokerRequest = JSON.parse(JSON.stringify(first));
    second.appId = "other-app";
    expect(containedRequestProblem(second, process.execPath, resolution)?.code).toBe(-32602);
    first.tools!.allow!.push("mcp__corpus__write");
    expect(containedRequestProblem(first, process.execPath, resolution)?.code).toBe(-32602);
    expect([...set]).toEqual(["mcp__corpus__read"]);
  });

  it("command/cwd tampering cannot survive revalidation", () => {
    const r = request();
    const bad = [
      { ...r, cwd: "/project" },
      { ...r, servers: [{ ...r.servers![0]!, args: ["/outside/mcp.js"] }] },
      { ...r, servers: [{ ...r.servers![0]!, command: "/bin/sh" }] },
    ];
    for (const candidate of bad) expect(containedRequestProblem(candidate, process.execPath, resolution)?.code).toBe(-32602);
  });

  it("restart: app paths stay stable and contained work remains outside ordinary work", () => {
    const base = defaultBaseDirs("/home/review", {});
    const a = appPathsOf(base, "app");
    expect(appPathsOf(JSON.parse(JSON.stringify(base)), "app")).toEqual(a);
    expect(a.sessionsDir).toBe(`${a.stateDir}/sessions`);
    expect(a.secretsParent).toBe(a.tmpDir);
    for (const field of ["auditDir", "consentDir", "sessionsDir", "secretsParent"] as const) {
      expect(a[field]).not.toBe(appPathsOf(base, "other-app")[field]);
    }
  });

  it("persisted policy and app ceilings never raise the global or policy budget", () => {
    const policy = JSON.parse('{"maxToolCalls":3,"wallClockMs":100}');
    const app = JSON.parse('{"maxToolCalls":500,"wallClockMs":3600000}');
    expect(narrowSessionBudget(narrowSessionBudget(SESSION_BUDGET_CEILING, policy), app)).toEqual({ maxToolCalls: 3, wallClockMs: 100 });
  });

  it("update/rollback/first install use the same terminal-consent rule", () => {
    const surface = request().grant!.surface;
    const old: GrantSurface = { items: [] };
    expect(grantWidened(surface, undefined)).toBe(true);
    expect(grantWidened(surface, old)).toBe(true);
    expect(installAnswerProblem({ nonInteractive: true }, grantWidened(surface, old))).toBeDefined();
    expect(installAnswerProblem({ terminal: true }, grantWidened(surface, old))).toBeUndefined();
    expect(grantWidened(old, surface)).toBe(false);
    expect(grantWidened(surface, JSON.parse(JSON.stringify(surface)))).toBe(false);
  });

  it("approval state and audit joins have every required contract input", () => {
    type Origin = Extract<PermissionOrigin, { kind: "plugin" }>;
    expectTypeOf<Origin["allow"]>().toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<AuditLog["recordDecision"]>().parameters.toEqualTypeOf<[string, string, "allow" | "reject" | "cancel"]>();
    expectTypeOf<AuditLog["endSession"]>().toEqualTypeOf<(sessionId: string) => void>();
  });
});
