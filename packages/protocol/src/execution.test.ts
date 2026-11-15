import { describe, expect, it } from "vitest";
import { isContainedRequest, validatePluginManifest, validateStartAgentSessionParams } from "./plugin.js";

const execution = { profile: "confined-v1", network: ["api.anthropic.com:443"] };
describe("explicit confined execution wire contract", () => {
  it("round-trips the distinct profile and refuses caller cwd / builtin-none ambiguity", () => {
    expect(validateStartAgentSessionParams({ agent: "claude", execution })).toEqual({ ok: true, value: { agent: "claude", execution } });
    for (const extra of [{ cwd: "/app" }, { tools: { builtins: "none" } }]) {
      expect(validateStartAgentSessionParams({ agent: "claude", execution, ...extra }).ok).toBe(false);
    }
    expect(isContainedRequest({ tools: { builtins: "none" } })).toBe(true);
    expect(isContainedRequest({ tools: { builtins: "agent-default" } })).toBe(false);
  });
  it("refuses unknown profiles, unknown fields, broad domains, non-HTTPS and address aliases", () => {
    for (const network of [["*.anthropic.com:443"], ["localhost:443"], ["127.0.0.1:443"], ["[::1]:443"], ["2130706433:443"], ["api.anthropic.com:80"], ["metadata.internal:443"], ["api.anthropic.com:443", "api.anthropic.com:443"]]) {
      expect(validateStartAgentSessionParams({ agent: "claude", execution: { ...execution, network } }).ok, JSON.stringify(network)).toBe(false);
    }
    for (const bad of [{ ...execution, profile: "future" }, { ...execution, cwd: "/host" }]) expect(validateStartAgentSessionParams({ agent: "claude", execution: bad }).ok).toBe(false);
  });
  it("binds the host service to explicit execution consent and a relative plugin-data socket", () => {
    const broker = { transport: "http-unix", socket: "brokers/run.sock" };
    expect(validateStartAgentSessionParams({ agent: "claude", execution, broker }).ok).toBe(false);
    expect(validateStartAgentSessionParams({ agent: "claude", execution: { ...execution, broker: "http-unix" }, broker })).toEqual({ ok: true, value: { agent: "claude", execution: { ...execution, broker: "http-unix" }, broker } });
    for (const socket of ["../another-plugin/run.sock", "/other-app/run.sock", "brokers/../../private.sock"]) expect(validateStartAgentSessionParams({ agent: "claude", execution: { ...execution, broker: "http-unix" }, broker: { ...broker, socket } }).ok).toBe(false);
  });
  it("records fd3 as an explicit server declaration and rejects unknown transports", () => {
    const manifest = { id: "test", app: "app", entry: "index.mjs", permissions: { execution, mcpServers: { broker: { entry: "broker.mjs", secretTransport: "fd3" } } } };
    expect(validatePluginManifest(manifest).ok).toBe(true);
    expect(validatePluginManifest({ ...manifest, permissions: { ...manifest.permissions, mcpServers: { broker: { entry: "broker.mjs", secretTransport: "env" } } } }).ok).toBe(false);
  });
});
