import { describe, expect, it } from "vitest";

import { doctorPaths, formatDoctorPaths } from "./doctor.js";
import { appPathsOf, defaultBaseDirs, runnerPaths } from "./paths.js";
import { planPaths, planService } from "./service.js";

const base = defaultBaseDirs("/tmp/h", {});

describe("paths", () => {
  it("derives XDG-style bases, honouring overrides", () => {
    expect(base).toEqual({
      home: "/tmp/h",
      data: "/tmp/h/.local/share",
      config: "/tmp/h/.config",
      state: "/tmp/h/.local/state",
      bin: "/tmp/h/.local/bin",
    });
    expect(defaultBaseDirs("/tmp/h", { XDG_DATA_HOME: "/d" }).data).toBe("/d");
  });
  it("rejects hostile app names", () => {
    expect(() => runnerPaths({ app: "../evil", platform: "linux", base })).toThrow();
    expect(() => runnerPaths({ app: "A b", platform: "linux", base })).toThrow();
  });
});

describe("doctorPaths", () => {
  it("lists every path for linux, including the unit", () => {
    const paths = doctorPaths({ app: "app-a", platform: "linux", base }).map((e) => e.path);
    expect(paths).toEqual([
      "/tmp/h/.local/share/app-a",
      "/tmp/h/.local/share/app-a/versions",
      "/tmp/h/.local/bin/app-a",
      "/tmp/h/.config/app-a",
      "/tmp/h/.local/state/app-a",
      "/tmp/h/.local/state/app-a/runner.log",
      "/tmp/h/.local/state/app-a/runner.json",
      "/tmp/h/.config/app-a/agents",
      "/tmp/h/.config/app-a/agents/claude",
      "/tmp/h/.config/app-a/agents/codex",
      "/tmp/h/.config/systemd/user/app-a-runner.service",
      "/tmp/h/.config/systemd/user/default.target.wants/app-a-runner.service",
    ]);
  });
  it("lists runner.json under the machine-wide state dir and no per-app folder without apps", () => {
    const state = doctorPaths({ app: "bridge", platform: "linux", base }).filter((e) => e.role === "state");
    expect(state.map((e) => [e.path, e.kind])).toEqual([
      ["/tmp/h/.local/state/bridge", "dir"],
      ["/tmp/h/.local/state/bridge/runner.json", "file"],
    ]);
    expect(formatDoctorPaths(state)).toContain("/tmp/h/.local/state/bridge/runner.json\tfile\t");
    expect(doctorPaths({ app: "bridge", platform: "linux", base }).some((e) => e.path.includes("/apps/"))).toBe(false);
  });
  it("lists each app's three bridge dirs and their contents, never the app's own parents", () => {
    const apps = ["app-a", "app-b"].map((id) => appPathsOf(base, id));
    const entries = doctorPaths({ app: "bridge", platform: "linux", base, appPaths: apps });
    const mine = entries.filter((e) => e.description.startsWith("app-a: "));
    expect(mine.map((e) => e.path)).toEqual([
      "/tmp/h/.config/app-a/bridge",
      "/tmp/h/.config/app-a/bridge/app.json",
      "/tmp/h/.config/app-a/bridge/trust.json",
      "/tmp/h/.config/app-a/bridge/identity.json",
      "/tmp/h/.config/app-a/bridge/identity.key",
      "/tmp/h/.config/app-a/bridge/enroll.json",
      "/tmp/h/.config/app-a/bridge/revoked.json",
      "/tmp/h/.config/app-a/bridge/config.json",
      "/tmp/h/.local/share/app-a/bridge",
      "/tmp/h/.local/share/app-a/bridge/plugins",
      "/tmp/h/.local/share/app-a/bridge/plugin-data",
      "/tmp/h/.local/state/app-a/bridge",
      "/tmp/h/.local/state/app-a/bridge/work",
      "/tmp/h/.local/state/app-a/bridge/tmp",
    ]);
    expect(mine.map((e) => e.role)).toEqual(["config", "config", "config", "config", "config", "config", "config", "config", "install", "install", "install", "state", "state", "state"]);
    expect(entries.filter((e) => e.description.startsWith("app-b: "))).toHaveLength(14);
    expect(mine.every((e) => e.removeOnUninstall)).toBe(true);
    for (const parent of ["/tmp/h/.config/app-a", "/tmp/h/.local/share/app-a", "/tmp/h/.local/state/app-a", "/tmp/h/.config/app-b"]) {
      expect(entries.some((e) => e.path === parent)).toBe(false);
    }
    // Nothing of an unlisted app appears.
    expect(entries.some((e) => e.path.includes("/other/"))).toBe(false);
  });
  it("lists the agents dirs of the machine-wide app as owned config", () => {
    const entries = doctorPaths({ app: "bridge", platform: "linux", base });
    const agents = entries.filter((e) => e.path.includes("/agents"));
    expect(agents.map((e) => [e.path, e.kind, e.role, e.removeOnUninstall])).toEqual([
      ["/tmp/h/.config/bridge/agents", "dir", "config", true],
      ["/tmp/h/.config/bridge/agents/claude", "dir", "config", true],
      ["/tmp/h/.config/bridge/agents/codex", "dir", "config", true],
    ]);
  });
  it("rejects an app id that is not a safe folder name (it never reaches doctorPaths: appPathsOf refuses it)", () => {
    expect(() => appPathsOf(base, "../x")).toThrow(/invalid app folder name/);
  });
  it("uses the LaunchAgents plist on darwin and can omit the service", () => {
    const entries = doctorPaths({ app: "app-a", platform: "darwin", base });
    expect(entries.find((e) => e.role === "service")?.path).toBe("/tmp/h/Library/LaunchAgents/com.berdyh.app-a.runner.plist");
    expect(doctorPaths({ app: "app-a", platform: "darwin", base, includeService: false }).some((e) => e.role === "service")).toBe(false);
  });
  it("covers every file the service plan would write", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const manifest = new Set(doctorPaths({ app: "app-a", platform, base }).map((e) => e.path));
      const plan = planService({ app: "app-a", platform, base, launcher: "/tmp/h/.local/bin/app-a" });
      for (const p of planPaths(plan)) expect(manifest.has(p)).toBe(true);
    }
  });
  it("lists no agent login file: bridge keeps its own copies and never writes the agents' files", () => {
    const entries = doctorPaths({ app: "app-a", platform: "linux", base });
    expect(entries.some((e) => e.role === "external")).toBe(false);
    expect(entries.some((e) => e.path.includes(".claude") || e.path.includes(".codex") || e.path.endsWith("auth.json"))).toBe(false);
    expect(entries.every((e) => e.removeOnUninstall)).toBe(true);
  });
  it("formats one tab-separated line per path", () => {
    const text = formatDoctorPaths(doctorPaths({ app: "a", platform: "linux", base }));
    expect(text.trim().split("\n")).toHaveLength(12);
  });
});
