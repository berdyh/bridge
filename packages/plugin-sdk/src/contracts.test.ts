import { describe, expect, expectTypeOf, it } from "vitest";

import {
  SESSION_END_REASONS,
  isContainedRequest,
  type AgentSession,
  type AgentSessionRequest,
  type PluginCaller,
  type SessionEndReason,
  type SessionEvent,
} from "./contracts.js";

describe("agent session request", () => {
  it("can name the browser an `ask` permission goes to, never the plugin", () => {
    expectTypeOf<AgentSessionRequest["onBehalfOf"]>().toEqualTypeOf<PluginCaller | undefined>();
    expectTypeOf<AgentSessionRequest>().not.toHaveProperty("onPermissionRequest");
  });  it("mirrors the protocol's session options, and has no command, env, cwd for a server or a mode", () => {
    expectTypeOf<AgentSessionRequest["mcpServers"]>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<AgentSessionRequest["secret"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AgentSessionRequest["model"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AgentSessionRequest["headless"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<AgentSessionRequest["budget"]>().toEqualTypeOf<{ wallClockMs?: number; maxToolCalls?: number } | undefined>();
    expectTypeOf<AgentSessionRequest["tools"]>().toEqualTypeOf<{ allow?: string[]; builtins?: "none" | "agent-default" } | undefined>();
    for (const key of ["command", "env", "mode", "permissionMode", "callToken"] as const) {
      expectTypeOf<AgentSessionRequest>().not.toHaveProperty(key);
    }
  });
  it("shares the protocol's one definition of contained", () => {
    expect(isContainedRequest({ tools: { builtins: "none" } })).toBe(true);
    expect(isContainedRequest({ tools: { builtins: "agent-default" } })).toBe(false);
  });
});

describe("agent session", () => {
  it("lets the plugin watch its session and learn why it ended, keeping prompt/cancel/close as they were", () => {
    expectTypeOf<AgentSession["ended"]>().toEqualTypeOf<Promise<{ reason: SessionEndReason }> | undefined>();
    expectTypeOf<NonNullable<AgentSession["onUpdate"]>>().parameters.toEqualTypeOf<[(event: SessionEvent) => void]>();
    expectTypeOf<AgentSession["prompt"]>().returns.toEqualTypeOf<Promise<{ stopReason: string; text: string }>>();
    expect(SESSION_END_REASONS).toHaveLength(7);
  });
  it("types events the way the wire sends them", () => {
    const events: SessionEvent[] = [
      { type: "tool_call", id: "t1", toolName: "mcp__corpus__read", kind: "other", status: "pending" },
      { type: "tool_call_update", id: "t1", status: "completed", result: { ok: true } },
      { type: "text", text: "hi" },
      { type: "plan", entries: [{ content: "step" }] },
      { type: "usage", inputTokens: 1 },
    ];
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_call_update", "text", "plan", "usage"]);
  });
});
