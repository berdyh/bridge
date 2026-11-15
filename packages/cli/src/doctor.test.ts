import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import type { AgentAdapter, ConsentedGrant, InstalledPlugin } from "@berdyh/bridge-runner";
import { createConsentStore, createDefaultAgentAdapters, surfaceOf, surfaceSha256Of } from "@berdyh/bridge-runner";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { adapterOptionsOf, claudeAdapterDirOf, codexAdapterDirOf } from "./adapters.js";
import { runCli } from "./cli.js";
import { upsertApp } from "./config.js";
import { appPathsOf, runnerLockPath, workerLockPath } from "./paths.js";
import { type Harness, harness, exists, memoryCredentials, record } from "./testkit.js";
import { CLI_VERSION } from "./version.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("doctor --paths", () => {
  it("lists apps.json, the machine-wide dirs and the service unit under the injected dirs only", async () => {
    h = await harness();
    expect(await runCli(["doctor", "--paths"], h.deps)).toBe(0);
    const paths = h.out.join("").trim().split("\n").map((l) => l.split("\t")[0]!);
    expect(paths).toContain(path.join(h.deps.configDir, "bridge", "apps.json"));
    expect(paths).toContain(path.join(h.deps.dataDir, "bridge", "versions"));
    expect(paths).toContain(path.join(h.deps.configDir, "bridge", "agents"));
    expect(paths).toContain(path.join(h.deps.configDir, "systemd", "user", "bridge-runner.service"));
    // Nothing may live outside the injected base dirs, and the manifest no longer names an agent's own login file.
    const outside = paths.filter((p) => !p.startsWith(h.root));
    expect(outside).toEqual([]);
    expect(await exists(h.deps.configDir)).toBe(false);
  });
});

function fakeAdapters(h: Harness): void {
  const adapter = (id: string, available: boolean, resolved?: { command: string; source: "bundled" | "path" }) =>
    ({ id, availability: async () => ({ id, available }), resolved: () => resolved, spawn: async () => Promise.reject(new Error("unused")) }) as never;
  h.deps.adapters = [
    adapter("claude", true, { command: "/v/node_modules/.bin/claude-agent-acp", source: "bundled" }),
    adapter("codex", false),
  ];
}

describe("doctor --paths (manifest)", () => {
  it("adds the setup config, the bridge:// handler files, runner.json and each connected app's three bridge/ dirs and what is in them", async () => {
    h = await harness();
    await upsertApp(h.deps, record({ appId: "demo" }));
    expect(await runCli(["doctor", "--paths"], h.deps)).toBe(0);
    const lines = h.out.join("").trim().split("\n").map((l) => l.split("\t"));
    const paths = lines.map((l) => l[0]!);
    const state = path.join(h.root, "home/.local/state/bridge");
    const app = appPathsOf(h.deps, "demo");
    expect(paths).toContain(path.join(h.deps.configDir, "bridge", "config.json"));
    expect(paths).toContain(path.join(h.deps.dataDir, "applications", "bridge-url-handler.desktop"));
    expect(paths).toContain(path.join(h.deps.configDir, "mimeapps.list"));
    expect(paths).toContain(path.join(state, "runner.json"));
    for (const p of [app.configDir, app.appFile, app.trustFile, app.identityFile, app.enrollFile, app.configFile, app.dataDir, app.pluginsDir, app.pluginDataDir, app.stateDir, app.workDir, app.tmpDir]) {
      expect(paths).toContain(p);
    }
    expect(paths).toContain(path.join(h.deps.configDir, "bridge", "agents"));
    // The old shared dirs and the app's parents are not in the manifest: bridge owns only the bridge/ segment.
    for (const old of ["trust", "identity", "identity-key", "enroll"]) expect(paths).not.toContain(path.join(h.deps.configDir, "bridge", old));
    expect(paths).not.toContain(path.join(state, "apps/demo/work"));
    expect(paths).not.toContain(app.parents.config);
    expect(paths).not.toContain(app.parents.data);
    expect(paths).not.toContain(app.parents.state);
    expect(paths.filter((p) => !p.startsWith(h.root))).toEqual([]);
  });

  it("--paths --json is the manifest as JSON", async () => {
    h = await harness();
    expect(await runCli(["doctor", "--paths", "--json"], h.deps)).toBe(0);
    const entries = JSON.parse(h.out.join("")) as { path: string; kind: string; removeOnUninstall: boolean }[];
    expect(entries.find((e) => e.path.endsWith("bridge-url-handler.desktop"))).toMatchObject({ kind: "file", removeOnUninstall: true });
    expect(entries.find((e) => e.path.endsWith("mimeapps.list"))).toMatchObject({ removeOnUninstall: false });
  });

  it("lists no handler files off Linux", async () => {
    h = await harness({ platform: "darwin" });
    expect(await runCli(["doctor", "--paths"], h.deps)).toBe(0);
    expect(h.out.join("")).not.toContain("mimeapps.list");
    expect(h.out.join("")).toContain("com.berdyh.bridge.runner.plist");
  });
});

describe("doctor", () => {
  it("reports each agent's adapter and its login in bridge's folder separately", async () => {
    h = await harness();
    fakeAdapters(h);
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    let out = h.out.join("");
    expect(out).toContain("claude: adapter found (bundled adapter (source checkout): /v/node_modules/.bin/claude-agent-acp), no login (run `bridge agent login claude`)");
    expect(out).toContain("codex: no adapter found, no login (run `bridge agent login codex`)");
    expect(out).toContain("launcher:");
    expect(out).toContain("not installed");
    expect(await exists(h.deps.configDir)).toBe(false);

    const login = path.join(h.deps.configDir, "bridge/agents/claude/.credentials.json");
    await mkdir(path.dirname(login), { recursive: true });
    await writeFile(login, JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
    h.out.length = 0;
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    out = h.out.join("");
    expect(out).toContain("claude: adapter found (bundled adapter (source checkout): /v/node_modules/.bin/claude-agent-acp), login present");
  });

  describe("the claude adapter is installed on request", () => {
    /** The real adapter construction over this harness's folders, with no source checkout to find and an empty PATH. */
    const realAdapters = (): AgentAdapter[] => {
      h.deps.env.PATH = "";
      return createDefaultAgentAdapters(adapterOptionsOf(h.deps, { fromDir: h.root }));
    };

    it("a fresh install says how to install it, in text and in --json, and contained sessions are refused for that reason", async () => {
      h = await harness();
      h.deps.adapters = realAdapters();
      expect(await runCli(["doctor"], h.deps)).toBe(0);
      const adaptersDir = path.join(h.deps.dataDir, "bridge", "adapters");
      const out = h.out.join("");
      expect(out).toContain(`claude: no adapter installed; run \`bridge agent install claude\` (about 300 MB from the npm registry into ${adaptersDir})`);
      expect(out).toContain("codex: no adapter found");
      expect(out).toContain("contained sessions: refused: the claude adapter is not installed");
      h.out.length = 0;
      expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
      const claude = (JSON.parse(h.out.join("")) as { adapters: Record<string, unknown>[] }).adapters.find((a) => a.id === "claude")!;
      expect(claude).toMatchObject({ available: false });
      expect(claude).not.toHaveProperty("command");
    });

    it("after an install the line says bridge installed it and where", async () => {
      h = await harness();
      const bin = path.join(claudeAdapterDirOf(h.deps), "node_modules/.bin/claude-agent-acp");
      await mkdir(path.dirname(bin), { recursive: true });
      await writeFile(bin, "#!/bin/sh\n");
      await chmod(bin, 0o755);
      h.deps.adapters = realAdapters();
      expect(await runCli(["doctor"], h.deps)).toBe(0);
      expect(h.out.join("")).toContain(`claude: adapter found (adapter installed by bridge: ${bin})`);
      h.out.length = 0;
      expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
      expect((JSON.parse(h.out.join("")) as { adapters: { id: string; command?: string; source?: string }[] }).adapters.find((a) => a.id === "claude")).toMatchObject({ command: bin, source: "bundled" });
    });

    it("a codex login with no codex adapter names the install command and its size; without a login it does not", async () => {
      h = await harness();
      h.deps.adapters = realAdapters();
      expect(await runCli(["doctor"], h.deps)).toBe(0);
      expect(h.out.join("")).toContain("codex: no adapter found, no login (run `bridge agent login codex`)");
      const adaptersDir = path.join(h.deps.dataDir, "bridge", "adapters");
      const login = path.join(h.deps.configDir, "bridge/agents/codex/auth.json");
      await mkdir(path.dirname(login), { recursive: true });
      await writeFile(login, JSON.stringify({ tokens: { access_token: "a1" } }));
      h.out.length = 0;
      expect(await runCli(["doctor"], h.deps)).toBe(0);
      expect(h.out.join("")).toContain(`codex: no adapter installed; run \`bridge agent install codex\` (about 450 MB from the npm registry into ${adaptersDir}), login present`);
      h.out.length = 0;
      expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
      expect((JSON.parse(h.out.join("")) as { adapters: Record<string, unknown>[] }).adapters.find((a) => a.id === "codex")).toMatchObject({ available: false, login: { present: true } });
    });

    it("after a codex install the line says bridge installed it, and where", async () => {
      h = await harness();
      const bin = path.join(codexAdapterDirOf(h.deps), "node_modules/.bin/codex-acp");
      await mkdir(path.dirname(bin), { recursive: true });
      await writeFile(bin, "#!/bin/sh\n");
      await chmod(bin, 0o755);
      h.deps.adapters = realAdapters();
      expect(await runCli(["doctor"], h.deps)).toBe(0);
      expect(h.out.join("")).toContain(`codex: adapter found (adapter installed by bridge: ${bin})`);
    });

    it("--paths lists the adapters folder as bridge's own, inside the data folder uninstall removes", async () => {
      h = await harness();
      expect(await runCli(["doctor", "--paths"], h.deps)).toBe(0);
      expect(h.out.join("")).toContain(`${path.join(h.deps.dataDir, "bridge", "adapters")}\tdir\tagent adapters installed by bridge (bridge agent install)`);
    });
  });

  it("a login in the person's own ~/.claude does not count", async () => {
    h = await harness();
    fakeAdapters(h);
    await mkdir(path.join(h.root, "home/.claude"), { recursive: true });
    await writeFile(path.join(h.root, "home/.claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    const adapters = (JSON.parse(h.out.join("")) as { adapters: { id: string; login: { present: boolean } }[] }).adapters;
    expect(adapters.find((a) => a.id === "claude")!.login.present).toBe(false);
  });

  it("--json reports version, install dir, launcher target, service state, adapters, apps and the manifest", async () => {
    h = await harness();
    fakeAdapters(h);
    await upsertApp(h.deps, record({ appId: "demo", name: "Demo" }));
    const version = path.join(h.root, `data/bridge/versions/${CLI_VERSION}`);
    const entry = path.join(version, "node_modules/@berdyh/bridge/bin/run.js");
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, "");
    const launcher = path.join(h.root, "home/.local/bin/bridge");
    await mkdir(path.dirname(launcher), { recursive: true });
    await symlink(entry, launcher);
    const unit = path.join(h.deps.configDir, "systemd/user/bridge-runner.service");
    await mkdir(path.dirname(unit), { recursive: true });
    await writeFile(unit, "[Unit]\n");
    h.deps.run = async (command, args) => {
      h.commands.push([command, ...args]);
      return { exitCode: 0, stdout: "active\n", stderr: "" };
    };

    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    const report = JSON.parse(h.out.join("")) as Record<string, unknown>;
    expect(report).toMatchObject({
      version: CLI_VERSION,
      platform: "linux",
      install: { dir: version, versionsDir: path.join(h.root, "data/bridge/versions"), launcher: { path: launcher, state: "current", target: entry } },
      service: { name: "bridge-runner.service", file: unit, installed: true, state: "active" },
      adapters: [
        { id: "claude", available: true, command: "/v/node_modules/.bin/claude-agent-acp", source: "bundled", login: { present: false, file: path.join(h.deps.configDir, "bridge/agents/claude/.credentials.json") } },
        { id: "codex", available: false, login: { present: false, file: path.join(h.deps.configDir, "bridge/agents/codex/auth.json") } },
      ],
      apps: [{ appId: "demo", name: "Demo", origin: "https://demo.example", dirs: { config: path.join(h.deps.configDir, "demo/bridge"), data: path.join(h.deps.dataDir, "demo/bridge"), state: path.join(h.root, "home/.local/state/demo/bridge") } }],
      legacy: [],
      protocolHandler: { supported: true, desktopFile: false, mimeapps: "none" },
    });
    expect(h.commands).toEqual([["systemctl", "--user", "is-active", "bridge-runner.service"]]);
    expect((report.paths as { path: string }[]).some((e) => e.path === launcher)).toBe(true);
  });

  it("shows both launcher links in the text and in --json, and --paths lists both", async () => {
    h = await harness();
    fakeAdapters(h);
    const entry = path.join(h.root, `data/bridge/versions/${CLI_VERSION}/node_modules/@berdyh/bridge/bin/run.js`);
    const bin = path.join(h.root, "home/.local/bin");
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, "");
    await mkdir(bin, { recursive: true });
    await symlink(entry, path.join(bin, "bridge"));
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    let text = h.out.join("");
    expect(text).toContain(`launcher: ${path.join(bin, "bridge")} -> ${entry}\n`);
    expect(text).toContain(`          ${path.join(bin, "bridge-runner")} (not installed; run \`bridge self install\`)\n`);

    await symlink(entry, path.join(bin, "bridge-runner"));
    h.out.length = 0;
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    const report = JSON.parse(h.out.join("")) as { install: { launcher: { alias: unknown } }; paths: { path: string; role: string }[] };
    expect(report.install.launcher.alias).toEqual({ path: path.join(bin, "bridge-runner"), state: "current", target: entry });
    expect(report.paths.filter((e) => e.role === "launcher").map((e) => e.path)).toEqual([path.join(bin, "bridge"), path.join(bin, "bridge-runner")]);

    h.out.length = 0;
    expect(await runCli(["doctor", "--paths"], h.deps)).toBe(0);
    text = h.out.join("");
    expect(text).toContain(`${path.join(bin, "bridge-runner")}\tsymlink\tlauncher link on PATH, unambiguous name (bridge-runner)`);
  });

  describe("update notice", () => {
    const REGISTRY_URL = "https://registry.npmjs.org/@berdyh%2fbridge/latest";

    /** A harness with the check switched on and a registry that answers `answer` (a version, or undefined for no answer). */
    async function withRegistry(answer: string | undefined) {
      const asked: string[] = [];
      h = await harness({
        fetch: (async (input: string | URL | Request) => {
          asked.push(String(input));
          if (answer === undefined) throw new Error("offline");
          return new Response(JSON.stringify({ version: answer }));
        }) as typeof fetch,
      });
      delete h.deps.env.BRIDGE_UPDATE_CHECK;
      fakeAdapters(h);
      return asked;
    }

    it("prints the newer version and the install command after the launcher lines, and --json carries it; nothing is downloaded", async () => {
      const asked = await withRegistry("99.0.0");
      expect(await runCli(["doctor"], h.deps)).toBe(0);
      const lines = h.out.join("").split("\n");
      const update = lines.findIndex((l) => l.startsWith("update:"));
      expect(lines[update]).toBe(`update:   bridge 99.0.0 is available (this is ${CLI_VERSION}); install it with \`bridge self install --version 99.0.0\``);
      expect(update).toBeGreaterThan(lines.findIndex((l) => l.startsWith("launcher:")) + 1);
      h.out.length = 0;
      expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
      expect(JSON.parse(h.out.join("")).update).toEqual({ latest: "99.0.0", command: "bridge self install --version 99.0.0" });
      expect(asked).toEqual([REGISTRY_URL, REGISTRY_URL]);
    });

    it.each([
      ["the same version", CLI_VERSION],
      ["no registry answer", undefined],
    ])("prints nothing, and --json says null, for %s", async (_name, answer) => {
      await withRegistry(answer);
      expect(await runCli(["doctor"], h.deps)).toBe(0);
      expect(h.out.join("")).not.toContain("update:");
      h.out.length = 0;
      expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
      expect(JSON.parse(h.out.join("")).update).toBeNull();
    });

    it("does not ask a registry when BRIDGE_UPDATE_CHECK=0 (the harness default)", async () => {
      const asked = await withRegistry("99.0.0");
      h.deps.env.BRIDGE_UPDATE_CHECK = "0";
      expect(await runCli(["doctor"], h.deps)).toBe(0);
      expect(asked).toEqual([]);
      expect(h.out.join("")).not.toContain("update:");
    });
  });

  it("--json says no launcher and no service when nothing is installed, and never runs systemctl for a missing unit", async () => {
    h = await harness();
    fakeAdapters(h);
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    const report = JSON.parse(h.out.join("")) as { install: { dir: unknown; launcher: { state: string; target: unknown } }; service: { installed: boolean } };
    expect(report.install.dir).toBeNull();
    expect(report.install.launcher).toMatchObject({ state: "missing", target: null });
    expect(report.service.installed).toBe(false);
    expect(h.commands).toEqual([]);
  });

  it("flags a launcher that is not ours or points at a removed version", async () => {
    h = await harness();
    fakeAdapters(h);
    const launcher = path.join(h.root, "home/.local/bin/bridge");
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(launcher, "#!/bin/sh\n");
    await runCli(["doctor", "--json"], h.deps);
    expect(JSON.parse(h.out.join("")).install.launcher.state).toBe("foreign");
    await rm(launcher);
    await symlink(path.join(h.root, `data/bridge/versions/${CLI_VERSION}/node_modules/@berdyh/bridge/bin/run.js`), launcher);
    h.out.length = 0;
    await runCli(["doctor", "--json"], h.deps);
    expect(JSON.parse(h.out.join("")).install.launcher.state).toBe("dangling");
  });

  it("reports whether both mimeapps.list lines are present", async () => {
    h = await harness();
    fakeAdapters(h);
    const mime = path.join(h.deps.configDir, "mimeapps.list");
    await mkdir(h.deps.configDir, { recursive: true });
    const report = async () => {
      h.out.length = 0;
      await runCli(["doctor", "--json"], h.deps);
      return (JSON.parse(h.out.join("")) as { protocolHandler: Record<string, unknown> }).protocolHandler;
    };
    await writeFile(mime, "[Default Applications]\nx-scheme-handler/bridge=bridge-url-handler.desktop\n");
    expect(await report()).toMatchObject({ mimeapps: "partial" });
    await writeFile(mime, `[Default Applications]\nx-scheme-handler/bridge=bridge-url-handler.desktop\n\n[Added Associations]\nx-scheme-handler/bridge=bridge-url-handler.desktop;\n`);
    expect(await report()).toMatchObject({ mimeapps: "both" });
    await writeFile(mime, "[Default Applications]\nx-scheme-handler/bridge=bridge-url-handler.desktop\nx-scheme-handler/bridge=other.desktop\n");
    expect(await report()).toMatchObject({ mimeapps: "unknown" });
  });

  it("survives an unreadable apps.json and says so", async () => {
    h = await harness();
    fakeAdapters(h);
    await mkdir(path.join(h.deps.configDir, "bridge"), { recursive: true });
    await writeFile(path.join(h.deps.configDir, "bridge", "apps.json"), "{nope");
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    const report = JSON.parse(h.out.join("")) as { apps: unknown[]; appsError: string };
    expect(report.apps).toEqual([]);
    expect(report.appsError).toContain("not valid JSON");
  });

  it("names each app's three folders in the text report, and a listed app whose app.json is broken", async () => {
    h = await harness();
    fakeAdapters(h);
    await upsertApp(h.deps, record());
    await upsertApp(h.deps, record({ appId: "other", origin: "https://other.example", runnerId: "r2" }));
    await writeFile(appPathsOf(h.deps, "other").appFile, "{nope");
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    const out = h.out.join("");
    const demo = appPathsOf(h.deps, "demo");
    expect(out).toContain(`config ${demo.configDir}`);
    expect(out).toContain(`data   ${demo.dataDir}`);
    expect(out).toContain(`state  ${demo.stateDir}`);
    expect(out).toContain("other (broken:");
    h.out.length = 0;
    await runCli(["doctor", "--json"], h.deps);
    expect(JSON.parse(h.out.join("")).brokenApps).toEqual([expect.objectContaining({ appId: "other", file: appPathsOf(h.deps, "other").appFile })]);
  });

  it("warns about an app's config.json: an unknown agent is ignored, an unknown agent is ignored, effort is recorded but not applied", async () => {
    h = await harness();
    fakeAdapters(h);
    await upsertApp(h.deps, record());
    await writeFile(appPathsOf(h.deps, "demo").configFile, JSON.stringify({ agent: { default: "gemini", model: "m", effort: "high" } }));
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("WARNING:");
    expect(h.out.join("")).toContain("agent.default");
    expect(h.out.join("")).toContain("not applied yet");
    h.out.length = 0;
    await runCli(["doctor", "--json"], h.deps);
    expect(JSON.parse(h.out.join("")).apps[0].warnings).toHaveLength(2);
  });

  it("warns about an older layout in the text and --json reports and still prints", async () => {
    h = await harness();
    fakeAdapters(h);
    await mkdir(path.join(h.deps.configDir, "bridge", "trust"), { recursive: true });
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("WARNING: an older bridge layout is present");
    expect(h.out.join("")).toContain("agents:");
    h.out.length = 0;
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join("")).legacy).toEqual([path.join(h.deps.configDir, "bridge", "trust")]);
  });

  it("usage errors exit 2", async () => {
    h = await harness();
    expect(await runCli(["doctor", "extra"], h.deps)).toBe(2);
  });
});

// --- contained sessions ------------------------------------------------------------------------------------

describe("doctor --paths: the lock and the contained-session folders", () => {
  it("lists runner.lock and, per connected app, its audit, consent and session folders and worker.lock, all inside folders uninstall already removes", async () => {
    h = await harness();
    await upsertApp(h.deps, record({ appId: "demo" }));
    await upsertApp(h.deps, record({ appId: "other", name: "Other" }));
    expect(await runCli(["doctor", "--paths"], h.deps)).toBe(0);
    const lines = h.out.join("").trim().split("\n").map((l) => l.split("\t") as [string, string, string]);
    const byPath = new Map(lines.map((l) => [l[0], l] as const));
    expect(byPath.get(runnerLockPath(h.deps))?.[1]).toBe("file");
    for (const id of ["demo", "other"]) {
      const a = appPathsOf(h.deps, id);
      expect(byPath.get(a.auditDir)?.[1]).toBe("dir");
      expect(byPath.get(a.consentDir)?.[1]).toBe("dir");
      expect(byPath.get(a.sessionsDir)?.[1]).toBe("dir");
      expect(byPath.get(workerLockPath(a))?.[1]).toBe("file");
      // Each is under its own app's bridge/ folders and no other app's.
      for (const file of [a.auditDir, a.sessionsDir, workerLockPath(a)]) expect(file.startsWith(a.stateDir + path.sep)).toBe(true);
      expect(a.consentDir.startsWith(a.configDir + path.sep)).toBe(true);
    }
    // Not shared: every new path is listed once, and the worker locks differ.
    expect(workerLockPath(appPathsOf(h.deps, "demo"))).not.toBe(workerLockPath(appPathsOf(h.deps, "other")));
    expect(new Set(lines.map((l) => l[0])).size).toBe(lines.length);
    expect(lines.map((l) => l[0]).filter((x) => !x.startsWith(h.root))).toEqual([]);
    // Nothing is created by looking.
    expect(await exists(appPathsOf(h.deps, "demo").sessionsDir)).toBe(false);
  });
});

/** An adapter that answers the way the real ones do about containment. */
function adapterWith(id: string, over: { resolved?: { command: string; source: "bundled" | "path" }; profile?: { adapterVersion: string; binaryVersion: string; platformPackageVersion: string } }): AgentAdapter {
  return {
    id,
    availability: async () => ({ id, available: true }),
    resolved: () => over.resolved,
    ...(over.profile ? { containment: () => ({ id: "claude-p1", ...over.profile! }) as never } : {}),
    spawn: async () => Promise.reject(new Error("unused")),
  } as never;
}

const MEASURED = { adapterVersion: "0.94.0", binaryVersion: "2.1.303", platformPackageVersion: "0.3.303" };

describe("doctor: contained sessions per agent", () => {
  it("claude on the measured versions is 'supported (running ... measured on ...)'; codex is 'refused: no containment profile'; the word 'proven' never appears", async () => {
    h = await harness();
    h.deps.adapters = [
      adapterWith("claude", { resolved: { command: "/v/.bin/claude-agent-acp", source: "bundled" }, profile: MEASURED }),
      adapterWith("codex", {}),
    ];
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    const text = h.out.join("");
    expect(text).toContain("contained sessions: supported (running adapter 0.94.0 / CLI 2.1.303; measured on adapter 0.94.0 / CLI 2.1.303, accepted from those versions up, argv asserted at CI, detected at runtime)");
    expect(text).toContain("contained sessions: refused: no containment profile");
    h.out.length = 0;
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    const json = h.out.join("");
    const adapters = (JSON.parse(json) as { adapters: { id: string; containment: unknown }[] }).adapters;
    expect(adapters.find((a) => a.id === "claude")!.containment).toEqual({ supported: true, profile: "claude-p1", adapter: "0.94.0", binary: "2.1.303", platformPackage: "0.3.303" });
    // A newer stack is reported with the versions it runs on, not the measured ones.
    h.out.length = 0;
    h.deps.adapters = [adapterWith("claude", { resolved: { command: "/v/.bin/claude-agent-acp", source: "bundled" }, profile: { adapterVersion: "0.95.2", binaryVersion: "2.2.0", platformPackageVersion: "0.4.0" } })];
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("contained sessions: supported (running adapter 0.95.2 / CLI 2.2.0; measured on adapter 0.94.0 / CLI 2.1.303, accepted from those versions up");
    expect(adapters.find((a) => a.id === "codex")!.containment).toEqual({ supported: false, reason: "no containment profile" });
    for (const output of [text, json]) {
      expect(output.toLowerCase()).not.toContain("proven");
      expect(output.toLowerCase()).not.toContain("guarantee");
    }
  });

  it("claude on an adapter from PATH is refused: contained sessions run only the bundled adapter", async () => {
    h = await harness();
    h.deps.adapters = [adapterWith("claude", { resolved: { command: "/usr/bin/claude-agent-acp", source: "path" } })];
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("contained sessions: refused: contained sessions run only the bundled adapter");
  });

  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("claude with an adapter older than the lowest supported version is refused and the message names both versions", async () => {
    h = await harness();
    // A tree shaped like the install: adapter -> SDK -> platform package, with an adapter below the lowest supported version.
    const modules = path.join(h.root, "install/node_modules");
    const pkg = async (name: string, json: object, files: string[] = []) => {
      const dir = path.join(modules, name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, ...json }));
      for (const f of files) {
        await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
        await writeFile(path.join(dir, f), "");
      }
    };
    await pkg("@agentclientprotocol/claude-agent-acp", { version: "0.93.0", bin: { "claude-agent-acp": "dist/index.js" } }, ["dist/index.js"]);
    await pkg("@anthropic-ai/claude-agent-sdk", { version: "9.9.8" });
    await pkg("@anthropic-ai/claude-agent-sdk-linux-x64", { version: "9.9.8" });
    await mkdir(path.join(modules, ".bin"), { recursive: true });
    const bin = path.join(modules, ".bin/claude-agent-acp");
    await symlink(path.join(modules, "@agentclientprotocol/claude-agent-acp/dist/index.js"), bin);
    h.deps.adapters = [adapterWith("claude", { resolved: { command: bin, source: "bundled" } })];
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("contained sessions: refused: claude adapter 0.93.0 is older than the lowest supported 0.94.0");
  });
});

describe("doctor --containment", () => {
  it("lists each measured pair with its adapter and binary version, says whether the installed pair is it, and points to the canary procedure", async () => {
    h = await harness();
    h.deps.adapters = [adapterWith("claude", { resolved: { command: "/v/.bin/claude-agent-acp", source: "bundled" }, profile: MEASURED })];
    expect(await runCli(["doctor", "--containment"], h.deps)).toBe(0);
    const text = h.out.join("");
    expect(text).toContain("adapter 0.94.0 / SDK 0.3.303 / platform package 0.3.303 / CLI 2.1.303");
    expect(text).toContain("this is the installed pair");
    expect(text).toContain('docs/guides/operate-the-runner.md, section "The claude version floor"');
    expect(text.toLowerCase()).not.toContain("proven");

    h.out.length = 0;
    h.deps.adapters = [adapterWith("claude", { resolved: { command: "/usr/bin/claude-agent-acp", source: "path" } })];
    expect(await runCli(["doctor", "--containment", "--json"], h.deps)).toBe(0);
    const report = JSON.parse(h.out.join("")) as { measured: { adapter: string; binary: string; installed: boolean }[]; claude: { supported: boolean }; canary: string };
    expect(report.measured).toEqual([expect.objectContaining({ adapter: "0.94.0", binary: "2.1.303", installed: false })]);
    expect(report.claude.supported).toBe(false);
    expect(report.canary).toBe('see docs/guides/operate-the-runner.md, section "The claude version floor"');
  });

  it("is not combined with --paths", async () => {
    h = await harness();
    expect(await runCli(["doctor", "--containment", "--paths"], h.deps)).toBe(2);
  });
});

describe("doctor --paths: what only the machine knows (installed plugins' files, the file credential store)", () => {
  const plugin = (appId: string, id: string, version: string): InstalledPlugin => {
    const a = appPathsOf(h.deps, appId);
    return { manifest: { id, app: appId, entry: "entry.js" } as unknown as InstalledPlugin["manifest"], appId, version, installDir: path.join(a.pluginsDir, id, version), dataDir: path.join(a.pluginDataDir, id), status: "stopped" };
  };

  it("lists each installed plugin's package folder, data folder, consent record and audit logs, in text and in JSON", async () => {
    h = await harness();
    await upsertApp(h.deps, record({ appId: "demo" }));
    const a = appPathsOf(h.deps, "demo");
    // Two versions of one plugin are one set of files.
    h.deps.pluginHost = { list: async () => [plugin("demo", "demo.sync", "1.0.0"), plugin("demo", "demo.sync", "1.1.0"), plugin("demo", "other.tool", "2.0.0")] } as never;
    const expected = (id: string): [string, string][] => [
      [path.join(a.pluginsDir, id), "dir"],
      [path.join(a.pluginDataDir, id), "dir"],
      [path.join(a.consentDir, `${id}.consent.json`), "file"],
      [path.join(a.auditDir, `${id}.jsonl`), "file"],
      [path.join(a.auditDir, `${id}.jsonl.1`), "file"],
    ];
    expect(await runCli(["doctor", "--paths"], h.deps)).toBe(0);
    const lines = h.out.join("").trim().split("\n").map((l) => l.split("\t") as [string, string, string]);
    for (const id of ["demo.sync", "other.tool"]) for (const [file, kind] of expected(id)) expect(lines.find((l) => l[0] === file)?.[1], file).toBe(kind);
    expect(new Set(lines.map((l) => l[0])).size).toBe(lines.length);
    h.out.length = 0;
    expect(await runCli(["doctor", "--paths", "--json"], h.deps)).toBe(0);
    const json = JSON.parse(h.out.join("")) as { path: string; kind: string }[];
    for (const id of ["demo.sync", "other.tool"]) for (const [file, kind] of expected(id)) expect(json.find((e) => e.path === file)?.kind, file).toBe(kind);
    // The full report's path list carries them too.
    h.out.length = 0;
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    expect((JSON.parse(h.out.join("")) as { paths: { path: string }[] }).paths.some((e) => e.path === path.join(a.auditDir, "demo.sync.jsonl"))).toBe(true);
  });

  it("lists the credential folder when BRIDGE_CREDENTIAL_STORE=file:<dir> is in use, and not otherwise", async () => {
    h = await harness();
    const dir = path.join(h.root, "state", "bridge-credentials");
    expect(await runCli(["doctor", "--paths"], h.deps)).toBe(0);
    expect(h.out.join("")).not.toContain(dir);
    h.out.length = 0;
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${dir}`;
    expect(await runCli(["doctor", "--paths"], h.deps)).toBe(0);
    const line = h.out.join("").split("\n").find((l) => l.startsWith(`${dir}\t`));
    expect(line).toContain("dir\t");
    expect(line).toContain("BRIDGE_CREDENTIAL_STORE");
    h.out.length = 0;
    expect(await runCli(["doctor", "--paths", "--json"], h.deps)).toBe(0);
    expect((JSON.parse(h.out.join("")) as { path: string; kind: string; removeOnUninstall: boolean }[]).find((e) => e.path === dir)).toMatchObject({ kind: "dir", removeOnUninstall: false });
    // Looking creates nothing.
    expect(await exists(dir)).toBe(false);
  });
});

describe("doctor: the consent record of a plugin that asks for contained sessions", () => {
  const MANIFEST = {
    id: "demo.sync", app: "demo", entry: "entry.js",
    permissions: { agents: ["claude"], mcpServers: { files: { entry: "server.js" } }, headless: { tools: ["mcp__files__read"] } },
  } as unknown as InstalledPlugin["manifest"];

  const installed = (manifest = MANIFEST): InstalledPlugin => ({ manifest, appId: "demo", version: "1.0.0", installDir: "/x", dataDir: "/y", status: "stopped" });

  async function setup(plugins: InstalledPlugin[]): Promise<void> {
    h = await harness();
    // No bridge on PATH: the machine's own /usr/bin/bridge (iproute2) would add a PATH warning to the text checked below.
    h.deps.env.PATH = path.join(h.root, "no-bin");
    h.deps.adapters = [];
    await upsertApp(h.deps, record({ appId: "demo" }));
    h.deps.pluginHost = { list: async () => plugins } as never;
  }

  const grantFor = (manifest: InstalledPlugin["manifest"], over: Partial<ConsentedGrant> = {}): ConsentedGrant => {
    const surface = surfaceOf(manifest);
    return { pluginId: manifest.id, appId: "demo", version: "1.0.0", surface, surfaceSha256: surfaceSha256Of(surface), time: "2026-11-03T10:00:00.000Z", ...over };
  };

  const doctorText = async (): Promise<string> => {
    h.out.length = 0;
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    return h.out.join("");
  };

  it("flags a missing record, a stale one (the manifest now asks for more), and one behind a link; says nothing wrong about a matching one", async () => {
    await setup([installed()]);
    const store = createConsentStore({ paths: appPathsOf(h.deps, "demo") });

    // missing
    let text = await doctorText();
    expect(text).toContain("demo.sync 1.0.0 (app demo): WARNING: no valid consent record; contained sessions refused until `bridge plugin add` is confirmed again");

    // matching
    await store.write(grantFor(MANIFEST));
    text = await doctorText();
    expect(text).toContain("demo.sync 1.0.0 (app demo): consent record matches the installed manifest");
    expect(text).not.toContain("WARNING");

    // stale: the installed manifest asks for a tool the person never approved
    const wider = { ...MANIFEST, permissions: { ...MANIFEST.permissions, headless: { tools: ["mcp__files__read", "mcp__files__write"] } } } as unknown as InstalledPlugin["manifest"];
    h.deps.pluginHost = { list: async () => [installed(wider)] } as never;
    text = await doctorText();
    expect(text).toContain("WARNING: its consent record is for other permissions than the installed manifest asks for; contained sessions refused until `bridge plugin add` is confirmed again");
    h.out.length = 0;
    await runCli(["doctor", "--json"], h.deps);
    expect((JSON.parse(h.out.join("")) as { plugins: unknown[] }).plugins).toEqual([expect.objectContaining({ pluginId: "demo.sync", consent: "stale" })]);

    // behind a link: the consent folder is a link
    h.deps.pluginHost = { list: async () => [installed()] } as never;
    const dir = appPathsOf(h.deps, "demo").consentDir;
    await rm(dir, { recursive: true });
    await mkdir(path.join(h.root, "elsewhere"), { recursive: true });
    await symlink(path.join(h.root, "elsewhere"), dir);
    text = await doctorText();
    expect(text).toContain("WARNING: its consent record or folder is behind a link or cannot be read; contained sessions refused until `bridge plugin add` is confirmed again");
  });

  it("checks the consent record of an agent-only plugin too (missing, matching, stale, behind a link)", async () => {
    const agentOnly = { id: "demo.chat", app: "demo", entry: "entry.js", permissions: { agents: ["claude"] } } as unknown as InstalledPlugin["manifest"];
    await setup([installed(agentOnly)]);
    const store = createConsentStore({ paths: appPathsOf(h.deps, "demo") });
    const refused = "contained sessions refused until `bridge plugin add` is confirmed again";

    let text = await doctorText();
    expect(text).toContain(`demo.chat 1.0.0 (app demo): WARNING: no valid consent record; ${refused}`);

    await store.write(grantFor(agentOnly));
    text = await doctorText();
    expect(text).toContain("demo.chat 1.0.0 (app demo): consent record matches the installed manifest");
    expect(text).not.toContain("WARNING");

    // stale: the installed manifest now names another agent than the one approved
    const wider = { ...agentOnly, permissions: { agents: ["claude", "codex"] } } as unknown as InstalledPlugin["manifest"];
    h.deps.pluginHost = { list: async () => [installed(wider)] } as never;
    text = await doctorText();
    expect(text).toContain(`WARNING: its consent record is for other permissions than the installed manifest asks for; ${refused}`);

    // behind a link
    h.deps.pluginHost = { list: async () => [installed(agentOnly)] } as never;
    const dir = appPathsOf(h.deps, "demo").consentDir;
    await rm(dir, { recursive: true });
    await mkdir(path.join(h.root, "elsewhere"), { recursive: true });
    await symlink(path.join(h.root, "elsewhere"), dir);
    text = await doctorText();
    expect(text).toContain(`WARNING: its consent record or folder is behind a link or cannot be read; ${refused}`);
  });

  it("does not list a plugin that can start no agent session (no agent, MCP server or headless tool)", async () => {
    await setup([installed({ id: "demo.plain", app: "demo", entry: "entry.js", permissions: { network: ["example.com"] } } as unknown as InstalledPlugin["manifest"])]);
    const text = await doctorText();
    expect(text).not.toContain("demo.plain");
    expect(text).not.toContain("plugins with contained sessions");
  });
});

describe("doctor: app settings", () => {
  it("no longer says agent.model is not applied (the policy takes it); agent.effort still is", async () => {
    h = await harness();
    h.deps.adapters = [];
    await upsertApp(h.deps, record());
    await writeFile(appPathsOf(h.deps, "demo").configFile, JSON.stringify({ agent: { model: "m" } }));
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).not.toContain("not applied");
    await writeFile(appPathsOf(h.deps, "demo").configFile, JSON.stringify({ agent: { model: "m", effort: "high" } }));
    h.out.length = 0;
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("agent.effort is recorded but not applied yet");
    expect(h.out.join("")).not.toContain("agent.model");
  });
});

describe("doctor: lock files", () => {
  it("shows the pid in runner.lock and in an app's worker.lock and whether it is running; says nothing when there are none", async () => {
    h = await harness();
    h.deps.adapters = [];
    await upsertApp(h.deps, record({ appId: "demo" }));
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).not.toContain("locks:");

    const live = JSON.stringify({ version: 1, pid: process.pid, startedAt: "2026-11-03T10:00:00.000Z" });
    const dead = JSON.stringify({ version: 1, pid: 2_000_000_001, startedAt: "2026-11-02T10:00:00.000Z" });
    await mkdir(path.dirname(runnerLockPath(h.deps)), { recursive: true });
    await writeFile(runnerLockPath(h.deps), `${live}\n`);
    await mkdir(path.dirname(workerLockPath(appPathsOf(h.deps, "demo"))), { recursive: true });
    await writeFile(workerLockPath(appPathsOf(h.deps, "demo")), `${dead}\n`);
    h.out.length = 0;
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    const text = h.out.join("");
    expect(text).toContain(`runner.lock: held by pid ${process.pid} since 2026-11-03T10:00:00.000Z (running)`);
    expect(text).toContain("worker.lock of demo: held by pid 2000000001 since 2026-11-02T10:00:00.000Z (not running: a runner start replaces it)");
    h.out.length = 0;
    await runCli(["doctor", "--json"], h.deps);
    expect((JSON.parse(h.out.join("")) as { locks: { holder: string }[] }).locks.map((l) => l.holder)).toEqual(["runner", "demo"]);
  });
});

describe("doctor with the adapters the CLI builds", () => {
  it("the bundled claude adapter carries the containment support (it is judged, not 'no containment profile'); codex has none", async () => {
    h = await harness();
    // No injected adapters: `adaptersOf` builds the real ones over this checkout's bundled adapter.
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    const adapters = (JSON.parse(h.out.join("")) as { adapters: { id: string; source?: string; containment: { supported: boolean; reason?: string } }[] }).adapters;
    const claude = adapters.find((a) => a.id === "claude")!;
    expect(claude.source).toBe("bundled");
    // Supported on the measured pair; otherwise the pin check's own reason, never the 'no profile' answer of an adapter without support.
    expect(claude.containment.supported || claude.containment.reason !== "no containment profile").toBe(true);
    expect(adapters.find((a) => a.id === "codex")!.containment).toEqual({ supported: false, reason: "no containment profile" });
  });
});

describe("doctor: bridge on PATH", () => {
  async function bridgeIn(dir: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "bridge");
    await writeFile(file, "#!/bin/sh\nexit 255\n");
    await chmod(file, 0o755);
    return file;
  }

  it("warns, naming both paths and the fix, when the first bridge on PATH is not the launcher", async () => {
    h = await harness();
    fakeAdapters(h);
    const other = await bridgeIn(path.join(h.root, "usr/bin"));
    const launcher = path.join(h.root, "home/.local/bin/bridge");
    h.deps.env.PATH = [path.dirname(other), path.dirname(launcher)].join(":");
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    const out = h.out.join("");
    expect(out).toContain("WARNING: `bridge` on your PATH is not the bridge launcher");
    expect(out).toContain(`finds ${other} first`);
    expect(out).toContain(`the launcher is ${launcher}`);
    expect(out).toContain(`put ${path.dirname(launcher)} before ${path.dirname(other)} in PATH`);
    h.out.length = 0;
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    expect((JSON.parse(h.out.join("")) as { pathWarning: string }).pathWarning).toContain(`finds ${other} first`);
  });

  it("prints no warning with the launcher first on PATH", async () => {
    h = await harness();
    fakeAdapters(h);
    const entry = path.join(h.root, `data/bridge/versions/${CLI_VERSION}/node_modules/@berdyh/bridge/bin/run.js`);
    const launcher = path.join(h.root, "home/.local/bin/bridge");
    await mkdir(path.dirname(entry), { recursive: true });
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(entry, "", { mode: 0o755 });
    await symlink(entry, launcher);
    const other = await bridgeIn(path.join(h.root, "usr/bin"));
    h.deps.env.PATH = [path.dirname(launcher), path.dirname(other)].join(":");
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).not.toContain("is not the bridge launcher");
    h.out.length = 0;
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    expect((JSON.parse(h.out.join("")) as { pathWarning: unknown }).pathWarning).toBeNull();
  });
});

describe("doctor: the file credential store", () => {
  it("with BRIDGE_CREDENTIAL_STORE set, prints the warning with the directory and how to leave it", async () => {
    h = await harness();
    fakeAdapters(h);
    const dir = path.join(h.root, "creds");
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${dir}`;
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    const out = h.out.join("");
    expect(out).toContain(`WARNING: BRIDGE_CREDENTIAL_STORE is set: the runner's credentials are kept as plain, unencrypted files in ${dir}`);
    expect(out).toContain("not in the OS keychain");
    expect(out).toContain("unset BRIDGE_CREDENTIAL_STORE to use the keychain");
    expect(await exists(dir)).toBe(false);
    h.out.length = 0;
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    expect((JSON.parse(h.out.join("")) as { credentialStore: { kind: string; dir: string; warning: string } }).credentialStore).toMatchObject({ kind: "file", dir, warning: expect.stringContaining("unencrypted") });
  });

  it("without BRIDGE_CREDENTIAL_STORE (or empty), prints nothing about it", async () => {
    h = await harness();
    fakeAdapters(h);
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).not.toContain("BRIDGE_CREDENTIAL_STORE");
    expect(h.out.join("")).not.toContain("unencrypted");
    h.deps.env.BRIDGE_CREDENTIAL_STORE = "";
    h.out.length = 0;
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).not.toContain("BRIDGE_CREDENTIAL_STORE");
    h.out.length = 0;
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    expect((JSON.parse(h.out.join("")) as { credentialStore: unknown }).credentialStore).toEqual({ kind: "keychain" });
  });

  it("a malformed value is reported as a warning, and doctor still runs", async () => {
    h = await harness();
    fakeAdapters(h);
    h.deps.env.BRIDGE_CREDENTIAL_STORE = "file:relative/dir";
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("WARNING: BRIDGE_CREDENTIAL_STORE must be file:<absolute directory>");
  });
});

describe("doctor: an OS keychain that is not usable", () => {
  const NO_SERVICE = "secret-tool: The name org.freedesktop.secrets was not provided by any .service files";

  it("on Linux with no Secret Service owner: warns, names BRIDGE_CREDENTIAL_STORE=file:<dir>, and the JSON carries it", async () => {
    h = await harness();
    fakeAdapters(h);
    delete h.deps.credentials;
    h.deps.run = async (command) => (command === "secret-tool" ? { exitCode: 1, stdout: "", stderr: `${NO_SERVICE}\n` } : { exitCode: 0, stdout: "", stderr: "" });
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    const out = h.out.join("");
    expect(out).toContain("WARNING: the OS keychain is not usable here");
    expect(out).toContain("org.freedesktop.secrets");
    expect(out).toContain("BRIDGE_CREDENTIAL_STORE=file:<absolute directory>");
    h.out.length = 0;
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    expect((JSON.parse(h.out.join("")) as { credentialStore: { kind: string; usable: boolean; warning: string } }).credentialStore).toMatchObject({ kind: "keychain", usable: false, warning: expect.stringContaining("BRIDGE_CREDENTIAL_STORE=file:") });
  });

  it("a keychain that does not answer in time is not verified: doctor warns with the unlock hint", async () => {
    h = await harness();
    fakeAdapters(h);
    delete h.deps.credentials;
    h.deps.run = async (command) => {
      if (command === "secret-tool") throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("WARNING: the OS keychain did not answer within 5 s");
    expect(h.out.join("")).toContain("unlock it and retry");
    expect(h.out.join("")).toContain("BRIDGE_CREDENTIAL_STORE=file:<absolute directory>");
  });

  it("with no secret-tool at all: warns the same way", async () => {
    h = await harness();
    fakeAdapters(h);
    delete h.deps.credentials;
    h.deps.run = async (command) => {
      if (command === "secret-tool") throw Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("secret-tool is not installed");
    expect(h.out.join("")).toContain("BRIDGE_CREDENTIAL_STORE=file:<absolute directory>");
  });

  it("a working Secret Service (lookup of a missing item: exit 1, no output), the file store, macOS and an injected store: no warning, and no secret stored by the probe", async () => {
    h = await harness();
    fakeAdapters(h);
    delete h.deps.credentials;
    const seen: string[][] = [];
    h.deps.run = async (command, args) => {
      seen.push([command, ...args]);
      return { exitCode: command === "secret-tool" ? 1 : 0, stdout: "", stderr: "" };
    };
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).not.toContain("not usable");
    expect(seen.filter((c) => c[0] === "secret-tool").every((c) => c[1] === "lookup")).toBe(true);
    expect(seen.some((c) => c[0] === "secret-tool")).toBe(true);
    // The other three never reach for the keychain probe.
    seen.length = 0;
    h.deps.run = async (command, args) => {
      seen.push([command, ...args]);
      return { exitCode: 1, stdout: "", stderr: NO_SERVICE };
    };
    h.out.length = 0;
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${path.join(h.root, "creds")}`;
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).not.toContain("not usable");
    delete h.deps.env.BRIDGE_CREDENTIAL_STORE;
    h.deps.platform = "darwin";
    h.out.length = 0;
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).not.toContain("not usable");
    h.deps.platform = "linux";
    h.deps.credentials = memoryCredentials();
    h.out.length = 0;
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).not.toContain("not usable");
    expect(seen.some((c) => c[0] === "secret-tool")).toBe(false);
  });
});

describe("doctor: token write-back", () => {
  it("lists, under its own heading, the files a refreshed agent token is written back to, with or without a login", async () => {
    h = await harness();
    fakeAdapters(h);
    const claude = path.join(h.deps.configDir, "bridge/agents/claude/.credentials.json");
    const codex = path.join(h.deps.configDir, "bridge/agents/codex/auth.json");
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    let out = h.out.join("");
    expect(out).toContain("token write-back (a token an agent refreshes inside a session is written back to these plain files; ~/.claude and ~/.codex are not written):");
    expect(out).toContain(`  claude: ${claude} (no login)`);
    expect(out).toContain(`  codex: ${codex} (no login)`);
    expect(out.indexOf("token write-back")).toBeLessThan(out.indexOf("agents:"));

    await mkdir(path.dirname(claude), { recursive: true });
    await writeFile(claude, JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
    h.out.length = 0;
    expect(await runCli(["doctor", "--json"], h.deps)).toBe(0);
    expect((JSON.parse(h.out.join("")) as { tokenWriteBack: unknown[] }).tokenWriteBack).toEqual([
      { agent: "claude", file: claude, present: true },
      { agent: "codex", file: codex, present: false },
    ]);
  });

  it("is the same list under the file credential store (the agent logins are plain files either way)", async () => {
    h = await harness();
    fakeAdapters(h);
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${path.join(h.root, "creds")}`;
    expect(await runCli(["doctor"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(`  claude: ${path.join(h.deps.configDir, "bridge/agents/claude/.credentials.json")}`);
  });
});


describe("confined-v1 capability report", () => {
  it("names the exact supported platform and distinguishes the adapter from sandbox prerequisites", async () => {
    h = await harness();
    fakeAdapters(h);
    expect(await runCli(["doctor", "--containment", "--json"], h.deps)).toBe(0);
    const report = JSON.parse(h.out.join(""));
    expect(report.execution).toMatchObject({ profile: "confined-v1", platform: "linux-x64", agent: "claude", adapterSupported: false });
    expect(typeof report.execution.supported).toBe("boolean");
    if (!report.execution.supported) expect(report.execution.hint).toMatch(/namespace|Linux/);
    expect(JSON.stringify(report)).not.toMatch(/SYNTHETIC_BROKER_SECRET/);
  });
});
