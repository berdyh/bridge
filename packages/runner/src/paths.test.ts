import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createLocalPolicy } from "./acp/policy.js";
import { RESERVED_APP_NAMES, agentDir, appPathsOf, assertAppFolderName, defaultBaseDirs, isAppFolderName, runnerPaths } from "./paths.js";

const base = defaultBaseDirs("/h", {});

describe("app folder names", () => {
  it("accepts the assertAppName rule and refuses the reserved name", () => {
    for (const ok of ["app-a", "app-b", "a", "a1-b2", "a".repeat(63)]) expect(isAppFolderName(ok), ok).toBe(true);
    for (const bad of ["bridge", "AppA", "appA", "1app", "-app", "a_b", "a.b", "../x", "a/b", "", " a", "a".repeat(64)]) {
      expect(isAppFolderName(bad), bad).toBe(false);
      expect(() => assertAppFolderName(bad), bad).toThrow(/invalid app folder name/);
    }
    expect(RESERVED_APP_NAMES).toEqual(["bridge"]);
    expect(() => assertAppFolderName("AppA")).toThrow(/lowercase/);
  });
});

describe("appPathsOf", () => {
  it("derives the three bridge folders and their files from one id", () => {
    const p = appPathsOf(base, "app-a");
    expect(p).toEqual({
      appId: "app-a",
      configDir: "/h/.config/app-a/bridge",
      appFile: "/h/.config/app-a/bridge/app.json",
      trustFile: "/h/.config/app-a/bridge/trust.json",
      identityFile: "/h/.config/app-a/bridge/identity.json",
      identityKeyFile: "/h/.config/app-a/bridge/identity.key",
      enrollFile: "/h/.config/app-a/bridge/enroll.json",
      revokedFile: "/h/.config/app-a/bridge/revoked.json",
      configFile: "/h/.config/app-a/bridge/config.json",
      dataDir: "/h/.local/share/app-a/bridge",
      pluginsDir: "/h/.local/share/app-a/bridge/plugins",
      pluginDataDir: "/h/.local/share/app-a/bridge/plugin-data",
      stateDir: "/h/.local/state/app-a/bridge",
      workDir: "/h/.local/state/app-a/bridge/work",
      tmpDir: "/h/.local/state/app-a/bridge/tmp",
      auditDir: "/h/.local/state/app-a/bridge/audit",
      consentDir: "/h/.config/app-a/bridge/plugins",
      sessionsDir: "/h/.local/state/app-a/bridge/sessions",
      secretsParent: "/h/.local/state/app-a/bridge/tmp",
      parents: { config: "/h/.config/app-a", data: "/h/.local/share/app-a", state: "/h/.local/state/app-a" },
    });
  });

  it("binds the paths to their app id: the object cannot be re-labelled for another app", () => {
    const p = appPathsOf(base, "app-a");
    expect(Object.isFrozen(p) && Object.isFrozen(p.parents)).toBe(true);
    expect(() => { (p as { appId: string }).appId = "app-b"; }).toThrow(TypeError);
    expect(p.appId).toBe("app-a");
  });

  it("honours injected bases", () => {
    const p = appPathsOf({ config: "/c", data: "/d", state: "/s" }, "x");
    expect([p.configDir, p.dataDir, p.stateDir]).toEqual(["/c/x/bridge", "/d/x/bridge", "/s/x/bridge"]);
  });

  it("never shares a path between two ids, and every path stays under its own app folder", () => {
    const a = appPathsOf(base, "app-a");
    const b = appPathsOf(base, "app-b");
    const flat = (p: ReturnType<typeof appPathsOf>): string[] => [
      ...Object.entries(p).filter(([key]) => key !== "appId" && key !== "parents").map(([, value]) => value as string),
      ...Object.values(p.parents),
    ];
    const pathsA = new Set(flat(a));
    for (const other of flat(b)) expect(pathsA.has(other), other).toBe(false);
    for (const own of [a.configDir, a.appFile, a.trustFile, a.identityFile, a.identityKeyFile, a.enrollFile, a.revokedFile, a.configFile, a.consentDir]) expect(own.startsWith(`${a.parents.config}${path.sep}bridge`)).toBe(true);
    for (const own of [a.dataDir, a.pluginsDir, a.pluginDataDir]) expect(own.startsWith(`${a.parents.data}${path.sep}bridge`)).toBe(true);
    for (const own of [a.stateDir, a.workDir, a.tmpDir, a.auditDir, a.sessionsDir, a.secretsParent]) expect(own.startsWith(`${a.parents.state}${path.sep}bridge`)).toBe(true);
  });

  it("derives the contained-session dirs from the one id and keeps them apart per app", () => {
    const a = appPathsOf(base, "app-a");
    const b = appPathsOf(base, "app-b");
    expect(a.secretsParent).toBe(a.tmpDir);
    expect(a.sessionsDir).toBe(path.join(a.stateDir, "sessions"));
    // A sibling of the work folder, never inside it (the folder allowSession admits for browser sessions).
    expect(path.relative(a.workDir, a.sessionsDir).startsWith("..")).toBe(true);
    expect(path.relative(a.sessionsDir, a.workDir).startsWith("..")).toBe(true);
    for (const key of ["auditDir", "consentDir", "sessionsDir", "secretsParent"] as const) {
      expect(a[key], key).toContain("/app-a/");
      expect(b[key], key).toContain("/app-b/");
      expect(a[key], key).not.toBe(b[key]);
    }
    // The consent records and the plugin packages are two different folders named `plugins`.
    expect(a.consentDir).not.toBe(a.pluginsDir);
    expect(a.consentDir.startsWith(a.parents.config)).toBe(true);
    expect(a.pluginsDir.startsWith(a.parents.data)).toBe(true);
  });

  it("keeps the contained-session folder out of what allowSession admits to a browser", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-paths-"));
    try {
      const home = path.join(root, "home");
      const real = defaultBaseDirs(home, {});
      const paths = appPathsOf(real, "app-a");
      const policy = createLocalPolicy({
        homedir: home,
        workDirOf: (id) => appPathsOf(real, id).workDir,
        appStateDirOf: (id) => appPathsOf(real, id).stateDir,
        protectedPaths: [paths.configDir, paths.dataDir, paths.stateDir],
      });
      const ok = { appId: "app-a", agentId: "claude" };
      expect(await policy.allowSession({ ...ok, cwd: paths.workDir })).toBe(true);
      await mkdir(path.join(paths.sessionsDir, "sess-1"), { recursive: true });
      for (const cwd of [paths.sessionsDir, path.join(paths.sessionsDir, "sess-1"), path.join(paths.sessionsDir, "sess-1", "sub")]) {
        expect(await policy.allowSession({ ...ok, cwd }), cwd).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses bridge, uppercase and hostile ids", () => {
    for (const id of ["bridge", "AppA", "../evil", "a/b", ""]) expect(() => appPathsOf(base, id), id).toThrow(/invalid app folder name/);
  });
});

describe("agent login folders", () => {
  it("agentsDir and agentDir sit in the machine-wide config folder", () => {
    const p = runnerPaths({ app: "bridge", platform: "linux", base });
    expect(p.agentsDir).toBe("/h/.config/bridge/agents");
    expect(agentDir(p, "claude")).toBe("/h/.config/bridge/agents/claude");
    expect(agentDir(p, "codex")).toBe("/h/.config/bridge/agents/codex");
    expect(() => agentDir(p, "../x" as "claude")).toThrow(/invalid agent/);
  });
});
