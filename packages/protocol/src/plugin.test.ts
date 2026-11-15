import { describe, expect, it } from "vitest";
import * as protocol from "./index.js";
import {
  ARG_PLACEHOLDER,
  PLUGIN_LIMITS,
  PLUGIN_RPC,
  SESSION_END_REASONS,
  type PluginCallParams,
  type PluginManifest,
  type StartAgentSessionParams,
  containedForbiddenFieldsOf,
  containedOnlyFieldsOf,
  hasForeignPlaceholder,
  isContainedRequest,
  isPluginManifest,
  parseMcpToolName,
  substituteArgPlaceholders,
  validatePluginManifest,
  validateStartAgentSessionParams,
} from "./index.js";

const manifest: PluginManifest = {
  id: "app-a.mail-sync",
  app: "app-a",
  entry: "dist/plugin.js",
  permissions: {
    network: ["gmail.googleapis.com", "oauth2.googleapis.com"],
    fs: ["$PLUGIN_DATA"],
    agents: ["claude", "codex"],
    localUi: { port: "auto" },
    mcpServers: {
      corpus: { entry: "dist/corpus-mcp.js", args: ["${SESSION_SECRET_FILE}", "--data=${PLUGIN_DATA}/corpus", "plain"] },
      notes: { entry: "dist/notes-mcp.js" },
    },
    headless: { tools: ["mcp__corpus__read", "mcp__corpus__a__b", "mcp__notes__append"] },
  },
};
const errorsOf = (m: unknown) => {
  const r = validatePluginManifest(m);
  return r.ok ? [] : r.errors;
};

describe("plugin manifest", () => {
  it("accepts the plan's example and a minimal one", () => {
    expect(validatePluginManifest(manifest)).toEqual({ ok: true, value: manifest });
    expect(isPluginManifest({ id: "sample", app: "demo", entry: "plugin.js", permissions: {} })).toBe(true);
  });
  it("rejects bad ids, including the reserved one", () => {
    expect(errorsOf({ ...manifest, id: "App A" }).length).toBe(1);
    expect(errorsOf({ ...manifest, id: "bridge" })).toEqual([expect.stringContaining("reserved")]);
    expect(errorsOf({ ...manifest, id: "a/b" }).length).toBe(1);
  });
  it("rejects entries that leave the package", () => {
    for (const entry of ["/etc/passwd", "../x.js", "a/../../x.js", "", "C:\\x.js"]) {
      expect(errorsOf({ ...manifest, entry }), entry).toEqual([expect.stringContaining("entry")]);
    }
  });
  it("rejects unknown permissions and bad values", () => {
    expect(errorsOf({ ...manifest, permissions: { ...manifest.permissions, sudo: true } })).toEqual([expect.stringContaining("unknown permission")]);
    expect(errorsOf({ ...manifest, permissions: { network: ["https://x.com/path"] } }).length).toBe(1);
    expect(errorsOf({ ...manifest, permissions: { localUi: { port: 80 } } }).length).toBe(1);
    expect(errorsOf({ ...manifest, permissions: { agents: "claude" } }).length).toBe(1);
    expect(errorsOf({ ...manifest, permissions: undefined }).length).toBe(1);
    expect(errorsOf("nope")).toEqual(["manifest must be an object"]);
  });
  it("rejects control characters and odd charsets that could rewrite the consent prompt", () => {
    const evil = "claude\r\u001b[2KAgents: none";
    expect(errorsOf({ ...manifest, permissions: { agents: [evil] } }).length).toBe(1);
    expect(errorsOf({ ...manifest, permissions: { agents: ["a b"] } }).length).toBe(1);
    expect(errorsOf({ ...manifest, permissions: { fs: ["/tmp/x\u001b[2K"] } }).length).toBe(1);
    expect(errorsOf({ ...manifest, permissions: { fs: ["/tmp/x\ny"] } }).length).toBe(1);
    expect(errorsOf({ ...manifest, permissions: { fs: ["/tmp/" + "a".repeat(600)] } }).length).toBe(1);
    expect(errorsOf({ ...manifest, app: "demo\u001b[2K" }).length).toBe(1);
    expect(errorsOf({ ...manifest, app: "has space" }).length).toBe(1);
    expect(errorsOf({ ...manifest, permissions: { fs: ["$PLUGIN_DATA", "/home/me/proj dir"], agents: ["claude"] } })).toEqual([]);
  });
});

/** A manifest whose permissions are `extra` on top of one declared server, `corpus`. */
const withPerms = (extra: Record<string, unknown>): unknown => ({
  ...manifest,
  permissions: { mcpServers: { corpus: { entry: "dist/c.js" } }, ...extra },
});
const server = (value: unknown, name = "corpus"): unknown => ({ ...manifest, permissions: { mcpServers: { [name]: value } } });

describe("plugin manifest: mcpServers", () => {
  it("rejects server names outside ^[a-z][a-z0-9-]{0,31}$", () => {
    for (const name of ["a_b", "A", "-x", "1x", "a".repeat(33), "", "a b", "__proto__"]) {
      const errors = errorsOf(server({ entry: "x.js" }, name));
      expect(errors.length, name).toBeGreaterThan(0);
      expect(errors.join("\n"), name).toContain("server name must be lowercase");
    }
    expect(errorsOf(server({ entry: "x.js" }, "a".repeat(32)))).toEqual([]);
    expect(errorsOf(server({ entry: "x.js" }, "a-1"))).toEqual([]);
  });
  it("rejects an entry that leaves the package", () => {
    for (const entry of ["../x.js", "/abs.js", "C:\\x.js", "", "a/../../x.js", "a/..", "a".repeat(513), "x\u001b.js", "x\0.js", 5, undefined]) {
      expect(errorsOf(server({ entry })).join("\n"), String(entry)).toContain("inside the package");
    }
    expect(errorsOf(server({ entry: "a".repeat(512) }))).toEqual([]);
    expect(errorsOf(server({ entry: "dist/sub/x.js" }))).toEqual([]);
  });
  it("allows only the two placeholders", () => {
    for (const arg of ["${HOME}", "$${HOME}", "${PLUGIN_DATA}/${HOME}", "${PLUGIN_DATA", "${SESSION_SECRET_FILE }", "${${PLUGIN_DATA}}", "${}", "x${", "${PLUGIN_${SESSION_SECRET_FILE}DATA}", "${SESSION_${PLUGIN_DATA}SECRET_FILE}", "${PLUGIN_${PLUGIN_DATA}DATA}", "${${SESSION_SECRET_FILE}"]) {
      const errors = errorsOf(server({ entry: "x.js", args: [arg] }));
      expect(errors.length, arg).toBe(1);
      expect(errors[0], arg).toContain("${SESSION_SECRET_FILE}");
      expect(errors[0], arg).toContain("${PLUGIN_DATA}");
    }
    expect(errorsOf(server({ entry: "x.js", args: ["${SESSION_SECRET_FILE}", "--data=${PLUGIN_DATA}/x", "plain", "$HOME", "$"] }))).toEqual([]);
  });
  it("substitutes the two placeholders in one pass and never rescans a value", () => {
    const values = { secretFile: "/s/${PLUGIN_DATA}", pluginData: "/d" };
    expect(substituteArgPlaceholders("--f=${SESSION_SECRET_FILE}:${PLUGIN_DATA}", values)).toBe("--f=/s/${PLUGIN_DATA}:/d");
    expect(substituteArgPlaceholders("$${PLUGIN_DATA}", values)).toBe("$/d");
    expect(substituteArgPlaceholders("plain", values)).toBe("plain");
    // One pass: removing the inner placeholder leaves a string that is not substituted again (and the validator rejects it).
    expect(substituteArgPlaceholders("${PLUGIN_${SESSION_SECRET_FILE}DATA}", { secretFile: "", pluginData: "" })).toBe("${PLUGIN_DATA}");
  });
  it("exports a placeholder pattern that is safe to call test and exec on again and again", () => {
    const samples = ["${PLUGIN_DATA}", "a${SESSION_SECRET_FILE}b", "${HOME}", "plain", ""];
    for (const sample of samples) {
      const first = ARG_PLACEHOLDER.test(sample);
      for (let i = 0; i < 5; i++) expect(ARG_PLACEHOLDER.test(sample), sample).toBe(first);
      const found = ARG_PLACEHOLDER.exec(sample)?.[0];
      for (let i = 0; i < 5; i++) expect(ARG_PLACEHOLDER.exec(sample)?.[0], sample).toBe(found);
    }
  });
  it("exports no stateful regular expression at all from the protocol package", () => {
    const regexes = Object.entries(protocol).filter(([, v]) => v instanceof RegExp) as [string, RegExp][];
    expect(regexes.map(([name]) => name)).toContain("ARG_PLACEHOLDER");
    for (const [name, re] of regexes) {
      expect(re.global, name).toBe(false);
      expect(re.sticky, name).toBe(false);
    }
  });
  it("tells a foreign placeholder from the two exact ones, on the template, in one pass", () => {
    for (const arg of ["${HOME}", "x${", "${PLUGIN_${SESSION_SECRET_FILE}DATA}", "${PLUGIN_DATA}${HOME}"]) expect(hasForeignPlaceholder(arg), arg).toBe(true);
    for (const arg of ["${SESSION_SECRET_FILE}", "--d=${PLUGIN_DATA}/x${SESSION_SECRET_FILE}", "$HOME", ""]) expect(hasForeignPlaceholder(arg), arg).toBe(false);
  });
  it("bounds args: 32 of 512 printable characters", () => {
    expect(errorsOf(server({ entry: "x.js", args: Array(32).fill("a") }))).toEqual([]);
    expect(errorsOf(server({ entry: "x.js", args: Array(33).fill("a") })).join()).toContain("at most 32");
    expect(errorsOf(server({ entry: "x.js", args: ["a".repeat(512)] }))).toEqual([]);
    expect(errorsOf(server({ entry: "x.js", args: ["a".repeat(513)] })).join()).toContain("at most 512");
    expect(errorsOf(server({ entry: "x.js", args: ["a\u001bb"] })).join()).toContain("printable");
    expect(errorsOf(server({ entry: "x.js", args: [1] })).join()).toContain("must be a string");
    expect(errorsOf(server({ entry: "x.js", args: "x" })).join()).toContain("list of strings");
  });
  it("bounds the number of servers: 16 accepted, 17 rejected", () => {
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { entry: "x.js" }]));
    expect(errorsOf({ ...manifest, permissions: { mcpServers: many(PLUGIN_LIMITS.maxMcpServers) } })).toEqual([]);
    expect(errorsOf({ ...manifest, permissions: { mcpServers: many(PLUGIN_LIMITS.maxMcpServers + 1) } }).join()).toContain("at most 16");
  });
  it("rejects a command, env, cwd or any other key, and says the runner runs its own Node", () => {
    for (const key of ["command", "env", "cwd", "shell", "Entry"]) {
      const errors = errorsOf(server({ entry: "x.js", [key]: key === "env" ? { A: "b" } : "node" }));
      expect(errors.length, key).toBe(1);
      expect(errors[0], key).toContain(`"${key}"`);
      expect(errors[0], key).toContain("its own Node");
    }
  });
  it("rejects shapes that are not objects", () => {
    expect(errorsOf({ ...manifest, permissions: { mcpServers: [] } }).length).toBe(1);
    expect(errorsOf({ ...manifest, permissions: { mcpServers: "x" } }).length).toBe(1);
    expect(errorsOf(server("x.js")).join()).toContain("must be an object");
    expect(errorsOf(server(null)).length).toBe(1);
  });
});

describe("plugin manifest: headless", () => {
  it("accepts tools of declared servers, including a tool part with a double underscore", () => {
    expect(errorsOf(withPerms({ headless: { tools: ["mcp__corpus__read", "mcp__corpus__a__b", "mcp__corpus__x-y_z"] } }))).toEqual([]);
    expect(parseMcpToolName("mcp__corpus__a__b")).toEqual({ server: "corpus", tool: "a__b" });
    expect(parseMcpToolName("mcp__a-b__read")).toEqual({ server: "a-b", tool: "read" });
  });
  it("rejects a tool of an undeclared server and names the server", () => {
    const errors = errorsOf(withPerms({ headless: { tools: ["mcp__other__read"] } }));
    expect(errors).toEqual([expect.stringContaining('undeclared server "other"')]);
  });
  it("rejects names that are not mcp__<server>__<tool>", () => {
    const tool65 = `mcp__corpus__${"t".repeat(65)}`;
    for (const tool of ["read", "mcp__corpus__", "mcp__corpus__a b", tool65, "mcp__Corpus__x", "mcp__a_b__x", "mcp__corpus_read", "", 5]) {
      expect(errorsOf(withPerms({ headless: { tools: [tool] } })).length, String(tool)).toBeGreaterThan(0);
    }
    expect(errorsOf(withPerms({ headless: { tools: [`mcp__corpus__${"t".repeat(64)}`] } }))).toEqual([]);
    expect(parseMcpToolName("mcp__corpus__")).toBeUndefined();
    expect(parseMcpToolName(5)).toBeUndefined();
  });
  it("rejects duplicates, an empty list, extra keys and a non-list", () => {
    expect(errorsOf(withPerms({ headless: { tools: ["mcp__corpus__read", "mcp__corpus__read"] } })).join()).toContain("listed twice");
    expect(errorsOf(withPerms({ headless: { tools: [] } })).length).toBe(1);
    expect(errorsOf(withPerms({ headless: { tools: ["mcp__corpus__read"], extra: 1 } })).join()).toContain('unknown key "extra"');
    expect(errorsOf(withPerms({ headless: { tools: "mcp__corpus__read" } })).length).toBe(1);
    expect(errorsOf(withPerms({ headless: ["mcp__corpus__read"] })).length).toBe(1);
  });
  it("bounds the list at 256", () => {
    const tools = (n: number) => Array.from({ length: n }, (_, i) => `mcp__corpus__t${i}`);
    expect(errorsOf(withPerms({ headless: { tools: tools(256) } }))).toEqual([]);
    expect(errorsOf(withPerms({ headless: { tools: tools(257) } })).join()).toContain("at most 256");
  });
  it("needs a declared server", () => {
    expect(errorsOf({ ...manifest, permissions: { headless: { tools: ["mcp__corpus__read"] } } }).join()).toContain("needs permissions.mcpServers");
  });
  it("counts every key of mcpServers as declared, however broken, so only the real fault is reported", () => {
    // A malformed declaration is one error; the tool that names it is not also an "undeclared server".
    const broken: [string, unknown][] = [
      ["a non-object server", 5],
      ["a null server", null],
      ["an array server", []],
      ["a bad entry", { entry: "../x.js" }],
      ["an unknown key", { entry: "x.js", command: "sh" }],
      ["bad args", { entry: "x.js", args: [1] }],
    ];
    for (const [label, value] of broken) {
      const errors = errorsOf({ ...manifest, permissions: { mcpServers: { corpus: value }, headless: { tools: ["mcp__corpus__read"] } } });
      expect(errors.length, label).toBe(1);
      expect(errors.join(), label).not.toContain("undeclared");
    }
    // A server name that breaks the name rule is still a declared key; the tool naming it fails its own, separate check.
    const badName = errorsOf({ ...manifest, permissions: { mcpServers: { "Bad-Name": { entry: "x.js" } }, headless: { tools: ["mcp__corpus__read"] } } });
    expect(badName.filter((e) => e.includes("undeclared")).length).toBe(1);
    expect(badName.filter((e) => e.includes("server name must be lowercase")).length).toBe(1);
  });
});

describe("plugin manifest: messages", () => {
  it("keeps unknown permissions rejected, one line, no control characters, values quoted short", () => {
    expect(errorsOf(withPerms({ sudo: true }))).toEqual([expect.stringContaining("unknown permission")]);
    const evil = "x\u001b[2K\r\n" + "y".repeat(200);
    const messages = [
      ...errorsOf(server({ entry: "x.js", args: [evil] })),
      ...errorsOf(server({ entry: evil })),
      ...errorsOf(server({ entry: "x.js", [evil]: 1 })),
      ...errorsOf(server({ entry: "x.js" }, evil)),
      ...errorsOf(withPerms({ headless: { tools: [evil] } })),
      ...errorsOf(withPerms({ headless: { tools: ["mcp__corpus__ok"], [evil]: 1 } })),
    ];
    expect(messages.length).toBeGreaterThan(5);
    for (const m of messages) {
      expect(m).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
      expect(m).not.toContain("y".repeat(65));
    }
  });
});

const ok = (p: unknown): StartAgentSessionParams => {
  const r = validateStartAgentSessionParams(p);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.value;
};
const bad = (p: unknown): string[] => {
  const r = validateStartAgentSessionParams(p);
  return r.ok ? [] : r.errors;
};
const full: StartAgentSessionParams = {
  agent: "claude",
  tools: { allow: ["mcp__corpus__read"], builtins: "none" },
  mcpServers: ["corpus"],
  secret: "s3cret",
  model: "claude-sonnet-5-5",
  budget: { wallClockMs: 60_000, maxToolCalls: 20 },
  headless: true,
};

describe("startAgentSession params", () => {
  it("accepts today's request and a full contained one", () => {
    expect(ok({ agent: "claude" })).toEqual({ agent: "claude" });
    expect(ok({ agent: "claude", cwd: "/w", onBehalfOf: { appId: "a", browserKeyId: "k" } })).toBeTruthy();
    expect(ok(full)).toEqual(full);
    expect(ok({ agent: "claude", callToken: "x" })).toBeTruthy();
  });
  it("defines contained as tools.builtins === 'none' and lists the contained-only fields otherwise", () => {
    expect(isContainedRequest(full)).toBe(true);
    expect(containedOnlyFieldsOf(full)).toEqual([]);
    for (const p of [{ ...full, tools: { ...full.tools, builtins: "agent-default" as const } }, { ...full, tools: { allow: full.tools!.allow } }, { ...full, tools: undefined }]) {
      expect(isContainedRequest(p)).toBe(false);
      expect(containedOnlyFieldsOf(p)).toEqual(p.tools?.allow ? ["mcpServers", "secret", "headless", "tools.allow", "budget"] : ["mcpServers", "secret", "headless", "budget"]);
    }
    expect(isContainedRequest({})).toBe(false);
  });
  it("counts only fields that would do something", () => {
    expect(containedOnlyFieldsOf({ headless: false })).toEqual([]);
    expect(containedOnlyFieldsOf({ tools: { allow: [] }, mcpServers: [] })).toEqual([]);
    expect(containedOnlyFieldsOf({ secret: "" })).toEqual(["secret"]);
    expect(containedOnlyFieldsOf({ headless: true })).toEqual(["headless"]);
    expect(containedOnlyFieldsOf({})).toEqual([]);
  });
  it("counts a budget with a limit, and never a model", () => {
    expect(containedOnlyFieldsOf({ budget: { maxToolCalls: 5 } })).toEqual(["budget"]);
    expect(containedOnlyFieldsOf({ budget: { wallClockMs: 1000 } })).toEqual(["budget"]);
    expect(containedOnlyFieldsOf({ budget: {} })).toEqual([]);
    expect(containedOnlyFieldsOf({ tools: { builtins: "none" }, budget: { maxToolCalls: 5 } })).toEqual([]);
    expect(containedOnlyFieldsOf({ ...({ model: "claude-sonnet-5-5" } as object) })).toEqual([]);
  });
  it("rejects unknown keys at every level", () => {
    expect(bad({ agent: "claude", onPermission: 1 }).join()).toContain('unknown key "onPermission"');
    expect(bad({ agent: "claude", tools: { builtins: "none", mode: "bypass" } }).join()).toContain('unknown key "mode"');
    expect(bad({ agent: "claude", budget: { wallClockMs: 1, tokens: 1 } }).join()).toContain('unknown key "tokens"');
    expect(bad({ agent: "claude", command: "sh", env: {} }).length).toBe(2);
  });
  it("bounds the secret at 4 KiB of well-formed UTF-8 and never echoes it", () => {
    expect(bad({ agent: "claude", secret: "a".repeat(4096) })).toEqual([]);
    expect(bad({ agent: "claude", secret: "a".repeat(4097) }).length).toBe(1);
    expect(bad({ agent: "claude", secret: "é".repeat(2048) })).toEqual([]);
    expect(bad({ agent: "claude", secret: "é".repeat(2049) }).length).toBe(1);
    expect(bad({ agent: "claude", secret: "a".repeat(4000) + "€".repeat(40) }).length).toBe(1);
    expect(bad({ agent: "claude", secret: "ab\ud800cd" }).length).toBe(1);
    expect(bad({ agent: "claude", secret: "😀" })).toEqual([]);
    expect(bad({ agent: "claude", secret: "a\0b" }).length).toBe(1);
    expect(bad({ agent: "claude", secret: 5 }).length).toBe(1);
    const canary = "CANARY-9f3a" + "\ud800";
    for (const secret of [canary, canary + "x".repeat(5000), "CANARY-9f3a\0"]) {
      expect(bad({ agent: "claude", secret, model: 5 }).join("\n")).not.toContain("CANARY");
    }
  });
  it("bounds mcpServers: 16 declared-looking names, no duplicates", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
    expect(bad({ agent: "claude", mcpServers: [] })).toEqual([]);
    expect(bad({ agent: "claude", mcpServers: names(16) })).toEqual([]);
    expect(bad({ agent: "claude", mcpServers: names(17) }).join()).toContain("at most 16");
    expect(bad({ agent: "claude", mcpServers: ["a", "a"] }).join()).toContain("listed twice");
    expect(bad({ agent: "claude", mcpServers: ["a_b"] }).length).toBe(1);
    expect(bad({ agent: "claude", mcpServers: "a" }).length).toBe(1);
  });
  it("bounds tools.allow at 256 distinct mcp__ names and tools.builtins to two values", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `mcp__corpus__t${i}`);
    expect(bad({ agent: "claude", tools: { allow: names(256) } })).toEqual([]);
    expect(bad({ agent: "claude", tools: { allow: names(257) } }).join()).toContain("at most 256");
    expect(bad({ agent: "claude", tools: { allow: ["mcp__corpus__a", "mcp__corpus__a"] } }).join()).toContain("listed twice");
    expect(bad({ agent: "claude", tools: { allow: ["Bash"] } }).length).toBe(1);
    expect(bad({ agent: "claude", tools: { builtins: "all" } }).length).toBe(1);
    expect(bad({ agent: "claude", tools: "none" }).length).toBe(1);
  });
  it("bounds model and budget", () => {
    expect(bad({ agent: "claude", model: "m".repeat(128) })).toEqual([]);
    expect(bad({ agent: "claude", model: "m".repeat(129) }).length).toBe(1);
    expect(bad({ agent: "claude", model: "a b" }).length).toBe(1);
    expect(bad({ agent: "claude", budget: {} })).toEqual([]);
    expect(bad({ agent: "claude", budget: { wallClockMs: 3_600_000, maxToolCalls: 500 } })).toEqual([]);
    for (const budget of [{ wallClockMs: 0 }, { maxToolCalls: 501 }, { wallClockMs: 1.5 }, { wallClockMs: "1" }, { wallClockMs: 3_600_001 }, { wallClockMs: 86_400_000 }, { maxToolCalls: 10_000 }, "x"]) {
      expect(bad({ agent: "claude", budget }).length, JSON.stringify(budget)).toBe(1);
    }
  });
  it("rejects headless: true together with onBehalfOf", () => {
    const caller = { appId: "a", browserKeyId: "k" };
    expect(bad({ agent: "claude", headless: true, onBehalfOf: caller }).join()).toContain("contradicts onBehalfOf");
    expect(bad({ agent: "claude", tools: { builtins: "none" }, headless: true, onBehalfOf: caller }).length).toBe(1);
    expect(bad({ agent: "claude", headless: false, onBehalfOf: caller })).toEqual([]);
    expect(bad({ agent: "claude", headless: true })).toEqual([]);
    expect(bad({ agent: "claude", headless: "yes", onBehalfOf: caller }).length).toBe(1);
  });
  it("refuses a cwd on a contained request, wherever the rest of the params stand", () => {
    expect(containedForbiddenFieldsOf({ tools: { builtins: "none" }, cwd: "/w" })).toEqual(["cwd"]);
    expect(containedForbiddenFieldsOf({ tools: { builtins: "none" }, cwd: "" })).toEqual(["cwd"]);
    expect(containedForbiddenFieldsOf({ tools: { builtins: "none" } })).toEqual([]);
    for (const tools of [undefined, {}, { allow: [] }, { builtins: "agent-default" as const }]) {
      expect(containedForbiddenFieldsOf({ tools, cwd: "/w" }), JSON.stringify(tools)).toEqual([]);
    }
    for (const cwd of ["/w", "", "/".repeat(4096), "relative", ".", "/state/sessions/x"]) {
      const errors = bad({ ...full, cwd });
      expect(errors.filter((e) => e.includes("cwd must not be set on a contained session")), JSON.stringify(cwd)).toHaveLength(1);
      expect(bad({ agent: "claude", tools: { builtins: "none" }, cwd })).toEqual([expect.stringContaining("contained session")]);
    }
    // A non-contained request keeps its cwd, with or without the other fields.
    expect(ok({ agent: "claude", cwd: "/w" }).cwd).toBe("/w");
    expect(ok({ agent: "claude", tools: { builtins: "agent-default" }, cwd: "/w" }).cwd).toBe("/w");
    expect(bad({ ...full, cwd: undefined })).toEqual([]);
  });
  it("rejects unknown keys inside onBehalfOf and bounds cwd, callToken and the caller ids", () => {
    const caller = { appId: "a", browserKeyId: "k" };
    expect(bad({ agent: "claude", onBehalfOf: { ...caller, role: "admin" } }).join()).toContain('onBehalfOf: unknown key "role"');
    expect(bad({ agent: "claude", onBehalfOf: { appId: "a".repeat(256), browserKeyId: "k".repeat(256) } })).toEqual([]);
    expect(bad({ agent: "claude", onBehalfOf: { appId: "a".repeat(257), browserKeyId: "k" } }).length).toBe(1);
    expect(bad({ agent: "claude", onBehalfOf: { appId: "a", browserKeyId: "k".repeat(257) } }).length).toBe(1);
    expect(bad({ agent: "claude", onBehalfOf: "x" }).length).toBe(1);
    expect(bad({ agent: "claude", cwd: "/".repeat(4096) })).toEqual([]);
    expect(bad({ agent: "claude", cwd: "/".repeat(4097) }).length).toBe(1);
    expect(bad({ agent: "claude", callToken: "t".repeat(128) })).toEqual([]);
    expect(bad({ agent: "claude", callToken: "t".repeat(129) }).length).toBe(1);
    expect(bad({ agent: "claude", callToken: 5 }).length).toBe(1);
  });
  it("returns a rebuilt copy that holds only the known keys", () => {
    const input = JSON.parse(JSON.stringify({ ...full, tools: { ...full.tools, builtins: "agent-default" }, headless: undefined, onBehalfOf: { appId: "a", browserKeyId: "k" }, cwd: "/w", callToken: "t" })) as Record<string, unknown>;
    const value = ok(input);
    expect(value).toEqual(input);
    expect(value).not.toBe(input);
    expect(value.tools).not.toBe(input.tools);
    expect(value.onBehalfOf).not.toBe(input.onBehalfOf);
    expect(value.mcpServers).not.toBe(input.mcpServers);
    expect(Object.keys(ok({ agent: "claude" }))).toEqual(["agent"]);
  });
  it("rejects an over-long secret without scanning it", () => {
    const canary = "CANARY-9f3a";
    const r = bad({ agent: "claude", secret: canary + "x".repeat(1_000_000) });
    expect(r.length).toBe(1);
    expect(r.join()).not.toContain("CANARY");
  });
  it("keeps the budget ceiling a person would approve for an unattended session: at most 1 hour and 500 calls", () => {
    expect(PLUGIN_LIMITS.maxWallClockMs).toBeLessThanOrEqual(3_600_000);
    expect(PLUGIN_LIMITS.maxToolCalls).toBeLessThanOrEqual(500);
  });
  it("keeps the shape checks of today's params", () => {
    expect(bad({ agent: "claude", cwd: 5 }).length).toBe(1);
    expect(bad({ agent: "claude", onBehalfOf: { appId: "a" } }).length).toBe(1);
    expect(bad({ agent: "claude", headless: "yes" }).length).toBe(1);
    expect(bad({ cwd: "/w" }).length).toBe(1);
    expect(bad({ agent: "a b" }).length).toBe(1);
    expect(bad("x")).toEqual(["params must be an object"]);
  });
});

describe("session wire constants", () => {
  it("documents the host-issued call token on the plugin call and on the session start", () => {
    const call: PluginCallParams = { method: "_p/x", caller: { appId: "a", browserKeyId: "k" }, callToken: "t" };
    expect(ok({ agent: "claude", onBehalfOf: call.caller, callToken: call.callToken }).callToken).toBe("t");
  });
  it("fixes the seven end reasons and the two host-to-plugin notifications", () => {
    expect(SESSION_END_REASONS).toEqual(["closed", "cancelled", "budget", "breach", "agent_exited", "plugin_gone", "runner_shutdown"]);
    expect(PLUGIN_RPC.sessionUpdate).toBe("host/sessionUpdate");
    expect(PLUGIN_RPC.sessionEnded).toBe("host/sessionEnded");
  });
});
