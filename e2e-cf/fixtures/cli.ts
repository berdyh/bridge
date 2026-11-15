// Test entry point for the real CLI parser/commands. Only host dependencies are
// injected: private dirs, a file-backed fake keychain, ws and the stub ACP binary.
import { runCli } from "@berdyh/bridge";
import { createDefaultDeps } from "../../packages/cli/src/deps.js";
import { createAcpAgentAdapter } from "@berdyh/bridge-runner";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { RelaySocket } from "../../packages/cli/src/deps.js";

const base = process.env.BRIDGE_TEST_ROOT;
if (!base || !path.isAbsolute(base)) throw new Error("Missing private harness directory");
const credentialsDir = path.join(base, "credentials");
await mkdir(credentialsDir, { recursive: true, mode: 0o700 });
const keyFile = (key: string) => path.join(credentialsDir, encodeURIComponent(key));
const deps = createDefaultDeps({ HOME: path.join(base, "home"), XDG_CONFIG_HOME: path.join(base, "config"), XDG_DATA_HOME: path.join(base, "data") });
deps.confirm = async () => true;
// `bridge run` shows a desktop notification when it starts: never on the machine running the tests.
deps.notify = async () => undefined;
// `bridge setup` and `connect` open the sign-in and enroll pages in the default browser: never on the machine running the tests.
deps.openUrl = async () => undefined;
// stdin is not a terminal here, but the test plays the human who answers `yes`: take the interactive path.
deps.isTTY = true;
deps.credentials = {
  async get(key) {
    try { return await readFile(keyFile(key), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  },
  async set(key, value) {
    const temporary = `${keyFile(key)}.${process.pid}.tmp`;
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, keyFile(key));
  },
  async delete(key) { await rm(keyFile(key), { force: true }); },
};
const Ws = createRequire(import.meta.url)(process.env.BRIDGE_TEST_WS!) as new (url: string, protocols: string[], options: object) => RelaySocket;
deps.socket = (url, init) => {
  const socket = new Ws(url, init.protocols, { headers: init.headers });
  const record = (direction: string, data: unknown) => process.stdout.write(`WIRE ${JSON.stringify({ direction, text: String(data) })}\n`);
  const send = socket.send.bind(socket);
  socket.send = (data) => { record("runner-out", data); send(data); };
  socket.addEventListener("message", (event) => record("runner-in", event.data));
  return socket;
};
deps.adapters = [createAcpAgentAdapter({ id: "stub", command: process.execPath, args: [process.env.BRIDGE_TEST_AGENT!],
  environment: { env: {}, homedir: path.join(base, "home"), tmpBase: base } })];
deps.defaultCwd = path.join(base, "home");
// Sessions start in an app's work folder unless `allowedCwds` says otherwise; this test starts its own in `home`.
await mkdir(path.join(base, "config", "bridge"), { recursive: true });
await writeFile(path.join(base, "config", "bridge", "policy.json"), JSON.stringify({ allowedCwds: [path.join(base, "home")] }));
process.exitCode = await runCli(process.argv.slice(2), deps);
