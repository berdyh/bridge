import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type LocalPolicyConfig, SESSION_BUDGET_CEILING, createLocalPolicy } from "@berdyh/bridge-runner";

import { MODE_RANK, appConfigOf, effectivePolicyOf, orderAdapters, parseAppConfig } from "./app-config.js";
import { setupConfigOf } from "./deps.js";
import { appPathsOf } from "./paths.js";
import { type Harness, harness } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const WORK = "/state/demo/bridge/work";
/** What a machine policy with these roots would say (on these fake paths): the cwd is a root or inside one. */
const under = (...roots: string[]) => async (cwd: string): Promise<boolean> => roots.some((r) => cwd === r || cwd.startsWith(`${r}/`));
const none = async (): Promise<boolean> => false;
const RUNNER_BUDGET = { wallClockMs: SESSION_BUDGET_CEILING.wallClockMs, maxToolCalls: SESSION_BUDGET_CEILING.maxToolCalls };
const effective = (machine: LocalPolicyConfig, app: Parameters<typeof effectivePolicyOf>[1]) => effectivePolicyOf(machine, app, { workDir: WORK, admits: none });

describe("effectivePolicyOf: an app's policy only narrows the machine's", () => {
  it("no override: the machine policy unchanged", async () => {
    const machine = { mode: "accept-edits" as const, allowedCwds: ["/proj"], agents: ["claude"] };
    expect(await effectivePolicyOf(machine, undefined, { workDir: WORK, admits: none })).toEqual({ config: machine, warnings: [], sessionBudget: RUNNER_BUDGET });
  });

  describe("allowedCwds", () => {
    it("keeps entries inside a machine root or the app's work dir, drops the rest with a warning", async () => {
      const r = await effectivePolicyOf({ allowedCwds: ["/proj"] }, { allowedCwds: ["/proj/a", "/proj", WORK, "/etc", "/projx", "rel/path", "/"] }, { workDir: WORK, admits: under("/proj") });
      expect(r.config.allowedCwds).toEqual(["/proj/a", "/proj", WORK]);
      expect(r.warnings).toHaveLength(4);
      expect(r.warnings.join("\n")).toContain('"/etc"');
      expect(r.warnings.join("\n")).toContain('"/"');
    });

    /** The machine policy as the runner builds it (agents left out), asked whether it admits a cwd. */
    const machineAdmits = (machine: LocalPolicyConfig, home: string) => {
      const state = path.join(home, "state", "demo", "bridge");
      const policy = createLocalPolicy({ ...machine, homedir: home, appStateDirOf: () => state, workDirOf: () => path.join(state, "work"), warn: () => {} });
      return (cwd: string) => Promise.resolve(policy.allowSession({ appId: "demo", agentId: "any", cwd }));
    };

    it("an override cannot revive a machine root the runner drops: `/projects/a/../b` admits nothing, so `/projects/b` is dropped", async () => {
      h = await harness();
      const projects = path.join(h.root, "projects");
      await mkdir(path.join(projects, "a"), { recursive: true });
      await mkdir(path.join(projects, "b"), { recursive: true });
      const machine = { allowedCwds: [`${projects}/a/../b`] };
      const r = await effectivePolicyOf(machine, { allowedCwds: [path.join(projects, "b")] }, { workDir: WORK, admits: machineAdmits(machine, h.root) });
      expect(r.config.allowedCwds).toEqual([]);
      expect(r.warnings.join("\n")).toContain("not a folder the machine policy admits");
      const policy = createLocalPolicy({ ...r.config, homedir: h.root, warn: () => {} });
      expect(await policy.allowSession({ appId: "demo", agentId: "claude", cwd: path.join(projects, "b") })).toBe(false);
    });

    it("an override cannot admit a folder the machine reaches only through a protected path (/guard/link -> /projects)", async () => {
      h = await harness();
      const guard = path.join(h.root, "guard");
      const projects = path.join(h.root, "projects");
      await mkdir(guard, { recursive: true });
      await mkdir(projects, { recursive: true });
      await symlink(projects, path.join(guard, "link"));
      const machine = { protectedPaths: [guard], allowedCwds: [path.join(guard, "link")] };
      // The machine policy itself refuses /projects.
      expect(await machineAdmits(machine, h.root)(projects)).toBe(false);
      const r = await effectivePolicyOf(machine, { allowedCwds: [projects] }, { workDir: WORK, admits: machineAdmits(machine, h.root) });
      expect(r.config.allowedCwds).toEqual([]);
      expect(r.warnings.join("\n")).toContain(JSON.stringify(projects));
      const policy = createLocalPolicy({ ...r.config, homedir: h.root, warn: () => {} });
      expect(await policy.allowSession({ appId: "demo", agentId: "claude", cwd: projects })).toBe(false);
    });

    it("an override folder the machine policy admits is kept, and sessions start there", async () => {
      h = await harness();
      const proj = path.join(h.root, "proj");
      await mkdir(path.join(proj, "a"), { recursive: true });
      const machine = { allowedCwds: [proj] };
      const r = await effectivePolicyOf(machine, { allowedCwds: [path.join(proj, "a")] }, { workDir: WORK, admits: machineAdmits(machine, h.root) });
      expect(r.config.allowedCwds).toEqual([path.join(proj, "a")]);
      expect(r.warnings).toEqual([]);
      const policy = createLocalPolicy({ ...r.config, homedir: h.root, warn: () => {} });
      expect(await policy.allowSession({ appId: "demo", agentId: "claude", cwd: path.join(proj, "a") })).toBe(true);
      expect(await policy.allowSession({ appId: "demo", agentId: "claude", cwd: proj })).toBe(false);
    });

    it("with no machine list the only root is the app's work dir: everything else is dropped", async () => {
      const r = await effectivePolicyOf({}, { allowedCwds: ["/home/u", WORK] }, { workDir: WORK, admits: none });
      expect(r.config.allowedCwds).toEqual([WORK]);
    });

    it("an entry below the work dir, or elsewhere in the app's state dir, is dropped: the policy admits only the work dir itself there", async () => {
      const STATE = "/state/demo/bridge";
      const r = await effectivePolicyOf({ allowedCwds: ["/state"] }, { allowedCwds: [WORK, `${WORK}/project`, `${STATE}/tmp`, STATE, "/state/other"] }, { workDir: WORK, admits: under("/state"), stateDir: STATE });
      expect(r.config.allowedCwds).toEqual([WORK, "/state/other"]);
      expect(r.warnings).toHaveLength(3);
      expect(r.warnings.join("\n")).toContain(`only the work folder itself (${WORK})`);
      // Without a machine root the work dir alone is a root, and a folder under it is dropped, not kept to admit nothing.
      expect((await effectivePolicyOf({}, { allowedCwds: [`${WORK}/project`] }, { workDir: WORK, admits: none, stateDir: STATE })).config.allowedCwds).toEqual([]);
    });

    it("a path that cannot be resolved (a dangling link, a loop) is dropped, never read as the path it sits at", async () => {
      const resolve = (p: string): string | undefined => (p === "/proj/dangling" || p === "/proj/loop" ? undefined : p);
      const r = await effectivePolicyOf({ allowedCwds: ["/proj"] }, { allowedCwds: ["/proj/dangling", "/proj/loop", "/proj/ok"] }, { workDir: WORK, admits: under("/proj"), resolve });
      expect(r.config.allowedCwds).toEqual(["/proj/ok"]);
      expect(r.warnings.join("\n")).toContain("can be resolved");
      // An unresolvable machine root is no root: nothing is admitted below it.
      expect((await effectivePolicyOf({ allowedCwds: ["/proj/dangling"] }, { allowedCwds: ["/proj/dangling/x"] }, { workDir: WORK, admits: none, resolve: (p) => (p === "/proj/dangling" ? undefined : p) })).config.allowedCwds).toEqual([]);
    });

    it("a link cannot lead out: containment is judged on where paths really are", async () => {
      const real: Record<string, string> = { "/proj/link": "/etc", "/proj": "/proj" };
      const r = await effectivePolicyOf({ allowedCwds: ["/proj"] }, { allowedCwds: ["/proj/link", "/proj"] }, { workDir: WORK, admits: async (p) => p === "/proj", resolve: (p) => real[p] ?? p });
      expect(r.config.allowedCwds).toEqual(["/proj"]);
    });

    it("entries that are all dropped leave an empty list, which admits nothing (narrower, never wider)", async () => {
      const r = await effectivePolicyOf({ allowedCwds: ["/proj"] }, { allowedCwds: ["/etc"] }, { workDir: WORK, admits: under("/proj") });
      expect(r.config.allowedCwds).toEqual([]);
    });

    it("absent in the override leaves the machine list as it is", async () => {
      expect((await effectivePolicyOf({ allowedCwds: ["/proj"] }, { mode: "ask" }, { workDir: WORK, admits: under("/proj") })).config.allowedCwds).toEqual(["/proj"]);
    });
  });

  describe("agents", () => {
    it.each([["a string", "claude"], ["a number", 7], ["a list with a non-string", ["claude", 1]]])("a machine list that is %s reads as a list nobody is on, never as 'any agent'", async (_label, bad) => {
      const r = await effectivePolicyOf({ agents: bad as unknown as string[] }, { agents: ["claude"] }, { workDir: WORK, admits: none });
      expect(r.config.agents).toHaveLength(1);
      expect(r.config.agents).not.toContain("claude");
    });
    it("is intersected with the machine list", async () => {
      const r = await effectivePolicyOf({ agents: ["claude", "codex"] }, { agents: ["codex", "gemini"] }, { workDir: WORK, admits: none });
      expect(r.config.agents).toEqual(["codex"]);
      expect(r.warnings.join("")).toContain("gemini");
    });

    it("with an empty machine list (every agent) the app's list narrows it", async () => {
      expect((await effectivePolicyOf({}, { agents: ["claude"] }, { workDir: WORK, admits: none })).config.agents).toEqual(["claude"]);
      expect((await effectivePolicyOf({ agents: [] }, { agents: ["claude"] }, { workDir: WORK, admits: none })).config.agents).toEqual(["claude"]);
    });

    it("an empty intersection allows no agent; it never turns into the policy's 'empty means all'", async () => {
      const r = await effectivePolicyOf({ agents: ["claude"] }, { agents: ["codex"] }, { workDir: WORK, admits: none });
      expect(r.config.agents).toHaveLength(1);
      expect(r.config.agents).not.toContain("claude");
      expect(r.config.agents).not.toContain("codex");
    });

    it("an empty app list says nothing", async () => {
      expect((await effectivePolicyOf({ agents: ["claude"] }, { agents: [] }, { workDir: WORK, admits: none })).config.agents).toEqual(["claude"]);
    });
  });

  describe("mode: equal or stricter, by what is approved without a person", () => {
    const modes = ["ask", "read-only", "accept-edits", "bypass"] as const;
    for (const machine of modes) {
      for (const app of modes) {
        it(`machine ${machine}, app ${app}: ${MODE_RANK[app] <= MODE_RANK[machine] ? "the app's mode" : "the machine's mode stays, with a warning"}`, async () => {
          const r = await effectivePolicyOf({ mode: machine }, { mode: app }, { workDir: WORK, admits: none });
          if (MODE_RANK[app] <= MODE_RANK[machine]) {
            expect(r.config.mode).toBe(app);
            expect(r.warnings).toEqual([]);
          } else {
            expect(r.config.mode).toBe(machine);
            expect(r.warnings.join("")).toContain("looser");
          }
        });
      }
    }

    it("no machine mode means ask: an app cannot loosen it", async () => {
      expect((await effectivePolicyOf({}, { mode: "bypass" }, { workDir: WORK, admits: none })).config.mode).toBeUndefined();
      expect((await effectivePolicyOf({}, { mode: "ask" }, { workDir: WORK, admits: none })).config.mode).toBe("ask");
    });
  });

  describe("pluginApprovals: an app can only turn the automatic approval off", () => {
    it("an app's false wins, over an absent or a true machine value", async () => {
      expect((await effective({}, { pluginApprovals: false })).config.pluginApprovals).toBe(false);
      expect((await effective({ pluginApprovals: true }, { pluginApprovals: false })).config.pluginApprovals).toBe(false);
      expect((await effective({ pluginApprovals: false }, { pluginApprovals: false })).config.pluginApprovals).toBe(false);
    });
    it("an app's true never turns on what the machine turned off, and changes nothing otherwise", async () => {
      const off = await effective({ pluginApprovals: false }, { pluginApprovals: true });
      expect(off.config.pluginApprovals).toBe(false);
      expect(off.warnings.join("")).toContain("looser");
      expect((await effective({}, { pluginApprovals: true })).config.pluginApprovals).toBeUndefined();
      expect((await effective({ pluginApprovals: true }, { pluginApprovals: true })).config.pluginApprovals).toBe(true);
    });
    it("a machine value that is not a boolean is not turned on by the app's true", async () => {
      const r = await effective({ pluginApprovals: "no" as unknown as boolean }, { pluginApprovals: true });
      expect(r.config.pluginApprovals).toBe("no");
    });
  });

  describe("models", () => {
    it("is intersected with the machine list", async () => {
      const r = await effective({ models: ["sonnet", "haiku"] }, { models: ["haiku", "opus"] });
      expect(r.config.models).toEqual(["haiku"]);
      expect(r.warnings.join("")).toContain("opus");
    });
    it("with no machine list (any model) the app's list narrows it", async () => {
      expect((await effective({}, { models: ["haiku"] })).config.models).toEqual(["haiku"]);
      expect((await effective({ models: [] }, { models: ["haiku"] })).config.models).toEqual(["haiku"]);
    });
    it("an empty intersection allows no model; it never turns into 'empty means any'", async () => {
      const r = await effective({ models: ["sonnet"] }, { models: ["opus"] });
      expect(r.config.models).toHaveLength(1);
      expect(r.config.models).not.toContain("sonnet");
      expect(r.config.models).not.toContain("opus");
      const policy = createLocalPolicy({ ...r.config, warn: () => {} });
      expect(await policy.allowContainedSession!({ appId: "a", agentId: "claude", model: "opus" })).toMatchObject({ allowed: false });
      expect(await policy.allowContainedSession!({ appId: "a", agentId: "claude", model: "sonnet" })).toMatchObject({ allowed: false });
    });
    it("an empty app list says nothing", async () => {
      expect((await effective({ models: ["sonnet"] }, { models: [] })).config.models).toEqual(["sonnet"]);
    });
    it.each([["a string", "sonnet"], ["a number", 7], ["null", null], ["a list with a non-string", ["sonnet", 1]], ["an object", { sonnet: true }]])(
      "a machine list that is %s reads as a list nobody is on, never as 'any model'",
      async (_label, bad) => {
        const r = await effective({ models: bad as unknown as string[] }, { models: ["haiku", "sonnet"] });
        const policy = createLocalPolicy({ ...r.config, warn: () => {} });
        for (const model of ["haiku", "sonnet", "opus"]) {
          expect(await policy.allowContainedSession!({ appId: "a", agentId: "claude", model })).toMatchObject({ allowed: false });
        }
      },
    );
  });

  describe("sessionBudget: runner ceiling, then policy.json, then the app's config.json", () => {
    const verdictOf = async (r: Awaited<ReturnType<typeof effective>>) => createLocalPolicy({ ...r.config, warn: () => {} }).allowContainedSession!({ appId: "a", agentId: "claude" });

    it("no key anywhere: the runner's ceiling", async () => {
      const r = await effective({}, { agents: ["claude"] });
      expect(r.sessionBudget).toEqual(RUNNER_BUDGET);
      expect(await verdictOf(r)).toEqual({ allowed: true, budget: RUNNER_BUDGET });
    });
    it("a policy.json ceiling lowers the budget an app gets, and the verdict built from the effective config returns it", async () => {
      const r = await effective({ sessionBudget: { wallClockMs: 600_000, maxToolCalls: 40 } }, { agents: ["claude"] });
      expect(r.sessionBudget).toEqual({ wallClockMs: 600_000, maxToolCalls: 40 });
      expect(await verdictOf(r)).toEqual({ allowed: true, budget: { wallClockMs: 600_000, maxToolCalls: 40 } });
      // Also with no app override at all.
      expect((await effective({ sessionBudget: { maxToolCalls: 40 } }, undefined)).sessionBudget).toEqual({ wallClockMs: RUNNER_BUDGET.wallClockMs, maxToolCalls: 40 });
    });
    it("a policy.json ceiling above the runner's is clamped to it", async () => {
      const r = await effective({ sessionBudget: { wallClockMs: RUNNER_BUDGET.wallClockMs * 3, maxToolCalls: RUNNER_BUDGET.maxToolCalls * 3 } }, undefined);
      expect(r.sessionBudget).toEqual(RUNNER_BUDGET);
      expect(await verdictOf(r)).toEqual({ allowed: true, budget: RUNNER_BUDGET });
    });
    it("a config.json ceiling above the policy's is ignored with a warning and the policy's stands", async () => {
      const r = await effective({ sessionBudget: { wallClockMs: 600_000, maxToolCalls: 40 } }, { sessionBudget: { wallClockMs: 1_200_000, maxToolCalls: 400 } });
      expect(r.sessionBudget).toEqual({ wallClockMs: 600_000, maxToolCalls: 40 });
      expect(r.config.sessionBudget).toEqual({ wallClockMs: 600_000, maxToolCalls: 40 });
      expect(r.warnings.join("\n")).toContain("sessionBudget.wallClockMs");
      expect(r.warnings.join("\n")).toContain("sessionBudget.maxToolCalls");
      expect(await verdictOf(r)).toEqual({ allowed: true, budget: { wallClockMs: 600_000, maxToolCalls: 40 } });
    });
    it("a config.json ceiling below the policy's wins, per field", async () => {
      const r = await effective({ sessionBudget: { wallClockMs: 600_000, maxToolCalls: 40 } }, { sessionBudget: { wallClockMs: 60_000, maxToolCalls: 400 } });
      expect(r.sessionBudget).toEqual({ wallClockMs: 60_000, maxToolCalls: 40 });
      expect(r.warnings).toHaveLength(1);
      expect(await verdictOf(r)).toEqual({ allowed: true, budget: { wallClockMs: 60_000, maxToolCalls: 40 } });
    });
    it("a config.json ceiling with no policy.json key narrows the runner's", async () => {
      expect((await effective({}, { sessionBudget: { maxToolCalls: 25 } })).sessionBudget).toEqual({ wallClockMs: RUNNER_BUDGET.wallClockMs, maxToolCalls: 25 });
    });
    it("a config.json value above the runner's ceiling cannot raise anything", async () => {
      const r = await effective({}, { sessionBudget: { maxToolCalls: RUNNER_BUDGET.maxToolCalls + 1 } });
      expect(r.sessionBudget).toEqual(RUNNER_BUDGET);
      expect(r.warnings.join("")).toContain("above the machine's ceiling");
    });
  });

  it("never touches protectedPaths, allowedTools or anything else of the machine's", async () => {
    const machine = { protectedPaths: ["/secret"], allowedTools: ["Read"], homedir: "/home/u" };
    const r = await effectivePolicyOf(machine, { allowedCwds: [WORK], agents: ["claude"], mode: "ask" }, { workDir: WORK, admits: none });
    expect(r.config).toMatchObject(machine);
  });
});

describe("an app's config.json", () => {
  const file = "/x/config.json";

  it("parses agent and policy; unknown keys are ignored", () => {
    const c = parseAppConfig({ agent: { default: "codex", model: "m1", effort: "high", extra: 1 }, policy: { allowedCwds: ["/a"], agents: ["claude"], mode: "read-only" }, unknown: true }, file);
    expect(c).toEqual({ agent: { default: "codex", model: "m1", effort: "high" }, policy: { allowedCwds: ["/a"], agents: ["claude"], mode: "read-only" }, warnings: [] });
  });

  it("parses pluginApprovals, models and sessionBudget; bad values are ignored with a warning, per field for the budget", () => {
    const good = parseAppConfig({ policy: { pluginApprovals: false, models: ["sonnet"], sessionBudget: { wallClockMs: 60_000, maxToolCalls: 5 } } }, file);
    expect(good).toEqual({ policy: { pluginApprovals: false, models: ["sonnet"], sessionBudget: { wallClockMs: 60_000, maxToolCalls: 5 } }, warnings: [] });

    const bad = parseAppConfig({ policy: { pluginApprovals: "yes", models: [1], sessionBudget: { wallClockMs: 0, maxToolCalls: 5, bogus: 1 } } }, file);
    expect(bad.policy).toEqual({ sessionBudget: { maxToolCalls: 5 } });
    expect(bad.warnings.join("\n")).toContain("policy.pluginApprovals");
    expect(bad.warnings.join("\n")).toContain("policy.models");
    expect(bad.warnings.join("\n")).toContain("policy.sessionBudget.wallClockMs");
    expect(bad.warnings.join("\n")).toContain("policy.sessionBudget has a key");

    const over = parseAppConfig({ policy: { sessionBudget: { maxToolCalls: SESSION_BUDGET_CEILING.maxToolCalls + 1 } } }, file);
    expect(over.policy).toBeUndefined();
    expect(over.warnings).toHaveLength(1);
    expect(parseAppConfig({ policy: { sessionBudget: 5 } }, file).warnings.join("")).toContain("policy.sessionBudget");
  });

  it("ignores an unknown agent, a bad mode and malformed lists, each with a warning", () => {
    const c = parseAppConfig({ agent: { default: "gemini", model: 5 }, policy: { mode: "yolo", allowedCwds: "/a", agents: [1] } }, file);
    expect(c.agent).toBeUndefined();
    expect(c.policy).toBeUndefined();
    expect(c.warnings).toHaveLength(5);
    expect(c.warnings.join("\n")).toContain("agent.default");
  });

  it("a file that is not an object means the machine defaults, with a warning", () => {
    expect(parseAppConfig([], file).warnings).toHaveLength(1);
    expect(parseAppConfig(undefined, file)).toEqual({ warnings: [] });
  });

  it("is read from the app's own folder: missing is fine, bad JSON is a warning, never a failure", async () => {
    h = await harness();
    expect(await appConfigOf(h.deps, "demo")).toEqual({ warnings: [] });
    const f = appPathsOf(h.deps, "demo").configFile;
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, "{nope");
    expect((await appConfigOf(h.deps, "demo")).warnings[0]).toContain("not valid JSON");
    await writeFile(f, JSON.stringify({ agent: { default: "claude" } }));
    expect((await appConfigOf(h.deps, "demo")).agent).toEqual({ default: "claude" });
    expect((await appConfigOf(h.deps, "other")).agent).toBeUndefined();
  });

  it("orderAdapters puts the app's default agent first and keeps the rest in order", () => {
    const a = [{ id: "claude" }, { id: "codex" }, { id: "x" }];
    expect(orderAdapters(a, "codex").map((x) => x.id)).toEqual(["codex", "claude", "x"]);
    expect(orderAdapters(a, undefined).map((x) => x.id)).toEqual(["claude", "codex", "x"]);
  });
});

describe("setupConfigOf with an app: the app's config.json overrides the machine's key by key", () => {
  async function write(file: string, body: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(body));
  }

  it("machine, then app override; a bad or missing file falls through; the machine file is never copied", async () => {
    h = await harness();
    expect(await setupConfigOf(h.deps, "demo")).toEqual({ service: "default-yes" });
    await write(path.join(h.deps.configDir, "bridge", "config.json"), { setup: { service: "ask" } });
    expect(await setupConfigOf(h.deps)).toEqual({ service: "ask" });
    expect(await setupConfigOf(h.deps, "demo")).toEqual({ service: "ask" });
    await write(appPathsOf(h.deps, "demo").configFile, { setup: { service: "default-yes" } });
    expect(await setupConfigOf(h.deps, "demo")).toEqual({ service: "default-yes" });
    expect(await setupConfigOf(h.deps, "other")).toEqual({ service: "ask" });
    expect(await setupConfigOf(h.deps)).toEqual({ service: "ask" });
    await writeFile(appPathsOf(h.deps, "demo").configFile, "{nope");
    expect(await setupConfigOf(h.deps, "demo")).toEqual({ service: "ask" });
    await write(appPathsOf(h.deps, "demo").configFile, { setup: { service: "sometimes" } });
    expect(await setupConfigOf(h.deps, "demo")).toEqual({ service: "ask" });
  });
});
