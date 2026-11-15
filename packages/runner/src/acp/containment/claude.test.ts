import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as barrel from "../../index.js";
import { createDefaultAgentAdapters } from "../adapters.js";
import { CLAUDE_BUILTIN_TOOL_NAMES, CLAUDE_CONTAINMENT_OPTIONS, ContainmentRefused, MEASURED_CLAUDE_STACK } from "../contracts.js";

import {
  CLAUDE_MEASURED_STACKS,
  CLAUDE_MIN_SUPPORTED,
  checkClaudeNewSession,
  claudeCommandsOutsideSet,
  claudeContainmentSupport,
  claudeContainmentSupportWithSeams,
  claudeExecutableProblem,
  claudeProfileOf,
  claudeSessionOptions,
  claudeToolOutsideSet,
  resolveClaudeStack,
} from "./claude.js";

const CLI_PACKAGE_JSON = fileURLToPath(new URL("../../../../cli/package.json", import.meta.url));
const BUNDLED_ADAPTER = path.join(path.dirname(CLI_PACKAGE_JSON), "node_modules/.bin/claude-agent-acp");
const linuxX64 = process.platform === "linux" && process.arch === "x64";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-claude-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("the floor: the CLI's adapter and the resolved binary are at or above the lowest measured version", () => {
  const versionOf = (packageJson: string): string => (JSON.parse(readFileSync(packageJson, "utf8")) as { version: string }).version;

  it("the measured table is MEASURED_CLAUDE_STACK (adapter, SDK, platform package, binary)", () => {
    expect(CLAUDE_MEASURED_STACKS).toHaveLength(1);
    expect(CLAUDE_MEASURED_STACKS[0]).toMatchObject({ ...MEASURED_CLAUDE_STACK });
    expect(MEASURED_CLAUDE_STACK).toEqual({ adapter: "0.94.0", sdk: "0.3.303", platformPackage: "0.3.303", binary: "2.1.303" });
  });

  it("the lowest supported version is the lowest measured row (adapter 0.94.0, CLI 2.1.303)", () => {
    expect(CLAUDE_MIN_SUPPORTED).toEqual({ adapter: "0.94.0", binary: "2.1.303" });
    expect(CLAUDE_MEASURED_STACKS.some((row) => row.adapter === CLAUDE_MIN_SUPPORTED.adapter && row.binary === CLAUDE_MIN_SUPPORTED.binary)).toBe(true);
  });

  it.skipIf(!linuxX64)("packages/cli's adapter pin and the installed claude-agent-sdk-linux-x64 resolve to a stack at or above the floor, and its binary answers --version", () => {
    const cli = JSON.parse(readFileSync(CLI_PACKAGE_JSON, "utf8")) as { devDependencies: Record<string, string> };
    const adapterPin = cli.devDependencies["@agentclientprotocol/claude-agent-acp"]!;
    // Resolved the way the adapter does (adapter -> SDK -> platform package), independently of resolveClaudeStack.
    const adapterJson = createRequire(CLI_PACKAGE_JSON).resolve("@agentclientprotocol/claude-agent-acp/package.json");
    // (The SDK's exports map hides its package.json, so go by the installed layout: dependencies are siblings.)
    const sdkJson = path.join(realpathSync(path.join(path.dirname(adapterJson), "../../@anthropic-ai/claude-agent-sdk")), "package.json");
    const platformJson = path.join(realpathSync(path.join(path.dirname(sdkJson), "../claude-agent-sdk-linux-x64")), "package.json");
    expect(versionOf(adapterJson), "packages/cli pins the adapter exactly").toBe(adapterPin);

    // And the production check agrees: it ran the real binary with --version and read a version at or above the floor.
    const found = resolveClaudeStack(BUNDLED_ADAPTER);
    expect(found).toHaveProperty("stack");
    if ("stack" in found) {
      expect(found.stack.installed).toEqual({ adapter: versionOf(adapterJson), sdk: versionOf(sdkJson), platformPackage: versionOf(platformJson), binary: expect.stringMatching(/^\d+\.\d+\.\d+/) });
      expect(found.stack.binary).toBe(realpathSync(path.join(path.dirname(platformJson), "claude")));
      expect(found.stack.newerThanMeasured).toBe(found.stack.installed.adapter !== "0.94.0" || found.stack.installed.binary !== "2.1.303");
    }
  });

  it.skipIf(!linuxX64)("the support object yields the profile of the installed versions for the bundled adapter and none for a PATH copy", () => {
    const support = claudeContainmentSupport();
    const bundled = support.resolve({ command: BUNDLED_ADAPTER, source: "bundled" });
    expect(bundled).toHaveProperty("launch");
    if ("launch" in bundled) {
      expect(bundled.launch.profile).toMatchObject({ id: "claude-p1", adapterVersion: expect.stringMatching(/^\d+\.\d+\.\d+/), binaryVersion: expect.stringMatching(/^\d+\.\d+\.\d+/), platformPackageVersion: expect.stringMatching(/^\d+\.\d+\.\d+/) });
      expect(bundled.launch.command).toBe(process.execPath);
      expect(path.isAbsolute(bundled.launch.args[0]!)).toBe(true);
      expect(bundled.launch.env.CLAUDE_CODE_EXECUTABLE).toMatch(/claude-agent-sdk-linux-x64.*\/claude$/);
    }
    expect(support.resolve({ command: BUNDLED_ADAPTER, source: "path" })).toEqual({ unavailable: "contained sessions run only the bundled adapter" });
    expect(support.resolve(undefined)).toHaveProperty("unavailable");
  });

  it("only a missing adapter carries a reason code; every other refusal has none", () => {
    const support = claudeContainmentSupport();
    expect(support.resolve(undefined)).toEqual({ unavailable: "the claude adapter is not installed", reason: "adapter_missing" });
    expect(support.resolve({ command: BUNDLED_ADAPTER, source: "path" })).not.toHaveProperty("reason");
    const missingFile = support.resolve({ command: "/nonexistent/bridge-test/claude-agent-acp", source: "bundled" });
    expect(missingFile).toHaveProperty("unavailable");
    expect(missingFile).not.toHaveProperty("reason");
  });
});

/** A binary that answers `--version` the way claude does (`2.1.303 (Claude Code)`). */
const claudeAnswering = (version: string): string => `#!/bin/sh\necho "${version} (Claude Code)"\n`;

/** A claude install tree under `root`, with the versions and binary content of the test's choosing. The binary defaults to the measured 2.1.303. */
async function fakeInstall(o: { adapter?: string; sdk?: string; platform?: string; binary?: string; binaryName?: string; bin?: "sh" | "link" }) {
  const nm = path.join(root, "install/node_modules");
  const write = async (rel: string, text: string, mode = 0o644) => {
    await mkdir(path.dirname(path.join(nm, rel)), { recursive: true });
    await writeFile(path.join(nm, rel), text);
    await chmod(path.join(nm, rel), mode);
  };
  await write("@agentclientprotocol/claude-agent-acp/package.json", JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: o.adapter ?? "0.94.0", bin: { "claude-agent-acp": "dist/index.js" } }));
  await write("@agentclientprotocol/claude-agent-acp/dist/index.js", "// adapter\n");
  await write("@anthropic-ai/claude-agent-sdk/package.json", JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: o.sdk ?? "0.3.303" }));
  await write("@anthropic-ai/claude-agent-sdk-linux-x64/package.json", JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk-linux-x64", version: o.platform ?? "0.3.303" }));
  await write(`@anthropic-ai/claude-agent-sdk-linux-x64/${o.binaryName ?? "claude"}`, o.binary ?? claudeAnswering("2.1.303"), 0o755);
  const bin = path.join(nm, ".bin/claude-agent-acp");
  await mkdir(path.dirname(bin), { recursive: true });
  if (o.bin === "link") await symlink("../@agentclientprotocol/claude-agent-acp/dist/index.js", bin);
  else await writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return bin;
}

describe.skipIf(!linuxX64)("the version check: measured and newer are accepted, older is refused", () => {
  const problemOf = (r: ReturnType<typeof resolveClaudeStack>): string => ("problem" in r ? r.problem : "<accepted>");

  it("the measured versions (adapter 0.94.0, CLI 2.1.303) are accepted and are not newer", async () => {
    const bin = await fakeInstall({});
    const found = resolveClaudeStack(bin);
    expect(found).toHaveProperty("stack");
    if ("stack" in found) {
      expect(found.stack.installed).toEqual({ adapter: "0.94.0", sdk: "0.3.303", platformPackage: "0.3.303", binary: "2.1.303" });
      expect(found.stack.newerThanMeasured).toBe(false);
    }
    expect(claudeContainmentSupport().resolve({ command: bin, source: "bundled" })).toHaveProperty("launch");
  });

  it("a newer adapter, a newer CLI, or both are accepted, reported newer, and the profile carries the versions the session runs on", async () => {
    for (const [what, o, adapter, binary] of [
      ["newer adapter patch", { adapter: "0.94.1" }, "0.94.1", "2.1.303"],
      ["newer adapter minor", { adapter: "0.95.0" }, "0.95.0", "2.1.303"],
      ["newer CLI patch", { binary: claudeAnswering("2.1.304") }, "0.94.0", "2.1.304"],
      ["newer CLI major (numeric, not string, order)", { binary: claudeAnswering("10.0.0") }, "0.94.0", "10.0.0"],
      ["both, with other SDK and platform package versions", { adapter: "1.0.0", sdk: "0.4.0", platform: "0.4.1", binary: claudeAnswering("2.2.0") }, "1.0.0", "2.2.0"],
      ["a prerelease of a newer CLI", { binary: claudeAnswering("2.1.304-beta.1") }, "0.94.0", "2.1.304-beta.1"],
    ] as const) {
      await rm(path.join(root, "install"), { recursive: true, force: true });
      const bin = await fakeInstall(o);
      const found = resolveClaudeStack(bin);
      expect(found, what).toHaveProperty("stack");
      if ("stack" in found) {
        expect(found.stack.newerThanMeasured, what).toBe(true);
        expect(found.stack.installed.adapter, what).toBe(adapter);
        expect(found.stack.installed.binary, what).toBe(binary);
      }
      const resolved = claudeContainmentSupport().resolve({ command: bin, source: "bundled" });
      expect(resolved, what).toHaveProperty("launch");
      if ("launch" in resolved) expect(resolved.launch.profile, what).toMatchObject({ adapterVersion: adapter, binaryVersion: binary });
    }
  });

  it("an older adapter or an older CLI is refused with a message that names both versions", async () => {
    for (const [what, o, expected] of [
      ["adapter patch below", { adapter: "0.93.9" }, "claude adapter 0.93.9 is older than the lowest supported 0.94.0"],
      ["adapter major below", { adapter: "0.9.0" }, "claude adapter 0.9.0 is older than the lowest supported 0.94.0"],
      ["adapter prerelease of the floor", { adapter: "0.94.0-rc.1" }, "claude adapter 0.94.0-rc.1 is older than the lowest supported 0.94.0"],
      ["CLI patch below", { binary: claudeAnswering("2.1.302") }, "claude CLI 2.1.302 is older than the lowest supported 2.1.303"],
      ["CLI minor below", { binary: claudeAnswering("2.0.999") }, "claude CLI 2.0.999 is older than the lowest supported 2.1.303"],
      ["CLI major below", { binary: claudeAnswering("1.99.99") }, "claude CLI 1.99.99 is older than the lowest supported 2.1.303"],
      ["CLI prerelease of the floor", { binary: claudeAnswering("2.1.303-rc.1") }, "claude CLI 2.1.303-rc.1 is older than the lowest supported 2.1.303"],
    ] as const) {
      await rm(path.join(root, "install"), { recursive: true, force: true });
      const bin = await fakeInstall(o);
      expect(problemOf(resolveClaudeStack(bin)), what).toBe(expected);
      expect(claudeContainmentSupport().resolve({ command: bin, source: "bundled" }), what).toEqual({ unavailable: expected });
    }
  });

  it("a binary whose --version cannot be read is refused: junk, a non-zero exit, no output", async () => {
    for (const [what, binary, expected] of [
      ["another program's output", "#!/bin/sh\necho some other build\n", "claude --version did not print a version number"],
      ["no output", "#!/bin/sh\nexit 0\n", "claude --version did not print a version number"],
      ["a non-zero exit, even with a version printed", '#!/bin/sh\necho "9.9.9 (Claude Code)"\nexit 3\n', "cannot read the claude CLI version"],
      ["a version only after a banner", '#!/bin/sh\necho "banner 2.1.303"\n', "claude --version did not print a version number"],
    ] as const) {
      await rm(path.join(root, "install"), { recursive: true, force: true });
      const bin = await fakeInstall({ binary });
      expect(problemOf(resolveClaudeStack(bin)), what).toContain(expected);
    }
  });

  it("a version string that is not a version, in the adapter's package.json, is refused", async () => {
    const bin = await fakeInstall({ adapter: "latest" });
    expect(problemOf(resolveClaudeStack(bin))).toContain("is not a version number");
  });

  it("runs the binary with an empty environment: the runner's secrets and config dirs never reach it", async () => {
    process.env.BRIDGE_TEST_SECRET = "s3cret";
    process.env.CLAUDE_CONFIG_DIR = "/should/not/leak";
    try {
      const bin = await fakeInstall({ binary: '#!/bin/sh\nif [ -n "$BRIDGE_TEST_SECRET$CLAUDE_CONFIG_DIR$HOME" ]; then echo "leak"; else echo "2.1.303 (Claude Code)"; fi\n' });
      expect(resolveClaudeStack(bin)).toHaveProperty("stack");
    } finally {
      delete process.env.BRIDGE_TEST_SECRET;
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it("a stack above the floor is logged once per versions pair; the measured one and a refusal are not", async () => {
    const lines: string[] = [];
    const support = claudeContainmentSupport({ log: (line) => lines.push(line) });
    const adapter = (bin: string) => ({ command: bin, source: "bundled" as const });

    const measured = await fakeInstall({});
    expect(support.resolve(adapter(measured))).toHaveProperty("launch");
    expect(lines).toEqual([]);

    await rm(path.join(root, "install"), { recursive: true, force: true });
    const newer = await fakeInstall({ adapter: "0.95.0", binary: claudeAnswering("2.2.0") });
    expect(support.resolve(adapter(newer))).toHaveProperty("launch");
    expect(support.resolve(adapter(newer))).toHaveProperty("launch");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("adapter 0.95.0 / CLI 2.2.0");
    expect(lines[0]).toContain("newer than the measured 0.94.0 / 2.1.303");

    await rm(path.join(root, "install"), { recursive: true, force: true });
    const older = await fakeInstall({ binary: claudeAnswering("2.1.1") });
    expect(support.resolve(adapter(older))).toHaveProperty("unavailable");
    expect(lines).toHaveLength(1);
  });

  it("finds the adapter from a pnpm-style bin script and from an npm-style bin link", async () => {
    for (const style of ["sh", "link"] as const) {
      await rm(path.join(root, "install"), { recursive: true, force: true });
      const bin = await fakeInstall({ bin: style });
      expect(resolveClaudeStack(bin), style).toHaveProperty("stack");
      await rm(path.join(root, "install"), { recursive: true, force: true });
      expect(problemOf(resolveClaudeStack(await fakeInstall({ bin: style, binary: claudeAnswering("2.1.302") }))), style).toContain("older than the lowest supported");
    }
  });

  it("a command that is no adapter at all is refused", () => {
    expect(resolveClaudeStack(process.execPath)).toHaveProperty("problem");
    expect(resolveClaudeStack(path.join(root, "missing"))).toHaveProperty("problem");
  });

  it("refuses an executable that is relative, a script (.mjs, .js, .ts), a directory or missing", async () => {
    await writeFile(path.join(root, "claude.mjs"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(path.join(root, "claude.ts"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(path.join(root, "claude.sh-not-exec"), "x", { mode: 0o644 });
    await writeFile(path.join(root, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    expect(claudeExecutableProblem(path.join(root, "claude"))).toBeUndefined();
    for (const bad of ["claude", "./claude", "../claude", path.join(root, "claude.mjs"), path.join(root, "claude.ts"), path.join(root, "claude.sh-not-exec"), root, path.join(root, "nope")]) {
      expect(claudeExecutableProblem(bad), bad).toEqual(expect.any(String));
    }
    // The same rule guards the binary the version check resolved (a test seam stands in for it here).
    const bundled = { command: BUNDLED_ADAPTER, source: "bundled" as const };
    for (const bad of [path.join(root, "claude.mjs"), "relative/claude"]) {
      const resolved = claudeContainmentSupportWithSeams({ binaryPath: bad }).resolve(bundled);
      expect(resolved, bad).toHaveProperty("unavailable");
    }
    expect(claudeContainmentSupportWithSeams({ binaryPath: path.join(root, "claude") }).resolve(bundled)).toHaveProperty("launch");
  });
});

describe.skipIf(!linuxX64)("the version decision reflects the files on disk at every contained spawn", () => {
  const GOOD = claudeAnswering("2.1.303");
  const OLDER = claudeAnswering("2.1.302"); // same length as GOOD
  const binaryOf = (bin: string) => path.join(path.dirname(bin), "../@anthropic-ai/claude-agent-sdk-linux-x64/claude");
  const adapterJsonOf = (bin: string) => path.join(path.dirname(bin), "../@agentclientprotocol/claude-agent-acp/package.json");
  const adapterJson = (version: string) => JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version, bin: { "claude-agent-acp": "dist/index.js" } });

  it("a refusal is not remembered: the same support object launches once the binary is at the floor", async () => {
    const bin = await fakeInstall({ binary: OLDER });
    const support = claudeContainmentSupport();
    const adapter = { command: bin, source: "bundled" as const };
    expect(support.resolve(adapter)).toHaveProperty("unavailable");
    await writeFile(binaryOf(bin), GOOD);
    expect(support.resolve(adapter)).toHaveProperty("launch");
  });

  it("an acceptance is not remembered: a binary rewritten after the first spawn is refused at the next one", async () => {
    const bin = await fakeInstall({ binary: GOOD });
    const support = claudeContainmentSupport();
    const adapter = { command: bin, source: "bundled" as const };
    expect(support.resolve(adapter)).toHaveProperty("launch");
    await writeFile(binaryOf(bin), OLDER);
    expect(support.resolve(adapter)).toHaveProperty("unavailable");
    await writeFile(binaryOf(bin), GOOD);
    expect(support.resolve(adapter)).toHaveProperty("launch");
  });

  it("the --version answer is reused while the file is unchanged, and asked again once it changes", async () => {
    const counter = path.join(root, "runs");
    const counting = (version: string) => `#!/bin/sh\necho x >> "${counter}"\necho "${version} (Claude Code)"\n`;
    const bin = await fakeInstall({ binary: counting("2.1.303") });
    const support = claudeContainmentSupport();
    const adapter = { command: bin, source: "bundled" as const };
    const runs = async () => (await readFile(counter, "utf8")).split("\n").filter(Boolean).length;
    for (let i = 0; i < 3; i++) expect(support.resolve(adapter)).toHaveProperty("launch");
    expect(await runs()).toBe(1);
    await writeFile(binaryOf(bin), counting("2.1.304")); // another size
    expect(support.resolve(adapter)).toHaveProperty("launch");
    expect(await runs()).toBe(2);
  });

  it("a replacement file of the same size and mtime, but another inode, is asked again and refused", async () => {
    const bin = await fakeInstall({ binary: GOOD });
    const support = claudeContainmentSupport();
    const adapter = { command: bin, source: "bundled" as const };
    const target = binaryOf(bin);
    await utimes(target, 1_700_000_000, 1_700_000_000); // whole seconds: the copy below can match the mtime exactly
    expect(support.resolve(adapter)).toHaveProperty("launch");
    const before = await stat(target);
    expect(OLDER.length).toBe(GOOD.length);
    await writeFile(`${target}.new`, OLDER, { mode: 0o755 });
    await utimes(`${target}.new`, before.atime, before.mtime);
    await rename(`${target}.new`, target);
    const after = await stat(target);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    expect(after.ino).not.toBe(before.ino);
    expect(support.resolve(adapter)).toHaveProperty("unavailable");
  });

  it("an adapter package.json that changed version after the first spawn changes the decision, both ways", async () => {
    const bin = await fakeInstall({});
    const support = claudeContainmentSupport();
    const adapter = { command: bin, source: "bundled" as const };
    expect(support.resolve(adapter)).toHaveProperty("launch");
    await writeFile(adapterJsonOf(bin), adapterJson("0.93.0"));
    expect(support.resolve(adapter)).toHaveProperty("unavailable");
    await writeFile(adapterJsonOf(bin), adapterJson("0.95.0"));
    expect(support.resolve(adapter)).toHaveProperty("launch");
  });
});

describe.skipIf(!linuxX64)("no production entry point can replace the checked binary", () => {
  it("the package barrel exports no seam, and the entry points it does export ignore one handed in anyway", async () => {
    expect(Object.keys(barrel).filter((name) => /seam/i.test(name))).toEqual([]);
    const bin = await fakeInstall({ binary: claudeAnswering("2.1.100") }); // a binary below the floor
    const stand = path.join(root, "stand-in");
    await writeFile(stand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const seams = { binaryPath: stand, nodePath: stand };
    // The barrel's functions take no seam argument; hand one in anyway, past the types.
    const supportOf = barrel.claudeContainmentSupport as unknown as (seams: unknown) => ReturnType<typeof barrel.claudeContainmentSupport>;
    const resolveOf = barrel.resolveClaudeStack as unknown as (command: string, seams: unknown) => ReturnType<typeof barrel.resolveClaudeStack>;
    const bundled = { command: bin, source: "bundled" as const };
    // Reachable only in-package: the seam works there, which is what the in-package tests rely on.
    expect(claudeContainmentSupportWithSeams({ binaryPath: stand }).resolve(bundled)).toHaveProperty("launch");
    // Through the barrel, and through the CLI's construction, it is not.
    expect(supportOf(seams).resolve(bundled)).toHaveProperty("unavailable");
    expect(resolveOf(bin, seams)).toHaveProperty("problem");
    const claude = createDefaultAgentAdapters({
      environment: { env: { PATH: path.dirname(process.execPath) }, homedir: root, tmpBase: root },
      commands: { claude: bundled },
      claudeContainmentSeams: seams,
    } as never).find((a) => a.id === "claude")!;
    expect(claude.containment?.()).toBeUndefined();
  });
});

describe("the session options", () => {
  it("are the contained profile exactly, plus the model; fresh arrays every time", () => {
    const options = claudeSessionOptions("haiku");
    expect(options).toEqual({ ...CLAUDE_CONTAINMENT_OPTIONS, model: "haiku" });
    expect(options.allowDangerouslySkipPermissions).toBe(false);
    expect(options.extraArgs).toEqual({ restricted: null, "disable-slash-commands": null });
    expect(options.disallowedTools).toEqual([...CLAUDE_BUILTIN_TOOL_NAMES]);
    expect(claudeSessionOptions()).not.toHaveProperty("model");
    options.disallowedTools.push("x");
    options.extraArgs.restricted = null;
    expect(claudeSessionOptions().disallowedTools).toHaveLength(CLAUDE_BUILTIN_TOOL_NAMES.length);
    expect(CLAUDE_CONTAINMENT_OPTIONS.disallowedTools).toHaveLength(CLAUDE_BUILTIN_TOOL_NAMES.length);
  });
});

describe("toolOutsideSet", () => {
  const allow = new Set(["mcp__stub__read"]);
  it("mcp__stub__echo with allow [mcp__stub__read] is outside; an exact member is not", () => {
    expect(claudeToolOutsideSet({ toolName: "mcp__stub__echo" }, allow)).toBe(true);
    expect(claudeToolOutsideSet({ toolName: "mcp__stub__read" }, allow)).toBe(false);
  });
  it("is a full-name match, not a server-prefix check", () => {
    expect(claudeToolOutsideSet({ toolName: "mcp__stub__read2" }, allow)).toBe(true);
    expect(claudeToolOutsideSet({ toolName: "mcp__stub" }, allow)).toBe(true);
    expect(claudeToolOutsideSet({ toolName: "mcp__stub__read " }, allow)).toBe(true);
    expect(claudeToolOutsideSet({ toolName: "Read" }, allow)).toBe(true);
  });
  it("a frame with no tool name is outside, whatever its kind", () => {
    expect(claudeToolOutsideSet({}, allow)).toBe(true);
    expect(claudeToolOutsideSet({ kind: "read" }, allow)).toBe(true);
    expect(claudeToolOutsideSet({ kind: "other" }, allow)).toBe(true);
    expect(claudeToolOutsideSet({ toolName: "" }, allow)).toBe(true);
  });
  it("an empty allow set admits nothing", () => {
    expect(claudeToolOutsideSet({ toolName: "mcp__stub__read" }, new Set())).toBe(true);
  });
});

describe("commandsOutsideSet", () => {
  const cmds = (...names: string[]) => ({ availableCommands: names.map((name) => ({ name })) });
  it("the two adapter-synthesized names are inside; anything else is listed in order", () => {
    expect(claudeCommandsOutsideSet(cmds("mcp", "remote-control"))).toEqual([]);
    expect(claudeCommandsOutsideSet(cmds("mcp", "remote-control", "init"))).toEqual(["init"]);
    expect(claudeCommandsOutsideSet(cmds("mcp", "remote-control", "s00-user-skill"))).toEqual(["s00-user-skill"]);
    expect(claudeCommandsOutsideSet(cmds("mcp", "remote-control", "mcp:foo"))).toEqual(["mcp:foo"]);
    expect(claudeCommandsOutsideSet(cmds("z", "mcp", "a", "remote-control", "m"))).toEqual(["z", "a", "m"]);
  });
  it("an empty list is []", () => {
    expect(claudeCommandsOutsideSet(cmds())).toEqual([]);
  });
  it("a frame whose list cannot be read is outside the set (fail closed), not []", () => {
    const unreadable = [{}, { availableCommands: null }, { availableCommands: "mcp" }, { availableCommands: { name: "mcp" } }, { availableCommands: 3 }, null, undefined, "x"];
    for (const frame of unreadable) {
      expect(claudeCommandsOutsideSet(frame as never), JSON.stringify(frame)).not.toEqual([]);
    }
    // Entries that cannot be read as a name are listed too, never skipped.
    for (const entry of [null, 7, {}, { name: 1 }, { name: null }, "mcp", ["mcp"]]) {
      expect(claudeCommandsOutsideSet({ availableCommands: [{ name: "mcp" }, entry] } as never), JSON.stringify(entry)).toHaveLength(1);
    }
  });
  it("a case-different or padded name is outside (exact match)", () => {
    expect(claudeCommandsOutsideSet(cmds("MCP", "mcp ", "Remote-Control"))).toEqual(["MCP", "mcp ", "Remote-Control"]);
  });
});

describe("checkNewSession", () => {
  const measured = () => ({
    sessionId: "ba171248-15b3-4106-a53c-b21a5e84d528",
    modes: { currentModeId: "default", availableModes: ["default", "acceptEdits", "plan", "auto"].map((id) => ({ id, name: id })) },
    configOptions: ["mode", "model", "effort", "fast"].map((id) => ({ id, currentValue: "default" })),
  });
  const refused = (result: unknown) => {
    try {
      checkClaudeNewSession(result);
    } catch (error) {
      expect(error).toBeInstanceOf(ContainmentRefused);
      expect((error as ContainmentRefused).code).toBe(-32016);
      return true;
    }
    return false;
  };

  it("passes the measured result", () => {
    expect(refused(measured())).toBe(false);
    expect(() => claudeProfileOf(CLAUDE_MEASURED_STACKS[0]!).checkNewSession(measured())).not.toThrow();
  });
  it("refuses acceptEdits as the current mode, and any other current mode", () => {
    for (const mode of ["acceptEdits", "plan", "auto", "bypassPermissions", undefined, 3]) {
      const r = measured();
      (r.modes as { currentModeId: unknown }).currentModeId = mode;
      expect(refused(r), String(mode)).toBe(true);
    }
  });
  it("refuses a bypassPermissions entry among the offered modes", () => {
    const r = measured();
    r.modes.availableModes.push({ id: "bypassPermissions", name: "Bypass" });
    expect(refused(r)).toBe(true);
  });
  it("refuses an `agent` config option, and any id outside {mode, model, effort, fast}", () => {
    for (const id of ["agent", "thinking"]) {
      const r = measured();
      r.configOptions.push({ id, currentValue: "x" });
      expect(refused(r), id).toBe(true);
    }
  });
  it("fails closed on a result that is not the measured shape", () => {
    for (const bad of [undefined, null, 3, "x", [], {}, { modes: {} }, { modes: { currentModeId: "default" } }, { modes: { currentModeId: "default", availableModes: [] } }, { modes: { currentModeId: "default", availableModes: ["default"] }, configOptions: [] }]) {
      expect(refused(bad), JSON.stringify(bad)).toBe(true);
    }
    const r = measured();
    (r.configOptions as unknown[]).push(null);
    expect(refused(r)).toBe(true);
  });
});
