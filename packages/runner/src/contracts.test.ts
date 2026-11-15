import { describe, expect, it } from "vitest";

import { runnerStatusPath, type RunnerStatusFile } from "./contracts.js";
import { appPathsOf, defaultBaseDirs, runnerPaths } from "./paths.js";

const base = defaultBaseDirs("/home/u", {});
const paths = runnerPaths({ app: "bridge", platform: "linux", base });

describe("runner status and per-app folders", () => {
  it("runner.json lives in <state>/bridge", () => {
    expect(paths.stateDir).toBe("/home/u/.local/state/bridge");
    expect(runnerStatusPath(paths)).toBe("/home/u/.local/state/bridge/runner.json");
  });

  it("an app's work and sandbox folders are in its own bridge/ state folder, apart from another app's", () => {
    expect(appPathsOf(base, "app-a").workDir).toBe("/home/u/.local/state/app-a/bridge/work");
    expect(appPathsOf(base, "app-a").tmpDir).toBe("/home/u/.local/state/app-a/bridge/tmp");
    expect(appPathsOf(base, "a").workDir).not.toBe(appPathsOf(base, "b").workDir);
  });

  it("types the status file", () => {
    const status: RunnerStatusFile = { version: 1, pid: 1, startedAt: "2026-10-20T00:00:00Z", apps: { "app-a": "online" }, browsers: 0, idleSince: "2026-10-20T00:01:00Z" };
    expect(JSON.parse(JSON.stringify(status))).toEqual(status);
  });
});
