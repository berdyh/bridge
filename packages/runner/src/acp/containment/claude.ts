/**
 * The claude containment profile: no built-in tools, no user settings, only the declared MCP servers, and a secret
 * that travels as a file.
 *
 * Wording: measured on adapter 0.94.0 / CLI 2.1.303, accepted from those versions up, argv asserted at CI
 * (`claude-argv.test.ts`), detected at runtime. Not "proven". The stack is
 * identified by versions against a lowest supported one (the adapter's `package.json` version and the binary's
 * `claude --version`), not by the sha256 of one build, so a newer build is accepted (and logged) and an older
 * one is refused. The argv assertion, the contained env rule and the runtime frame checks stay the controls.
 *
 * What this module does: it accepts a stack at or above the lowest measured one and refuses an older one; it builds
 * the `_meta.claudeCode.options` of the session (`CLAUDE_CONTAINMENT_OPTIONS`, plus the model); it decides
 * whether a `session/new` result, an `available_commands_update` and a tool call stay inside the contained
 * set; and it names the binary the adapter must run (`CLAUDE_CODE_EXECUTABLE`, forced by the runner).
 *
 * RESIDUAL RISK, accepted: the staged login is visible to a
 * contained MCP server. `CLAUDE_CONFIG_DIR` is in the server's env under this profile too (claude reads the
 * subscription login only from `$CLAUDE_CONFIG_DIR/.credentials.json`), and the server runs as the same uid as
 * the agent, so it can open that file. A same-uid process also reads `/proc/<ppid>/environ` and the sandbox
 * paths, and an MCP `env` entry could not hide anything (the server inherits claude's env, cannot unset a
 * variable, and the entry lands in argv), so the profile adds none and no new login delivery. This is not a new
 * exposure: plugin code can already read bridge's login at rest (0600, same uid). The mitigations that exist
 * are the per-run copy (it holds only the `claudeAiOauth` block, never the file's other tokens), its removal at
 * exit, and that `~/.claude` is never involved. None of these closes the risk. A stronger boundary needs another
 * uid or a namespace. Nothing here, and no consent text, may say the
 * login is hidden from a declared server. The test "known limit: a same-uid child of the agent env can read the
 * staged login" (`../adapters.test.ts`) pins the fact.
 *
 * How the floor moves: it rises only when a newer stack is measured and an older one is dropped (a measurement run
 * on a real session; its row goes into `CLAUDE_MEASURED_STACKS`; see "The claude version floor" in
 * docs/guides/operate-the-runner.md). A bump of the
 * bundled adapter or SDK needs no re-measure to run: the pin test of `packages/cli`'s adapter only checks it is at or
 * above the floor. A version above the floor has not been measured; an OS sandbox is the planned strengthening.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import path from "node:path";

import {
  CLAUDE_BUILTIN_TOOL_NAMES,
  CLAUDE_CONTAINMENT_OPTIONS,
  ContainmentRefused,
  MEASURED_CLAUDE_STACK,
  type ClaudeContainmentOptions,
  type ContainmentProfile,
} from "../contracts.js";

import type { AcpContainmentSupport, ContainmentAdapterCommand } from "./profile.js";

export const CLAUDE_ADAPTER_PACKAGE = "@agentclientprotocol/claude-agent-acp";
export const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_PLATFORM_PACKAGE = "@anthropic-ai/claude-agent-sdk-linux-x64";

/** One stack that was measured. The adapter depends on the SDK, the SDK on the platform package, the platform package ships the binary. */
export interface ClaudeMeasuredStack {
  adapter: string;
  sdk: string;
  platformPackage: string;
  /** `claude --version` of the binary (2.1.303 (Claude Code)). */
  binary: string;
  /** sha256 of the binary file that was measured. Evidence of the measurement (the canary report and `doctor --containment` print it); no longer checked at a spawn. */
  binarySha256: string;
}

/** The measured stacks, linux x64 (glibc). Add a row only after the canary was rerun on it. */
export const CLAUDE_MEASURED_STACKS: readonly ClaudeMeasuredStack[] = [
  {
    adapter: MEASURED_CLAUDE_STACK.adapter,
    sdk: MEASURED_CLAUDE_STACK.sdk,
    platformPackage: MEASURED_CLAUDE_STACK.platformPackage,
    binary: MEASURED_CLAUDE_STACK.binary,
    binarySha256: "375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450",
  },
];

/**
 * The lowest supported versions, the floor of the look-up model: the adapter's package version
 * and the binary's `claude --version`, taken from the lowest row of `CLAUDE_MEASURED_STACKS`. A stack
 * at or above both is accepted; below either is refused. The SDK and platform package versions are recorded, not floored.
 */
export const CLAUDE_MIN_SUPPORTED = {
  adapter: MEASURED_CLAUDE_STACK.adapter,
  binary: MEASURED_CLAUDE_STACK.binary,
} as const;

/** The names an `available_commands_update` of a contained session may hold: adapter-synthesized, the only two left under `--disable-slash-commands`. */
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set(["mcp", "remote-control"]);
const ALLOWED_MODES: ReadonlySet<string> = new Set(["default", "acceptEdits", "plan", "auto"]);
const ALLOWED_CONFIG_OPTIONS: ReadonlySet<string> = new Set(["mode", "model", "effort", "fast"]);

/** Fresh `_meta.claudeCode.options` for a session: the contained profile plus `model` when one is chosen. */
export function claudeSessionOptions(model?: string): ClaudeContainmentOptions {
  return {
    ...CLAUDE_CONTAINMENT_OPTIONS,
    tools: [],
    settingSources: [],
    allowedTools: [],
    disallowedTools: [...CLAUDE_BUILTIN_TOOL_NAMES],
    extraArgs: { ...CLAUDE_CONTAINMENT_OPTIONS.extraArgs },
    ...(model !== undefined ? { model } : {}),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Refuses a `session/new` result that is not the measured contained one (see `ContainmentProfile.checkNewSession`).
 * Fail closed: a result without the mode list or the option list is refused too.
 */
export function checkClaudeNewSession(result: unknown): void {
  const refuse = (detail: string): never => {
    throw new ContainmentRefused(detail);
  };
  if (!isObject(result)) return refuse("session/new result is not an object");
  const modes = result.modes;
  if (!isObject(modes)) return refuse("session/new result has no modes");
  if (modes.currentModeId !== "default") return refuse(`the session starts in mode ${JSON.stringify(modes.currentModeId)}, not default`);
  if (!Array.isArray(modes.availableModes)) return refuse("session/new result lists no modes");
  for (const mode of modes.availableModes) {
    const id = isObject(mode) ? mode.id : undefined;
    if (typeof id !== "string" || !ALLOWED_MODES.has(id)) return refuse(`the session offers mode ${JSON.stringify(id)}`);
  }
  if (!Array.isArray(result.configOptions)) return refuse("session/new result lists no config options");
  for (const option of result.configOptions) {
    const id = isObject(option) ? option.id : undefined;
    if (typeof id !== "string" || !ALLOWED_CONFIG_OPTIONS.has(id)) return refuse(`the session offers config option ${JSON.stringify(id)}`);
  }
}

/** What `claudeCommandsOutsideSet` reports for a frame whose command list cannot be read (not an array, or missing). */
export const CLAUDE_UNREADABLE_COMMANDS = "<unreadable available_commands>";

/**
 * The names in an `available_commands_update` outside {mcp, remote-control}, in listed order. Fail closed: a frame
 * whose list is missing or not an array cannot be shown to be inside the set, so it reports
 * `CLAUDE_UNREADABLE_COMMANDS`; an entry without a string name is listed as `String(name)`.
 */
export function claudeCommandsOutsideSet(update: { availableCommands?: ReadonlyArray<{ name: string }> }): string[] {
  const list = update?.availableCommands;
  if (!Array.isArray(list)) return [CLAUDE_UNREADABLE_COMMANDS];
  const outside: string[] = [];
  for (const entry of list) {
    const name: unknown = isObject(entry) ? entry.name : undefined;
    if (typeof name !== "string" || !ALLOWED_COMMANDS.has(name)) outside.push(typeof name === "string" ? name : String(name));
  }
  return outside;
}

/**
 * True unless `tool.toolName` is a member of `allow` (a full-name match: an attached server's tool that is not
 * listed is outside). A frame with no tool name is outside whatever its kind, the strictest reading of the
 * contract: every claude tool call seen in the measurement carried `_meta.claudeCode.toolName` (24 of 24), so a frame
 * without one, a built-in `kind` included, is not something to wave through.
 */
export function claudeToolOutsideSet(tool: { toolName?: string; kind?: string }, allow: ReadonlySet<string>): boolean {
  const name = tool?.toolName;
  if (typeof name !== "string" || name === "") return true;
  return !allow.has(name);
}

/** The versions a stack runs on (a measured row, or what the version check read from the install). */
export type ClaudeStackVersions = Pick<ClaudeMeasuredStack, "adapter" | "platformPackage" | "binary">;

/** Builds the profile object for a stack that passed the version check; its versions are the ones the session runs on. */
export function claudeProfileOf(stack: ClaudeStackVersions): ContainmentProfile {
  return {
    id: "claude-p1",
    adapterVersion: stack.adapter,
    binaryVersion: stack.binary,
    platformPackageVersion: stack.platformPackage,
    checkNewSession: checkClaudeNewSession,
    commandsOutsideSet: claudeCommandsOutsideSet,
    toolOutsideSet: claudeToolOutsideSet,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The version check: which adapter, SDK, platform package and binary this install really has, against the floor.
// ---------------------------------------------------------------------------------------------------------------

/** A path the SDK would run as `node <path>` instead of exec'ing it. */
const SCRIPT_EXTENSION = /\.(?:[cm]?js|ts)$/i;

/**
 * Refuses an executable the contained spawn may not force into `CLAUDE_CODE_EXECUTABLE`: not an absolute path,
 * not a regular executable file, or a script (`.js`, `.mjs`, `.cjs`, `.ts`: the SDK runs those through `node`).
 * Returns the problem, or undefined.
 */
export function claudeExecutableProblem(file: string): string | undefined {
  if (!path.isAbsolute(file)) return "the claude executable is not an absolute path";
  if (SCRIPT_EXTENSION.test(file)) return "the claude executable is a script path";
  try {
    if (!statSync(file).isFile()) return "the claude executable is not a regular file";
    accessSync(file, constants.X_OK);
  } catch {
    return "the claude executable is missing or not executable";
  }
  return undefined;
}

/** What makes a file "the same file" for the version cache: where it is, which inode, how big, when last written. */
const identityOf = (file: string, st: Stats): string => `${file}\0${st.dev}\0${st.ino}\0${st.size}\0${st.mtimeMs}`;

/** A parsed `major.minor.patch[-prerelease]`. */
interface ParsedVersion {
  parts: [number, number, number];
  pre: string | undefined;
  text: string;
}

/** The version at the start of `text` (`2.1.303 (Claude Code)`, `0.94.0`), or undefined when it does not start with one. */
function parseVersion(text: string): ParsedVersion | undefined {
  const m = /^\s*v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?=\s|$)/.exec(text);
  if (m === null) return undefined;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4], text: `${m[1]}.${m[2]}.${m[3]}${m[4] !== undefined ? `-${m[4]}` : ""}` };
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. A prerelease is older than its release. */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i]! - b.parts[i]!;
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** The longest a `--version` run may take before the binary is treated as not answering. */
const VERSION_TIMEOUT_MS = 15_000;

const versionCache = new Map<string, { identity: string; version: string }>();
/**
 * `claude --version` of `file`, as the text the binary prints. Runs the binary with an empty environment (no login, no
 * config dir, no runner secret) and no stdin, bounded in time and output. The answer for an unchanged file (same path,
 * device, inode, size and mtime) is reused; any change of that identity, a replacement file included, runs it again,
 * so this is decided at every contained spawn. A file that changed while it ran is not cached.
 */
function binaryVersionOf(file: string): string {
  const before = identityOf(file, statSync(file));
  const known = versionCache.get(file);
  if (known !== undefined && known.identity === before) return known.version;
  const out = execFileSync(file, ["--version"], {
    env: { PATH: "/usr/bin:/bin" },
    cwd: path.dirname(file),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: VERSION_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 1 << 16,
    encoding: "utf8",
  });
  if (identityOf(file, statSync(file)) === before) versionCache.set(file, { identity: before, version: out });
  return out;
}

function readPackageJson(dir: string): { name?: unknown; version?: unknown; bin?: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Node's lookup of `name` from `fromDir` (every `node_modules` up the tree), on real paths. */
function findPackageDir(name: string, fromDir: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", ...name.split("/"));
      if (readPackageJson(candidate)?.name === name) return realpathSync(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The adapter package that `command` (a `.bin` link or script, or the entry itself) belongs to. */
function adapterPackageOf(command: string): string | undefined {
  const real = realpathSync(command);
  // An npm bin link, or the entry itself: the package is an ancestor of the real path.
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    if (readPackageJson(dir)?.name === CLAUDE_ADAPTER_PACKAGE) return dir;
    if (path.dirname(dir) === dir) break;
  }
  // A pnpm bin script: `<root>/node_modules/.bin/<bin>` next to `<root>/node_modules/<package>`.
  const beside = path.join(path.dirname(path.dirname(command)), ...CLAUDE_ADAPTER_PACKAGE.split("/"));
  if (readPackageJson(beside)?.name === CLAUDE_ADAPTER_PACKAGE) return realpathSync(beside);
  return undefined;
}

/**
 * Test-only inputs of the version check. In-package only: `index.ts` does not re-export this type nor the functions that
 * take it (`resolveClaudeStackWithSeams`, `claudeContainmentSupportWithSeams`), and `createDefaultAgentAdapters`
 * has no option for it, so no production path (the package barrel, the CLI's construction) can replace the
 * binary or the runner's Node.
 */
export interface ClaudeContainmentSeams {
  /** The runner's Node. Default: `process.execPath`. */
  nodePath?: string;
  /**
   * TEST ONLY. Run this executable (the argv recorder) in place of the SDK's platform binary. It still has to
   * be an absolute regular executable that is not a script, but it is not asked for its version: it reports the
   * floor's.
   */
  binaryPath?: string;
}

/** A stack that passed the version check, with the absolute paths to run. */
export interface ClaudeStack {
  /** The versions the stack runs on: the adapter's and the SDK's `package.json`, the platform package's, and `claude --version`. */
  installed: ClaudeStackVersions & { sdk: string };
  /** The adapter's entry (`dist/index.js` of the adapter package), realpath. */
  adapterEntry: string;
  /** The binary for `CLAUDE_CODE_EXECUTABLE`, realpath. */
  binary: string;
  /** True when the adapter or the binary is above the floor: accepted, but not a version that was measured. */
  newerThanMeasured: boolean;
}

/**
 * Resolves the adapter at `command` the way the adapter resolves its binary (`acp-agent.js` `claudeCliPath`):
 * adapter package, then the SDK it depends on, then the platform package that SDK depends on, each from the real
 * path of the one before. Returns the stack when the adapter's version and the binary's `--version` are at or above
 * `CLAUDE_MIN_SUPPORTED`, or why not. Reads package files and runs `<binary> --version` (once per file identity).
 */
export function resolveClaudeStack(command: string): { stack: ClaudeStack } | { problem: string } {
  return resolveClaudeStackWithSeams(command, {});
}

/** `resolveClaudeStack` with the test seams. In-package only (not in the barrel). */
export function resolveClaudeStackWithSeams(command: string, seams: ClaudeContainmentSeams): { stack: ClaudeStack } | { problem: string } {
  const problem = (text: string) => ({ problem: text });
  if (process.platform !== "linux" || process.arch !== "x64") return problem(`only linux x64 was measured, not ${process.platform} ${process.arch}`);
  try {
    const adapterDir = adapterPackageOf(command);
    if (adapterDir === undefined) return problem("the claude adapter's package was not found next to its command");
    const adapterJson = readPackageJson(adapterDir);
    const bin = isObject(adapterJson?.bin) ? adapterJson.bin["claude-agent-acp"] : undefined;
    if (typeof bin !== "string") return problem("the adapter's package.json names no claude-agent-acp entry");
    const adapterEntry = realpathSync(path.join(adapterDir, bin));
    if (!adapterEntry.startsWith(adapterDir + path.sep)) return problem("the adapter's entry lies outside its package");

    const sdkDir = findPackageDir(CLAUDE_SDK_PACKAGE, adapterDir);
    if (sdkDir === undefined) return problem("the claude agent SDK was not found from the adapter");
    const platformDir = findPackageDir(CLAUDE_PLATFORM_PACKAGE, sdkDir);
    if (platformDir === undefined) return problem("the SDK's platform package was not found");

    const adapter = readPackageJson(adapterDir)?.version;
    const sdk = readPackageJson(sdkDir)?.version;
    const platform = readPackageJson(platformDir)?.version;
    if (typeof adapter !== "string" || typeof sdk !== "string" || typeof platform !== "string") return problem("a package.json on the way has no version");
    const adapterVersion = parseVersion(adapter);
    if (adapterVersion === undefined) return problem(`the claude adapter's version ${JSON.stringify(adapter.slice(0, 40))} is not a version number`);
    const adapterFloor = parseVersion(CLAUDE_MIN_SUPPORTED.adapter)!;
    if (compareVersions(adapterVersion, adapterFloor) < 0) return problem(`claude adapter ${adapterVersion.text} is older than the lowest supported ${CLAUDE_MIN_SUPPORTED.adapter}`);

    const binary = realpathSync(seams.binaryPath ?? path.join(platformDir, "claude"));
    const bad = claudeExecutableProblem(binary);
    if (bad !== undefined) return problem(bad);
    let binaryText: string = CLAUDE_MIN_SUPPORTED.binary;
    if (seams.binaryPath === undefined) {
      try {
        binaryText = binaryVersionOf(binary);
      } catch {
        return problem("cannot read the claude CLI version (claude --version failed, timed out or printed too much)");
      }
    }
    const binaryVersion = parseVersion(binaryText);
    if (binaryVersion === undefined) return problem(`claude --version did not print a version number (${JSON.stringify(binaryText.trim().slice(0, 40))})`);
    const binaryFloor = parseVersion(CLAUDE_MIN_SUPPORTED.binary)!;
    if (compareVersions(binaryVersion, binaryFloor) < 0) return problem(`claude CLI ${binaryVersion.text} is older than the lowest supported ${CLAUDE_MIN_SUPPORTED.binary}`);

    const newerThanMeasured = compareVersions(adapterVersion, adapterFloor) > 0 || compareVersions(binaryVersion, binaryFloor) > 0;
    return { stack: { installed: { adapter: adapterVersion.text, sdk, platformPackage: platform, binary: binaryVersion.text }, adapterEntry, binary, newerThanMeasured } };
  } catch (error) {
    return problem(`cannot resolve the claude stack: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
}

/** Options of `claudeContainmentSupport`. */
export interface ClaudeSupportOptions {
  /** Receives one line each time a stack above the lowest measured one is accepted (once per versions pair). Default: none. */
  log?: (line: string) => void;
}

/**
 * Containment support for the claude ACP adapter. Contained sessions run only the adapter that ships with the
 * install (source `"bundled"`; `BRIDGE_CLAUDE_ADAPTER` and a `PATH` copy are refused), as `<runner node>
 * <verified entry>` so the file that was version-checked is the file that runs, with `CLAUDE_CODE_EXECUTABLE`
 * forced to the version-checked binary. The decision is made again at every call, from the files on disk: neither a
 * refusal nor an acceptance is remembered. Only the binary's `--version` answer is reused, for as long as the file's
 * identity (path, device, inode, size, mtime) is unchanged. A same-uid process that swaps a file between this check and
 * the exec stays the accepted uid-level limit. A stack above the floor is accepted and logged (the weaker, unmeasured case).
 */
export function claudeContainmentSupport(options: ClaudeSupportOptions = {}): AcpContainmentSupport {
  return claudeContainmentSupportWithSeams({}, options);
}

/** `claudeContainmentSupport` with the test seams. In-package only (not in the barrel). */
export function claudeContainmentSupportWithSeams(seams: ClaudeContainmentSeams, options: ClaudeSupportOptions = {}): AcpContainmentSupport {
  const logged = new Set<string>();
  return {
    resolve(adapter: ContainmentAdapterCommand | undefined) {
      if (adapter === undefined) return { unavailable: "the claude adapter is not installed", reason: "adapter_missing" };
      if (adapter.source !== "bundled") return { unavailable: "contained sessions run only the bundled adapter" };
      const found = resolveClaudeStackWithSeams(adapter.command, seams);
      if ("problem" in found) return { unavailable: found.problem };
      const { stack } = found;
      const { installed } = stack;
      if (stack.newerThanMeasured && options.log !== undefined) {
        const key = `${installed.adapter}\0${installed.binary}`;
        if (!logged.has(key)) {
          logged.add(key);
          options.log(`contained claude sessions run on adapter ${installed.adapter} / CLI ${installed.binary}, newer than the measured ${CLAUDE_MIN_SUPPORTED.adapter} / ${CLAUDE_MIN_SUPPORTED.binary}: accepted, not re-measured`);
        }
      }
      return {
        launch: {
          profile: claudeProfileOf(installed),
          command: seams.nodePath ?? process.execPath,
          args: [stack.adapterEntry],
          env: { CLAUDE_CODE_EXECUTABLE: stack.binary },
          sessionMeta: ({ model }) => ({ claudeCode: { options: claudeSessionOptions(model) } }),
        },
      };
    },
  };
}
