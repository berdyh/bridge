import { describe, expect, it } from "vitest";

import {
  containedOnlyFieldsOf,
  escapeControlChars,
  hasForeignPlaceholder,
  quoteUntrusted,
  substituteArgPlaceholders,
  validatePluginManifest,
  validateStartAgentSessionParams,
} from "./plugin.js";

/** Every character `CONTROL` forbids, written out here so the test does not lean on the code under test. */
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROLS = ["\u0000", "\n", "\u001f", "\u007f", "\u0085", "\u009b", "\u009f", "\u2028", "\u2029"];

const manifest = (arg: string) => ({
  id: "review.plugin",
  app: "review-app",
  entry: "index.js",
  permissions: { mcpServers: { corpus: { entry: "mcp.js", args: [arg] } } },
});

describe("placeholder parsing", () => {
  it.each(["${PLUGIN_DATA}", "${SESSION_SECRET_FILE}"])(
    "does not invent a foreign placeholder when removing %s",
    (placeholder) => {
      // Literal '$', one allowed placeholder, literal '{': there is no foreign '${' in the template.
      const arg = "$" + placeholder + "{";
      expect(substituteArgPlaceholders(arg, { pluginData: "/data", secretFile: "/secret" })).toMatch(/^\$\/(data|secret)\{$/);
      expect.soft(hasForeignPlaceholder(arg)).toBe(false);
      expect.soft(validatePluginManifest(manifest(arg)).ok).toBe(true);
    },
  );

  it("a template is foreign exactly when its own text holds a `${` that no exact placeholder starts (every short template)", () => {
    const pieces = ["$", "{", "}", "x", "${", "${PLUGIN_DATA}", "${SESSION_SECRET_FILE}", "PLUGIN_DATA"];
    // The oracle is semantic, not a second scanner: with values that hold no `$` or `{`, substitution
    // leaves a `${` in the result exactly where the template held one that no placeholder covered.
    const values = { pluginData: "/data", secretFile: "/secret" };
    const check = (template: string) => {
      expect(hasForeignPlaceholder(template), JSON.stringify(template)).toBe(substituteArgPlaceholders(template, values).includes("${"));
    };
    const walk = (prefix: string, depth: number): void => {
      check(prefix);
      if (depth === 0) return;
      for (const piece of pieces) walk(prefix + piece, depth - 1);
    };
    walk("", 4);
  });
});

describe("diagnostic safety", () => {
  it.each(["\u007f", "\u0085", "\u009b", "\u2028", "\u2029"].map((control) => ({ control, label: control.codePointAt(0)!.toString(16) })))(
    "does not echo rejected control U+$label into diagnostics",
    ({ control }) => {
      const result = validatePluginManifest(manifest(`bad${control}arg`));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(";")).not.toMatch(FORBIDDEN);
      }
    },
  );

  it("every echo site (names, keys, args, tools, request fields) is free of every forbidden control", () => {
    for (const c of CONTROLS) {
      const bad = `x${c}y`;
      const reports: string[][] = [
        // manifest: server name, unknown server key, arg, headless tool name, unknown permission key, fs path
        [validatePluginManifest({ id: "p", app: "a", entry: "i.js", permissions: { mcpServers: { [bad]: { entry: "m.js" } } } })],
        [validatePluginManifest({ id: "p", app: "a", entry: "i.js", permissions: { mcpServers: { s: { entry: "m.js", [bad]: 1 } } } })],
        [validatePluginManifest({ id: "p", app: "a", entry: "i.js", permissions: { mcpServers: { s: { entry: "m.js", args: [bad] } } } })],
        [validatePluginManifest({ id: "p", app: "a", entry: "i.js", permissions: { mcpServers: { s: { entry: "m.js" } }, headless: { tools: [`mcp__s__${bad}`, bad] } } })],
        [validatePluginManifest({ id: "p", app: "a", entry: "i.js", permissions: { [bad]: true } })],
        // request: unknown key, tool names
        [validateStartAgentSessionParams({ agent: "claude", [bad]: 1 })],
        [validateStartAgentSessionParams({ agent: "claude", tools: { builtins: "none", allow: [bad], [bad]: 1 }, mcpServers: [bad] })],
      ].map(([r]) => (r as { ok: boolean; errors?: string[] }).errors ?? []);
      for (const errors of reports) for (const message of errors) expect(message, JSON.stringify(c)).not.toMatch(FORBIDDEN);
      expect(reports.some((e) => e.length > 0)).toBe(true);
    }
  });

  it("the shared formatters keep one printable line of at most 64 characters", () => {
    for (const c of CONTROLS) {
      expect(escapeControlChars(`a${c}b`)).not.toMatch(FORBIDDEN);
      expect(quoteUntrusted(`a${c}b`)).not.toMatch(FORBIDDEN);
      expect(quoteUntrusted(c.repeat(40))).not.toMatch(FORBIDDEN);
      expect([...quoteUntrusted(c.repeat(40))].length).toBeLessThanOrEqual(67);
    }
    expect(escapeControlChars("a\u0085b\u2028")).toBe("a\\u0085b\\u2028");
    expect(quoteUntrusted("plain")).toBe('"plain"');
    expect(quoteUntrusted(42)).toBe("42");
    expect(quoteUntrusted(undefined)).toBe("undefined");
    expect(quoteUntrusted(() => "a\u0085b")).not.toMatch(FORBIDDEN);
    expect(quoteUntrusted(10n)).not.toMatch(FORBIDDEN);
  });
});

describe("door: contract compatibility and independent callers", () => {
  it("migration: still accepts manifests and requests with only the old fields", () => {
    const old = { id: "review.plugin", app: "review-app", entry: "index.js", permissions: { agents: ["claude"] } };
    expect(validatePluginManifest(old)).toEqual({ ok: true, value: old });
    const request = { agent: "claude", cwd: "/work", onBehalfOf: { appId: "review-app", browserKeyId: "browser" }, callToken: "call" };
    expect(validateStartAgentSessionParams(request)).toEqual({ ok: true, value: request });
  });

  it("rollback boundary: unsupported permissions and request fields are refused, not stripped", () => {
    expect(validatePluginManifest({ ...manifest("plain"), permissions: { unknownFuturePermission: true } }).ok).toBe(false);
    expect(validateStartAgentSessionParams({ agent: "claude", unknownFutureSessionOption: true }).ok).toBe(false);
    expect(containedOnlyFieldsOf({ secret: "secret" })).toEqual(["secret"]);
  });

  it("second writer: validation snapshots arrays and does not share caller-owned objects", () => {
    const input = { agent: "claude", tools: { builtins: "none" as const, allow: ["mcp__corpus__read"] }, mcpServers: ["corpus"], budget: { maxToolCalls: 3 } };
    const first = validateStartAgentSessionParams(input);
    const second = validateStartAgentSessionParams(input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    input.tools.allow.push("mcp__corpus__write");
    input.mcpServers.push("other");
    input.budget.maxToolCalls = 500;
    first.value.tools!.allow!.push("mcp__corpus__first-only");
    expect(second.value.tools!.allow).toEqual(["mcp__corpus__read"]);
    expect(second.value.mcpServers).toEqual(["corpus"]);
    expect(second.value.budget).toEqual({ maxToolCalls: 3 });
  });
});
