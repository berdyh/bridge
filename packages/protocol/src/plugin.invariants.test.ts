import { describe, expect, it } from "vitest";

import {
  containedOnlyFieldsOf,
  hasForeignPlaceholder,
  validatePluginManifest,
  validateStartAgentSessionParams,
} from "./plugin.js";

describe("independent door checks (pure protocol boundary)", () => {
  it("migration: old requests survive validation without a changed meaning", () => {
    const old = { agent: "claude", cwd: "/work", onBehalfOf: { appId: "app", browserKeyId: "browser" }, callToken: "call" };
    expect(validateStartAgentSessionParams(JSON.parse(JSON.stringify(old)))).toEqual({ ok: true, value: old });
  });

  it("rollback: future authority is rejected, while missing containment never implies approval", () => {
    expect(validateStartAgentSessionParams({ agent: "claude", tools: { futureApproval: true } }).ok).toBe(false);
    expect(validatePluginManifest({ id: "p", app: "app", entry: "index.js", permissions: { futureApproval: true } }).ok).toBe(false);
    expect(containedOnlyFieldsOf({ secret: "", tools: { allow: ["mcp__corpus__read"] }, budget: { maxToolCalls: 1 } })).toEqual(["secret", "tools.allow", "budget"]);
  });

  it("restart/second caller: placeholder classification does not retain regex state", () => {
    const cases = [
      ["$${PLUGIN_DATA}{", false], ["$${SESSION_SECRET_FILE}{", false],
      ["${PLUGIN_DATA}${SESSION_SECRET_FILE}", false], ["${", true],
      ["${HOME}${PLUGIN_DATA}", true], ["${PLUGIN_${SESSION_SECRET_FILE}DATA}", true],
    ] as const;
    for (const sequence of [cases, [...cases].reverse(), cases]) {
      for (const [template, foreign] of sequence) expect(hasForeignPlaceholder(template), template).toBe(foreign);
    }
  });

  it("every forbidden control is rejected without entering an echoed diagnostic", () => {
    const forbidden = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
    const points = [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => 127 + i), 0x2028, 0x2029];
    for (const point of points) {
      const c = String.fromCodePoint(point);
      const manifest = { id: "p", app: "app", entry: "index.js", permissions: { mcpServers: { corpus: { entry: "mcp.js", args: [`a${c}b`] } } } };
      const result = validatePluginManifest(manifest);
      expect(result.ok, `U+${point.toString(16)}`).toBe(false);
      if (!result.ok) for (const error of result.errors) expect(error).not.toMatch(forbidden);
    }
  });
});
