import { describe, expect, expectTypeOf, it } from "vitest";

import { createConsentStore, diffSurfaces, grantWidened, installAnswerProblem, surfaceOf, surfaceSha256Of } from "../index.js";
import type {
  ConsentOptions,
  ConsentStore,
  ConsentedGrant,
  GrantItem,
  GrantSurface,
  InstallOptions,
  InstalledPlugin,
  PackagePin,
  PermissionSummary,
  PluginHost,
  RemoveOptions,
} from "./contracts.js";

describe("install and remove options", () => {
  it("carry replace, nonInteractive, pinnedHash and terminal, and no manifest-hash acceptance", () => {
    expectTypeOf<InstallOptions>().toEqualTypeOf<{
      replace?: boolean;
      nonInteractive?: boolean;
      pinnedHash?: PackagePin;
      terminal?: boolean;
    }>();
    expectTypeOf<InstallOptions>().not.toHaveProperty("acceptManifestSha256");
    expectTypeOf<RemoveOptions>().toEqualTypeOf<{ keepData?: boolean }>();
  });
  it("types the pin as a digest of the downloaded artifact, in the two forms allowed", () => {
    expectTypeOf<PackagePin>().toEqualTypeOf<{ algorithm: "sha256"; digest: string } | { algorithm: "sha512"; digest: string }>();
    const https: InstallOptions = { nonInteractive: true, pinnedHash: { algorithm: "sha256", digest: "a".repeat(64) } };
    const npm: InstallOptions = { nonInteractive: true, pinnedHash: { algorithm: "sha512", digest: "A".repeat(86) + "==" } };
    expect([https.pinnedHash?.algorithm, npm.pinnedHash?.algorithm]).toEqual(["sha256", "sha512"]);
    // @ts-expect-error a bare string cannot say which digest it is, nor of what
    const bare: InstallOptions = { pinnedHash: "a".repeat(64) };
    expect(bare).toBeTruthy();
  });
  it("reads an absent terminal as no person: a widened or unknown grant needs terminal === true", () => {
    for (const options of [undefined, {}, { nonInteractive: true }, { terminal: false }, { nonInteractive: true, terminal: false }]) {
      expect(installAnswerProblem(options, true), JSON.stringify(options)).toContain("only a person at a terminal");
      expect(installAnswerProblem(options, undefined), JSON.stringify(options)).toContain("only a person at a terminal");
    }
    expect(installAnswerProblem({ terminal: true }, true)).toBeUndefined();
    expect(installAnswerProblem({ terminal: true }, undefined)).toBeUndefined();
  });
  it("lets an unchanged or narrower grant be answered without a person, and rejects the contradictory flags", () => {
    for (const options of [undefined, {}, { nonInteractive: true }, { terminal: true }]) {
      expect(installAnswerProblem(options, false), JSON.stringify(options)).toBeUndefined();
    }
    for (const widened of [true, false, undefined]) {
      expect(installAnswerProblem({ nonInteractive: true, terminal: true }, widened), String(widened)).toContain("both interactive");
    }
  });
  it("defines a widened grant once: a first install with mcpServers or headless, or an update that adds an item", () => {
    const item = (kind: GrantItem["kind"], value: string): GrantItem => ({ kind, value });
    const server = (entry: string, args: string[] = []) => item("mcpServer", JSON.stringify({ name: "corpus", entry, args }));
    const plain: GrantSurface = { items: [item("agent", "claude"), item("network", "api.example.com"), item("fs", "$PLUGIN_DATA"), item("localUi", "auto")] };
    const withServer: GrantSurface = { items: [...plain.items, server("dist/c.js")] };
    const withTools: GrantSurface = { items: [...withServer.items, item("headlessTool", "mcp__corpus__read")] };
    // First install.
    expect(grantWidened(plain, undefined)).toBe(false);
    expect(grantWidened({ items: [] }, undefined)).toBe(false);
    expect(grantWidened(withServer, undefined)).toBe(true);
    expect(grantWidened({ items: [item("headlessTool", "mcp__corpus__read")] }, undefined)).toBe(true);
    // Update or replace, against the consented surface.
    expect(grantWidened(plain, plain)).toBe(false);
    expect(grantWidened({ items: [...plain.items].reverse() }, plain)).toBe(false);
    expect(grantWidened(plain, withTools)).toBe(false);
    expect(grantWidened(withServer, withServer)).toBe(false);
    expect(grantWidened(withTools, withServer)).toBe(true);
    for (const added of [item("agent", "codex"), item("network", "evil.example.com"), item("fs", "/home/me"), item("localUi", "8080"), server("dist/d.js")]) {
      expect(grantWidened({ items: [...plain.items, added] }, plain), added.value).toBe(true);
    }
    // A changed entry or argument is a different item.
    expect(grantWidened({ items: [...plain.items, server("dist/c.js", ["--x"])] }, withServer)).toBe(true);
    expect(grantWidened({ items: [...plain.items, server("dist/other.js")] }, withServer)).toBe(true);
    // The same kind and value pair is one item; a value that merely contains another is not it.
    expect(grantWidened({ items: [item("network", "a.com")] }, { items: [item("network", "a.com"), item("fs", "a.com")] })).toBe(false);
    expect(grantWidened({ items: [item("fs", "a.com")] }, { items: [item("network", "a.com")] })).toBe(true);
  });
  it("lets --yes approve a plain first install and refuses one that carries an mcpServer or a headless set", () => {
    const item = (kind: GrantItem["kind"], value: string): GrantItem => ({ kind, value });
    const plain: GrantSurface = { items: [item("agent", "claude"), item("network", "api.example.com")] };
    const server: GrantSurface = { items: [...plain.items, item("mcpServer", JSON.stringify({ name: "s", entry: "e.js", args: [] }))] };
    const yes = { nonInteractive: true };
    expect(installAnswerProblem(yes, grantWidened(plain, undefined))).toBeUndefined();
    expect(installAnswerProblem(yes, grantWidened(server, undefined))).toContain("only a person at a terminal");
    expect(installAnswerProblem({ terminal: true }, grantWidened(server, undefined))).toBeUndefined();
    // An update that adds a network host is widened; the same update unchanged is not.
    const added: GrantSurface = { items: [...plain.items, item("network", "other.example.com")] };
    expect(installAnswerProblem(yes, grantWidened(added, plain))).toContain("only a person at a terminal");
    expect(installAnswerProblem(yes, grantWidened(plain, plain))).toBeUndefined();
    // A caller that cannot say still reads as widened.
    expect(installAnswerProblem(yes, undefined)).toContain("only a person at a terminal");
  });
  it("reach the host as an optional third argument", () => {
    expectTypeOf<PluginHost["install"]>().parameters.toEqualTypeOf<[string, ConsentOptions, (InstallOptions | undefined)?]>();
    expectTypeOf<PluginHost["install"]>().returns.toEqualTypeOf<Promise<InstalledPlugin>>();
    expectTypeOf<PluginHost["remove"]>().parameters.toEqualTypeOf<[string, ConsentOptions, (RemoveOptions | undefined)?]>();
    expectTypeOf<PluginHost["revoke"]>().toEqualTypeOf<(pluginId: string, consent?: ConsentOptions) => Promise<void>>();
  });
});

describe("grant surface and consent store", () => {
  it("records what was approved, canonical and hashed", () => {
    expectTypeOf<GrantItem["kind"]>().toEqualTypeOf<"agent" | "network" | "fs" | "localUi" | "mcpServer" | "headlessTool" | "execution">();
    expectTypeOf<ConsentedGrant["surface"]>().toEqualTypeOf<GrantSurface>();
    expectTypeOf<ConsentedGrant["surfaceSha256"]>().toEqualTypeOf<string>();
    expectTypeOf<ConsentStore>().toHaveProperty("read");
    expectTypeOf<ConsentStore>().toHaveProperty("write");
    expectTypeOf<ConsentStore>().toHaveProperty("revoke");
    expectTypeOf<ConsentStore["read"]>().returns.toEqualTypeOf<Promise<ConsentedGrant | undefined>>();
  });
  it("adds the grant facts to the permission summary, all optional", () => {
    expectTypeOf<PermissionSummary["surfaceSha256"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PermissionSummary["widened"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<PermissionSummary["headless"]>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<PermissionSummary>().toHaveProperty("mcpServers");
    expectTypeOf<PermissionSummary>().toHaveProperty("diff");
    expectTypeOf<PermissionSummary>().toHaveProperty("auditFile");
  });
});

describe("consent.ts", () => {
  it("is re-exported from the barrel", () => {
    for (const fn of [surfaceOf, surfaceSha256Of, diffSurfaces, createConsentStore]) expect(typeof fn).toBe("function");
  });
});
