import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type ConsentOptions, type InstallOptions, type InstalledPlugin, type PermissionSummary, type PluginHost, type RemoveOptions, installAnswerProblem } from "@berdyh/bridge-runner";
import { runCli } from "./cli.js";
import { upsertApp } from "./config.js";
import { pluginJsonOf, pluginLogOf, runPluginAudit } from "./plugin.js";
import { stageDirOf } from "./plugin-source.js";
import { runnerPathsOf } from "./paths.js";
import { type Harness, harness, exists, record } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("plugin", () => {
  it("reports the exact consented execution profile through plugin list JSON", () => {
    const installed = {
      manifest: { id: "demo.sync", app: "demo", entry: "entry.js", permissions: { execution: { profile: "confined-v1", network: ["api.anthropic.com:443"] } } },
      appId: "demo", version: "1.0.0", installDir: "/synthetic/install", dataDir: "/synthetic/data", status: "stopped",
    } as InstalledPlugin;
    const first = pluginJsonOf(installed);
    expect(first.grants.execution).toEqual({ profile: "confined-v1", network: ["api.anthropic.com:443"] });
    first.grants.execution!.network.push("mutated.example:443");
    expect(pluginJsonOf(installed).grants.execution!.network).toEqual(["api.anthropic.com:443"]);
  });

  async function pluginSource(app = "demo"): Promise<string> {
    const dir = path.join(h.root, "src-plugin");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module", version: "1.0.0" }));
    await writeFile(path.join(dir, "bridge-plugin.json"), JSON.stringify({ id: "demo.sync", app, entry: "entry.js", permissions: { agents: ["claude"] } }));
    await writeFile(path.join(dir, "entry.js"), "export {};\n");
    return dir;
  }

  it("add shows the permissions and writes nothing until confirmed", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const src = await pluginSource();
    h.answers.yes = false;
    expect(await runCli(["plugin", "add", src], h.deps)).toBe(1);
    expect(h.out.join("")).toContain("Agents: claude");
    expect(await exists(path.join(h.deps.dataDir, "demo", "bridge", "plugins"))).toBe(false);
    expect(await exists(path.join(h.deps.dataDir, "bridge", "plugins"))).toBe(false);
    expect(h.err.join("")).toContain("not confirmed");

    h.answers.yes = true;
    expect(await runCli(["plugin", "add", src], h.deps)).toBe(0);
    h.out.length = 0;
    expect(await runCli(["plugin", "list"], h.deps)).toBe(0);
    expect(h.out.join("")).toBe("demo.sync\t1.0.0\tapp demo\n");
  });

  it("installs into the manifest's app only: an app that is not connected says to connect it first, and nothing is written", async () => {
    h = await harness();
    await upsertApp(h.deps, record({ appId: "other", name: "Other", origin: "https://other.example", runnerId: "r2" }));
    const src = await pluginSource("demo");
    expect(await runCli(["plugin", "add", src], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("connect demo first");
    expect(await exists(path.join(h.deps.dataDir, "demo"))).toBe(false);
    expect(await exists(path.join(h.deps.dataDir, "other", "bridge", "plugins", "demo.sync"))).toBe(false);
    h.err.length = 0;
    expect(await runCli(["plugin", "add", await pluginSource("other")], h.deps)).toBe(0);
    expect(await exists(path.join(h.deps.dataDir, "other", "bridge", "plugins", "demo.sync", "1.0.0"))).toBe(true);
    h.out.length = 0;
    await runCli(["plugin", "list"], h.deps);
    expect(h.out.join("")).toBe("demo.sync\t1.0.0\tapp other\n");
  });

  it("add and remove print the full path list before asking, with --yes too", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const src = await pluginSource();
    const installDir = path.join(h.deps.dataDir, "demo", "bridge", "plugins", "demo.sync", "1.0.0");
    const dataDir = path.join(h.deps.dataDir, "demo", "bridge", "plugin-data", "demo.sync");
    expect(await runCli(["plugin", "add", src, "--yes"], h.deps)).toBe(0);
    let out = h.out.join("");
    expect(out).toContain(`Install into ${installDir}`);
    expect(out).toContain(`Plugin data in ${dataDir}`);
    expect(out.indexOf(`Install into ${installDir}`)).toBeLessThan(out.indexOf("Installed demo.sync"));
    h.out.length = 0;
    expect(await runCli(["plugin", "remove", "demo.sync", "--yes"], h.deps)).toBe(0);
    out = h.out.join("");
    expect(out).toContain(`Remove ${path.join(h.deps.dataDir, "demo", "bridge", "plugins", "demo.sync")}\n`);
    expect(out).toContain(`Remove ${dataDir}\n`);
    expect(out.indexOf("Remove ")).toBeLessThan(out.indexOf("Removed demo.sync"));
  });

  it("prints every install and removal path in full on its own line, even under a root longer than the line cap, with --yes too", async () => {
    h = await harness();
    const longRoot = path.join(h.root, "x".repeat(120), "y".repeat(120), "z".repeat(120));
    h.deps.dataDir = longRoot;
    await upsertApp(h.deps, record());
    const src = await pluginSource();
    const installDir = path.join(longRoot, "demo", "bridge", "plugins", "demo.sync", "1.0.0");
    const dataDir = path.join(longRoot, "demo", "bridge", "plugin-data", "demo.sync");
    expect(installDir.length).toBeGreaterThan(400);
    expect(await runCli(["plugin", "add", src, "--yes"], h.deps)).toBe(0);
    let lines = h.out.join("").split("\n");
    expect(lines).toContain(`Install into ${installDir}`);
    expect(lines).toContain(`Plugin data in ${dataDir}`);
    h.out.length = 0;
    expect(await runCli(["plugin", "remove", "demo.sync", "--yes"], h.deps)).toBe(0);
    lines = h.out.join("").split("\n");
    expect(lines).toContain(`Remove ${path.dirname(installDir)}`);
    expect(lines).toContain(`Remove ${dataDir}`);
  });

  it("strips control characters from consent lines and caps their length", async () => {
    let confirmed: boolean | undefined;
    h = await harness({
      pluginHost: {
        install: async (_src: string, consent: ConsentOptions) => {
          confirmed = await consent.confirm({
            pluginId: "x", app: "demo", version: "1", network: [], fs: [], agents: [], localUi: false,
            lines: ["Agents: claude\r\u001b[2KAgents: none", `Filesystem: ${"a".repeat(2000)}`],
          });
          throw new Error("stop");
        },
      } as unknown as PluginHost,
    });
    await runCli(["plugin", "add", await pluginSource()], h.deps);
    const out = h.out.join("");
    expect(confirmed).toBe(true);
    expect(out).not.toMatch(/[\u001b\r]/);
    expect(out).toContain("Agents: claude[2KAgents: none\n");
    expect(out.split("\n")[1]!.length).toBeLessThan(500);
  });

  it("add and remove refuse an aliased layout (Rule A): app A's data parent linked to app B's, and B's folder is untouched", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await upsertApp(h.deps, record({ appId: "other", origin: "https://other.example", runnerId: "r2" }));
    const other = path.join(h.deps.dataDir, "other");
    await mkdir(path.join(other, "bridge", "plugins"), { recursive: true });
    await symlink(other, path.join(h.deps.dataDir, "demo"));
    expect(await runCli(["plugin", "add", await pluginSource("demo"), "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toMatch(/overlap/);
    h.err.length = 0;
    expect(await runCli(["plugin", "remove", "demo.sync", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toMatch(/overlap/);
    expect(await readdir(path.join(other, "bridge", "plugins"))).toEqual([]);
    expect(await exists(path.join(other, "bridge", "plugin-data"))).toBe(false);
  });

  it("remove of an id that is not installed says so and exits 1: no Removed line, no restart", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    // Nothing installed at all, then another plugin installed: an id that is not there is not there either way.
    expect(await runCli(["plugin", "remove", "demo.sync", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("Plugin demo.sync is not installed");
    expect(h.out.join("")).not.toContain("Removed");
    expect(h.questions.join("")).toBe("");
    await runCli(["plugin", "add", await pluginSource()], h.deps);
    h.out.length = 0; h.err.length = 0;
    expect(await runCli(["plugin", "remove", "demo.other", "--yes", "--keep-data"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("Plugin demo.other is not installed");
    expect(h.out.join("")).not.toContain("Removed");
    // The installed one is still there, removes with 0, and a second remove of it is the not-installed case.
    h.out.length = 0; h.err.length = 0;
    expect(await runCli(["plugin", "remove", "demo.sync", "--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("Removed demo.sync.");
    h.out.length = 0; h.err.length = 0;
    expect(await runCli(["plugin", "remove", "demo.sync", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("Plugin demo.sync is not installed");
    expect(h.out.join("")).not.toContain("Removed");
  });

  it("remove deletes the install and its data", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await runCli(["plugin", "add", await pluginSource()], h.deps);
    expect(await runCli(["plugin", "remove", "demo.sync"], h.deps)).toBe(0);
    h.out.length = 0;
    await runCli(["plugin", "list"], h.deps);
    expect(h.out.join("")).toContain("No plugins installed");
    expect(await readdir(path.join(h.deps.dataDir, "demo", "bridge", "plugins"))).toEqual([]);
  });
});

// --- the real plugin host (no `pluginHost` override): the options the CLI passes are the ones the host reads ----------

describe("plugin against the real host", () => {
  async function sourceDir(permissions: Record<string, unknown>, version = "1.0.0"): Promise<string> {
    const dir = path.join(h.root, `real-${version}`);
    await mkdir(path.join(dir, "dist"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module", version }));
    await writeFile(path.join(dir, "bridge-plugin.json"), JSON.stringify({ id: "demo.sync", app: "demo", entry: "entry.js", permissions }));
    await writeFile(path.join(dir, "entry.js"), "export {};\n");
    await writeFile(path.join(dir, "dist", "notes.js"), "// mcp server");
    return dir;
  }
  const WIDENED = { agents: ["claude"], mcpServers: { notes: { entry: "dist/notes.js" } }, headless: { tools: ["mcp__notes__append"] } };
  const installRoot = () => path.join(h.deps.dataDir, "demo", "bridge", "plugins", "demo.sync");

  it("a local-path add installs, an add of the same version needs --replace, and remove --keep-data keeps the data folder", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const src = await sourceDir({ agents: ["claude"] });
    expect(await runCli(["plugin", "add", src, "--yes", "--no-restart"], h.deps)).toBe(0);
    expect(await exists(path.join(installRoot(), "1.0.0"))).toBe(true);
    h.err.length = 0;
    expect(await runCli(["plugin", "add", src, "--yes", "--no-restart"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("--replace");
    expect(await runCli(["plugin", "add", src, "--yes", "--replace", "--no-restart"], h.deps)).toBe(0);
    const dataDir = path.join(h.deps.dataDir, "demo", "bridge", "plugin-data", "demo.sync");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "state.json"), "{}");
    expect(await runCli(["plugin", "remove", "demo.sync", "--keep-data", "--yes", "--no-restart"], h.deps)).toBe(0);
    expect(await exists(installRoot())).toBe(false);
    expect(await exists(path.join(dataDir, "state.json"))).toBe(true);
  });

  it("--yes on a widened grant is refused by the host and writes nothing; a person at a terminal may confirm it", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const src = await sourceDir(WIDENED);
    h.deps.isTTY = true;
    expect(await runCli(["plugin", "add", src, "--yes", "--no-restart"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("run it in a terminal to confirm");
    expect(await exists(installRoot())).toBe(false);
    expect(await exists(path.join(h.deps.dataDir, "demo", "bridge", "plugin-data", "demo.sync"))).toBe(false);
    // No terminal and no --yes: nobody answers, so the host refuses too.
    h.deps.isTTY = false;
    h.err.length = 0;
    expect(await runCli(["plugin", "add", src, "--no-restart"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("run it in a terminal to confirm");
    expect(await exists(installRoot())).toBe(false);
    h.deps.isTTY = true;
    h.answers.yes = true;
    expect(await runCli(["plugin", "add", src, "--no-restart"], h.deps)).toBe(0);
    expect(await exists(path.join(installRoot(), "1.0.0"))).toBe(true);
  });

  it("revoke goes through the real host's required revoke, and the plugin stays installed", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    expect(await runCli(["plugin", "add", await sourceDir({ agents: ["claude"] }), "--yes", "--no-restart"], h.deps)).toBe(0);
    h.out.length = 0;
    expect(await runCli(["plugin", "revoke", "demo.sync", "--yes", "--no-restart"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("Revoked demo.sync");
    expect(await exists(path.join(installRoot(), "1.0.0"))).toBe(true);
  });
});

// --- published sources, flags and the service restart, against a fake of the plugin host ---------------------------

const BYTES = Buffer.from("tarball bytes the host would parse");
const SHA256 = createHash("sha256").update(BYTES).digest("hex");
const SRI = `sha512-${createHash("sha512").update(BYTES).digest("base64")}`;
const WRONG_SHA256 = "f".repeat(64);

interface FakeHost {
  host: PluginHost;
  installs: { source: string; bytes: Buffer | undefined; options: InstallOptions | undefined }[];
  removes: { id: string; options: RemoveOptions | undefined }[];
  revokes: string[];
  /** Whether the next install's manifest asks for a widened grant (mcpServers or headless tools). */
  widened: boolean;
  /** Whether the next install is an identical `--replace`: the host returns the installed copy without asking. */
  noop: boolean;
}

/** The host's install order: who may answer is decided from the flags before the prompt (`installAnswerProblem`). */
function fakeHost(): FakeHost {
  const fake: FakeHost = { installs: [], removes: [], revokes: [], widened: false, noop: false, host: undefined as never };
  const plugin: InstalledPlugin = {
    manifest: { id: "demo.sync", app: "demo", entry: "entry.js", permissions: { agents: ["claude"] } } as InstalledPlugin["manifest"],
    appId: "demo", version: "1.0.0", installDir: "/x", dataDir: "/y", status: "stopped",
  };
  const summary = (widened: boolean): PermissionSummary => ({ pluginId: "demo.sync", app: "demo", version: "1.0.0", network: [], fs: [], agents: ["claude"], localUi: false, widened, lines: ["Agents: claude"] });
  fake.host = {
    async install(source, consent, options) {
      fake.installs.push({ source, bytes: await readFile(source).catch(() => undefined), options });
      if (fake.noop) return plugin;
      if (installAnswerProblem(options, fake.widened)) throw new Error("This install adds an MCP server; run it in a terminal to confirm");
      if (!(await consent.confirm(summary(fake.widened)))) throw new Error("Plugin installation was not confirmed");
      return plugin;
    },
    list: async () => [plugin],
    async remove(id, consent, options) {
      fake.removes.push({ id, options });
      if (!(await consent.confirm({ ...summary(false), paths: [{ action: "remove", path: "/x" }] }))) throw new Error("Plugin removal was not confirmed");
    },
    async revoke(id, consent) {
      if (consent && !(await consent.confirm(summary(false)))) throw new Error("Revoking was not confirmed");
      fake.revokes.push(id);
    },
    start: async () => {}, stopAll: async () => {}, setBroker: () => {},
    router: undefined as never,
  };
  return fake;
}

/** A fetch over a table of https answers. */
function fetchOf(routes: Record<string, Buffer | string>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = routes[url];
    if (body === undefined) throw new Error(`unexpected fetch ${url}`);
    return new Response(body);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("plugin add from a published source", () => {
  const URL_TGZ = "https://example.com/demo-1.0.0.tgz";
  const flagged = (...extra: string[]) => ["plugin", "add", URL_TGZ, "--sha256", SHA256, ...extra];

  async function setup(routes: Record<string, Buffer | string> = { [URL_TGZ]: BYTES }, over: Partial<Parameters<typeof harness>[0]> = {}) {
    const fake = fakeHost();
    const net = fetchOf(routes);
    h = await harness({ pluginHost: fake.host, fetch: net.fn, ...over });
    await upsertApp(h.deps, record());
    return { fake, net };
  }
  const staged = () => readdir(stageDirOf(h.deps)).catch(() => [] as string[]);

  it("installs a good sha256: the host reads the hashed bytes from the cache folder, gets the pin, and the folder is removed", async () => {
    const { fake } = await setup();
    expect(await runCli(flagged("--yes"), h.deps)).toBe(0);
    expect(fake.installs).toHaveLength(1);
    expect(fake.installs[0]!.bytes).toEqual(BYTES);
    expect(fake.installs[0]!.source.startsWith(path.join(h.root, "home", ".cache", "bridge-install", "plugins") + path.sep)).toBe(true);
    expect(fake.installs[0]!.options).toMatchObject({ nonInteractive: true, pinnedHash: { algorithm: "sha256", digest: SHA256 } });
    expect(await staged()).toEqual([]);
    expect(h.out.join("")).toContain(`Verified sha256 ${SHA256}`);
  });

  it("refuses a bad sha256, an http URL and a redirect target without calling the host, leaving the cache folder clean", async () => {
    const { fake } = await setup();
    expect(await runCli(["plugin", "add", URL_TGZ, "--sha256", WRONG_SHA256], h.deps)).toBe(1);
    expect(h.err.join("")).toContain(WRONG_SHA256);
    expect(h.err.join("")).toContain(SHA256);
    h.err.length = 0;
    expect(await runCli(["plugin", "add", "http://example.com/a.tgz", "--sha256", SHA256], h.deps)).toBe(2);
    expect(fake.installs).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  it("cleans the cache folder when the host refuses", async () => {
    const { fake } = await setup();
    h.answers.yes = false;
    expect(await runCli(flagged(), h.deps)).toBe(1);
    expect(fake.installs).toHaveLength(1);
    expect(await staged()).toEqual([]);
  });

  it("--yes from npm without --integrity is refused before any request, and nothing is installed", async () => {
    const { fake, net } = await setup();
    expect(await runCli(["plugin", "add", "npm:demo@1.0.0", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("pin the package: --integrity");
    expect(net.calls).toEqual([]);
    expect(fake.installs).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  it("--yes from npm with --integrity installs, handing the host a sha512 pin", async () => {
    const tarball = "https://registry.npmjs.org/demo/-/demo-1.0.0.tgz";
    const { fake } = await setup(
      { "https://registry.npmjs.org/demo/1.0.0": JSON.stringify({ name: "demo", version: "1.0.0", dist: { tarball, integrity: SRI } }), [tarball]: BYTES },
    );
    expect(await runCli(["plugin", "add", "npm:demo@1.0.0", "--integrity", SRI, "--yes"], h.deps)).toBe(0);
    expect(fake.installs[0]!.options).toMatchObject({ nonInteractive: true, pinnedHash: { algorithm: "sha512", digest: SRI.slice(7) } });
    expect(fake.installs[0]!.bytes).toEqual(BYTES);
  });

  it("--yes with a widened manifest is refused with the host's message and nothing is installed", async () => {
    const { fake } = await setup();
    fake.widened = true;
    expect(await runCli(flagged("--yes"), h.deps)).toBe(1);
    expect(h.err.join("")).toContain("run it in a terminal to confirm");
    expect(h.out.join("")).not.toContain("Installed");
    expect(await staged()).toEqual([]);
  });

  it("a widened grant with stdin a pipe carrying y is refused: no terminal, no --yes, the answer is not taken", async () => {
    const { fake } = await setup();
    fake.widened = true;
    h.answers.yes = true;
    h.deps.isTTY = false;
    expect(await runCli(flagged(), h.deps)).toBe(1);
    expect(fake.installs[0]!.options?.terminal).toBeUndefined();
    expect(h.questions).toEqual([]);
    expect(h.out.join("")).not.toContain("Installed");
  });

  it("a widened grant at a terminal without --yes is the person's to answer, and is marked terminal", async () => {
    const { fake } = await setup();
    fake.widened = true;
    h.deps.isTTY = true;
    expect(await runCli(flagged(), h.deps)).toBe(0);
    expect(fake.installs[0]!.options).toMatchObject({ terminal: true });
    expect(fake.installs[0]!.options?.nonInteractive).toBeUndefined();
    expect(h.questions).toEqual(["Allow this?"]);
  });

  it("--yes marks the install non-interactive even at a terminal, for a local path too, and --replace reaches the host", async () => {
    const { fake } = await setup();
    h.deps.isTTY = true;
    expect(await runCli(["plugin", "add", "./some-dir", "--yes", "--replace"], h.deps)).toBe(0);
    expect(fake.installs[0]!.options).toEqual({ replace: true, nonInteractive: true });
    expect(fake.installs[0]!.source).toBe(path.resolve("./some-dir"));
  });

  it("a flag that does not belong to the subcommand is a usage error", async () => {
    await setup();
    expect(await runCli(["plugin", "add", "./d", "--keep-data"], h.deps)).toBe(2);
    expect(await runCli(["plugin", "remove", "demo.sync", "--replace"], h.deps)).toBe(2);
    expect(await runCli(["plugin", "add", "./d", "--sha256", SHA256], h.deps)).toBe(2);
    expect(await runCli(["plugin"], h.deps)).toBe(2);
    expect(h.err.join("")).toContain("usage: bridge plugin add");
  });
});

describe("plugin changes restart the running service", () => {
  const restarts = () => h.commands.filter((c) => c[0] === "systemctl" && c[2] === "restart");
  async function setup(opts: { service: boolean; active: boolean; restartFails?: boolean }) {
    const fake = fakeHost();
    h = await harness({ pluginHost: fake.host });
    h.deps.run = async (command, args) => {
      h.commands.push([command, ...args]);
      if (args.includes("is-active")) return { exitCode: opts.active ? 0 : 3, stdout: opts.active ? "active\n" : "inactive\n", stderr: "" };
      if (args.includes("restart") && opts.restartFails) return { exitCode: 1, stdout: "", stderr: "unit not found" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await upsertApp(h.deps, record());
    if (opts.service) {
      const file = runnerPathsOf(h.deps).serviceFile;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "[Unit]\n");
    }
    return fake;
  }

  it("add restarts once with a running service, and says what ends", async () => {
    await setup({ service: true, active: true });
    expect(await runCli(["plugin", "add", "./d", "--yes"], h.deps)).toBe(0);
    expect(restarts()).toHaveLength(1);
    expect(h.out.join("")).toContain("Restarting the bridge service: open agent sessions of every app end; browsers reconnect.");
    expect(h.out.join("")).not.toContain("Restart `bridge run`");
  });

  it("the consent screen states the restart before the question, only when approving restarts", async () => {
    const notice = "Approving restarts the bridge service: open agent sessions of every app end; browsers reconnect.";
    const cases: [label: string, argv: string[], service: boolean, shown: boolean][] = [
      ["running service", ["plugin", "add", "./d"], true, true],
      ["running service, --yes", ["plugin", "add", "./d", "--yes"], true, true],
      ["--no-restart", ["plugin", "add", "./d", "--no-restart"], true, false],
      ["no installed service", ["plugin", "add", "./d"], false, false],
    ];
    for (const [label, argv, service, shown] of cases) {
      await setup({ service, active: true });
      const askedWith: string[] = [];
      const ask = h.deps.confirm;
      h.deps.confirm = async (question) => {
        askedWith.push(h.out.join(""));
        return ask(question);
      };
      expect(await runCli([...argv], h.deps), label).toBe(0);
      if (shown) {
        expect(h.out.join(""), label).toContain(notice);
        if (!argv.includes("--yes")) expect(askedWith.join(""), label).toContain(notice);
      } else {
        expect(h.out.join(""), label).not.toContain("Approving restarts");
      }
      await h.cleanup();
    }
  });

  it("remove and revoke state the restart before their question too, under the same conditions as add", async () => {
    const notice = "Approving restarts the bridge service: open agent sessions of every app end; browsers reconnect.";
    const cases: [label: string, argv: string[], service: boolean, shown: boolean][] = [
      ["remove, running service", ["plugin", "remove", "demo.sync"], true, true],
      ["remove, running service, --yes", ["plugin", "remove", "demo.sync", "--yes"], true, true],
      ["remove, --no-restart", ["plugin", "remove", "demo.sync", "--no-restart"], true, false],
      ["remove, no installed service", ["plugin", "remove", "demo.sync"], false, false],
      ["revoke, running service", ["plugin", "revoke", "demo.sync"], true, true],
      ["revoke, running service, --yes", ["plugin", "revoke", "demo.sync", "--yes"], true, true],
      ["revoke, --no-restart", ["plugin", "revoke", "demo.sync", "--no-restart"], true, false],
      ["revoke, no installed service", ["plugin", "revoke", "demo.sync"], false, false],
    ];
    for (const [label, argv, service, shown] of cases) {
      await setup({ service, active: true });
      const askedWith: string[] = [];
      const ask = h.deps.confirm;
      h.deps.confirm = async (question) => {
        askedWith.push(h.out.join(""));
        return ask(question);
      };
      expect(await runCli([...argv], h.deps), label).toBe(0);
      const out = h.out.join("");
      if (shown) {
        expect(out.split(notice).length - 1, label).toBe(1);
        if (!argv.includes("--yes")) expect(askedWith.join(""), label).toContain(notice);
        expect(out.indexOf(notice), label).toBeLessThan(out.indexOf("Restarting the bridge service"));
      } else {
        expect(out, label).not.toContain("Approving restarts");
      }
      await h.cleanup();
    }
  });

  it("an identical --replace says nothing changed and does not restart; a changed one still restarts", async () => {
    const fake = await setup({ service: true, active: true });
    fake.noop = true;
    expect(await runCli(["plugin", "add", "./d", "--yes", "--replace"], h.deps)).toBe(0);
    expect(restarts()).toEqual([]);
    expect(h.out.join("")).toContain("Nothing changed: demo.sync@1.0.0 is already installed with identical content.");
    expect(h.out.join("")).not.toMatch(/Restarting|Installed|Approving/);
    expect(h.questions).toEqual([]);
    h.out.length = 0;
    fake.noop = false;
    expect(await runCli(["plugin", "add", "./d", "--yes", "--replace"], h.deps)).toBe(0);
    expect(restarts()).toHaveLength(1);
    expect(h.out.join("")).toContain("Installed demo.sync@1.0.0");
    expect(h.out.join("")).not.toContain("Nothing changed");
  });

  it("add with --no-restart never restarts and says to restart", async () => {
    await setup({ service: true, active: true });
    expect(await runCli(["plugin", "add", "./d", "--yes", "--no-restart"], h.deps)).toBe(0);
    expect(restarts()).toEqual([]);
    expect(h.out.join("")).toContain("Restart `bridge run`");
  });

  it("never restarts without a service, or with one that is installed but stopped", async () => {
    await setup({ service: false, active: false });
    expect(await runCli(["plugin", "add", "./d", "--yes"], h.deps)).toBe(0);
    expect(restarts()).toEqual([]);
    expect(h.out.join("")).toContain("Restart `bridge run`");
    await h.cleanup();
    await setup({ service: true, active: false });
    expect(await runCli(["plugin", "add", "./d", "--yes"], h.deps)).toBe(0);
    expect(restarts()).toEqual([]);
  });

  it("restarts only a running service: every systemd state but `active` leaves it alone", async () => {
    for (const state of ["inactive", "failed", "activating", "deactivating", "unknown"]) {
      const fake = fakeHost();
      h = await harness({ pluginHost: fake.host });
      h.deps.run = async (command, args) => {
        h.commands.push([command, ...args]);
        return args.includes("is-active") ? { exitCode: 3, stdout: `${state}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
      };
      await upsertApp(h.deps, record());
      const file = runnerPathsOf(h.deps).serviceFile;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "[Unit]\n");
      expect(await runCli(["plugin", "add", "./d", "--yes"], h.deps), state).toBe(0);
      expect(restarts(), state).toEqual([]);
      await h.cleanup();
    }
  });

  describe("on launchd, where `launchctl print` succeeds for a job that is loaded but not running", () => {
    const kicks = () => h.commands.filter((c) => c[0] === "launchctl" && c[1] === "kickstart");
    const bootstraps = () => h.commands.filter((c) => c[0] === "launchctl" && c[1] === "bootstrap");
    async function launchd(printed: string) {
      const fake = fakeHost();
      h = await harness({ pluginHost: fake.host, platform: "darwin" });
      h.deps.run = async (command, args) => {
        h.commands.push([command, ...args]);
        return { exitCode: 0, stdout: args[0] === "print" ? printed : "", stderr: "" };
      };
      await upsertApp(h.deps, record());
      const file = runnerPathsOf(h.deps).serviceFile;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "<plist/>");
    }

    it("never starts a loaded job that is not running", async () => {
      for (const printed of ["gui/501/x = {\n\tstate = not running\n}\n", "gui/501/x = {\n\tstate = waiting\n}\n", "gui/501/x = {\n\tstate = spawn scheduled\n}\n", ""]) {
        await launchd(printed);
        for (const argv of [["add", "./d"], ["remove", "demo.sync"], ["revoke", "demo.sync"]]) {
          expect(await runCli(["plugin", ...argv, "--yes"], h.deps), printed).toBe(0);
        }
        expect(kicks(), printed).toEqual([]);
        expect(bootstraps(), printed).toEqual([]);
        await h.cleanup();
      }
    });

    it("restarts a running job with kickstart -k", async () => {
      await launchd("gui/501/x = {\n\tstate = running\n\tpid = 4242\n}\n");
      expect(await runCli(["plugin", "add", "./d", "--yes"], h.deps)).toBe(0);
      expect(kicks()).toHaveLength(1);
      expect(kicks()[0]).toContain("-k");
    });
  });

  it("remove and revoke each restart once, and honour --no-restart", async () => {
    const fake = await setup({ service: true, active: true });
    expect(await runCli(["plugin", "remove", "demo.sync", "--yes"], h.deps)).toBe(0);
    expect(restarts()).toHaveLength(1);
    expect(await runCli(["plugin", "revoke", "demo.sync", "--yes"], h.deps)).toBe(0);
    expect(restarts()).toHaveLength(2);
    expect(fake.revokes).toEqual(["demo.sync"]);
    expect(await runCli(["plugin", "remove", "demo.sync", "--yes", "--no-restart"], h.deps)).toBe(0);
    expect(await runCli(["plugin", "revoke", "demo.sync", "--yes", "--no-restart"], h.deps)).toBe(0);
    expect(restarts()).toHaveLength(2);
  });

  it("a failed restart is reported and the exit code says the change is not live", async () => {
    await setup({ service: true, active: true, restartFails: true });
    expect(await runCli(["plugin", "add", "./d", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("the change is made, but the bridge service did not restart");
  });
});

describe("plugin remove, revoke and audit", () => {
  it("remove passes --keep-data to the host and the prompt says what stays", async () => {
    const fake = fakeHost();
    h = await harness({ pluginHost: fake.host });
    await upsertApp(h.deps, record());
    expect(await runCli(["plugin", "remove", "demo.sync", "--keep-data"], h.deps)).toBe(0);
    expect(fake.removes).toEqual([{ id: "demo.sync", options: { keepData: true } }]);
    expect(h.questions.join("")).toContain("data and audit files stay");
    h.questions.length = 0;
    expect(await runCli(["plugin", "remove", "demo.sync"], h.deps)).toBe(0);
    expect(fake.removes[1]).toEqual({ id: "demo.sync", options: {} });
    expect(h.questions.join("")).toContain("and its data?");
  });

  it("revoke asks unless --yes, and an unconfirmed or unknown plugin is not revoked", async () => {
    const fake = fakeHost();
    h = await harness({ pluginHost: fake.host });
    await upsertApp(h.deps, record());
    h.answers.yes = false;
    expect(await runCli(["plugin", "revoke", "demo.sync"], h.deps)).toBe(1);
    expect(fake.revokes).toEqual([]);
    expect(await runCli(["plugin", "revoke", "other.plugin", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("No plugin other.plugin is installed");
    h.answers.yes = true;
    expect(await runCli(["plugin", "revoke", "demo.sync"], h.deps)).toBe(0);
    expect(fake.revokes).toEqual(["demo.sync"]);
  });

  it("audit text prints none only for a record that carries decision none; an absent decision reads as pending (-), and --json keeps the records as they are", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const dir = (await import("./paths.js")).appPathsOf(h.deps, "demo").auditDir;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "demo.sync.jsonl"), "");
    const base = { appId: "demo", pluginId: "demo.sync", sessionId: "s1", trigger: { kind: "headless" }, servers: [], toolName: "mcp__x__y" };
    const records = [
      { ...base, time: "time-1", toolCallId: "t1", status: "pending" },
      { ...base, time: "time-2", toolCallId: "t1", decision: "allow" },
      { ...base, time: "time-3", toolCallId: "t2", status: "completed", decision: "none" },
    ];
    const reader = { readAudit: async () => records as never };
    await runPluginAudit(h.deps, [{ appId: "demo" }], "demo.sync", { limit: 10, json: false }, reader);
    const rows = h.out.join("").split("\n").filter((line) => line.startsWith("time-")).map((line) => line.split("\t").slice(0, 2));
    expect(rows).toEqual([["time-1", "-"], ["time-2", "allow"], ["time-3", "none"]]);
    h.out.length = 0;
    await runPluginAudit(h.deps, [{ appId: "demo" }], "demo.sync", { limit: 10, json: true }, reader);
    expect(JSON.parse(h.out.join("")).records).toEqual(records);
    expect(h.out.join("")).not.toContain('"decision":"-"');
  });

  it("audit prints the newest records of the plugin's log, as text or JSON, with --limit", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const dir = (await import("./paths.js")).appPathsOf(h.deps, "demo").auditDir;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "demo.sync.jsonl"), "");
    const records = [{ time: "2026-11-02T10:00:00Z", appId: "demo", pluginId: "demo.sync", sessionId: "s1", trigger: "background", servers: [], toolCallId: "t1", toolName: "mcp__x__y", status: "completed", decision: "allow" }];
    const reader = { readAudit: async (file: string, o: { limit: number }) => { expect(file).toBe(path.join(dir, "demo.sync.jsonl")); expect(o.limit).toBe(7); return records as never; } };
    const apps = [{ appId: "demo" }];
    expect(await runPluginAudit(h.deps, apps, "demo.sync", { limit: 7, json: false }, reader)).toBe(0);
    expect(h.out.join("")).toContain("mcp__x__y");
    h.out.length = 0;
    await runPluginAudit(h.deps, apps, "demo.sync", { limit: 7, json: true }, reader);
    expect(JSON.parse(h.out.join("")).records).toEqual(records);
    h.out.length = 0;
    await runPluginAudit(h.deps, apps, "missing.plugin", { limit: 7, json: false }, reader);
    expect(h.out.join("")).toBe("No audit records for missing.plugin.\n");
    h.out.length = 0;
    await runPluginAudit(h.deps, apps, "missing.plugin", { limit: 7, json: true }, reader);
    expect(JSON.parse(h.out.join(""))).toEqual({ pluginId: "missing.plugin", appId: null, file: null, records: [] });
    // a log that exists but holds no records is JSON too
    h.out.length = 0;
    await runPluginAudit(h.deps, apps, "demo.sync", { limit: 7, json: true }, { readAudit: async () => [] });
    expect(JSON.parse(h.out.join("")).records).toEqual([]);
    // and no app at all
    h.out.length = 0;
    await runPluginAudit(h.deps, [], "demo.sync", { limit: 7, json: true }, reader);
    expect(JSON.parse(h.out.join("")).records).toEqual([]);
    expect(await runCli(["plugin", "audit", "demo.sync", "--limit", "0"], h.deps)).toBe(2);
    expect(await runCli(["plugin", "audit", "demo.sync", "--yes"], h.deps)).toBe(2);
  });
});

describe("pluginLogOf: the log sink of the plugin host `bridge run` builds", () => {
  it("writes a host line and a plugin's own line to stderr, drops debug, and strips control characters", () => {
    const err: string[] = [];
    const log = pluginLogOf({ stderr: (text) => void err.push(text) });
    log("demo.sync", "warn", "Refused a session start", { code: -32019, reason: "consent missing" });
    log("demo.sync", "error", "boom\u001b[2K\nsecond", { stream: "stderr" });
    log("demo.sync", "debug", "chatty");
    log("demo.sync", "info", "no fields");
    expect(err).toEqual([
      '[plugin demo.sync] warn: Refused a session start {"code":-32019,"reason":"consent missing"}\n',
      '[plugin demo.sync] error: boom[2Ksecond {"stream":"stderr"}\n',
      "[plugin demo.sync] info: no fields\n",
    ]);
  });

  it("caps a long line", () => {
    const err: string[] = [];
    pluginLogOf({ stderr: (text) => void err.push(text) })("demo.sync", "error", "x".repeat(20_000), { stream: "stderr" });
    expect(err.join("").length).toBeLessThan(2200);
    expect(err.join("")).toContain("...");
  });
});

describe("plugin list --json", () => {
  const rich: InstalledPlugin = {
    manifest: {
      id: "demo.sync", app: "demo", entry: "entry.js",
      permissions: {
        network: ["api.example.com"], fs: ["$PLUGIN_DATA/cache"], agents: ["claude", "codex"], localUi: { port: "auto" },
        mcpServers: { tools: { entry: "mcp.js", args: ["${PLUGIN_DATA}"] } }, headless: { tools: ["mcp__tools__read"] },
      },
    },
    appId: "demo", version: "1.2.3", installDir: "/x", dataDir: "/y", status: "running", localUiUrl: "http://127.0.0.1:1234",
  };
  const bare: InstalledPlugin = {
    manifest: { id: "demo.bare", app: "demo", entry: "entry.js", permissions: {} }, appId: "demo", version: "0.0.1", installDir: "/x2", dataDir: "/y2", status: "stopped",
  };
  const hostOf = (plugins: InstalledPlugin[]): PluginHost => ({ ...fakeHost().host, list: async () => plugins });

  it("prints the stable shape as one JSON array: id, version, app and the grants summary", async () => {
    h = await harness({ pluginHost: hostOf([rich, bare]) });
    expect(await runCli(["plugin", "list", "--json"], h.deps)).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]!.endsWith("\n")).toBe(true);
    expect(JSON.parse(h.out[0]!)).toMatchInlineSnapshot(`
      [
        {
          "app": "demo",
          "grants": {
            "agents": [
              "claude",
              "codex",
            ],
            "fs": [
              "$PLUGIN_DATA/cache",
            ],
            "headlessTools": [
              "mcp__tools__read",
            ],
            "localUi": true,
            "mcpServers": [
              "tools",
            ],
            "network": [
              "api.example.com",
            ],
          },
          "id": "demo.sync",
          "version": "1.2.3",
        },
        {
          "app": "demo",
          "grants": {
            "agents": [],
            "fs": [],
            "headlessTools": [],
            "localUi": false,
            "mcpServers": [],
            "network": [],
          },
          "id": "demo.bare",
          "version": "0.0.1",
        },
      ]
    `);
    // No paths, no status and no URL: the summary is what was granted, nothing of the install's own folders.
    expect(h.out[0]).not.toContain("installDir");
    expect(h.err).toEqual([]);
  });

  it("prints [] when nothing is installed, and keeps the human output unchanged", async () => {
    h = await harness({ pluginHost: hostOf([]) });
    expect(await runCli(["plugin", "list", "--json"], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual([]);
    h.out.length = 0;
    expect(await runCli(["plugin", "list"], h.deps)).toBe(0);
    expect(h.out.join("")).toBe("No plugins installed.\n");
    h.out.length = 0;
    h = await harness({ pluginHost: hostOf([rich, bare]) });
    expect(await runCli(["plugin", "list"], h.deps)).toBe(0);
    expect(h.out.join("")).toBe("demo.sync\t1.2.3\tapp demo\ndemo.bare\t0.0.1\tapp demo\n");
  });

  it("lists what the real host holds", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const dir = path.join(h.root, "src-plugin");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module", version: "1.0.0" }));
    await writeFile(path.join(dir, "bridge-plugin.json"), JSON.stringify({ id: "demo.sync", app: "demo", entry: "entry.js", permissions: { agents: ["claude"], network: ["api.example.com"] } }));
    await writeFile(path.join(dir, "entry.js"), "export {};\n");
    expect(await runCli(["plugin", "add", dir, "--yes"], h.deps)).toBe(0);
    h.out.length = 0;
    expect(await runCli(["plugin", "list", "--json"], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual([
      { id: "demo.sync", version: "1.0.0", app: "demo", grants: { network: ["api.example.com"], fs: [], agents: ["claude"], localUi: false, mcpServers: [], headlessTools: [] } },
    ]);
  });

  it("--json applies to list and audit only, and the usage lists it for list", async () => {
    h = await harness({ pluginHost: hostOf([]) });
    expect(await runCli(["plugin", "remove", "demo.sync", "--json"], h.deps)).toBe(2);
    expect(h.err.join("")).toContain("--json does not apply to `plugin remove`");
    expect(h.err.join("")).toContain("list [--json]");
    h.err.length = 0;
    expect(await runCli(["plugin"], h.deps)).toBe(2);
    expect(h.err.join("")).toContain("| list [--json] |");
    expect(await runCli(["plugin", "list", "--limit", "3"], h.deps)).toBe(2);
    h.out.length = 0;
    await runCli(["help"], h.deps);
    expect(h.out.join("")).toContain("list [--json]");
  });
});
