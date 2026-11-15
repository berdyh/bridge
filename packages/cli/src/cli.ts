import { runAgent } from "./agent.js";
import { runApps } from "./apps.js";
import { runBrowsers } from "./browsers.js";
import { runConnect } from "./connect.js";
import { type CliDeps, UsageError, errorMessage } from "./deps.js";
import { runDoctor } from "./doctor.js";
import { runEnroll } from "./enroll.js";
import { runPlugin } from "./plugin.js";
import { runHandleUrl, runProtocol } from "./protocol-handler.js";
import { runRun } from "./run.js";
import { runSelfInstall } from "./self.js";
import { runService } from "./service.js";
import { runSetup, startRunnerOf } from "./setup.js";
import { runStatus } from "./status.js";
import { runUninstall } from "./uninstall.js";
import { CLI_VERSION } from "./version.js";

export * from "./deps.js";

interface Command {
  name: string;
  usage: string;
  summary: string;
  run: (args: string[], deps: CliDeps) => Promise<number>;
  /** Not in the help text: run by the OS or by another command, not typed. */
  hidden?: boolean;
}

const commands = (): Command[] => [
  { name: "setup", usage: "setup <app-url> [--service | --foreground] [--no-install] [--no-open] [--yes] [--json] [--plan]", summary: "Install, connect and pair a browser in one go", run: runSetup },
  { name: "connect", usage: "connect <app-url> [--yes] [--open] [--json]", summary: "Pair this machine with an app's bridge server", run: runConnect },
  { name: "run", usage: "run [--no-e2ee]", summary: "Serve every app: hold a connection to each connected app's relay and run every app's plugins", run: runRun },
  { name: "enroll", usage: "enroll [<app>] [--open] [--json] | enroll approve|deny <app> --words \"<w1 w2 w3 w4>\"|-", summary: "Open an enrollment window for a new browser, or answer its trust request", run: runEnroll },
  { name: "status", usage: "status [--json]", summary: "Show whether the runner is running and what each app's link and browsers are", run: runStatus },
  { name: "browsers", usage: "browsers list|revoke [<app>] [<browser-key-id>]", summary: "List or revoke the browsers trusted for an app", run: runBrowsers },
  { name: "apps", usage: "apps list [--json] | add-local <app-id> [--name <name>] [--yes] | remove <app> [--yes]", summary: "List apps, create a local app (no hosted server) or remove one", run: runApps },
  { name: "agent", usage: "agent login <claude|codex> [--copy | --login] [--yes] | agent logout <claude|codex> | agent install <claude|codex> [--yes] | agent status [--json]", summary: "Keep a coding agent's login in bridge's own folder (never in ~/.claude or ~/.codex), and sign out the one bridge made; install the claude (about 300 MB) or codex (about 450 MB) adapter on request", run: runAgent },
  { name: "plugin", usage: "plugin add <path | https://...tgz --sha256 <hex> | npm:<name>@<version> [--integrity <sri>]> [--replace] [--yes] [--no-restart] | list [--json] | remove <id> [--keep-data] [--yes] [--no-restart] | revoke <id> [--yes] [--no-restart] | audit <id> [--limit <n>] [--json]", summary: "Install, list, remove or revoke app plugins, and read a plugin's audit trail", run: runPlugin },
  { name: "doctor", usage: "doctor [--paths | --containment] [--json]", summary: "Check the install; --paths lists every path the runner writes, --containment shows what contained sessions were measured on", run: runDoctor },
  { name: "service", usage: "service install|uninstall [--no-activate] [--yes] [--json]", summary: "Install or remove the user service that runs `bridge run`", run: runService },
  { name: "self", usage: "self install [--yes] [--version <v>] [--from <dir>]", summary: "Install this release for the current user (versioned dir and one launcher link)", run: runSelfInstall },
  { name: "uninstall", usage: "uninstall [--yes]", summary: "Remove everything `bridge doctor --paths` lists", run: runUninstall },
  { name: "protocol", usage: "protocol install|uninstall [--yes]", summary: "Register or remove the bridge:// link handler (Linux)", run: runProtocol },
  {
    name: "handle-url",
    usage: "handle-url <bridge://run | bridge://setup?url=<origin>>",
    summary: "Run by the desktop entry for a bridge:// link",
    run: (args, deps) => runHandleUrl(args, deps, { startRunner: startRunnerOf(deps) }),
    hidden: true,
  },
];

export function helpText(): string {
  const shown = commands().filter((c) => !c.hidden);
  const width = Math.max(...shown.map((c) => c.usage.length));
  return [
    `bridge ${CLI_VERSION}: the local runner for hosted apps and your coding agent`,
    "",
    "Usage: bridge <command> [options]",
    "",
    "Commands:",
    ...shown.map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`),
    "",
    "Options:",
    "  -h, --help       Show this help",
    "  -v, --version    Show the version",
    "",
  ].join("\n");
}

/** Parses `argv` (without the node and script entries), runs the command and returns the exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined || first === "-h" || first === "--help" || first === "help") {
    (first === undefined ? deps.stderr : deps.stdout)(helpText());
    return first === undefined ? 2 : 0;
  }
  if (first === "-v" || first === "--version") {
    deps.stdout(`${CLI_VERSION}\n`);
    return 0;
  }
  const command = commands().find((c) => c.name === first);
  if (!command) {
    deps.stderr(`bridge: unknown command '${first}'\n\n${helpText()}`);
    return 2;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    deps.stdout(`Usage: bridge ${command.usage}\n\n${command.summary}\n`);
    return 0;
  }
  try {
    return await command.run(rest, deps);
  } catch (error) {
    deps.stderr(`bridge ${command.name}: ${error instanceof UsageError ? error.message : errorMessage(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

