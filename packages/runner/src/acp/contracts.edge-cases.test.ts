import path from "node:path";

import { containedOnlyFieldsOf, validatePluginManifest, type StartAgentSessionParams } from "@berdyh/bridge-protocol";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { GrantSurface } from "../plugins/contracts.js";
import { agentDir, appPathsOf, assertAppFolderName, assertAppName, defaultBaseDirs } from "../paths.js";
import {
  SESSION_BUDGET_CEILING,
  containedRequestProblem,
  narrowSessionBudget,
  resolveGrantedServer,
  validateSessionBudgetCeiling,
  type AgentSessionBrokerRequest,
  type GrantResolution,
} from "./contracts.js";

const hashOf = (surface: GrantSurface) => JSON.stringify(surface);
const resolution: GrantResolution = { installDir: "/plugins/review/1.0.0", dataDir: "/data/review", surfaceSha256Of: hashOf };

describe("inter-package types", () => {
  it("the proxy can use the shared rule with its broker request", () => {
    const request: AgentSessionBrokerRequest = { pluginId: "review", appId: "review-app", agent: "claude", secret: new Uint8Array([1]) };
    // This direct, documented call must compile, not require a cast or a second implementation.
    expect(containedOnlyFieldsOf(request)).toEqual(["secret"]);
  });

  it("the one rule takes every consumer's request type, and judges a secret by presence", () => {
    type Input = Parameters<typeof containedOnlyFieldsOf>[0];
    expectTypeOf<AgentSessionBrokerRequest>().toExtend<Input>();
    expectTypeOf<StartAgentSessionParams>().toExtend<Input>();
    const base: AgentSessionBrokerRequest = { pluginId: "p", appId: "a", agent: "claude" };
    expect(containedOnlyFieldsOf({ ...base, secret: "wire" })).toEqual(["secret"]);
    expect(containedOnlyFieldsOf({ ...base, secret: new Uint8Array() })).toEqual(["secret"]);
    expect(containedOnlyFieldsOf({ ...base })).toEqual([]);
    expect(containedOnlyFieldsOf({ ...base, tools: { builtins: "none" }, secret: new Uint8Array([1]) })).toEqual([]);
  });
});

describe("the same placeholder rule at the broker boundary", () => {
  it.each(["${PLUGIN_DATA}", "${SESSION_SECRET_FILE}"])(
    "accepts a consented arg with literal punctuation around %s",
    (placeholder) => {
      const item = { name: "corpus", entry: "mcp.js", args: ["$" + placeholder + "{"] };
      const surface: GrantSurface = { items: [{ kind: "mcpServer", value: JSON.stringify(item) }] };
      const request: AgentSessionBrokerRequest = {
        appId: "review-app", pluginId: "review", agent: "claude", tools: { builtins: "none" }, mcpServers: ["corpus"], servers: [resolveGrantedServer(item, process.execPath, resolution)!],
        ...(placeholder === "${SESSION_SECRET_FILE}" ? { secret: "review-secret" } : {}),
        grant: { appId: "review-app", pluginId: "review", version: "1.0.0", time: "2026-11-01T00:00:00Z", surface, surfaceSha256: hashOf(surface) },
      };
      expect(containedRequestProblem(request, process.execPath, resolution)).toBeUndefined();
    },
  );
});

describe("package-relative entry paths", () => {
  it.each(["..mcp.js", "..servers/mcp.js", "...x/mcp.js", "a/..b/mcp.js"])(
    "accepts an in-package name %s that is not a parent traversal",
    (entry) => {
      expect(validatePluginManifest({ id: "review", app: "review-app", entry: "index.js", permissions: { mcpServers: { corpus: { entry } } } }).ok).toBe(true);
      const expected = { name: "corpus", command: process.execPath, args: [path.join(resolution.installDir, entry)] };
      expect.soft(resolveGrantedServer({ name: "corpus", entry, args: [] }, process.execPath, resolution)).toEqual(expected);
      const surface: GrantSurface = { items: [{ kind: "mcpServer", value: JSON.stringify({ name: "corpus", entry, args: [] }) }] };
      const request: AgentSessionBrokerRequest = {
        appId: "review-app", pluginId: "review", agent: "claude", tools: { builtins: "none" }, mcpServers: ["corpus"], servers: [expected],
        grant: { appId: "review-app", pluginId: "review", version: "1.0.0", time: "2026-11-01T00:00:00Z", surface, surfaceSha256: hashOf(surface) },
      };
      expect(containedRequestProblem(request, process.execPath, resolution)).toBeUndefined();
    },
  );

  it.each(["..", "../mcp.js", "a/../../mcp.js", "a/..", ".", "", "/abs/mcp.js", "a/../../review/1.0.0x/mcp.js"])(
    "still refuses %j, which is not a file inside the install dir",
    (entry) => {
      expect(resolveGrantedServer({ name: "corpus", entry, args: [] }, process.execPath, resolution)).toBeUndefined();
    },
  );
});

describe("diagnostic safety", () => {
  const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  const CONTROLS = ["\u0000", "\n", "\u001f", "\u007f", "\u0085", "\u009b", "\u009f", "\u2028", "\u2029"];

  it.each(CONTROLS.map((control) => ({ control, label: control.codePointAt(0)!.toString(16) })))(
    "budget diagnostics escape rejected control U+$label",
    ({ control }) => {
      const messages = validateSessionBudgetCeiling({ maxToolCalls: control, [`bad${control}key`]: 1 }, "policy.sessionBudget");
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) expect(message).not.toMatch(FORBIDDEN);
    },
  );

  it("the proxy check names a rejected server without echoing a control character", () => {
    for (const control of CONTROLS) {
      const item = { name: "corpus", entry: "mcp.js", args: [] };
      const surface: GrantSurface = { items: [{ kind: "mcpServer", value: JSON.stringify(item) }] };
      const request: AgentSessionBrokerRequest = {
        appId: "review-app", pluginId: "review", agent: "claude", tools: { builtins: "none" }, mcpServers: [`bad${control}name`], servers: [],
        grant: { appId: "review-app", pluginId: "review", version: "1.0.0", time: "2026-11-01T00:00:00Z", surface, surfaceSha256: hashOf(surface) },
      };
      const problem = containedRequestProblem(request, process.execPath, resolution);
      expect(problem?.message).toMatch(/is not in the consented grant/);
      expect(problem?.message).not.toMatch(FORBIDDEN);
    }
  });

  it("a rejected agent or app name is echoed on one printable line", () => {
    const base = defaultBaseDirs("/review-home", {});
    for (const control of CONTROLS) {
      const bad = `a${control}b`;
      const errors = [
        () => agentDir({ agentsDir: "/agents" }, bad as "claude"),
        () => assertAppName(bad),
        () => assertAppFolderName(bad),
        () => appPathsOf(base, bad),
      ].map((run) => {
        try {
          run();
        } catch (error) {
          return (error as Error).message;
        }
        throw new Error("expected a throw");
      });
      for (const message of errors) expect(message).not.toMatch(FORBIDDEN);
    }
  });
});

describe("restart and independent writers (pure contract layer)", () => {
  it("restart: persisted grants produce the same command-line validation after reloading", () => {
    const item = { name: "corpus", entry: "mcp.js", args: ["--data=${PLUGIN_DATA}"] };
    const surface: GrantSurface = { items: [{ kind: "mcpServer", value: JSON.stringify(item) }] };
    const request: AgentSessionBrokerRequest = {
      appId: "review-app", pluginId: "review", agent: "claude", tools: { builtins: "none" }, mcpServers: ["corpus"], servers: [resolveGrantedServer(item, process.execPath, resolution)!],
      grant: { appId: "review-app", pluginId: "review", version: "1.0.0", time: "2026-11-01T00:00:00Z", surface, surfaceSha256: hashOf(surface) },
    };
    expect(containedRequestProblem(request, process.execPath, resolution)).toBeUndefined();
    expect(containedRequestProblem(JSON.parse(JSON.stringify(request)), process.execPath, resolution)).toBeUndefined();
    expect(containedRequestProblem({ ...request, grant: undefined }, process.execPath, resolution)?.code).toBe(-32019);
  });

  it("restart and rollback: new child paths do not move pre-existing app paths", () => {
    const base = defaultBaseDirs("/review-home", {});
    const first = appPathsOf(base, "review-app");
    const restarted = appPathsOf(JSON.parse(JSON.stringify(base)), "review-app");
    expect(restarted).toEqual(first);
    expect(first.workDir).toBe("/review-home/.local/state/review-app/bridge/work");
    expect(first.pluginsDir).toBe("/review-home/.local/share/review-app/bridge/plugins");
    expect(first.appFile).toBe("/review-home/.config/review-app/bridge/app.json");
    expect(first.sessionsDir).toBe(path.join(first.stateDir, "sessions"));
    expect(first.secretsParent).toBe(first.tmpDir);
    const other = appPathsOf(base, "other-app");
    for (const key of ["auditDir", "consentDir", "sessionsDir", "secretsParent"] as const) expect(first[key]).not.toBe(other[key]);
  });

  it("second writer: budget narrowing cannot mutate another app's ceiling or widen its parent", () => {
    const first = narrowSessionBudget(SESSION_BUDGET_CEILING, { maxToolCalls: 10 });
    const second = narrowSessionBudget(SESSION_BUDGET_CEILING, { wallClockMs: 30_000 });
    expect(narrowSessionBudget(first, { maxToolCalls: 500 })).toEqual(first);
    expect(second).toEqual({ wallClockMs: 30_000, maxToolCalls: 500 });
    expect(SESSION_BUDGET_CEILING).toEqual({ wallClockMs: 3_600_000, maxToolCalls: 500 });
  });
});
