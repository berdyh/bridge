import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { confinedSettings, runtimeReadPaths } from "./confined.js";
import { confinedSocketDirectoryFits } from "./confined-sockets.js";
import { hostInterfaceDenies } from "./confined-addresses.js";
import { containedRequestProblem, resolveGrantedServer } from "./contracts.js";
import { grantWidened, installAnswerProblem } from "../plugins/contracts.js";
import { surfaceOf, surfaceSha256Of } from "../plugins/consent.js";
import { createLocalPolicy } from "./policy.js";
import { createAcpProxy } from "./proxy.js";
import { claudeProfileOf } from "./containment/claude.js";
import { confinedProfile } from "./confined.js";
import { MEASURED_CLAUDE_STACK } from "./contracts.js";
import type { PluginManifest } from "@berdyh/bridge-protocol";

describe("confined-v1 consent boundary", () => {
  it("computes Linux socket capacity from bytes and the longest SRT filename", () => {
    expect(confinedSocketDirectoryFits("/" + "a".repeat(71))).toBe(true);
    expect(confinedSocketDirectoryFits("/" + "a".repeat(72))).toBe(false);
    expect(confinedSocketDirectoryFits("/" + "é".repeat(36))).toBe(false);
  });
  it("blocks globally routed host addresses and canonical mapped IPv6 interface aliases", () => {
    const info = (address: string) => ({ address, netmask: "", family: address.includes(":") ? "IPv6" as const : "IPv4" as const, mac: "", internal: false, cidr: null, scopeid: 0 });
    expect(hostInterfaceDenies({ public: [info("203.0.113.9"), info("2001:0db8:0:0::1"), info("::ffff:203.0.113.9")], link: [info("fe80::1%eth0")] })).toEqual(["203.0.113.9/32", "2001:db8::1/128", "::ffff:cb00:7109/128", "fe80::1/128"]);
  });
  const execution = { profile: "confined-v1" as const, network: ["api.anthropic.com:443"] };
  const manifest: PluginManifest = { id: "alpha", app: "a", entry: "index.js", permissions: { execution, agents: ["claude"], mcpServers: { broker: { entry: "broker.js", secretTransport: "fd3" } }, headless: { tools: ["mcp__broker__read"] } } };
  const resolution = { installDir: "/kit/plugin", dataDir: "/app/private", surfaceSha256Of };
  const surface = surfaceOf(manifest);
  const grant = { pluginId: "alpha", appId: "a", version: "1", time: "now", surface, surfaceSha256: surfaceSha256Of(surface) };
  const server = resolveGrantedServer({ name: "broker", entry: "broker.js", args: [], secretTransport: "fd3" }, "/usr/bin/node", resolution)!;
  const request = { pluginId: "alpha", appId: "a", agent: "claude", execution, mcpServers: ["broker"], servers: [server], tools: { allow: ["mcp__broker__read"] }, secret: "CANARY", grant };
  it("binds script/workspace/network and broker fd3 permissions to the install grant", () => {
    expect(containedRequestProblem(request, "/usr/bin/node", resolution)).toBeUndefined();
    expect(surface.items).toContainEqual({ kind: "execution", value: JSON.stringify(execution) });
    expect(containedRequestProblem({ ...request, execution: { ...execution, network: ["other.domain:443"] } }, "/usr/bin/node", resolution)?.message).toMatch(/consented/);
    expect(containedRequestProblem({ ...request, servers: [{ ...server, secretTransport: undefined }] }, "/usr/bin/node", resolution)?.message).toMatch(/transport/);
    expect(containedRequestProblem({ ...request, grant: { ...grant, appId: "other" } }, "/usr/bin/node", resolution)?.message).toMatch(/another/);
  });
  it("returns safe actionable unsupported-agent and busy-login refusal codes", async () => {
    for (const id of ["codex", "claude"]) {
      const proxy = createAcpProxy({ appId: "a", defaultCwd: "/run", adapters: [{ id, availability: async () => ({ id, available: true }), execution: id === "claude" ? () => confinedProfile(claudeProfileOf(MEASURED_CLAUDE_STACK)) : undefined, spawn: async () => { throw Object.assign(new Error("PRIVATE_LEASE_PATH_MUST_STAY_LOCAL"), { code: "AGENT_LOGIN_BUSY" }); } }], policy: createLocalPolicy({ agents: [id], pluginApprovals: true, auditFailed: () => false }), contained: { runnerNode: "/usr/bin/node", sessionsDir: "/run/sessions", resolutionOf: () => resolution, auditLogOf: () => ({ append() {}, recordFrame() {}, recordDecision() {}, endSession() {} }) } });
      try {
        const error = await proxy.broker.start({ ...request, agent: id }).then(() => undefined, (caught) => caught);
        expect(error).toMatchObject({ code: -32016, data: { reason: id === "codex" ? "execution_unsupported" : "login_busy" } });
        expect(error.data.hint).toMatch(id === "codex" ? /bundled Claude/ : /active agent session/);
        expect(JSON.stringify(error)).not.toContain("PRIVATE_LEASE_PATH");
      } finally { await proxy.close(); }
    }
  });
  it("requires terminal consent for execution-only first installs", () => {
    const widened = grantWidened({ items: [{ kind: "execution", value: JSON.stringify(execution) }] }, undefined);
    expect(widened).toBe(true);
    expect(installAnswerProblem({ nonInteractive: true, terminal: false }, widened)).toBeDefined();
    expect(installAnswerProblem({ terminal: true }, widened)).toBeUndefined();
  });
  it("requires fresh consent when an existing profile adds host-service authority", () => {
    const before = surfaceOf(manifest);
    const next = surfaceOf({ ...manifest, permissions: { ...manifest.permissions, execution: { ...execution, broker: "http-unix" } } });
    expect(grantWidened(next, before)).toBe(true);
    expect(installAnswerProblem({ nonInteractive: true }, grantWidened(next, before))).toBeDefined();
  });
  it("keeps root reads denied, writes bounded, private addresses blocked and seccomp enabled", () => {
    const settings = confinedSettings(["/runtime"], ["/run"], execution.network);
    expect(settings.filesystem.denyRead).toEqual(["/"]);
    expect(settings.filesystem.allowWrite).toEqual(["/run"]);
    expect(settings.network.allowAllUnixSockets).toBe(false);
    expect(settings.allowNestedUserNamespaces).toBe(false);
    expect(settings.network.deniedResolvedAddresses).toContain("127.0.0.0/8");
    expect(settings.network.deniedResolvedAddresses).toContain("::ffff:0:0/96");
  });
  it("approves script tools only with runner-verified execution consent, preserving builtin-none refusals", async () => {
    const policy = createLocalPolicy({ pluginApprovals: true, auditFailed: () => false });
    const info = { appId: "a", agentId: "claude", sessionId: "s", cwd: "/run", toolCallId: "t", toolName: "Bash", options: [{ optionId: "yes", kind: "allow_once", name: "yes" }, { optionId: "no", kind: "reject_once", name: "no" }], origin: { kind: "plugin" as const, pluginId: "alpha", contained: true, headless: true, callsLeft: 1, allow: ["Bash"] } };
    expect(await policy.decidePermission(info)).toEqual({ action: "select", optionId: "no" });
    expect(await policy.decidePermission({ ...info, origin: { ...info.origin, execution: "confined-v1" } })).toEqual({ action: "select", optionId: "yes" });
  });
});

describe("runtime read paths", () => {
  it("grants only the entry file inside a workspace root, whatever the root package is called", () => {
    const root = mkdtempSync(path.join(tmpdir(), "confined-root-"));
    try {
      for (const [name, workspace] of [["bridge", true], ["renamed-checkout", true], ["any-name", true], ["plain-package", false]] as const) {
        const dir = path.join(root, name);
        mkdirSync(dir);
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
        if (workspace) writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
        const entry = path.join(dir, "entry.js");
        writeFileSync(entry, "");
        // The node binary and the entry itself are always readable; only a non-workspace package adds its folder.
        const node = realpathSync(process.execPath);
        expect(runtimeReadPaths([entry])).toEqual(workspace ? [node, realpathSync(entry)] : [node, realpathSync(entry), realpathSync(dir)]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
