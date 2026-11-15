// The real `bridge` CLI with the test seams a pipe cannot give it: a scripted terminal, a recording
// browser opener and shortened timers. Everything else (keychain shims, agent, paths) is the
// machine's own environment, as with `main.js`. Used through `Machine.start(..., { seams: true })`.
//
//   E2E_TTY=1            the person is at a terminal: prompts are asked, answers are read one
//                        line each from stdin (the test writes a line only when a prompt shows).
//   E2E_OPENED_URLS=<f>  every URL the CLI would open in a browser is appended to <f>, one per line.
//   E2E_IDLE_MS=<n>      `bridge run` idle stop after n ms instead of 15 minutes.
//   E2E_PEER_GONE_MS=<n> grace before a browser that went away counts as gone (default 60 s, PEER_GONE_GRACE_MS).
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { createDefaultDeps, runCli, runRun } from "@berdyh/bridge";

const deps = createDefaultDeps(process.env);
const argv = process.argv.slice(2);
let lines;
if (process.env.E2E_TTY === "1") {
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
if (process.env.E2E_OPENED_URLS) {
  deps.openUrl = async (url) => void appendFileSync(process.env.E2E_OPENED_URLS, `${url}\n`);
}
if (process.env.E2E_PEER_GONE_MS) deps.peerGoneGraceMs = Number(process.env.E2E_PEER_GONE_MS);

let code;
if (argv[0] === "run" && process.env.E2E_IDLE_MS) {
  code = await runRun(argv.slice(1), deps, { idle: { ms: Number(process.env.E2E_IDLE_MS) } });
} else {
  code = await runCli(argv, deps);
}
lines?.close();
process.exitCode = code;
