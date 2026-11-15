import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DECOY_SECRET, Machine, type BridgeProcess, type Snapshot } from "./machine.js";
import { HeadlessPage } from "./page.js";
import { collectingApp, deployApp, promptOnce, type AppDeployment } from "./world.js";

const ENROLL_PAGE = "/enroll";

/** The enroll link in `urls`: the app's enroll page with the code in the fragment (not the sign-in page). */
function enrollLinkOf(app: AppDeployment, urls: string[]): string {
  const link = urls.find((u) => u.startsWith(`${app.server.url}${ENROLL_PAGE}#`));
  if (!link) throw new Error(`no enroll link among the opened URLs: ${JSON.stringify(urls)}`);
  return link;
}

/** The enroll link once the opener has recorded it: setup prints "Opening <url>" before it calls the opener. */
async function openedEnrollLink(app: AppDeployment, machine: Machine, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const urls = await machine.openedUrls();
    if (urls.some((u) => u.startsWith(`${app.server.url}${ENROLL_PAGE}#`)) || Date.now() > deadline) return enrollLinkOf(app, urls);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The four words the terminal printed for the browser (`bridge setup` prints them two spaces apart). */
function terminalWords(output: string): string[] {
  const match = output.match(/^ {2}(\S+) {2}(\S+) {2}(\S+) {2}(\S+)$/m);
  if (!match) throw new Error(`no four words in the terminal output:\n${output}`);
  return match.slice(1, 5);
}

/** The paths in `after` that `before` did not have, with the random parts (sandbox name, keychain entry) named, sorted. */
function createdSince(before: Snapshot, after: Snapshot): string[] {
  return Object.keys(after)
    .filter((k) => !(k in before))
    .map((k) => k.replace(/bridge-acp-[A-Za-z0-9]+/, "bridge-acp-<id>").replace(/^keychain\/[0-9a-f]{64}\.json$/, "keychain/<entry>.json"))
    .sort();
}

/** The JSON event lines `--json` printed, in order. */
function eventsOf(output: string): Record<string, unknown>[] {
  return output.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("bridge setup on a terminal: one command, one question, no typed code, the browser it opened", () => {
  let app: AppDeployment;
  let machine: Machine;
  let page: HeadlessPage;
  let setup: BridgeProcess;
  let link = "";
  let pageWords: string[] = [];
  let shownWords: string[] = [];
  let enrolledKeyId = "";
  let runnerId = "";
  let preInstall: Snapshot;
  let agentDirsBefore: Snapshot;

  beforeAll(async () => {
    app = await deployApp("setup-app", { enrollPage: ENROLL_PAGE });
    // Nothing of bridge's yet: the tree as it is before anything is installed is what uninstall must restore.
    machine = await Machine.create({ defer: true });
    preInstall = await machine.snapshot();
    agentDirsBefore = await machine.protectedSnapshot();
    // The person's one-time steps before setup: `bridge agent login claude --copy` (bridge's own login) and the machine policy.
    await machine.stageBridgeFiles();
    // The page is open before anything is installed: nothing is known about a runner yet.
    page = await HeadlessPage.open(app);
  });
  afterAll(async () => {
    page?.close();
    await setup?.stop();
    await machine?.dispose();
    await app?.close();
  });

  it("starts with no runner", async () => {
    expect((await page.bridge.status()).state).toBe("no_runner");
  });

  it("connects, starts the runner in this terminal and opens the enroll page with the code in the link", async () => {
    setup = machine.start(["setup", app.server.url, "--foreground", "--no-install"], {}, { tty: true });
    // The person is at the terminal: every question is answered only once it is asked.
    await setup.waitFor(/Set up bridge for App setup-app at \S+\? \[Y\/n\]/, { stream: "stderr" });
    setup.write("y\n");
    await setup.waitFor(/Runner online\. Opening App setup-app's enroll page in your browser\./);
    link = await openedEnrollLink(app, machine);
    expect(link).toMatch(new RegExp(`^${app.server.url}${ENROLL_PAGE}#code=[A-Z0-9-]{8,12}&runner=\\S+$`));
    // The browser setup opened is trusted without the words, so the code and the link are not printed for anyone to paste elsewhere.
    const code = /#code=([^&]+)/.exec(link)![1]!;
    expect(setup.stdout() + setup.stderr()).not.toContain(code);
  });

  it("the page consumes the link (it never types the code), is trusted without a question, and the terminal shows its words and how to revoke it", async () => {
    const pairing = await page.pair(link);
    expect(page.fragmentAfterConsume, "consumeEnrollLink scrubs the code from the page URL").toBe("");
    pageWords = await pairing.words;
    expect(pageWords).toHaveLength(4);
    const enrolled = await pairing.enrolled;
    enrolledKeyId = enrolled.browserKeyId;
    runnerId = enrolled.runnerId;
    await setup.waitFor(/Trusting the browser '[^']*' that setup opened/);
    shownWords = terminalWords((await setup.waitFor(/^ {2}\S+ {2}\S+ {2}\S+ {2}\S+$/m))[0]);
    expect(shownWords).toEqual(pageWords);
    await setup.waitFor(/Ready: App setup-app can use your coding agent/);
    expect(setup.stdout()).toContain(`bridge browsers revoke setup-app ${enrolledKeyId}`);
  });

  it("status went no_runner, online_not_enrolled, ready", async () => {
    await page.waitForState("ready");
    expect(page.states).toEqual(["no_runner", "online_not_enrolled", "ready"]);
  });

  it("the browser is trusted and an ACP session runs", async () => {
    const listed = await machine.exec(["browsers", "list", "setup-app"]);
    expect(listed.stdout).toContain(enrolledKeyId);
    const updates: string[] = [];
    const connection = await page.bridge.acp(collectingApp(updates), runnerId);
    const answer = await promptOnce(connection, updates, machine.project, "after setup");
    expect(answer.stopReason).toBe("end_turn");
    expect(answer.text).toMatch(/^agent\[\d+\] echo: after setup$/);
  });

  it("asked exactly one question", () => {
    // Every question setup asked is on stderr with its answer marker: one.
    const questions = setup.stderr().match(/^.*\[(?:y\/N|Y\/n)\].*$/gm) ?? [];
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/^Set up bridge for App setup-app at /);
    expect(setup.stdout()).toContain("press Ctrl-C to stop it");
  });

  it("wrote exactly the per-app layout: files in <config>/<app>/bridge, sandboxes in <state>/<app>/bridge/tmp, nothing else", async () => {
    const after = await machine.snapshot();
    // Every path this machine gained, by place: no old shared trust/identity/plugin dirs, no /tmp, no ~/.claude.
    expect(createdSince(preInstall, after)).toEqual(
      [
        "config/bridge",
        "config/bridge/agents",
        "config/bridge/agents/claude",
        "config/bridge/agents/claude/.credentials.json",
        "config/bridge/agents/claude/.credentials.json.bridge-login-lease",
        "config/bridge/agents/claude/.credentials.json.bridge-login-lease/owner.json",
        "config/bridge/apps.json",
        "config/bridge/policy.json",
        "config/setup-app",
        "config/setup-app/bridge",
        "config/setup-app/bridge/app.json",
        "config/setup-app/bridge/identity.json",
        "config/setup-app/bridge/trust.json",
        "home/.local/state/bridge",
        "home/.local/state/bridge/runner.json",
        "home/.local/state/bridge/runner.lock",
        "home/.local/state/setup-app",
        "home/.local/state/setup-app/bridge",
        "home/.local/state/setup-app/bridge/tmp",
        "home/.local/state/setup-app/bridge/tmp/bridge-acp-<id>",
        "home/.local/state/setup-app/bridge/tmp/bridge-acp-<id>/claude-home",
        "home/.local/state/setup-app/bridge/tmp/bridge-acp-<id>/claude-home/.credentials.json",
        "home/.local/state/setup-app/bridge/tmp/bridge-acp-<id>/home",
        "home/.local/state/setup-app/bridge/tmp/bridge-acp-<id>/xdg-cache",
        "home/.local/state/setup-app/bridge/tmp/bridge-acp-<id>/xdg-config",
        "home/.local/state/setup-app/bridge/tmp/bridge-acp-<id>/xdg-data",
        "home/.local/state/setup-app/bridge/worker.lock",
        "keychain/<entry>.json",
        "keychain/<entry>.json",
      ].sort(),
    );
    // The trust, identity and connection files hold what their names say, and only their user can read them.
    const lease = `${machine.claudeLogin}.bridge-login-lease`;
    expect((await stat(lease)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(lease, "owner.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(lease, "owner.json"), "utf8")).not.toContain("e2e-not-a-real-token");
    const list = JSON.parse(await readFile(path.join(machine.configDir, "bridge", "apps.json"), "utf8")) as { version: number; apps: { appId: string; origin: string }[] };
    expect(list).toEqual({ version: 2, apps: [{ appId: "setup-app", origin: app.server.url }] });
    const appDir = path.join(machine.configDir, "setup-app", "bridge");
    const record = JSON.parse(await readFile(path.join(appDir, "app.json"), "utf8")) as { appId: string; enrollPage?: string; runnerId: string };
    expect(record).toMatchObject({ appId: "setup-app", enrollPage: ENROLL_PAGE, runnerId });
    expect(await readFile(path.join(appDir, "trust.json"), "utf8")).toContain(enrolledKeyId);
    for (const secret of ["identity.json", "trust.json"]) expect(after[`config/setup-app/bridge/${secret}`], secret).toMatch(/ 600$/);
    // The session ran from a sandbox in the app's state folder, holding bridge's login copy, not the decoys'.
    const sandbox = (await readdir(path.join(machine.home, ".local", "state", "setup-app", "bridge", "tmp")))[0]!;
    expect(await readFile(path.join(machine.home, ".local", "state", "setup-app", "bridge", "tmp", sandbox, "claude-home", ".credentials.json"), "utf8")).toContain("e2e-not-a-real-token");
    // The agents' own dirs are as they were and their secret went nowhere in bridge's folders.
    expect(await machine.protectedSnapshot()).toEqual(agentDirsBefore);
    expect(await machine.filesContaining(DECOY_SECRET)).toEqual([]);
    // `doctor --paths` lists the same places and never an agent's own dir.
    const paths = await machine.exec(["doctor", "--paths"]);
    expect(paths.code).toBe(0);
    expect(paths.stdout).toContain(appDir);
    expect(paths.stdout).toContain(path.join(machine.dataDir, "setup-app", "bridge"));
    expect(paths.stdout).toContain(path.join(machine.home, ".local", "state", "setup-app", "bridge"));
    for (const decoy of Object.values(machine.decoys)) expect(paths.stdout).not.toContain(decoy);
    expect(paths.stdout).not.toContain(".claude");
    expect(paths.stdout).not.toContain(".codex");
  });

  it("Ctrl-C stops the runner and setup", async () => {
    const done = await setup.stop();
    expect(done.code).toBe(0);
    const left = await machine.exec(["status", "--json"]);
    expect(JSON.parse(left.stdout)).toMatchObject({ running: false });
  });

  it("bridge uninstall restores the tree to what it was before anything was installed, and leaves the agents' dirs alone", async () => {
    const removed = await machine.exec(["uninstall", "--yes"]);
    expect(removed.code, `${removed.stdout}\n${removed.stderr}`).toBe(0);
    // Not an rm -rf of the test root: the manifest alone took everything back, the keychain items included.
    expect(await machine.snapshot()).toEqual(preInstall);
    expect(await machine.keychainEntries()).toBe(0);
    expect(await machine.protectedSnapshot()).toEqual(agentDirsBefore);
  });
});

describe("bridge setup without a terminal: --json, consent by flag, the words by another process", () => {
  let app: AppDeployment;
  let machine: Machine;
  let page: HeadlessPage;
  let setup: BridgeProcess;
  let agentDirsBefore: Snapshot;

  /** Waits for the `n`th (1-based) `--json` event called `name` and returns it. */
  async function nthEvent(name: string, n: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const found = eventsOf(setup.stdout()).filter((e) => e.event === name);
      if (found.length >= n) return found[n - 1]!;
      if (Date.now() > deadline) throw new Error(`no ${name} #${n} event:\n${setup.stdout()}\n${setup.stderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeAll(async () => {
    app = await deployApp("agent-app", { enrollPage: ENROLL_PAGE });
    // No machine policy: sessions start in the app's work folder, the default.
    machine = await Machine.create({ policy: false });
    agentDirsBefore = await machine.protectedSnapshot();
    page = await HeadlessPage.open(app);
  });
  afterAll(async () => {
    page?.close();
    await setup?.stop();
    await machine?.dispose();
    await app?.close();
  });

  it("stops before the first write without --yes: nothing can be asked", async () => {
    const before = await machine.snapshot();
    const refused = await machine.exec(["setup", app.server.url, "--json", "--foreground", "--no-install"]);
    expect(refused.code).toBe(1);
    expect(eventsOf(refused.stdout).some((e) => e.event === "error" && e.code === "consent_required")).toBe(true);
    expect(await machine.snapshot()).toEqual(before);
  });

  it("plans first: --plan lists the paths and writes nothing", async () => {
    const before = await machine.snapshot();
    const planned = await machine.exec(["setup", app.server.url, "--json", "--foreground", "--no-install", "--plan"]);
    expect(planned.code).toBe(0);
    const plan = eventsOf(planned.stdout).find((e) => e.event === "plan") as { steps: { id: string; paths: string[] }[] };
    expect(plan.steps.find((s) => s.id === "connect")!.paths).toContain(path.join(machine.configDir, "agent-app", "bridge"));
    expect(await machine.snapshot()).toEqual(before);
  });

  it("wrong words deny that attempt: the browser is not trusted, the code stays open for the right ones", async () => {
    setup = machine.start(["setup", app.server.url, "--json", "--yes", "--foreground", "--no-install"], {}, { seams: true });
    const { url } = (await nthEvent("enroll_code", 1)) as { url: string };
    const first = await page.pair(url);
    const words = await first.words;
    const trust = (await nthEvent("trust_request", 1)) as { words: string[]; instructions: string };
    // The terminal's words are the page's; an agent reading this is told to ask the person for them.
    expect(trust.words).toEqual(words);
    expect(trust.instructions).toMatch(/Ask the person/);
    const wrong = await machine.exec(["enroll", "approve", "agent-app", "--words", "abacus abdomen abdominal abide"]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toMatch(/do not match/);
    await expect(first.enrolled).rejects.toThrow();
    expect((await machine.exec(["browsers", "list", "agent-app"])).stdout).not.toMatch(/[A-Za-z0-9_-]{22}/);
    expect((await page.bridge.status()).state).toBe("online_not_enrolled");
  });

  it("the right words, from a second process, trust the browser on a new attempt with the same code", async () => {
    const { url } = (await nthEvent("enroll_code", 1)) as { url: string };
    const second = await page.pair(url);
    const words = await second.words;
    expect((await nthEvent("trust_request", 2)) as { words: string[] }).toMatchObject({ words });
    const approved = await machine.exec(["enroll", "approve", "agent-app", "--words", words.join(" ")]);
    expect(approved.code, approved.stderr).toBe(0);
    const enrolled = await second.enrolled;
    await nthEvent("ready", 1);
    expect(eventsOf(setup.stdout()).find((e) => e.event === "ready")).toMatchObject({ status: "paired", keyId: enrolled.browserKeyId });
    expect((await machine.exec(["browsers", "list", "agent-app"])).stdout).toContain(enrolled.browserKeyId);
    await page.waitForState("ready");
    expect(page.states).toEqual(["no_runner", "online_not_enrolled", "ready"]);
  });

  it("an ACP session runs in the app's work folder, the default with no policy", async () => {
    const runner = (await page.bridge.status()).runner!;
    const workDir = path.join(machine.home, ".local", "state", "agent-app", "bridge", "work");
    const updates: string[] = [];
    const connection = await page.bridge.acp(collectingApp(updates), runner.runnerId);
    const answer = await promptOnce(connection, updates, workDir, "in the work folder");
    expect(answer.stopReason).toBe("end_turn");
    expect(answer.text).toMatch(/echo: in the work folder$/);
  });

  it("the agents' own dirs (~/.claude, ~/.codex, CLAUDE_CONFIG_DIR, CODEX_HOME) are untouched and their secret is in none of bridge's folders", async () => {
    expect(await machine.protectedSnapshot()).toEqual(agentDirsBefore);
    expect(await machine.filesContaining(DECOY_SECRET)).toEqual([]);
  });
});

describe("an older bridge layout is refused, never migrated", () => {
  let app: AppDeployment;
  let machine: Machine;
  let planted: Snapshot;

  beforeAll(async () => {
    app = await deployApp("legacy-app", { enrollPage: ENROLL_PAGE });
    machine = await Machine.create({ defer: true });
    // What an older bridge left: one shared `<config>/bridge` with a v1 apps.json, trust list and identity,
    // per-app state under `<state>/bridge/apps`, and shared plugins.
    const old = async (file: string, text: string) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    };
    await old(path.join(machine.configDir, "bridge", "apps.json"), JSON.stringify({ version: 1, apps: [{ appId: "old-app", origin: app.server.url, runnerId: "r-old" }] }));
    await old(path.join(machine.configDir, "bridge", "trust", "old-app.json"), JSON.stringify({ browsers: [{ keyId: "old-browser-key" }] }));
    await old(path.join(machine.configDir, "bridge", "identity", "old-app.json"), "old identity");
    await old(path.join(machine.home, ".local", "state", "bridge", "apps", "old-app", "work", "keep.txt"), "mine");
    await old(path.join(machine.dataDir, "bridge", "plugins", "old-plugin", "bridge-plugin.json"), "{}");
    planted = await machine.snapshot();
  });
  afterAll(async () => {
    await machine?.dispose();
    await app?.close();
  });

  const commands: [string, string[]][] = [
    ["setup", ["setup", "<url>", "--yes", "--foreground", "--no-install", "--no-open"]],
    ["setup --json", ["setup", "<url>", "--json", "--yes", "--foreground", "--no-install", "--no-open"]],
    ["connect", ["connect", "<url>", "--yes"]],
    ["run", ["run"]],
    ["status", ["status"]],
    ["apps list", ["apps", "list"]],
    ["enroll approve", ["enroll", "approve", "old-app", "--words", "abacus abdomen abdominal abide"]],
    ["uninstall", ["uninstall", "--yes"]],
  ];

  for (const [name, argv] of commands) {
    it(`${name} stops with the fixed message, writes and removes nothing, and never starts a sign-in`, async () => {
      const result = await machine.exec(argv.map((a) => (a === "<url>" ? app.server.url : a)));
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.code, output).toBe(1);
      expect(output).toContain("an older bridge layout is present");
      expect(output).toContain("run the old `bridge uninstall`, then `bridge setup <url>`");
      // The old v1 list and trust files are named, so the person knows what to remove.
      expect(output).toContain(path.join(machine.configDir, "bridge", "trust"));
      // No migration: the old files are byte for byte what they were, and nothing new appeared beside them.
      expect(await machine.snapshot()).toEqual(planted);
      // No device authorization was requested: a sign-in never began (other server calls are not recorded here).
      expect(app.oauth.requests).toEqual([]);
      expect(await machine.keychainEntries()).toBe(0);
    });
  }

  it("--json reports it as a legacy_layout error event", async () => {
    const result = await machine.exec(["setup", app.server.url, "--json", "--yes", "--foreground", "--no-install"]);
    expect(eventsOf(result.stdout).some((e) => e.event === "error" && e.code === "legacy_layout")).toBe(true);
  });

  it("doctor still runs and warns; once the older folders are removed by hand, setup plans normally", async () => {
    const doctor = await machine.exec(["doctor"]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain("an older bridge layout is present");
    await rm(path.join(machine.configDir, "bridge"), { recursive: true });
    await rm(path.join(machine.home, ".local", "state", "bridge"), { recursive: true });
    await rm(path.join(machine.dataDir, "bridge"), { recursive: true });
    const plan = await machine.exec(["setup", app.server.url, "--json", "--foreground", "--no-install", "--plan"]);
    expect(plan.code, plan.stdout + plan.stderr).toBe(0);
    expect(eventsOf(plan.stdout).some((e) => e.event === "plan")).toBe(true);
  });
});
