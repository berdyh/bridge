import { readFileSync } from "node:fs";
import { chmod, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CLAUDE_MEASURED_STACKS, CONTAINMENT_REFUSAL_HINT, ContainmentRefused, MEASURED_CLAUDE_STACK, type CommandResult, createDefaultAgentAdapters } from "@berdyh/bridge-runner";
import { afterEach, describe, expect, it } from "vitest";

import {
  ADAPTER_KINDS,
  BUNDLED_CLAUDE_ADAPTER,
  CODEX_ADAPTER_BIN,
  CODEX_ADAPTER_ENV,
  CODEX_ADAPTER_PACKAGE,
  CODEX_ADAPTER_PIN,
  CODEX_ADAPTER_SIZE,
  INSTALL_CODEX_ADAPTER_COMMAND,
  codexAdapterDirOf,
  installCodexAdapter,
  CLAUDE_ADAPTER_ENV,
  CLAUDE_ADAPTER_PIN,
  INSTALL_ADAPTER_COMMAND,
  adapterInstallPlan,
  adapterOptionsOf,
  bundledAdapterCommand,
  checkInstalledAdapter,
  checkClaudeStack,
  checkInstalledClaudeAdapter,
  claudeAdapterDirOf,
  installClaudeAdapter,
  runAdapterInstall,
} from "./adapters.js";
import { runAgent } from "./agent.js";
import { UsageError } from "./deps.js";
import { manifestOf } from "./doctor.js";
import { type Harness, exists, harness } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

async function fakeBin(file: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\n");
  await chmod(file, 0o755);
  return file;
}

describe("bundledAdapterCommand", () => {
  it("finds the adapter in a source checkout's package node_modules/.bin, from dist or src", async () => {
    h = await harness();
    const pkg = path.join(h.root, "checkout/packages/cli");
    await mkdir(path.join(pkg, "dist"), { recursive: true });
    await writeFile(path.join(pkg, "package.json"), "{}");
    const bin = await fakeBin(path.join(pkg, "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    expect(bundledAdapterCommand({ fromDir: path.join(pkg, "dist") })).toBe(bin);
    expect(bundledAdapterCommand({ fromDir: pkg })).toBe(bin);
  });

  it("finds the hoisted adapter of an install made with npm install --prefix versions/<v>", async () => {
    h = await harness();
    const version = path.join(h.root, "data/bridge/versions/0.1.0");
    const bin = await fakeBin(path.join(version, "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    const dist = path.join(version, "node_modules/@berdyh/bridge/dist");
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(version, "node_modules/@berdyh/bridge/package.json"), "{}");
    expect(bundledAdapterCommand({ fromDir: dist })).toBe(bin);
  });

  it("never looks beyond the install's own root", async () => {
    h = await harness();
    // A same-named binary above the checkout and above the version dir is not ours.
    await fakeBin(path.join(h.root, "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    await fakeBin(path.join(h.root, "checkout/node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    const pkg = path.join(h.root, "checkout/packages/cli");
    await mkdir(path.join(pkg, "dist"), { recursive: true });
    await writeFile(path.join(pkg, "package.json"), "{}");
    expect(bundledAdapterCommand({ fromDir: path.join(pkg, "dist") })).toBeUndefined();

    const version = path.join(h.root, "data/bridge/versions/0.1.0");
    const dist = path.join(version, "node_modules/@berdyh/bridge/dist");
    await mkdir(dist, { recursive: true });
    await fakeBin(path.join(h.root, "data/bridge/versions/node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    expect(bundledAdapterCommand({ fromDir: dist })).toBeUndefined();
  });

  it("ignores a non-executable file", async () => {
    h = await harness();
    const pkg = path.join(h.root, "checkout/packages/cli");
    const bin = await fakeBin(path.join(pkg, "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    await writeFile(path.join(pkg, "package.json"), "{}");
    await chmod(bin, 0o644);
    expect(bundledAdapterCommand({ fromDir: pkg })).toBeUndefined();
  });

  it("finds the dependency in this workspace (the real lookup, from this module)", () => {
    const found = bundledAdapterCommand();
    expect(found).toBeDefined();
    expect(found!.endsWith(path.join("node_modules", ".bin", BUNDLED_CLAUDE_ADAPTER))).toBe(true);
  });
});

describe("adapterOptionsOf", () => {
  it("puts session sandboxes under <state>/<app>/bridge/tmp, from the deps, not the real home", async () => {
    h = await harness();
    const options = adapterOptionsOf(h.deps, { fromDir: h.root });
    expect(options.base).toMatchObject({ state: path.join(h.root, "home/.local/state"), config: h.deps.configDir, data: h.deps.dataDir });
    expect(options.environment).toEqual({ env: h.deps.env, homedir: path.join(h.root, "home") });
    const xdg = await harness({ env: { HOME: "/x", XDG_STATE_HOME: "/xdg/state" }, homeDir: "/x" });
    try {
      expect(adapterOptionsOf(xdg.deps, { fromDir: xdg.root }).base?.state).toBe("/xdg/state");
    } finally {
      await xdg.cleanup();
    }
  });

  it("containment decisions reach the deps' stderr with the bridge: prefix, and agent stderr stays off", async () => {
    h = await harness();
    const options = adapterOptionsOf(h.deps, { fromDir: h.root });
    expect(options.containmentLog).toBeTypeOf("function");
    options.containmentLog!("x");
    expect(h.err).toEqual(["bridge: x\n"]);
    expect(options.log).toBeUndefined();
  });

  it("points both agents at bridge's own login files, never at ~/.claude or ~/.codex", async () => {
    h = await harness();
    const options = adapterOptionsOf(h.deps, { fromDir: h.root });
    expect(options.authFiles).toEqual({
      "claude-code": path.join(h.deps.configDir, "bridge/agents/claude/.credentials.json"),
      "codex-cli": path.join(h.deps.configDir, "bridge/agents/codex/auth.json"),
    });
  });

  it("lists bridge's own copy path, then the checkout copy when there is one, before the PATH names", async () => {
    h = await harness();
    const pkg = path.join(h.root, "checkout/packages/cli");
    await writeFile(path.join(await mkdirp(pkg), "package.json"), "{}");
    const bin = await fakeBin(path.join(pkg, "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    expect(adapterOptionsOf(h.deps, { fromDir: pkg }).commands?.claude).toEqual([{ command: path.join(claudeAdapterDirOf(h.deps), "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER), source: "bundled" }, { command: bin, source: "bundled" }, BUNDLED_CLAUDE_ADAPTER, "claude-code-acp"]);
    expect(adapterOptionsOf(h.deps, { fromDir: h.root }).commands?.claude).toEqual([{ command: path.join(claudeAdapterDirOf(h.deps), "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER), source: "bundled" }, BUNDLED_CLAUDE_ADAPTER, "claude-code-acp"]);
  });

  it("makes the bundled adapter win over a same-named PATH entry, and reports where it came from", async () => {
    h = await harness();
    const pkg = path.join(h.root, "checkout/packages/cli");
    await writeFile(path.join(await mkdirp(pkg), "package.json"), "{}");
    const bundled = await fakeBin(path.join(pkg, "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    const decoy = await fakeBin(path.join(h.root, "decoy-bin", BUNDLED_CLAUDE_ADAPTER));
    const deps = { ...h.deps, env: { ...h.deps.env, PATH: path.dirname(decoy) } };
    const [claude, codex] = createDefaultAgentAdapters(adapterOptionsOf(deps, { fromDir: pkg }));
    expect(claude!.resolved()).toEqual({ command: bundled, source: "bundled" });
    expect(codex!.resolved()).toBeUndefined();

    // Without the bundled copy the PATH one is used, and says so.
    const [fallback] = createDefaultAgentAdapters(adapterOptionsOf(deps, { fromDir: h.root }));
    expect(fallback!.resolved()).toEqual({ command: decoy, source: "path" });
  });

  it("tries $BRIDGE_CLAUDE_ADAPTER before the bundled copy, as a path source", async () => {
    h = await harness();
    const pkg = path.join(h.root, "checkout/packages/cli");
    await writeFile(path.join(await mkdirp(pkg), "package.json"), "{}");
    const bundled = await fakeBin(path.join(pkg, "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    const mine = await fakeBin(path.join(h.root, "mine/my-acp"));
    const deps = { ...h.deps, env: { ...h.deps.env, [CLAUDE_ADAPTER_ENV]: mine } };
    expect(adapterOptionsOf(deps, { fromDir: pkg }).commands?.claude).toEqual([mine, { command: path.join(claudeAdapterDirOf(h.deps), "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER), source: "bundled" }, { command: bundled, source: "bundled" }, BUNDLED_CLAUDE_ADAPTER, "claude-code-acp"]);
    const [claude] = createDefaultAgentAdapters(adapterOptionsOf(deps, { fromDir: pkg }));
    expect(claude!.resolved()).toEqual({ command: mine, source: "path" });
    // A path that does not exist falls through to the bundled copy.
    const missing = { ...h.deps, env: { ...h.deps.env, [CLAUDE_ADAPTER_ENV]: path.join(h.root, "nope") } };
    expect(createDefaultAgentAdapters(adapterOptionsOf(missing, { fromDir: pkg }))[0]!.resolved()).toEqual({ command: bundled, source: "bundled" });
  });
});

async function mkdirp(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

// --- the adapter is installed on request ------------------------------------------------------

const ADAPTER_PKG = "node_modules/@agentclientprotocol/claude-agent-acp";

describe("lookup order with the adapter installed on request", () => {
  it("a fresh install, with no checkout copy and an empty PATH, finds nothing and the claude adapter is unavailable", async () => {
    h = await harness();
    h.deps.env.PATH = "";
    const options = adapterOptionsOf(h.deps, { fromDir: h.root });
    expect(options.commands?.claude).toEqual([{ command: path.join(claudeAdapterDirOf(h.deps), "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER), source: "bundled" }, BUNDLED_CLAUDE_ADAPTER, "claude-code-acp"]);
    const [claude] = createDefaultAgentAdapters(options);
    expect(claude!.id).toBe("claude");
    expect(claude!.resolved()).toBeUndefined();
    expect(await claude!.availability()).toMatchObject({ available: false });
  });

  it("a contained session on that machine is refused with the reason adapter_missing, and the runner's hint is the command bridge prints", async () => {
    h = await harness();
    h.deps.env.PATH = "";
    const [claude] = createDefaultAgentAdapters(adapterOptionsOf(h.deps, { fromDir: h.root }));
    expect(claude!.containment?.()).toBeUndefined();
    expect(claude!.containmentRefusalReason?.()).toBe("adapter_missing");
    expect(CONTAINMENT_REFUSAL_HINT.adapter_missing).toBe(INSTALL_ADAPTER_COMMAND);
    const sessionId = "2f0e5f4e-2a5c-4d0e-8d8a-6f1f3f0b9d11";
    const refused = await claude!.spawn({ cwd: path.join(h.root, "sessions", sessionId), appId: "app", containment: { sessionId, servers: [], allow: [] } }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ContainmentRefused);
    expect(refused).toMatchObject({ code: -32016, message: "Contained session unavailable", reason: "adapter_missing" });
  });

  it("a $BRIDGE_CLAUDE_ADAPTER override is not a missing adapter: no reason code", async () => {
    h = await harness();
    h.deps.env.PATH = "";
    const mine = await fakeBin(path.join(h.root, "mine/my-acp"));
    const [claude] = createDefaultAgentAdapters(adapterOptionsOf({ ...h.deps, env: { ...h.deps.env, [CLAUDE_ADAPTER_ENV]: mine } }, { fromDir: h.root }));
    expect(claude!.containmentRefusalReason?.()).toBeUndefined();
  });

  it("bridge's copy at the pinned version is offered as bundled, after $BRIDGE_CLAUDE_ADAPTER and before the checkout copy and PATH", async () => {
    h = await harness();
    const installed = await fakeBin(path.join(claudeAdapterDirOf(h.deps), "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    const pkg = path.join(h.root, "checkout/packages/cli");
    await writeFile(path.join(await mkdirp(pkg), "package.json"), "{}");
    const checkout = await fakeBin(path.join(pkg, "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    const mine = await fakeBin(path.join(h.root, "mine/my-acp"));
    expect(adapterOptionsOf(h.deps, { fromDir: h.root }).commands?.claude).toEqual([{ command: installed, source: "bundled" }, BUNDLED_CLAUDE_ADAPTER, "claude-code-acp"]);
    expect(adapterOptionsOf(h.deps, { fromDir: pkg }).commands?.claude).toEqual([{ command: installed, source: "bundled" }, { command: checkout, source: "bundled" }, BUNDLED_CLAUDE_ADAPTER, "claude-code-acp"]);
    const deps = { ...h.deps, env: { ...h.deps.env, [CLAUDE_ADAPTER_ENV]: mine } };
    const commands = adapterOptionsOf(deps, { fromDir: pkg }).commands?.claude;
    expect((commands as readonly unknown[])[0]).toBe(mine);
    const [claude] = createDefaultAgentAdapters(adapterOptionsOf(deps, { fromDir: pkg }));
    expect(claude!.resolved()).toEqual({ command: mine, source: "path" });
  });

  it("a copy of another version is never a candidate, so a pin bump asks for the install again", async () => {
    h = await harness();
    await fakeBin(path.join(h.deps.dataDir, "bridge/adapters/claude/0.93.0/node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    await fakeBin(path.join(h.deps.dataDir, "bridge/adapters/claude/9.9.9/node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    h.deps.env.PATH = "";
    expect(adapterOptionsOf(h.deps, { fromDir: h.root }).commands?.claude).toEqual([{ command: path.join(claudeAdapterDirOf(h.deps), "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER), source: "bundled" }, BUNDLED_CLAUDE_ADAPTER, "claude-code-acp"]);
    expect(createDefaultAgentAdapters(adapterOptionsOf(h.deps, { fromDir: h.root }))[0]!.resolved()).toBeUndefined();
  });

  it("a copy that is not executable does not resolve", async () => {
    h = await harness();
    h.deps.env.PATH = "";
    const bin = await fakeBin(path.join(claudeAdapterDirOf(h.deps), "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    await chmod(bin, 0o644);
    expect(createDefaultAgentAdapters(adapterOptionsOf(h.deps, { fromDir: h.root }))[0]!.resolved()).toBeUndefined();
  });

  it("a copy installed after the adapters were built serves the next session: the runner needs no restart", async () => {
    h = await harness();
    h.deps.env.PATH = "";
    const [claude] = createDefaultAgentAdapters(adapterOptionsOf(h.deps, { fromDir: h.root }));
    expect(claude!.resolved()).toBeUndefined();
    const bin = await fakeBin(path.join(claudeAdapterDirOf(h.deps), "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    expect(claude!.resolved()).toEqual({ command: bin, source: "bundled" });
    await chmod(bin, 0o644);
    expect(claude!.resolved()).toBeUndefined();
  });
});

describe("codex adapter lookup order", () => {
  const codexInstalledBin = (deps: Harness["deps"]) => path.join(codexAdapterDirOf(deps), "node_modules/.bin", CODEX_ADAPTER_BIN);
  const codexOf = (deps: Harness["deps"], fromDir: string) => createDefaultAgentAdapters(adapterOptionsOf(deps, { fromDir }))[1]!;

  it("lists $BRIDGE_CODEX_ADAPTER, then bridge's copy at the pinned version (bundled), then codex-acp on PATH", async () => {
    h = await harness();
    expect(adapterOptionsOf(h.deps, { fromDir: h.root }).commands?.codex).toEqual([{ command: codexInstalledBin(h.deps), source: "bundled" }, CODEX_ADAPTER_BIN]);
    const deps = { ...h.deps, env: { ...h.deps.env, [CODEX_ADAPTER_ENV]: "/x/mine" } };
    expect(adapterOptionsOf(deps, { fromDir: h.root }).commands?.codex).toEqual(["/x/mine", { command: codexInstalledBin(h.deps), source: "bundled" }, CODEX_ADAPTER_BIN]);
    // The claude override does not leak into codex, nor the other way round.
    const claudeOnly = { ...h.deps, env: { ...h.deps.env, [CLAUDE_ADAPTER_ENV]: "/x/claude" } };
    expect(adapterOptionsOf(claudeOnly, { fromDir: h.root }).commands?.codex).toEqual([{ command: codexInstalledBin(h.deps), source: "bundled" }, CODEX_ADAPTER_BIN]);
    expect(adapterOptionsOf(deps, { fromDir: h.root }).commands?.claude).not.toContain("/x/mine");
  });

  it("resolves the override first, as a path source", async () => {
    h = await harness();
    const mine = await fakeBin(path.join(h.root, "mine/my-codex-acp"));
    const installed = await fakeBin(codexInstalledBin(h.deps));
    const onPath = await fakeBin(path.join(h.root, "pathbin", CODEX_ADAPTER_BIN));
    const deps = { ...h.deps, env: { ...h.deps.env, PATH: path.dirname(onPath), [CODEX_ADAPTER_ENV]: mine } };
    expect(codexOf(deps, h.root).resolved()).toEqual({ command: mine, source: "path" });
    // A path that does not exist falls through to bridge's copy.
    const missing = { ...deps, env: { ...deps.env, [CODEX_ADAPTER_ENV]: path.join(h.root, "nope") } };
    expect(codexOf(missing, h.root).resolved()).toEqual({ command: installed, source: "bundled" });
  });

  it("bridge's installed copy wins over a codex-acp on PATH, which cannot shadow it", async () => {
    h = await harness();
    const installed = await fakeBin(codexInstalledBin(h.deps));
    const onPath = await fakeBin(path.join(h.root, "pathbin", CODEX_ADAPTER_BIN));
    const deps = { ...h.deps, env: { ...h.deps.env, PATH: path.dirname(onPath) } };
    expect(codexOf(deps, h.root).resolved()).toEqual({ command: installed, source: "bundled" });
  });

  it("falls back to codex-acp on PATH when nothing is installed, and says so", async () => {
    h = await harness();
    const onPath = await fakeBin(path.join(h.root, "pathbin", CODEX_ADAPTER_BIN));
    const deps = { ...h.deps, env: { ...h.deps.env, PATH: path.dirname(onPath) } };
    expect(codexOf(deps, h.root).resolved()).toEqual({ command: onPath, source: "path" });
  });

  it("with nothing anywhere the codex adapter is unavailable; a copy of another version is never a candidate", async () => {
    h = await harness();
    h.deps.env.PATH = "";
    await fakeBin(path.join(h.deps.dataDir, "bridge/adapters/codex/2.4.0/node_modules/.bin", CODEX_ADAPTER_BIN));
    const codex = codexOf(h.deps, h.root);
    expect(codex.id).toBe("codex");
    expect(codex.resolved()).toBeUndefined();
    expect(await codex.availability()).toMatchObject({ id: "codex", available: false });
  });

  it("a copy installed after the adapters were built serves the next session, and with a login the agent is available", async () => {
    h = await harness();
    h.deps.env.PATH = "";
    const codex = codexOf(h.deps, h.root);
    expect(codex.resolved()).toBeUndefined();
    const bin = await fakeBin(codexInstalledBin(h.deps));
    expect(codex.resolved()).toEqual({ command: bin, source: "bundled" });
    expect(await codex.availability()).toMatchObject({ available: false }); // no login in bridge's folder yet
    const login = path.join(h.deps.configDir, "bridge/agents/codex/auth.json");
    await mkdir(path.dirname(login), { recursive: true });
    await writeFile(login, JSON.stringify({ tokens: { access_token: "a1" } }), { mode: 0o600 });
    expect(await codex.availability()).toMatchObject({ available: true });
  });

  it("contained sessions stay refused for codex, on bridge's own copy too", async () => {
    h = await harness();
    await fakeBin(codexInstalledBin(h.deps));
    const sessionId = "2f0e5f4e-2a5c-4d0e-8d8a-6f1f3f0b9d11";
    const refused = await codexOf(h.deps, h.root).spawn({ cwd: path.join(h.root, "sessions", sessionId), appId: "app", containment: { sessionId, servers: [], allow: [] } }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ContainmentRefused);
    expect(refused).toMatchObject({ code: -32016 });
  });
});

describe("the pin", () => {
  const cliDir = fileURLToPath(new URL("..", import.meta.url));
  const repo = path.join(cliDir, "../..");

  it("is the same version in packages/cli's devDependencies and the runner's measured stack, and it is no longer a dependency", () => {
    const cli = JSON.parse(readFileSync(path.join(cliDir, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(cli.devDependencies["@agentclientprotocol/claude-agent-acp"]).toBe(CLAUDE_ADAPTER_PIN.version);
    expect(cli.dependencies).not.toHaveProperty("@agentclientprotocol/claude-agent-acp");
    expect(CLAUDE_ADAPTER_PIN.version).toBe(MEASURED_CLAUDE_STACK.adapter);
    expect(CLAUDE_MEASURED_STACKS[0]!.adapter).toBe(CLAUDE_ADAPTER_PIN.version);
  });

  it("has the integrity pnpm-lock.yaml records for that version", () => {
    const lock = readFileSync(path.join(repo, "pnpm-lock.yaml"), "utf8");
    const escaped = CLAUDE_ADAPTER_PIN.version.replace(/\./g, "\\.");
    const match = new RegExp(`'@agentclientprotocol/claude-agent-acp@${escaped}':\\n\\s+resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)`).exec(lock);
    expect(match?.[1]).toBe(CLAUDE_ADAPTER_PIN.integrity);
  });

  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("the workspace copy passes the same stack check the install runs on its staging folder", () => {
    const bin = path.join(cliDir, "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER);
    expect(() => checkClaudeStack(bin)).not.toThrow();
  });
});

interface FakeAdapterNpm {
  /** Which adapter the fake lays out; default claude. */
  agent?: "claude" | "codex";
  /** What the lockfile and the package report; default: the pin. */
  version?: string;
  integrity?: string;
  /** Skip writing the bin link. */
  noBin?: boolean;
  fail?: boolean;
  onInstall?: (prefix: string) => Promise<void> | void;
}

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

/** A fake `npm install --prefix <staging> ... <spec>` that lays out what npm does for the adapter, and records every command. */
function fakeAdapterNpm(h: Harness, options: FakeAdapterNpm = {}): void {
  h.deps.run = async (command, args): Promise<CommandResult> => {
    h.commands.push([command, ...args]);
    if (command !== "npm") return OK;
    if (options.fail) return { exitCode: 1, stdout: "", stderr: "npm error first\nnpm error network down" };
    const prefix = args[args.indexOf("--prefix") + 1]!;
    await options.onInstall?.(prefix);
    const kind = ADAPTER_KINDS[options.agent ?? "claude"];
    const key = `node_modules/${kind.package}`;
    const version = options.version ?? kind.pin.version;
    const pkg = path.join(prefix, key);
    await mkdir(path.join(pkg, "dist"), { recursive: true });
    await mkdir(path.join(prefix, "node_modules/.bin"), { recursive: true });
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: kind.package, version }));
    await writeFile(path.join(pkg, "dist/index.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
    if (!options.noBin) await symlink(`../${kind.package}/dist/index.js`, path.join(prefix, "node_modules/.bin", kind.bin));
    await writeFile(
      path.join(prefix, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": {}, [key]: { version, integrity: options.integrity ?? kind.pin.integrity } } }),
    );
    return OK;
  };
}

/** `installClaudeAdapter` with a stack check that accepts the fake layout (the real one needs the 273 MB platform binary). */
const install = (deps: Harness["deps"], run: { yes?: boolean } = {}) => installClaudeAdapter(deps, { ...run, stackCheck: () => {} });

const names = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [])).sort();
const npmCommands = (h: Harness) => h.commands.filter((c) => c[0] === "npm");

describe("bridge agent install claude", () => {
  it("is pure in its plan: the version folder, the staging folder and npm's cache", async () => {
    h = await harness();
    const plan = adapterInstallPlan(h.deps);
    expect(plan.dir).toBe(path.join(h.deps.dataDir, "bridge/adapters/claude", CLAUDE_ADAPTER_PIN.version));
    expect(plan.staging).toBe(path.join(h.deps.dataDir, "bridge/adapters/claude", `.staging-${CLAUDE_ADAPTER_PIN.version}-<random>`));
    expect(plan.npmCache).toBe(path.join(h.root, "home/.npm"));
    expect(h.commands).toEqual([]);
    expect(await exists(path.join(h.root, "data"))).toBe(false);
  });

  it("lists the paths before it asks, installs with one npm invocation and renames the staging folder into place", async () => {
    h = await harness({ isTTY: true });
    const seen: string[] = [];
    fakeAdapterNpm(h, {
      onInstall: async (prefix) => {
        seen.push(prefix);
        // Mid-install nothing is at the destination yet.
        expect(await exists(claudeAdapterDirOf(h.deps))).toBe(false);
      },
    });
    expect(await install(h.deps)).toMatchObject({ outcome: "installed", version: CLAUDE_ADAPTER_PIN.version });
    const out = h.out.join("");
    const dir = claudeAdapterDirOf(h.deps);
    expect(out.indexOf(dir)).toBeGreaterThanOrEqual(0);
    expect(out).toContain(`${path.join(path.dirname(dir), `.staging-${CLAUDE_ADAPTER_PIN.version}-<random>`)}/`);
    expect(out).toContain(path.join(h.root, "home/.npm"));
    expect(h.questions).toEqual([`Install the claude adapter ${CLAUDE_ADAPTER_PIN.version} for bridge (about 300 MB from the npm registry)?`]);
    expect(npmCommands(h)).toEqual([["npm", "install", "--prefix", seen[0]!, "--ignore-scripts", "--no-audit", "--no-fund", `@agentclientprotocol/claude-agent-acp@${CLAUDE_ADAPTER_PIN.version}`]]);
    expect(path.dirname(seen[0]!)).toBe(path.dirname(dir));
    expect(path.basename(seen[0]!)).toMatch(new RegExp(`^\\.staging-${CLAUDE_ADAPTER_PIN.version.replace(/\./g, "\\.")}-`));
    expect(await names(path.dirname(dir))).toEqual([CLAUDE_ADAPTER_PIN.version]); // no staging folder is left
    expect(await exists(path.join(dir, ADAPTER_PKG, "package.json"))).toBe(true);
    expect(await exists(path.join(dir, "package-lock.json"))).toBe(true);
    expect(h.out.join("")).toContain(`Installed the claude adapter ${CLAUDE_ADAPTER_PIN.version} for bridge: ${dir}\n`);
    // And the lookup now finds it.
    expect((adapterOptionsOf(h.deps, { fromDir: h.root }).commands?.claude as readonly unknown[])[0]).toEqual({ command: path.join(dir, "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER), source: "bundled" });
  });

  it("--yes answers the question; without --yes and without a terminal nothing is asked and nothing is written", async () => {
    h = await harness({ isTTY: false });
    fakeAdapterNpm(h);
    await expect(install(h.deps)).rejects.toThrow(/without a terminal, pass --yes/);
    await expect(runAdapterInstall(["claude"], h.deps)).rejects.toThrow(UsageError);
    expect(h.questions).toEqual([]);
    expect(h.commands).toEqual([]);
    expect(await exists(path.join(h.root, "data"))).toBe(false);
    expect(await install(h.deps, { yes: true })).toMatchObject({ outcome: "installed" });
    expect(h.questions).toEqual([]);
    expect(h.out.join("")).toContain("These paths will be written");
  });

  it("a cancelled prompt leaves nothing behind and runs nothing", async () => {
    h = await harness({ isTTY: true });
    fakeAdapterNpm(h);
    h.answers.yes = false;
    expect(await install(h.deps)).toEqual({ outcome: "cancelled", version: CLAUDE_ADAPTER_PIN.version });
    expect(h.err.join("")).toContain("cancelled");
    expect(h.commands).toEqual([]);
    expect(await exists(path.join(h.root, "data"))).toBe(false);
  });

  it.each([
    ["an integrity mismatch", { integrity: "sha512-AAAA" }, /integrity/],
    ["a version mismatch", { version: "0.95.0" }, /locked @agentclientprotocol\/claude-agent-acp 0\.95\.0, not 0\.94\.0/],
    ["a missing bin", { noBin: true }, /no executable claude-agent-acp/],
  ] as const)("%s leaves no destination and no staging folder", async (_name, options, message) => {
    h = await harness({ isTTY: true });
    fakeAdapterNpm(h, options);
    await expect(install(h.deps, { yes: true })).rejects.toThrow(message);
    expect(await exists(path.join(h.deps.dataDir, "bridge"))).toBe(false);
  });

  it("an npm exit 1 carries the stderr tail, and leaves no destination and no staging folder", async () => {
    h = await harness({ isTTY: true });
    fakeAdapterNpm(h, { fail: true });
    await expect(install(h.deps, { yes: true })).rejects.toThrow(/npm install exited with 1: npm error first\nnpm error network down/);
    expect(await exists(path.join(h.deps.dataDir, "bridge"))).toBe(false);
  });

  it("a failed install leaves a bridge folder that was there before it, and a run in a terminal asks first", async () => {
    h = await harness({ isTTY: true });
    await mkdir(path.join(h.deps.dataDir, "bridge/versions"), { recursive: true });
    fakeAdapterNpm(h, { fail: true });
    await expect(install(h.deps)).rejects.toThrow(/npm install exited/);
    expect(h.questions).toHaveLength(1);
    expect(await names(path.join(h.deps.dataDir, "bridge"))).toEqual(["versions"]);
  });

  it("no npm on the machine is said plainly", async () => {
    h = await harness({ isTTY: true });
    h.deps.run = async () => {
      throw new Error("spawn npm ENOENT");
    };
    await expect(install(h.deps, { yes: true })).rejects.toThrow(/could not run npm \(spawn npm ENOENT\); install Node\.js with npm/);
    expect(await exists(path.join(h.deps.dataDir, "bridge"))).toBe(false);
  });

  it("a second run is current: no question, no npm", async () => {
    h = await harness({ isTTY: true });
    fakeAdapterNpm(h);
    await install(h.deps, { yes: true });
    h.commands.length = 0;
    h.out.length = 0;
    expect(await install(h.deps)).toMatchObject({ outcome: "current" });
    expect(h.commands).toEqual([]);
    expect(h.questions).toEqual([]);
    expect(h.out.join("")).toBe(`The claude adapter ${CLAUDE_ADAPTER_PIN.version} is already installed at ${claudeAdapterDirOf(h.deps)}.\n`);
  });

  it("a half-made folder at the destination is refused, with how to go on", async () => {
    h = await harness({ isTTY: true });
    fakeAdapterNpm(h);
    await mkdir(claudeAdapterDirOf(h.deps), { recursive: true });
    await expect(install(h.deps, { yes: true })).rejects.toThrow(/exists but is incomplete; remove it and run this again/);
    expect(h.commands).toEqual([]);
    // A folder with the bin but not the pinned package is no better.
    await fakeBin(path.join(claudeAdapterDirOf(h.deps), "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    await expect(install(h.deps, { yes: true })).rejects.toThrow(/incomplete/);
  });

  it("refuses a destination that is a file", async () => {
    h = await harness({ isTTY: true });
    await mkdir(path.dirname(claudeAdapterDirOf(h.deps)), { recursive: true });
    await writeFile(claudeAdapterDirOf(h.deps), "x");
    await expect(install(h.deps, { yes: true })).rejects.toThrow(/is not a directory/);
  });

  it("the adapters folder retargeted during the question is refused before npm runs", async () => {
    h = await harness({ isTTY: true });
    fakeAdapterNpm(h);
    const outside = path.join(h.root, "outside");
    await mkdir(outside, { recursive: true });
    const adapters = path.join(h.deps.dataDir, "bridge/adapters");
    await mkdir(path.dirname(adapters), { recursive: true });
    h.deps.confirm = async () => {
      await symlink(outside, adapters);
      return true;
    };
    await expect(install(h.deps)).rejects.toThrow(/changed while waiting/);
    expect(h.commands).toEqual([]);
    expect(await readdir(outside)).toEqual([]);
  });

  it("an install whose package folder was removed afterwards is incomplete, not current", async () => {
    h = await harness({ isTTY: true });
    fakeAdapterNpm(h);
    await install(h.deps, { yes: true });
    await rm(path.join(claudeAdapterDirOf(h.deps), ADAPTER_PKG), { recursive: true });
    await expect(install(h.deps, { yes: true })).rejects.toThrow(/incomplete/);
  });
});

describe("the staging checks", () => {
  const stack = () => {};

  async function staged(over: { lock?: unknown; pkg?: unknown } = {}): Promise<string> {
    h = await harness();
    const root = path.join(h.root, "staging");
    await mkdir(path.join(root, ADAPTER_PKG), { recursive: true });
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify(over.lock ?? { packages: { [ADAPTER_PKG]: { version: CLAUDE_ADAPTER_PIN.version, integrity: CLAUDE_ADAPTER_PIN.integrity } } }));
    await writeFile(path.join(root, ADAPTER_PKG, "package.json"), JSON.stringify(over.pkg ?? { version: CLAUDE_ADAPTER_PIN.version }));
    await fakeBin(path.join(root, "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER));
    return root;
  }

  it("passes a staging folder that has the pinned lock entry, package and bin", async () => {
    await expect(checkInstalledClaudeAdapter(await staged(), stack)).resolves.toBeUndefined();
  });

  it("refuses a package on disk that is not the pinned version even when the lock says it is", async () => {
    await expect(checkInstalledClaudeAdapter(await staged({ pkg: { version: "0.95.0" } }), stack)).rejects.toThrow(/npm installed @agentclientprotocol\/claude-agent-acp 0\.95\.0, not 0\.94\.0/);
  });

  it("refuses a missing or unreadable lockfile and a lock without the adapter", async () => {
    const root = await staged();
    await rm(path.join(root, "package-lock.json"));
    await expect(checkInstalledClaudeAdapter(root, stack)).rejects.toThrow(/no readable package-lock\.json/);
    await expect(checkInstalledClaudeAdapter(await staged({ lock: { packages: {} } }), stack)).rejects.toThrow(/locked .* undefined/);
  });

  it("runs the stack check last and passes it the staging bin; its refusal is the install's", async () => {
    const root = await staged();
    const bins: string[] = [];
    await checkInstalledClaudeAdapter(root, (bin) => void bins.push(bin));
    expect(bins).toEqual([path.join(root, "node_modules/.bin", BUNDLED_CLAUDE_ADAPTER)]);
    await expect(
      checkInstalledClaudeAdapter(root, () => {
        throw new Error("claude CLI 2.0.0 is older than the lowest supported 2.1.303");
      }),
    ).rejects.toThrow(/older than the lowest supported/);
  });
});

describe("bridge agent install dispatch", () => {
  it("runAgent hands install to the adapter install for claude and codex; no name and unknown names are usage errors", async () => {
    h = await harness({ isTTY: false });
    await expect(runAgent(["install"], h.deps)).rejects.toThrow(/usage: bridge agent install <claude\|codex> \[--yes\]/);
    await expect(runAgent(["install", "nope"], h.deps)).rejects.toThrow(UsageError);
    await expect(runAgent(["install", "claude", "codex"], h.deps)).rejects.toThrow(UsageError);
    await expect(runAgent(["install", "claude"], h.deps)).rejects.toThrow(/without a terminal, pass --yes to install the claude adapter/);
    await expect(runAgent(["install", "codex"], h.deps)).rejects.toThrow(/without a terminal, pass --yes to install the codex adapter/);
    expect(h.commands).toEqual([]);
  });

  it("runAgent installs codex with --yes", async () => {
    h = await harness({ isTTY: false });
    fakeAdapterNpm(h, { agent: "codex" });
    expect(await runAgent(["install", "codex", "--yes"], h.deps)).toBe(0);
    expect(await exists(path.join(codexAdapterDirOf(h.deps), "node_modules/.bin", CODEX_ADAPTER_BIN))).toBe(true);
  });
});

describe("bridge agent install codex", () => {
  const codexDir = (deps: Harness["deps"]) => codexAdapterDirOf(deps);
  const codexKey = `node_modules/${CODEX_ADAPTER_PACKAGE}`;

  it("is pinned to the scoped package at 2.5.0 with its integrity, and is no dependency of this repo", () => {
    expect(CODEX_ADAPTER_PACKAGE).toBe("@agentclientprotocol/codex-acp");
    expect(CODEX_ADAPTER_PIN).toEqual({ version: "2.5.0", integrity: "sha512-7e/4OhJwpvSTqsjiokoVYRV7O1XGem1CAsQgO1opmGYbRD5LvmydwDlJrldzQYO5TcPWueGzQ2Jdvyvp6l3qDw==" });
    expect(CODEX_ADAPTER_BIN).toBe("codex-acp");
    const repo = path.join(fileURLToPath(new URL("..", import.meta.url)), "../..");
    for (const pkg of ["cli", "runner", "e2e"].map((d) => (d === "e2e" ? path.join(repo, "e2e/package.json") : path.join(repo, "packages", d, "package.json")))) {
      expect(readFileSync(pkg, "utf8")).not.toContain("codex-acp");
    }
  });

  it("is pure in its plan: the version folder next to claude's, the staging folder and npm's cache", async () => {
    h = await harness();
    const plan = adapterInstallPlan(h.deps, "codex");
    expect(plan.dir).toBe(path.join(h.deps.dataDir, "bridge/adapters/codex", CODEX_ADAPTER_PIN.version));
    expect(plan.staging).toBe(path.join(h.deps.dataDir, "bridge/adapters/codex", `.staging-${CODEX_ADAPTER_PIN.version}-<random>`));
    expect(plan.spec).toBe(`${CODEX_ADAPTER_PACKAGE}@${CODEX_ADAPTER_PIN.version}`);
    expect(plan.npmCache).toBe(path.join(h.root, "home/.npm"));
    expect(h.commands).toEqual([]);
    expect(await exists(path.join(h.root, "data"))).toBe(false);
  });

  it("lists the paths and the size before it asks, installs with one npm invocation (--ignore-scripts) and renames the staging folder into place", async () => {
    h = await harness({ isTTY: true });
    const seen: string[] = [];
    fakeAdapterNpm(h, {
      agent: "codex",
      onInstall: async (prefix) => {
        seen.push(prefix);
        expect(await exists(codexDir(h.deps))).toBe(false);
      },
    });
    expect(await installCodexAdapter(h.deps)).toMatchObject({ outcome: "installed", version: CODEX_ADAPTER_PIN.version });
    const out = h.out.join("");
    const dir = codexDir(h.deps);
    expect(out).toContain(`${dir}  (the codex adapter ${CODEX_ADAPTER_PIN.version} and its dependencies: npm install of ${CODEX_ADAPTER_PACKAGE}@${CODEX_ADAPTER_PIN.version} from the npm registry, --ignore-scripts, ${CODEX_ADAPTER_SIZE}`);
    expect(out).toContain(`${path.join(path.dirname(dir), `.staging-${CODEX_ADAPTER_PIN.version}-<random>`)}/`);
    expect(out).toContain(path.join(h.root, "home/.npm"));
    expect(h.questions).toEqual([`Install the codex adapter ${CODEX_ADAPTER_PIN.version} for bridge (about 450 MB from the npm registry)?`]);
    expect(npmCommands(h)).toEqual([["npm", "install", "--prefix", seen[0]!, "--ignore-scripts", "--no-audit", "--no-fund", `${CODEX_ADAPTER_PACKAGE}@${CODEX_ADAPTER_PIN.version}`]]);
    expect(path.dirname(seen[0]!)).toBe(path.dirname(dir));
    expect(await names(path.dirname(dir))).toEqual([CODEX_ADAPTER_PIN.version]); // no staging folder is left
    expect(await exists(path.join(dir, codexKey, "package.json"))).toBe(true);
    expect(await exists(path.join(dir, "node_modules/.bin", CODEX_ADAPTER_BIN))).toBe(true);
    expect(out).toContain(`Installed the codex adapter ${CODEX_ADAPTER_PIN.version} for bridge: ${dir}\n`);
    // Claude's folder is not touched and no claude stack check ran (the fake layout has no claude SDK or binary).
    expect(await exists(path.join(h.deps.dataDir, "bridge/adapters/claude"))).toBe(false);
  });

  it("--yes answers the question; without --yes and without a terminal nothing is asked and nothing is written", async () => {
    h = await harness({ isTTY: false });
    fakeAdapterNpm(h, { agent: "codex" });
    await expect(installCodexAdapter(h.deps)).rejects.toThrow(/without a terminal, pass --yes to install the codex adapter \(about 450 MB/);
    expect(h.questions).toEqual([]);
    expect(h.commands).toEqual([]);
    expect(await exists(path.join(h.root, "data"))).toBe(false);
    expect(await installCodexAdapter(h.deps, { yes: true })).toMatchObject({ outcome: "installed" });
    expect(h.questions).toEqual([]);
    expect(h.out.join("")).toContain("These paths will be written");
  });

  it("a cancelled prompt leaves nothing behind and runs nothing", async () => {
    h = await harness({ isTTY: true });
    fakeAdapterNpm(h, { agent: "codex" });
    h.answers.yes = false;
    expect(await installCodexAdapter(h.deps)).toEqual({ outcome: "cancelled", version: CODEX_ADAPTER_PIN.version });
    expect(h.commands).toEqual([]);
    expect(await exists(path.join(h.root, "data"))).toBe(false);
  });

  it.each([
    ["an integrity mismatch", { integrity: "sha512-AAAA" }, /integrity sha512-AAAA, not the pinned sha512-7e\//],
    ["a version mismatch", { version: "2.6.0" }, /locked @agentclientprotocol\/codex-acp 2\.6\.0, not 2\.5\.0/],
    ["a missing bin", { noBin: true }, /no executable codex-acp/],
  ] as const)("%s leaves no destination and no staging folder", async (_name, options, message) => {
    h = await harness({ isTTY: true });
    fakeAdapterNpm(h, { agent: "codex", ...options });
    await expect(installCodexAdapter(h.deps, { yes: true })).rejects.toThrow(message);
    expect(await exists(path.join(h.deps.dataDir, "bridge"))).toBe(false);
  });

  it("an npm exit 1 carries the stderr tail, and leaves nothing", async () => {
    h = await harness({ isTTY: true });
    fakeAdapterNpm(h, { agent: "codex", fail: true });
    await expect(installCodexAdapter(h.deps, { yes: true })).rejects.toThrow(/npm install exited with 1: npm error first\nnpm error network down/);
    expect(await exists(path.join(h.deps.dataDir, "bridge"))).toBe(false);
  });

  it("a second run is current (no question, no npm); a half-made folder is refused", async () => {
    h = await harness({ isTTY: true });
    fakeAdapterNpm(h, { agent: "codex" });
    await installCodexAdapter(h.deps, { yes: true });
    h.commands.length = 0;
    h.out.length = 0;
    expect(await installCodexAdapter(h.deps)).toMatchObject({ outcome: "current" });
    expect(h.commands).toEqual([]);
    expect(h.questions).toEqual([]);
    expect(h.out.join("")).toBe(`The codex adapter ${CODEX_ADAPTER_PIN.version} is already installed at ${codexDir(h.deps)}.\n`);
    await rm(path.join(codexDir(h.deps), codexKey), { recursive: true });
    await expect(installCodexAdapter(h.deps, { yes: true })).rejects.toThrow(/exists but is incomplete/);
  });

  it("a claude install does not make the codex one current, and the other way round", async () => {
    h = await harness({ isTTY: true });
    fakeAdapterNpm(h);
    await install(h.deps, { yes: true });
    fakeAdapterNpm(h, { agent: "codex" });
    expect(await installCodexAdapter(h.deps, { yes: true })).toMatchObject({ outcome: "installed" });
    expect(await names(path.join(h.deps.dataDir, "bridge/adapters"))).toEqual(["claude", "codex"]);
  });

  it("bridge doctor --paths lists the adapters folder, which holds the codex copy (uninstall removes that folder)", async () => {
    h = await harness({ isTTY: true });
    fakeAdapterNpm(h, { agent: "codex" });
    await installCodexAdapter(h.deps, { yes: true });
    const entries = await manifestOf(h.deps);
    const adapters = entries.find((e) => e.path === path.join(h.deps.dataDir, "bridge/adapters"));
    expect(adapters).toMatchObject({ kind: "dir", role: "install", removeOnUninstall: true });
    expect(codexDir(h.deps).startsWith(`${adapters!.path}${path.sep}`)).toBe(true);
  });

  it("the staging checks name the codex package and its pin", async () => {
    h = await harness();
    const root = path.join(h.root, "staging");
    await mkdir(path.join(root, codexKey), { recursive: true });
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ packages: { [codexKey]: { version: CODEX_ADAPTER_PIN.version, integrity: CODEX_ADAPTER_PIN.integrity } } }));
    await writeFile(path.join(root, codexKey, "package.json"), JSON.stringify({ version: CODEX_ADAPTER_PIN.version }));
    await fakeBin(path.join(root, "node_modules/.bin", CODEX_ADAPTER_BIN));
    await expect(checkInstalledAdapter(root, "codex")).resolves.toBeUndefined();
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ packages: { [codexKey]: { version: CODEX_ADAPTER_PIN.version, integrity: ADAPTER_KINDS.claude.pin.integrity } } }));
    await expect(checkInstalledAdapter(root, "codex")).rejects.toThrow(/integrity/);
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ packages: {} }));
    await expect(checkInstalledAdapter(root, "codex")).rejects.toThrow(/locked .* undefined/);
  });
});
