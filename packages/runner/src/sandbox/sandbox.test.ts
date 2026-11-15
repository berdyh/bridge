import { chmod, mkdir, mkdtemp, writeFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APP_DIR_LEVELS, CONTAINED_ENV_DENY, buildAgentEnv, buildContainedAgentEnv, ensurePrivateAppDir, redirectedComponent } from "./sandbox.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-sandbox-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("per-app folders", () => {
  it("fails closed on ENOTDIR: a file where a directory should be is not a missing component", async () => {
    await writeFile(path.join(root, "file"), "x");
    const dir = path.join(root, "file/bridge/tmp");
    expect(await redirectedComponent(dir)).toBe(path.join(root, "file/bridge"));
    await expect(ensurePrivateAppDir(dir)).rejects.toThrow(/redirected/);
  });

  it("the default is the two-level tail: bridge/<work|tmp>", async () => {
    await mkdir(path.join(root, "x/a/bridge"), { recursive: true });
    await mkdir(path.join(root, "other"));
    await symlink(path.join(root, "other"), path.join(root, "x/a/bridge/tmp"));
    const dir = path.join(root, "x/a/bridge/tmp");
    expect(await redirectedComponent(dir)).toBe(dir);
    await expect(ensurePrivateAppDir(dir)).rejects.toThrow(/redirected/);
  });
});

describe("per-app folders in the app's own bridge folder (two levels)", () => {
  it("creates <state>/<app>/bridge/tmp 0700 and tolerates a symlinked <state>/<app>", async () => {
    await mkdir(path.join(root, "real"));
    await mkdir(path.join(root, "state"));
    await symlink(path.join(root, "real"), path.join(root, "state/app-a"));
    const dir = path.join(root, "state/app-a/bridge/tmp");
    await ensurePrivateAppDir(dir, APP_DIR_LEVELS);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root, "real/bridge"))).mode & 0o777).toBe(0o700);
    expect(await redirectedComponent(dir, APP_DIR_LEVELS)).toBeUndefined();
  });

  it("names a symlinked bridge or tmp, which the app parent allowance does not cover", async () => {
    await mkdir(path.join(root, "x/app-a"), { recursive: true });
    await mkdir(path.join(root, "other"));
    const dir = path.join(root, "x/app-a/bridge/tmp");
    await symlink(path.join(root, "other"), path.join(root, "x/app-a/bridge"));
    expect(await redirectedComponent(dir, APP_DIR_LEVELS)).toBe(path.join(root, "x/app-a/bridge"));
    await expect(ensurePrivateAppDir(dir, APP_DIR_LEVELS)).rejects.toThrow(/redirected/);
    await rm(path.join(root, "x/app-a/bridge"));
    await mkdir(path.join(root, "x/app-a/bridge"));
    await symlink(path.join(root, "other"), dir);
    expect(await redirectedComponent(dir, APP_DIR_LEVELS)).toBe(dir);
    await expect(ensurePrivateAppDir(dir, APP_DIR_LEVELS)).rejects.toThrow(/redirected/);
    expect(await redirectedComponent(path.join(root, "x/app-a/bridge/work"), APP_DIR_LEVELS)).toBeUndefined();
  });

  it("creates missing parents 0700 but never changes an existing parent's mode", async () => {
    await mkdir(path.join(root, "state/app-a"), { recursive: true });
    await chmod(path.join(root, "state/app-a"), 0o755);
    await chmod(path.join(root, "state"), 0o755);
    await ensurePrivateAppDir(path.join(root, "state/app-a/bridge/work"), APP_DIR_LEVELS);
    expect((await stat(path.join(root, "state/app-a"))).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(root, "state"))).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(root, "state/app-a/bridge"))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root, "state/app-a/bridge/work"))).mode & 0o777).toBe(0o700);
    // missing parents come out 0700
    await ensurePrivateAppDir(path.join(root, "fresh/app-b/bridge/tmp"), APP_DIR_LEVELS);
    for (const d of ["fresh", "fresh/app-b", "fresh/app-b/bridge", "fresh/app-b/bridge/tmp"]) {
      expect((await stat(path.join(root, d))).mode & 0o777, d).toBe(0o700);
    }
  });
});

describe("env sandbox", () => {
  it("redirects HOME/TMPDIR/XDG and strips secrets", () => {
    const env = buildAgentEnv("/t/run", {
      PATH: "/bin",
      HOME: "/real/home",
      OPENAI_API_KEY: "sk-1",
      DATABASE_URL: "postgres://x",
      GITHUB_TOKEN: "ghp",
      CODEX_HOME: "/real/.codex",
      MY_VAR: "v",
      LANG: "C",
    });
    expect(env).toMatchObject({ PATH: "/bin", LANG: "C", HOME: "/t/run/home", TMPDIR: "/t/run", XDG_CONFIG_HOME: "/t/run/xdg-config" });
    for (const k of ["OPENAI_API_KEY", "DATABASE_URL", "GITHUB_TOKEN", "CODEX_HOME", "MY_VAR"]) expect(env).not.toHaveProperty(k);
  });

  it("supports a configurable allowlist and denylist; deny wins; sandbox keys are protected", () => {
    const parent = { PATH: "/bin", MY_VAR: "v", PROXY: "p", NODE_EXTRA_SECRET: "s", HOME: "/real", XDG_DATA_HOME: "/real" };
    const env = buildAgentEnv("/t", parent, { allow: ["MY_VAR", "PROXY", "NODE_EXTRA_SECRET", "HOME", "XDG_DATA_HOME"], deny: ["PROXY"] });
    expect(env.MY_VAR).toBe("v");
    expect(env).not.toHaveProperty("PROXY");
    expect(env).not.toHaveProperty("NODE_EXTRA_SECRET");
    expect(env.HOME).toBe("/t/home");
    expect(env.XDG_DATA_HOME).toBe("/t/xdg-data");
  });
});

describe("buildContainedAgentEnv: the contained env rule", () => {
  const dir = "/run/sandbox";
  const parent = {
    PATH: "/usr/bin",
    CLAUDE_CODE_EXECUTABLE: "/evil/claude",
    CLAUDE_MODEL_CONFIG: '{"modelOverrides":{}}',
    MAX_THINKING_TOKENS: "9999",
    NODE_OPTIONS: "--require /evil.js",
    DEBUG_CLAUDE_AGENT_SDK: "1",
    KEEP: "yes",
  };
  const allowAll = { allow: ["CLAUDE_CODE_EXECUTABLE", "CLAUDE_MODEL_CONFIG", "MAX_THINKING_TOKENS", "NODE_OPTIONS", "DEBUG_CLAUDE_AGENT_SDK", "KEEP"] };

  it("names the four argv inputs", () => {
    expect([...CONTAINED_ENV_DENY]).toEqual(["CLAUDE_MODEL_CONFIG", "MAX_THINKING_TOKENS", "NODE_OPTIONS", "DEBUG_CLAUDE_AGENT_SDK"]);
  });

  it("allow naming all five: CLAUDE_CODE_EXECUTABLE is the runner's value, the other four are gone", () => {
    const env = buildContainedAgentEnv(dir, parent, allowAll, { CLAUDE_CONFIG_DIR: `${dir}/claude-home` }, { CLAUDE_CODE_EXECUTABLE: "/pin/claude" });
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe("/pin/claude");
    for (const key of CONTAINED_ENV_DENY) expect(env, key).not.toHaveProperty(key);
    expect(env.KEEP).toBe("yes");
    expect(env.CLAUDE_CONFIG_DIR).toBe(`${dir}/claude-home`);
    expect(env.HOME).toBe(`${dir}/home`);
  });

  it("the rule itself only denies the four; forcing CLAUDE_CODE_EXECUTABLE is the caller's containmentEnv", () => {
    const env = buildContainedAgentEnv(dir, parent, allowAll, {}, {});
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe("/evil/claude"); // only the adapter forces it; the rule itself is the deny list
    for (const key of CONTAINED_ENV_DENY) expect(env, key).not.toHaveProperty(key);
  });

  it("strips the denied keys whatever their case, and from staged or forced values too", () => {
    const env = buildContainedAgentEnv(dir, { node_options: "x" }, { allow: ["node_options"] }, { Node_Options: "y" }, { MAX_THINKING_TOKENS: "1" });
    expect(Object.keys(env).filter((k) => /node_options|max_thinking/i.test(k))).toEqual([]);
  });

  it("a non-contained spawn is unchanged: buildAgentEnv still passes all five", () => {
    const env = buildAgentEnv(dir, parent, allowAll);
    for (const key of ["CLAUDE_CODE_EXECUTABLE", "CLAUDE_MODEL_CONFIG", "NODE_OPTIONS", "DEBUG_CLAUDE_AGENT_SDK"] as const) expect(env[key], key).toBe(parent[key]);
    // MAX_THINKING_TOKENS is already dropped for every spawn by the default `*TOKEN*` deny.
    expect(env).not.toHaveProperty("MAX_THINKING_TOKENS");
  });
});
