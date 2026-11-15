import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest, StartAgentSessionParams } from "@berdyh/bridge-protocol";
import { PROXY_ERROR, containedRequestProblem, type AgentSessionBroker } from "../acp/contracts.js";
import { brokerRequestOf, parseStartParams, restrictBroker, type SessionRequestContext } from "./broker.js";
import { surfaceOf, surfaceSha256Of } from "./consent.js";
import type { ConsentedGrant, InstalledPlugin } from "./contracts.js";

const NODE = "/usr/bin/node";
const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

const MANIFEST: PluginManifest = {
  id: "alpha", app: "app-a", entry: "index.js",
  permissions: {
    agents: ["claude"],
    mcpServers: {
      notes: { entry: "dist/notes.js", args: ["--data", "${PLUGIN_DATA}", "--secret", "${SESSION_SECRET_FILE}"] },
      plain: { entry: "dist/plain.js" },
    },
    headless: { tools: ["mcp__notes__append"] },
  },
};
const grantOfManifest = (manifest: PluginManifest): ConsentedGrant => {
  const surface = surfaceOf(manifest);
  return { pluginId: manifest.id, appId: manifest.app, version: "1.0.0", surface, surfaceSha256: surfaceSha256Of(surface), time: "2026-11-03T00:00:00.000Z" };
};

async function context(overrides: Partial<SessionRequestContext> = {}, manifest = MANIFEST): Promise<SessionRequestContext & { installed: InstalledPlugin }> {
  const root = await mkdtemp(fileURLToPath(new URL(".test-", import.meta.url)));
  temps.push(root);
  const installDir = path.join(root, "install"); const dataDir = path.join(root, "data");
  await mkdir(path.join(installDir, "dist"), { recursive: true }); await mkdir(dataDir);
  await writeFile(path.join(installDir, "dist", "notes.js"), ""); await writeFile(path.join(installDir, "dist", "plain.js"), "");
  const installed: InstalledPlugin = { manifest, appId: manifest.app, version: "1.0.0", installDir, dataDir, status: "running" };
  return { installed, runnerNode: NODE, pathBoundary: root, grantOf: async () => grantOfManifest(manifest), ...overrides };
}
const contained = (extra: Partial<StartAgentSessionParams> = {}): StartAgentSessionParams =>
  ({ agent: "claude", mcpServers: ["notes"], secret: "s", tools: { builtins: "none", allow: ["mcp__notes__append"] }, ...extra });
const refusal = async (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: number; message: string }) => error);

describe("restrictBroker", () => {
  it("lets only the manifest's agents through to the broker", async () => {
    const start = vi.fn(async () => ({}) as never);
    const broker = restrictBroker({ start } as AgentSessionBroker, ["claude"]);
    await expect(broker.start({ pluginId: "p", appId: "a", agent: "codex" })).rejects.toMatchObject({ code: PROXY_ERROR.sessionNotAllowed });
    expect(start).not.toHaveBeenCalled();
    await broker.start({ pluginId: "p", appId: "a", agent: "claude" });
    expect(start).toHaveBeenCalledOnce();
  });
});

describe("parseStartParams", () => {
  it("refuses unknown keys at every level with -32602, and never echoes the secret", () => {
    const secret = "SECRET-DO-NOT-ECHO";
    for (const raw of [
      { agent: "claude", permissionMode: "bypassPermissions" }, { agent: "claude", tools: { builtins: "none", extra: 1 } },
      { agent: "claude", budget: { wallClockMs: 1, cpu: 2 } }, { agent: "claude", tools: { builtins: "none" }, cwd: "/x", secret },
      { agent: "claude", secret: secret + "\0" }, "text", null, { agent: 5, secret },
    ]) {
      let failure: { code?: number; message: string } | undefined;
      try { parseStartParams(raw); } catch (error) { failure = error as typeof failure; }
      expect(failure?.code).toBe(-32602);
      expect(failure?.message).not.toContain(secret);
    }
  });
  it("returns only the known fields", () => {
    expect(parseStartParams(contained({ model: "sonnet", budget: { maxToolCalls: 2 }, headless: true }))).toEqual({
      agent: "claude", mcpServers: ["notes"], secret: "s", tools: { builtins: "none", allow: ["mcp__notes__append"] }, model: "sonnet", budget: { maxToolCalls: 2 }, headless: true,
    });
  });
});

describe("brokerRequestOf", () => {
  it("builds a contained request that passes the proxy's own check, with servers resolved to absolute entries", async () => {
    const ctx = await context();
    const request = await brokerRequestOf(contained({ model: "sonnet", budget: { wallClockMs: 5000 }, headless: true }), undefined, ctx);
    const { installDir, dataDir } = ctx.installed;
    expect(request).toMatchObject({
      pluginId: "alpha", appId: "app-a", agent: "claude", mcpServers: ["notes"], secret: "s", model: "sonnet", budget: { wallClockMs: 5000 }, headless: true,
      tools: { builtins: "none", allow: ["mcp__notes__append"] }, grant: grantOfManifest(MANIFEST),
      servers: [{ name: "notes", command: NODE, args: [path.join(installDir, "dist", "notes.js"), "--data", dataDir, "--secret", "${SESSION_SECRET_FILE}"] }],
    });
    expect("cwd" in request).toBe(false);
    expect(path.isAbsolute(request.servers![0]!.args[0]!)).toBe(true);
    expect(containedRequestProblem(request, NODE, { installDir, dataDir, surfaceSha256Of })).toBeUndefined();
  });
  it("reads the consent at each contained start, and not for an ordinary session", async () => {
    const grantOf = vi.fn(async () => grantOfManifest(MANIFEST));
    const ctx = await context({ grantOf });
    await brokerRequestOf(contained(), undefined, ctx); await brokerRequestOf(contained(), undefined, ctx);
    expect(grantOf).toHaveBeenCalledTimes(2);
    await brokerRequestOf({ agent: "claude", cwd: "/work", model: "sonnet" }, { browserKeyId: "k" }, ctx);
    expect(grantOf).toHaveBeenCalledTimes(2);
  });
  it("carries an ordinary session's fields as they are", async () => {
    const request = await brokerRequestOf({ agent: "claude", cwd: "/work", model: "sonnet", tools: { builtins: "agent-default" }, headless: false }, { browserKeyId: "k" }, await context());
    expect(request).toEqual({ pluginId: "alpha", appId: "app-a", agent: "claude", cwd: "/work", onBehalfOf: { browserKeyId: "k" }, model: "sonnet", tools: { builtins: "agent-default" }, headless: false });
  });
  it("refuses a contained-only field on an ordinary session with containmentUnavailable", async () => {
    const ctx = await context();
    for (const extra of [{ mcpServers: ["notes"] }, { secret: "" }, { headless: true }, { tools: { allow: ["mcp__notes__append"] } }, { budget: { maxToolCalls: 1 } }] as Partial<StartAgentSessionParams>[]) {
      expect(await refusal(brokerRequestOf({ agent: "claude", ...extra }, undefined, ctx))).toMatchObject({ code: PROXY_ERROR.containmentUnavailable });
    }
  });
  it("refuses with consentMissing when there is no consent, a failing read or no reader", async () => {
    for (const grantOf of [async () => undefined, async () => { throw new Error("link"); }, undefined]) {
      const ctx = await context({ grantOf });
      expect(await refusal(brokerRequestOf(contained(), undefined, ctx))).toMatchObject({ code: PROXY_ERROR.consentMissing });
    }
  });
  it("refuses a server that is not declared, or not in the grant, or granted twice", async () => {
    const ctx = await context();
    expect(await refusal(brokerRequestOf(contained({ mcpServers: ["ghost"] }), undefined, ctx))).toMatchObject({ code: -32602, message: expect.stringContaining("not declared") });
    // Declared in the manifest, but the consent record does not list it.
    const narrower = grantOfManifest({ ...MANIFEST, permissions: { ...MANIFEST.permissions, mcpServers: { plain: MANIFEST.permissions.mcpServers!.plain! }, headless: undefined } });
    expect(await refusal(brokerRequestOf(contained(), undefined, { ...ctx, grantOf: async () => narrower }))).toMatchObject({ code: -32602, message: expect.stringContaining("consented grant") });
    const twice = grantOfManifest(MANIFEST);
    twice.surface = { items: [...twice.surface.items, { kind: "mcpServer", value: JSON.stringify({ name: "notes", entry: "dist/other.js", args: [] }) }] };
    twice.surfaceSha256 = surfaceSha256Of(twice.surface);
    expect(await refusal(brokerRequestOf(contained(), undefined, { ...ctx, grantOf: async () => twice }))).toMatchObject({ code: -32602 });
  });
  it("refuses a grant whose hash does not match its surface, or that belongs to another plugin", async () => {
    const ctx = await context();
    const edited = grantOfManifest(MANIFEST);
    edited.surface = { items: [...edited.surface.items, { kind: "headlessTool", value: "mcp__notes__rm" }] };
    expect(await refusal(brokerRequestOf(contained(), undefined, { ...ctx, grantOf: async () => edited }))).toMatchObject({ code: -32602 });
    expect(await refusal(brokerRequestOf(contained(), undefined, { ...ctx, grantOf: async () => ({ ...grantOfManifest(MANIFEST), pluginId: "beta" }) }))).toMatchObject({ code: -32602 });
  });
  it("keeps tools.allow inside the consented headless set and the attached servers", async () => {
    const ctx = await context();
    for (const allow of [["mcp__notes__rm"], ["mcp__plain__append"]]) {
      expect(await refusal(brokerRequestOf(contained({ tools: { builtins: "none", allow } }), undefined, ctx))).toMatchObject({ code: -32602 });
    }
  });
  it("refuses a secret that no server reads, and a server that reads one when none is given", async () => {
    const ctx = await context();
    expect(await refusal(brokerRequestOf(contained({ mcpServers: ["plain"], tools: { builtins: "none" } }), undefined, ctx))).toMatchObject({ code: -32602 });
    const { secret: _omit, ...withoutSecret } = contained();
    expect(await refusal(brokerRequestOf(withoutSecret, undefined, ctx))).toMatchObject({ code: -32602 });
  });
  it("needs a consented headless set for headless: true", async () => {
    const manifest: PluginManifest = { ...MANIFEST, permissions: { ...MANIFEST.permissions, headless: undefined } };
    const ctx = await context({}, manifest);
    const params = contained({ tools: { builtins: "none" }, headless: true });
    expect(await refusal(brokerRequestOf(params, undefined, ctx))).toMatchObject({ code: PROXY_ERROR.consentMissing });
    expect(await brokerRequestOf({ ...params, headless: false }, undefined, ctx)).toMatchObject({ headless: false });
  });
  it("refuses a server entry behind a link, with a generic message and a local log line", async () => {
    const log = vi.fn();
    const ctx = await context({ log });
    const entry = path.join(ctx.installed.installDir, "dist", "notes.js");
    await rm(entry); await writeFile(path.join(ctx.installed.dataDir, "elsewhere.js"), ""); await symlink(path.join(ctx.installed.dataDir, "elsewhere.js"), entry);
    const failure = await refusal(brokerRequestOf(contained(), undefined, ctx));
    expect(failure).toMatchObject({ code: PROXY_ERROR.containmentUnavailable });
    expect(failure!.message).not.toContain(ctx.installed.installDir);
    expect(log).toHaveBeenCalledWith("warn", expect.any(String), expect.objectContaining({ error: expect.stringContaining("symlink") }));
  });
  it("refuses an agent the manifest does not list before reading any consent", async () => {
    const grantOf = vi.fn(async () => undefined);
    expect(await refusal(brokerRequestOf(contained({ agent: "codex" }), undefined, await context({ grantOf })))).toMatchObject({ code: PROXY_ERROR.sessionNotAllowed });
    expect(grantOf).not.toHaveBeenCalled();
  });
});
