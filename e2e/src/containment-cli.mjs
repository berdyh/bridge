// The real `bridge` CLI with the contained-session stub as its bundled claude adapter. Not a test file.
//
// It is `fixtures/bridge-cli.mjs` (the scripted terminal) plus one seam: `deps.adapters` is the runner's own
// `createDefaultAgentAdapters`, built with the CLI's own options (`adapterOptionsOf`: env, home, XDG bases, bridge's
// login files), except for the commands. Claude runs the stub install of `containment-stack.ts`, marked
// `source: "bundled"`, so the real pin check (`claudeContainmentSupport`) decides whether a contained session may
// run it; codex runs the same stub, and has no containment profile.
//
//   E2E_STUB_CLAUDE=<bin>  the stub install's claude-agent-acp bin script
//   E2E_STUB_CODEX=<bin>   the stub install's codex-acp script
//   E2E_TTY=1              a person at a terminal: prompts are asked and read one line each from stdin
//
// The three variables are taken out of the environment before the CLI sees it.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { agentLoginFileOf, baseDirsOf, createDefaultDeps, runCli } from "@berdyh/bridge";

const env = { ...process.env };
const claude = env.E2E_STUB_CLAUDE;
const codex = env.E2E_STUB_CODEX;
const tty = env.E2E_TTY === "1";
delete env.E2E_STUB_CLAUDE;
delete env.E2E_STUB_CODEX;
delete env.E2E_TTY;
if (!claude || !codex) throw new Error("containment-cli: E2E_STUB_CLAUDE and E2E_STUB_CODEX are required");

// `@berdyh/bridge-runner` as the CLI itself resolves it (the e2e package does not depend on it directly).
let cliDir = path.dirname(fileURLToPath(import.meta.resolve("@berdyh/bridge")));
while (!existsSync(path.join(cliDir, "package.json"))) cliDir = path.dirname(cliDir);
const runnerEntry = createRequire(path.join(cliDir, "package.json")).resolve("@berdyh/bridge-runner");
const { createDefaultAgentAdapters } = await import(pathToFileURL(runnerEntry).href);

const deps = createDefaultDeps(env);
deps.adapters = createDefaultAgentAdapters({
  environment: { env: deps.env, homedir: deps.env.HOME },
  base: baseDirsOf(deps),
  authFiles: { "claude-code": agentLoginFileOf(deps, "claude"), "codex-cli": agentLoginFileOf(deps, "codex") },
  commands: { claude: [{ command: claude, source: "bundled" }], codex: [codex] },
});

let lines;
if (tty) {
  deps.isTTY = true;
  const queue = [];
  const waiting = [];
  lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => (waiting.length > 0 ? waiting.shift()(line) : queue.push(line)));
  lines.on("close", () => waiting.splice(0).forEach((resolve) => resolve("")));
  deps.confirm = async (question, options) => {
    const fallback = options?.default ?? "no";
    const marker = fallback === "yes" ? "[Y/n]" : fallback === "no" ? "[y/N]" : "[y/n]";
    process.stderr.write(`${question} ${marker} `);
    const answer = (queue.length > 0 ? queue.shift() : await new Promise((resolve) => waiting.push(resolve))).trim();
    process.stderr.write(`\n`);
    if (/^y(es)?$/i.test(answer)) return true;
    if (/^no?$/i.test(answer)) return false;
    return answer === "" && fallback === "yes";
  };
}

const code = await runCli(process.argv.slice(2), deps);
lines?.close();
process.exitCode = code;
