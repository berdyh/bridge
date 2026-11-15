import { containedOnlyFieldsOf, type StartAgentSessionParams } from "@berdyh/bridge-protocol";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { AgentSessionRequest } from "./contracts.js";

describe("SDK consumer of the single containment rule", () => {
  it("accepts the actual public SDK request type without a cast or another rule", () => {
    type Input = Parameters<typeof containedOnlyFieldsOf>[0];
    expectTypeOf<AgentSessionRequest>().toExtend<Input>();
    expectTypeOf<StartAgentSessionParams>().toExtend<Input>();
    const request: AgentSessionRequest = { agent: "claude", secret: "" };
    expect(containedOnlyFieldsOf(request)).toEqual(["secret"]);
    expect(containedOnlyFieldsOf({ ...request, tools: { builtins: "none" } })).toEqual([]);
  });
});
