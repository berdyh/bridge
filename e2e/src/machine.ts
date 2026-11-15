import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scratchRoot } from "./scratch.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "fixtures");
/** The built `bridge` binary of `@berdyh/bridge`. */
const BRIDGE_MAIN = path.join(path.dirname(fileURLToPath(import.meta.resolve("@berdyh/bridge"))), "main.js");

/** The real CLI behind the test seams (a scripted terminal, a recording opener, short timers). */
const SEAMS_MAIN = path.join(fixtures, "bridge-cli.mjs");

export const SAMPLE_PLUGIN_DIR = path.resolve(here, "..", "..", "examples", "sample-plugin");

export interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A tree on disk as a comparison: each path (relative to the machine root) to `dir`, `file <sha256> <mode>` or `link <target>`. */
export type Snapshot = Record<string, string>;

/** The secret every decoy agent config holds. If it turns up anywhere in bridge's folders, bridge read an agent's own login. */
export const DECOY_SECRET = "DECOY-agent-login-never-copy-me";

/** A running `bridge` process with its output captured. */
export interface BridgeProcess {
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Resolves with the output once `pattern` appears in stdout (or in stderr, if `stream` says so). */
  waitFor(pattern: RegExp, options?: { timeoutMs?: number; stream?: "stdout" | "stderr" }): Promise<RegExpMatchArray>;
  write(text: string): void;
  exited: Promise<Finished>;
  stop(): Promise<Finished>;
}

export function track(child: ChildProcess): BridgeProcess {
  let stdout = "";
  let stderr = "";
  const waiters = new Set<() => void>();
  child.stdout?.on("data", (c: Buffer) => {
    stdout += c.toString();
    waiters.forEach((w) => w());
  });
  child.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString();
    waiters.forEach((w) => w());
  });
  child.stdin?.on("error", () => {});
  let done = false;
  const exited = new Promise<Finished>((resolve) => {
    child.on("close", (code) => {
      // Set before notifying, so waiters see the exit instead of timing out.
      done = true;
      resolve({ code, stdout, stderr });
      waiters.forEach((w) => w());
    });
  });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    exited,
    write: (text) => void child.stdin?.write(text),
    waitFor(pattern, { timeoutMs = 30_000, stream = "stdout" } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out waiting for ${pattern} in ${stream}:\n--- stdout\n${stdout}\n--- stderr\n${stderr}`));
        }, timeoutMs);
        const check = () => {
          const match = (stream === "stdout" ? stdout : stderr).match(pattern);
          if (match) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve(match);
          } else if (done) {
            clearTimeout(timer);
            waiters.delete(check);
            reject(new Error(`process exited before ${pattern} appeared in ${stream}:\n--- stdout\n${stdout}\n--- stderr\n${stderr}`));
          }
        };
        waiters.add(check);
        check();
      });
    },
    async stop() {
      if (!done) child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        return await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * One user's machine: its own HOME, config, data and keychain dirs under a temp root, and a bin dir
 * holding the stand-ins on PATH. The real `bridge` binary runs inside it as a child process.
 *
 * Nothing leaves the temp root: `secret-tool` and `security` are file-backed fakes (so the OS keychain is
 * never touched, on Linux or macOS), and the only agent on PATH is `claude-agent-acp`, which runs the stub ACP agent.
 */
export class Machine {
  private readonly children: BridgeProcess[] = [];
  readonly home: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly keychainDir: string;
  /**
   * The person's own agent config dirs, which bridge must never write: decoys holding a secret, standing where
   * `~/.claude`, `~/.codex`, `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` would. `env()` points the two variables at the last two.
   */
  readonly decoys: { claudeHome: string; codexHome: string; claudeConfigDir: string; codexHomeDir: string };
  /** Bridge's own claude login, where the runner stages it from: `<config>/bridge/agents/claude/.credentials.json`. */
  readonly claudeLogin: string;
  /** A project dir under HOME: the runner only starts agent sessions inside HOME. */
  readonly project: string;
  /** The stand-ins on PATH (`secret-tool`, `security`, `claude-agent-acp`, ...). */
  readonly binDir: string;

  private constructor(readonly root: string) {
    this.home = path.join(root, "home");
    this.configDir = path.join(root, "config");
    this.dataDir = path.join(root, "data");
    this.keychainDir = path.join(root, "keychain");
    this.decoys = {
      claudeHome: path.join(this.home, ".claude"),
      codexHome: path.join(this.home, ".codex"),
      claudeConfigDir: path.join(root, "decoys", "claude-config-dir"),
      codexHomeDir: path.join(root, "decoys", "codex-home"),
    };
    this.claudeLogin = path.join(this.configDir, "bridge", "agents", "claude", ".credentials.json");
    this.project = path.join(this.home, "project");
    this.binDir = path.join(root, "bin");
  }

  /**
   * `policy: false` leaves out the machine `policy.json`: sessions then start only in the app's own work folder
   * (the default), as on a machine nobody configured. `defer: true` leaves out everything of bridge's own
   * (`policy.json` and the login copy) so a test can take a pre-install snapshot; `stageBridgeFiles()` puts them in.
   * The root is under the run's disk TMPDIR (`scratchRoot`), never `/tmp`.
   */
  static async create(options: { policy?: boolean; defer?: boolean } = {}): Promise<Machine> {
    const machine = new Machine(await mkdtemp(path.join(scratchRoot(), "bridge-e2e-")));
    // The XDG parents and the keychain dir exist on any real machine before a tool is installed.
    await Promise.all(
      [machine.home, machine.project, machine.configDir, machine.dataDir, machine.binDir, machine.keychainDir, path.join(machine.home, ".local", "state"), path.join(machine.home, ".local", "bin")].map((d) =>
        mkdir(d, { recursive: true }),
      ),
    );
    const shim = async (name: string, script: string) => {
      const file = path.join(machine.binDir, name);
      await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(fixtures, script)}" "$@"\n`);
      await chmod(file, 0o755);
    };
    await shim("secret-tool", "secret-tool.mjs");
    // On macOS the runner calls `security`; /usr/bin is on PATH, so shadow the real one.
    await shim("security", "security.mjs");
    await shim("claude-agent-acp", "stub-acp-agent.mjs");
    // `bridge run` shows a desktop notification when it starts: no-op stand-ins, so a test never pops one on a real desktop.
    for (const name of ["notify-send", "osascript"]) {
      const file = path.join(machine.binDir, name);
      await writeFile(file, "#!/bin/sh\nexit 0\n");
      await chmod(file, 0o755);
    }
    await machine.writeDecoys();
    if (options.defer !== true) await machine.stageBridgeFiles({ policy: options.policy !== false });
    return machine;
  }

  /**
   * What `bridge agent login claude --copy` and the machine policy leave in `<config>/bridge`, written by the test:
   * the policy (sessions may start in `project`) and the stub agent's "signed in" login, bridge's own copy. The person's
   * own `~/.claude` is a decoy and is never read for it.
   */
  async stageBridgeFiles(options: { policy?: boolean } = {}): Promise<void> {
    await mkdir(path.join(this.configDir, "bridge"), { recursive: true });
    if (options.policy !== false) await writeFile(path.join(this.configDir, "bridge", "policy.json"), JSON.stringify({ allowedCwds: [this.project] }));
    await mkdir(path.dirname(this.claudeLogin), { recursive: true, mode: 0o700 });
    await writeFile(this.claudeLogin, JSON.stringify({ claudeAiOauth: { accessToken: "e2e-not-a-real-token" } }), { mode: 0o600 });
  }

  private async writeDecoys(): Promise<void> {
    const secret = JSON.stringify({ claudeAiOauth: { accessToken: DECOY_SECRET } });
    const files: [string, string][] = [
      [path.join(this.decoys.claudeHome, ".credentials.json"), secret],
      [path.join(this.decoys.claudeHome, "settings.json"), JSON.stringify({ decoy: true })],
      [path.join(this.decoys.codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: DECOY_SECRET })],
      [path.join(this.decoys.claudeConfigDir, ".credentials.json"), secret],
      [path.join(this.decoys.claudeConfigDir, "projects", "keep.txt"), "keep"],
      [path.join(this.decoys.codexHomeDir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: DECOY_SECRET })],
      [path.join(this.decoys.codexHomeDir, "config.toml"), "# decoy\n"],
    ];
    for (const [file, text] of files) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text, { mode: 0o600 });
    }
  }

  /** The environment of every `bridge` child: injected paths, no inherited secrets, no real keychain. */
  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: [this.binDir, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      HOME: this.home,
      XDG_CONFIG_HOME: this.configDir,
      XDG_DATA_HOME: this.dataDir,
      E2E_KEYCHAIN_DIR: this.keychainDir,
      // No e2e run asks a real registry whether a newer bridge exists.
      BRIDGE_UPDATE_CHECK: "0",
      // The bundled claude adapter is tried before PATH: point the runner at the stub instead.
      BRIDGE_CLAUDE_ADAPTER: path.join(this.binDir, "claude-agent-acp"),
      // Children's temp dir is on disk too (local CI's, else the scratch cache): never /tmp.
      TMPDIR: scratchRoot(),
      // The agents' own config dirs, as a person's shell would export them: decoys bridge must leave alone.
      CLAUDE_CONFIG_DIR: this.decoys.claudeConfigDir,
      CODEX_HOME: this.decoys.codexHomeDir,
      ...extra,
    };
  }

  /** Where the seams entry (`fixtures/bridge-cli.mjs`) records the URLs `bridge` would open in a browser. */
  get openedUrlsFile(): string {
    return path.join(this.root, "opened-urls.txt");
  }

  /** The URLs `bridge` would have opened in a browser, in order (only processes started with `seams`). */
  async openedUrls(): Promise<string[]> {
    return (await readFile(this.openedUrlsFile, "utf8").catch(() => "")).split("\n").filter(Boolean);
  }

  /**
   * Starts `bridge <args>` and returns at once. With `seams` it runs the real CLI through `fixtures/bridge-cli.mjs`,
   * which adds what a pipe cannot give: `tty: true` is a person at a terminal (prompts are asked and answered
   * with `write("y\n")` when they appear), opened URLs are recorded (`openedUrls`), `E2E_IDLE_MS` and
   * `E2E_PEER_GONE_MS` shorten the runner's timers. Without it the process is `main.js`, no terminal.
   */
  start(args: string[], env: Record<string, string> = {}, options: { seams?: boolean; tty?: boolean; entry?: string } = {}): BridgeProcess {
    const seams = options.entry === undefined && (options.seams === true || options.tty === true);
    // Another seams entry (`containment-cli.mjs`) takes `E2E_TTY` the same way.
    const entry = options.entry ?? (seams ? SEAMS_MAIN : BRIDGE_MAIN);
    const extra = seams ? { E2E_OPENED_URLS: this.openedUrlsFile, ...(options.tty ? { E2E_TTY: "1" } : {}), ...env } : { ...(options.tty ? { E2E_TTY: "1" } : {}), ...env };
    const child = spawn(process.execPath, [entry, ...args], { env: this.env(extra), stdio: ["pipe", "pipe", "pipe"] });
    const proc = track(child);
    this.children.push(proc);
    return proc;
  }

  /** Runs `bridge <args>` to completion, answering its prompts with `input`. */
  async exec(args: string[], input = "", env: Record<string, string> = {}, options: { entry?: string; tty?: boolean } = {}): Promise<Finished> {
    const proc = this.start(args, env, options);
    proc.write(input);
    return proc.exited;
  }

  /** Number of entries the fake keychain holds (one file each, for both fakes). */
  async keychainEntries(): Promise<number> {
    return (await readdir(this.keychainDir).catch(() => [])).length;
  }

  /** The entries the fake keychain holds: the attributes they were stored under, and the secret. */
  async keychainContents(): Promise<{ attributes: Record<string, string>; secret: string }[]> {
    const files = (await readdir(this.keychainDir).catch(() => [])).sort();
    return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(this.keychainDir, f), "utf8"))));
  }

  /** `dirs` (default: home, config, data, keychain; the shims and the seam files are left out) as a `Snapshot`. */
  async snapshot(dirs: string[] = [this.home, this.configDir, this.dataDir, this.keychainDir]): Promise<Snapshot> {
    const out: Snapshot = {};
    const walk = async (p: string): Promise<void> => {
      const key = path.relative(this.root, p);
      const info = await lstat(p).catch(() => undefined);
      if (!info) return;
      if (info.isSymbolicLink()) out[key] = `link ${await readlink(p)}`;
      else if (info.isDirectory()) {
        out[key] = "dir";
        for (const name of (await readdir(p)).sort()) await walk(path.join(p, name));
      } else out[key] = `file ${createHash("sha256").update(await readFile(p)).digest("hex")} ${(info.mode & 0o777).toString(8)}`;
    };
    for (const d of dirs) await walk(d);
    return out;
  }

  /** The decoy agent dirs as a `Snapshot`: equal before and after means bridge wrote and removed nothing there. */
  protectedSnapshot(): Promise<Snapshot> {
    return this.snapshot([this.decoys.claudeHome, this.decoys.codexHome, this.decoys.claudeConfigDir, this.decoys.codexHomeDir]);
  }

  /** Files under `dirs` (default: config, data, state, the places bridge writes) whose text contains `needle`, relative to the root. */
  async filesContaining(needle: string, dirs: string[] = [this.configDir, this.dataDir, path.join(this.home, ".local")]): Promise<string[]> {
    const hits: string[] = [];
    const walk = async (p: string): Promise<void> => {
      const info = await lstat(p).catch(() => undefined);
      if (!info || info.isSymbolicLink()) return;
      if (info.isDirectory()) for (const name of await readdir(p)) await walk(path.join(p, name));
      else if ((await readFile(p)).includes(needle)) hits.push(path.relative(this.root, p));
    };
    for (const d of dirs) await walk(d);
    return hits.sort();
  }

  async dispose(): Promise<void> {
    await Promise.all(this.children.map((c) => c.stop()));
    await rm(this.root, { recursive: true, force: true });
  }
}
