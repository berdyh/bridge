import { accessSync, constants, existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type DefaultAdapterOptions, applyUpdatePlan, removeBound, resolveClaudeStack } from "@berdyh/bridge-runner";

import { agentLoginFileOf } from "./agent.js";
import { parse } from "./args.js";
import { assertUnchanged, describePath, pathStates } from "./consent-plan.js";
import { type CliDeps, UsageError, errorMessage, homeOf, isTTYOf, runnerOf } from "./deps.js";
import { assertLayout, layoutSnapshot } from "./layout-rule.js";
import { assertNoLegacyLayout } from "./legacy.js";
import { adaptersDirOf, baseDirsOf } from "./paths.js";
import { nodeFs, npmInstallArgs } from "./self.js";

/** The bin name of the claude ACP adapter (`@agentclientprotocol/claude-agent-acp`). */
export const BUNDLED_CLAUDE_ADAPTER = "claude-agent-acp";

/** The npm package of the claude ACP adapter. */
export const CLAUDE_ADAPTER_PACKAGE = "@agentclientprotocol/claude-agent-acp";

/**
 * The one adapter version bridge installs (`bridge agent install claude`) and runs contained sessions on, with the
 * integrity npm must report for it. The same version as the `devDependencies` entry of `packages/cli/package.json`
 * and the runner's `CLAUDE_MEASURED_STACK.adapter`, and the `resolution.integrity` of `pnpm-lock.yaml`: a test
 * keeps the four in step, so a bump cannot change one of them alone.
 */
export const CLAUDE_ADAPTER_PIN = {
  version: "0.94.0",
  integrity: "sha512-3quBG9QaMKhETZPF0QaD/Ue2C0UCQDzDztDbzs8AVYM8RQKX93TPL0YzJl7sx06qYPLQvxrCDdiAp5a6cgFfZg==",
} as const;

/** The command that installs the claude adapter; the hint in doctor, `bridge run` and the CLI names it. */
export const INSTALL_ADAPTER_COMMAND = "bridge agent install claude";

/** What an install costs, for the question and the hints. */
export const CLAUDE_ADAPTER_SIZE = "about 300 MB";

/**
 * Environment variable that names the claude ACP adapter to run instead of bridge's own copy: an
 * absolute path (or a bare name looked up on `PATH`). Tried first, reported as source `path`
 * (so contained sessions refuse it). For users who pin their own adapter, and for the e2e tests' stub agent.
 */
export const CLAUDE_ADAPTER_ENV = "BRIDGE_CLAUDE_ADAPTER";

/** The bin name of the codex ACP adapter (`@agentclientprotocol/codex-acp`). */
export const CODEX_ADAPTER_BIN = "codex-acp";

/**
 * The npm package of the codex ACP adapter: the one under the same publisher org as the claude adapter
 * (`@zed-industries/codex-acp` is deprecated in its favour, and the unscoped `codex-acp` is a third party's).
 */
export const CODEX_ADAPTER_PACKAGE = "@agentclientprotocol/codex-acp";

/**
 * The one codex adapter version bridge installs (`bridge agent install codex`), with the integrity npm must report
 * for it. Not a dependency of any package in this repo (it pulls in `@openai/codex`, hundreds of MB), so unlike the
 * claude pin nothing else records it.
 */
export const CODEX_ADAPTER_PIN = {
  version: "2.5.0",
  integrity: "sha512-7e/4OhJwpvSTqsjiokoVYRV7O1XGem1CAsQgO1opmGYbRD5LvmydwDlJrldzQYO5TcPWueGzQ2Jdvyvp6l3qDw==",
} as const;

/** The command that installs the codex adapter; the hint in doctor, `bridge run` and setup names it. */
export const INSTALL_CODEX_ADAPTER_COMMAND = "bridge agent install codex";

/** What a codex adapter install costs (`npm install --ignore-scripts` on linux-x64 measured about 450 MB), for the question and the hints. */
export const CODEX_ADAPTER_SIZE = "about 450 MB";

/**
 * Environment variable that names the codex ACP adapter to run instead of bridge's own copy: an absolute path (or a
 * bare name looked up on `PATH`). Tried first. For users who pin their own adapter, and for the e2e tests' stub agent.
 */
export const CODEX_ADAPTER_ENV = "BRIDGE_CODEX_ADAPTER";

/** The agents whose ACP adapter bridge installs on request. */
export type AdapterAgent = "claude" | "codex";

/** What differs between the adapters bridge installs: the npm package and its pin, the bin, what it costs and the commands that name it. */
export interface AdapterKind {
  agent: AdapterAgent;
  package: string;
  bin: string;
  pin: { readonly version: string; readonly integrity: string };
  size: string;
  /** `bridge agent install <agent>`. */
  command: string;
  /** The environment variable that overrides bridge's own copy. */
  envVar: string;
}

/** The install command, size and package of `adapterId`'s adapter (`createDefaultAgentAdapters` ids), when bridge installs one. */
export function adapterKindOf(adapterId: string): AdapterKind | undefined {
  return adapterId === "claude" || adapterId === "codex" ? ADAPTER_KINDS[adapterId] : undefined;
}

export const ADAPTER_KINDS: Record<AdapterAgent, AdapterKind> = {
  claude: { agent: "claude", package: CLAUDE_ADAPTER_PACKAGE, bin: BUNDLED_CLAUDE_ADAPTER, pin: CLAUDE_ADAPTER_PIN, size: CLAUDE_ADAPTER_SIZE, command: INSTALL_ADAPTER_COMMAND, envVar: CLAUDE_ADAPTER_ENV },
  codex: { agent: "codex", package: CODEX_ADAPTER_PACKAGE, bin: CODEX_ADAPTER_BIN, pin: CODEX_ADAPTER_PIN, size: CODEX_ADAPTER_SIZE, command: INSTALL_CODEX_ADAPTER_COMMAND, envVar: CODEX_ADAPTER_ENV },
};

/** Test seams for the adapter lookups. */
export interface BundledLookup {
  /** Where the walk starts. Default: the directory of this module. */
  fromDir?: string;
  isExecutable?: (file: string) => boolean;
  exists?: (file: string) => boolean;
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const inNodeModules = (dir: string): boolean => dir.split(path.sep).includes("node_modules");

/**
 * The claude ACP adapter of a source checkout (the package's devDependency), or `undefined`. An installed
 * release carries none (the adapter is installed on request, `installedClaudeAdapter`). Looked up from this
 * module's own location, never from `PATH`, and never beyond the install's own root:
 * - a source checkout: `<package>/node_modules/.bin/claude-agent-acp`, where the walk stops at
 *   the package root (the dir with a `package.json` outside any `node_modules`);
 * - an install (`npm install --prefix versions/<v>`): the walk stops at that `node_modules`, which holds no adapter.
 */
export function bundledAdapterCommand(lookup: BundledLookup = {}): string | undefined {
  const isExec = lookup.isExecutable ?? executable;
  const exists = lookup.exists ?? existsSync;
  let dir = path.resolve(lookup.fromDir ?? path.dirname(fileURLToPath(import.meta.url)));
  for (;;) {
    const bins = [path.join(dir, "node_modules", ".bin", BUNDLED_CLAUDE_ADAPTER)];
    const isModulesDir = path.basename(dir) === "node_modules";
    if (isModulesDir) bins.push(path.join(dir, ".bin", BUNDLED_CLAUDE_ADAPTER));
    for (const bin of bins) if (isExec(bin)) return bin;
    if (isModulesDir) return undefined;
    if (!inNodeModules(dir) && exists(path.join(dir, "package.json"))) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `<data>/bridge/adapters/<agent>/<pin>`: where `bridge agent install <agent>` puts the adapter. Only this exact version is looked at. */
export function adapterDirOf(deps: CliDeps, agent: AdapterAgent): string {
  return path.join(adaptersDirOf(deps), agent, ADAPTER_KINDS[agent].pin.version);
}

export const claudeAdapterDirOf = (deps: CliDeps): string => adapterDirOf(deps, "claude");
export const codexAdapterDirOf = (deps: CliDeps): string => adapterDirOf(deps, "codex");

/** Where bridge's own copy of an adapter is (or will be) at the pinned version; the file may not exist yet. */
function installedAdapterPath(deps: CliDeps, agent: AdapterAgent): string {
  return path.join(adapterDirOf(deps, agent), "node_modules", ".bin", ADAPTER_KINDS[agent].bin);
}

/** The adapter bridge installed itself, at the pinned version: its executable, or `undefined` when there is none. */
export function installedAdapter(deps: CliDeps, agent: AdapterAgent, lookup: Pick<BundledLookup, "isExecutable"> = {}): string | undefined {
  const bin = installedAdapterPath(deps, agent);
  return (lookup.isExecutable ?? executable)(bin) ? bin : undefined;
}

export const installedClaudeAdapter = (deps: CliDeps, lookup: Pick<BundledLookup, "isExecutable"> = {}): string | undefined => installedAdapter(deps, "claude", lookup);

/**
 * The options `adaptersOf` passes to `createDefaultAgentAdapters`: the XDG base dirs (the
 * per-session sandboxes live in `<state>/<app>/bridge/tmp`, never in `/tmp`), the deps'
 * environment and home, `authFiles` (the logins in bridge's own folder, `bridge agent login`), and the claude adapter lookup order:
 * `$BRIDGE_CLAUDE_ADAPTER` when set, bridge's installed copy at the pinned version, the source checkout's copy, then
 * `claude-agent-acp` and `claude-code-acp` on `PATH`. A copy on `PATH` cannot shadow bridge's own. Both of
 * bridge's copies are source `bundled`: version-checked copies bridge controls, the only ones contained sessions run.
 * The codex adapter lookup order: `$BRIDGE_CODEX_ADAPTER` when set, bridge's installed copy at the pinned version
 * (source `bundled`, so the listings say bridge installed it), then `codex-acp` on `PATH`.
 */
export function adapterOptionsOf(deps: CliDeps, lookup: BundledLookup = {}): DefaultAdapterOptions {
  const bundled = bundledAdapterCommand(lookup);
  const override = deps.env[CLAUDE_ADAPTER_ENV];
  const codexOverride = deps.env[CODEX_ADAPTER_ENV];
  return {
    environment: { env: deps.env, homedir: homeOf(deps) },
    base: baseDirsOf(deps),
    // Bridge's own copies only: availability and staging never look at ~/.claude or ~/.codex.
    authFiles: { "claude-code": agentLoginFileOf(deps, "claude"), "codex-cli": agentLoginFileOf(deps, "codex") },
    // A contained session on a stack newer than the measured one leaves a line; agent stderr stays off (no `log`).
    containmentLog: (line) => deps.stderr(`bridge: ${line}\n`),
    commands: {
      claude: [
        ...(override ? [override] : []),
        // Always listed, found or not: the runner re-checks each candidate on every session, so a copy installed
        // after the runner started (`bridge agent install claude`) serves the next session without a restart.
        { command: installedAdapterPath(deps, "claude"), source: "bundled" as const },
        ...(bundled ? [{ command: bundled, source: "bundled" as const }] : []),
        BUNDLED_CLAUDE_ADAPTER,
        "claude-code-acp",
      ],
      // Codex: the same order without a checkout copy (the adapter is no dependency of this repo). Contained sessions
      // for codex are refused whatever the source (no containment profile).
      codex: [
        ...(codexOverride ? [codexOverride] : []),
        { command: installedAdapterPath(deps, "codex"), source: "bundled" as const },
        CODEX_ADAPTER_BIN,
      ],
    },
  };
}

// --- bridge agent install <claude|codex> ---------------------------------------------------------

/** What `bridge agent install <agent>` would do. Pure: reads nothing and writes nothing. */
export interface AdapterInstallPlan {
  version: string;
  /** `<data>/bridge/adapters/<agent>/<version>` */
  dir: string;
  /** The folder npm installs into, renamed to `dir` when the checks pass. */
  staging: string;
  /** npm's cache (`npm_config_cache`, else `~/.npm`), which the install fills. */
  npmCache: string;
  spec: string;
}

export function adapterInstallPlan(deps: CliDeps, agent: AdapterAgent = "claude"): AdapterInstallPlan {
  const kind = ADAPTER_KINDS[agent];
  const dir = adapterDirOf(deps, agent);
  return {
    version: kind.pin.version,
    dir,
    staging: path.join(path.dirname(dir), `.staging-${kind.pin.version}-<random>`),
    npmCache: deps.env.npm_config_cache ?? path.join(homeOf(deps), ".npm"),
    spec: `${kind.package}@${kind.pin.version}`,
  };
}

export type AdapterInstallResult = { outcome: "installed" | "current"; version: string; dir: string } | { outcome: "cancelled"; version: string };

/** The newest tail of a command's stderr, for an error message. */
const tail = (text: string): string => text.trim().split("\n").slice(-6).join("\n");

/** Whether `dir` holds a complete install of the pin: the package at the pinned version and the executable bin. */
async function pinInstalledAt(dir: string, kind: AdapterKind): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, "node_modules", ...kind.package.split("/"), "package.json"), "utf8")) as { version?: unknown };
    return pkg.version === kind.pin.version && executable(path.join(dir, "node_modules", ".bin", kind.bin));
  } catch {
    return false;
  }
}

/**
 * The stack the adapter at `bin` pulls in (SDK, platform package, the binary answering `--version`) passes the version
 * check a contained session runs, and the adapter is the pinned version. Linux x64 only: contained sessions are refused
 * elsewhere (`resolveClaudeStack` says so), so there is nothing to check. Throws the problem.
 */
export function checkClaudeStack(bin: string, resolve: typeof resolveClaudeStack = resolveClaudeStack): void {
  if (process.platform !== "linux" || process.arch !== "x64") return;
  const found = resolve(bin);
  if ("problem" in found) throw new Error(`the installed adapter does not pass the version check contained sessions run: ${found.problem}`);
  if (found.stack.installed.adapter !== CLAUDE_ADAPTER_PIN.version) throw new Error(`the installed adapter reports ${found.stack.installed.adapter}, not ${CLAUDE_ADAPTER_PIN.version}`);
}

/**
 * The checks on the staging folder, after npm: the lockfile npm wrote names the adapter at the pinned version and
 * integrity, the package on disk says the same version, the bin is an executable, and then `stackCheck` runs on the bin.
 * Throws the first problem. The adapter's own dependencies are not pinned by integrity here: npm checks each against
 * the registry's `dist.integrity`.
 */
export async function checkInstalledAdapter(root: string, agent: AdapterAgent, stackCheck?: (bin: string) => void): Promise<void> {
  const kind = ADAPTER_KINDS[agent];
  const key = `node_modules/${kind.package}`;
  let locked: { version?: unknown; integrity?: unknown } | undefined;
  try {
    locked = (JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")) as { packages?: Record<string, { version?: unknown; integrity?: unknown }> }).packages?.[key];
  } catch {
    throw new Error("npm install left no readable package-lock.json in the staging folder");
  }
  if (locked?.version !== kind.pin.version) throw new Error(`npm locked ${kind.package} ${String(locked?.version)}, not ${kind.pin.version}`);
  if (locked.integrity !== kind.pin.integrity) {
    throw new Error(`the registry's ${kind.package}@${kind.pin.version} has integrity ${String(locked.integrity)}, not the pinned ${kind.pin.integrity}; nothing was installed`);
  }
  let installed: unknown;
  try {
    installed = (JSON.parse(await readFile(path.join(root, key, "package.json"), "utf8")) as { version?: unknown }).version;
  } catch {
    throw new Error(`npm install left no ${kind.package} package in the staging folder`);
  }
  if (installed !== kind.pin.version) throw new Error(`npm installed ${kind.package} ${String(installed)}, not ${kind.pin.version}`);
  const bin = path.join(root, "node_modules", ".bin", kind.bin);
  if (!executable(bin)) throw new Error(`npm install left no executable ${kind.bin} in the staging folder`);
  stackCheck?.(bin);
}

/** `checkInstalledAdapter` for the claude adapter, whose stack must also pass the version check contained sessions run (`checkClaudeStack`). */
export const checkInstalledClaudeAdapter = (root: string, stackCheck: (bin: string) => void = checkClaudeStack): Promise<void> => checkInstalledAdapter(root, "claude", stackCheck);

/** What the install consents to; plain data, compared once more after the question. */
async function adapterBinding(deps: CliDeps, plan: AdapterInstallPlan) {
  const adapters = adaptersDirOf(deps);
  const [appDir, adaptersDir, agentDir, dir] = await pathStates([path.dirname(adapters), adapters, path.dirname(plan.dir), plan.dir]);
  return { appDir: appDir!, adaptersDir: adaptersDir!, agentDir: agentDir!, dir: dir!, layout: await layoutSnapshot(deps) };
}

/**
 * Installs the adapter of `agent` at the pinned version into bridge's own folder, by the self-install mechanism: look
 * (reads only), print the paths and ask, `npm install --prefix <staging> --ignore-scripts` in one invocation from the
 * registry npm is configured with, check the staging folder (`checkInstalledAdapter`), rename it into place.
 * Any failure removes the staging folder and leaves nothing at the destination. A complete install is kept
 * ("current", no npm); a half-made folder is refused. Without a terminal it needs `--yes`, before any write.
 */
export async function installAdapter(deps: CliDeps, agent: AdapterAgent, run: { yes?: boolean; /** The caller (`setup`) listed these paths in its own consent and got a yes: no path list, no question. */ consented?: boolean; /** Test seam: the stack check run on the staging folder (claude: the version check of contained sessions; codex: none). */ stackCheck?: (bin: string) => void } = {}): Promise<AdapterInstallResult> {
  const kind = ADAPTER_KINDS[agent];
  await assertNoLegacyLayout(deps);
  const plan = adapterInstallPlan(deps, agent);
  for (const dir of [adaptersDirOf(deps), path.dirname(plan.dir)]) {
    const info = await lstat(dir).catch(() => undefined);
    if (info !== undefined && !info.isDirectory()) throw new Error(`${dir} is not a directory (a symlink or other); refusing to install into it`);
  }
  const existing = await lstat(plan.dir).catch(() => undefined);
  if (existing !== undefined) {
    if (!existing.isDirectory()) throw new Error(`${plan.dir} is not a directory (a symlink or other); refusing to use it`);
    if (!(await pinInstalledAt(plan.dir, kind))) throw new Error(`${plan.dir} exists but is incomplete; remove it and run this again`);
    deps.stdout(`The ${agent} adapter ${plan.version} is already installed at ${plan.dir}.\n`);
    return { outcome: "current", version: plan.version, dir: plan.dir };
  }
  await assertLayout(deps, "install into");
  if (!run.yes && !run.consented && !isTTYOf(deps)) {
    throw new UsageError(`without a terminal, pass --yes to install the ${agent} adapter (${kind.size} from the npm registry into ${plan.dir})`);
  }

  const bound = await adapterBinding(deps, plan);
  const missing = [bound.appDir, bound.adaptersDir, bound.agentDir].filter((d) => d.kind === "missing");
  if (!run.consented) deps.stdout(
    [
      "These paths will be written:",
      `  ${describePath(bound.dir)}  (the ${agent} adapter ${plan.version} and its dependencies: npm install of ${plan.spec} from the npm registry, --ignore-scripts, ${kind.size}, built in a staging folder next to it)`,
      `  ${plan.staging}/  (the staging folder, removed when the install ends)`,
      `  ${plan.npmCache}  (npm's cache)`,
      ...(missing.length > 0 ? [`  folders created when missing: ${missing.map(describePath).join(", ")}`] : []),
      "",
    ].join("\n"),
  );
  if (!run.yes && !run.consented && !(await deps.confirm(`Install the ${agent} adapter ${plan.version} for bridge (${kind.size} from the npm registry)?`))) {
    deps.stderr("bridge agent install: cancelled\n");
    return { outcome: "cancelled", version: plan.version };
  }

  // The prompt may have taken minutes: recompute the whole plan and go on only if it is the one shown.
  assertUnchanged(bound, await adapterBinding(deps, plan), "bridge agent install");
  try {
    const result = await applyUpdatePlan(
      { action: "download", version: plan.version, url: plan.spec, destDir: bound.dir.canonical },
      {
        fs: nodeFs,
        entryFile: path.join("node_modules", ".bin", kind.bin),
        download: async (_plan, staging) => {
          let r;
          try {
            r = await runnerOf(deps)("npm", npmInstallArgs(staging, [plan.spec]));
          } catch (error) {
            throw new Error(`could not run npm (${errorMessage(error)}); install Node.js with npm and try again`);
          }
          if (r.exitCode !== 0) throw new Error(`npm install exited with ${r.exitCode}: ${tail(r.stderr)}`);
          await checkInstalledAdapter(staging, agent, run.stackCheck ?? (agent === "claude" ? checkClaudeStack : undefined));
        },
      },
    );
    if (!result.fetched) throw new Error(`install of the ${agent} adapter ${plan.version} failed: ${result.error ?? "unknown error"}`);
  } catch (error) {
    // Folders this run made (missing when the plan was bound) go again, deepest first, only while empty.
    for (const d of [bound.agentDir, bound.adaptersDir, bound.appDir]) {
      if (d.kind === "missing") await removeBound(d.canonical, { emptyDir: true }).catch(() => undefined);
    }
    throw error;
  }
  deps.stdout(`Installed the ${agent} adapter ${plan.version} for bridge: ${plan.dir}\n`);
  return { outcome: "installed", version: plan.version, dir: plan.dir };
}

/** `installAdapter` for claude. */
export const installClaudeAdapter = (deps: CliDeps, run: { yes?: boolean; stackCheck?: (bin: string) => void } = {}): Promise<AdapterInstallResult> => installAdapter(deps, "claude", run);

/** `installAdapter` for codex. */
export const installCodexAdapter = (deps: CliDeps, run: { yes?: boolean } = {}): Promise<AdapterInstallResult> => installAdapter(deps, "codex", run);

export const ADAPTER_INSTALL_USAGE = "usage: bridge agent install <claude|codex> [--yes]";

/** `bridge agent install <claude|codex> [--yes]`. */
export async function runAdapterInstall(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, { yes: { type: "boolean" } });
  const agent = positionals[0];
  if (positionals.length !== 1 || (agent !== "claude" && agent !== "codex")) throw new UsageError(ADAPTER_INSTALL_USAGE);
  const result = await installAdapter(deps, agent, { yes: values.yes === true });
  return result.outcome === "cancelled" ? 1 : 0;
}
