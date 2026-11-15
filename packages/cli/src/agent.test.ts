import { chmod, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { agentDirOf, agentLoginFileOf } from "./agent.js";
import { runCli } from "./cli.js";
import { type Harness, exists, harness } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const printed = (): string => h.out.join("") + h.err.join("");
const home = (): string => path.join(h.root, "home");
const claudeSource = (): string => path.join(home(), ".claude/.credentials.json");
const codexSource = (): string => path.join(home(), ".codex/auth.json");
const claudeCopy = (): string => agentLoginFileOf(h.deps, "claude");
const codexCopy = (): string => agentLoginFileOf(h.deps, "codex");
const oauthFile = (token: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "r" }, ...extra });
const codexAuth = JSON.stringify({ tokens: { access_token: "a1" } });

async function putSource(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, { mode: 0o600 });
}

describe("bridge agent login --copy", () => {
  it("prints the destination and the shared-grant warning before it asks, then copies only claudeAiOauth at 0600", async () => {
    h = await harness({ isTTY: true });
    const source = oauthFile("c1", { mcpOAuth: { vercel: "secret" } });
    await putSource(claudeSource(), source);
    let beforeQuestion = "";
    h.deps.confirm = async (question) => {
      h.questions.push(question);
      beforeQuestion = printed();
      return true;
    };
    expect(await runCli(["agent", "login", "claude", "--copy"], h.deps)).toBe(0);
    expect(h.questions).toHaveLength(1);
    expect(beforeQuestion).toContain(claudeCopy());
    expect(beforeQuestion).toContain(claudeSource());
    expect(beforeQuestion).toContain("Both copies share one grant");
    expect(beforeQuestion).toContain("your terminal agent included");
    expect(JSON.parse(await readFile(claudeCopy(), "utf8"))).toEqual({ claudeAiOauth: { accessToken: "c1", refreshToken: "r" } });
    expect((await stat(claudeCopy())).mode & 0o777).toBe(0o600);
    expect((await stat(agentDirOf(h.deps, "claude"))).mode & 0o777).toBe(0o700);
    expect(await readFile(claudeSource(), "utf8")).toBe(source);
    expect((await readdir(agentDirOf(h.deps, "claude"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("copies the login as it is after consent: a token refreshed while the question was open is the one copied", async () => {
    for (const argv of [["--copy"], []]) {
      h = await harness({ isTTY: true });
      await putSource(claudeSource(), oauthFile("before", { mcpOAuth: { vercel: "secret" } }));
      h.deps.confirm = async (question) => {
        h.questions.push(question);
        await writeFile(claudeSource(), oauthFile("rotated", { mcpOAuth: { vercel: "secret" } }));
        return true;
      };
      expect(await runCli(["agent", "login", "claude", ...argv], h.deps)).toBe(0);
      expect(JSON.parse(await readFile(claudeCopy(), "utf8"))).toEqual({ claudeAiOauth: { accessToken: "rotated", refreshToken: "r" } });
      await h.cleanup();
    }
  });

  it("binds the source path: swapped for a link to another file during the question, changed while waiting, nothing written", async () => {
    h = await harness({ isTTY: true });
    await putSource(claudeSource(), oauthFile("mine"));
    const other = path.join(h.root, "someone-else.json");
    await putSource(other, oauthFile("other"));
    h.deps.confirm = async (question) => {
      h.questions.push(question);
      await rm(claudeSource());
      await symlink(other, claudeSource());
      return true;
    };
    expect(await runCli(["agent", "login", "claude", "--copy"], h.deps)).toBe(1);
    expect(printed()).toContain("changed while waiting for confirmation");
    expect(await exists(claudeCopy())).toBe(false);
  });

  it("copies codex's auth.json verbatim", async () => {
    h = await harness({ isTTY: true });
    await putSource(codexSource(), codexAuth);
    expect(await runCli(["agent", "login", "codex", "--copy"], h.deps)).toBe(0);
    expect(await readFile(codexCopy(), "utf8")).toBe(codexAuth);
    expect(await readFile(codexSource(), "utf8")).toBe(codexAuth);
  });

  it("copies codex's login from $CODEX_HOME when it is set, and says that folder in its prompt and listing", async () => {
    h = await harness({ isTTY: true });
    const codexHome = path.join(h.root, "elsewhere/codex-home");
    const fromHome = JSON.stringify({ tokens: { access_token: "from-home" } });
    const fromEnv = JSON.stringify({ tokens: { access_token: "from-env" } });
    await putSource(codexSource(), fromHome);
    await putSource(path.join(codexHome, "auth.json"), fromEnv);
    h.deps.env = { ...h.deps.env, CODEX_HOME: codexHome };
    let beforeQuestion = "";
    h.deps.confirm = async (question) => {
      h.questions.push(question);
      beforeQuestion = printed();
      return true;
    };
    expect(await runCli(["agent", "login", "codex", "--copy"], h.deps)).toBe(0);
    expect(beforeQuestion).toContain(`from: ${path.join(codexHome, "auth.json")} (read only)`);
    expect(beforeQuestion).not.toContain(codexSource());
    expect(await readFile(codexCopy(), "utf8")).toBe(fromEnv);
    // Neither folder is written.
    expect(await readFile(path.join(codexHome, "auth.json"), "utf8")).toBe(fromEnv);
    expect(await readFile(codexSource(), "utf8")).toBe(fromHome);
    expect(await readdir(codexHome)).toEqual(["auth.json"]);
  });

  it("reads $HOME/.codex when CODEX_HOME is unset or empty", async () => {
    for (const env of [{}, { CODEX_HOME: "" }]) {
      h = await harness({ isTTY: true });
      await putSource(codexSource(), codexAuth);
      h.deps.env = { ...h.deps.env, ...env };
      expect(await runCli(["agent", "login", "codex", "--copy", "--yes"], h.deps)).toBe(0);
      expect(h.out.join("")).toContain(`from: ${codexSource()} (read only)`);
      expect(await readFile(codexCopy(), "utf8")).toBe(codexAuth);
      await h.cleanup();
    }
  });

  it("with $CODEX_HOME set and no login there it says where it looked, not at ~/.codex, and copies nothing", async () => {
    h = await harness({ isTTY: true });
    const codexHome = path.join(h.root, "elsewhere/codex-home");
    await putSource(codexSource(), codexAuth);
    h.deps.env = { ...h.deps.env, CODEX_HOME: codexHome };
    expect(await runCli(["agent", "login", "codex", "--copy", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain(`no codex login found at ${path.join(codexHome, "auth.json")}`);
    expect(await exists(codexCopy())).toBe(false);
  });

  it("--yes answers the copy question, also without a terminal, and still prints the paths", async () => {
    h = await harness({ isTTY: false });
    await putSource(claudeSource(), oauthFile("c1"));
    expect(await runCli(["agent", "login", "claude", "--copy", "--yes"], h.deps)).toBe(0);
    expect(h.questions).toEqual([]);
    const said = printed();
    expect(said).toContain(claudeCopy());
    expect(said).toContain("Both copies share one grant");
    expect(said.indexOf("Both copies share one grant")).toBeLessThan(said.indexOf("Copied the claude login"));
    expect(await exists(claudeCopy())).toBe(true);
  });

  it("without a terminal and without --yes it asks nothing and writes nothing", async () => {
    h = await harness({ isTTY: false });
    await putSource(claudeSource(), oauthFile("c1"));
    expect(await runCli(["agent", "login", "claude", "--copy"], h.deps)).toBe(2);
    expect(h.questions).toEqual([]);
    expect(await exists(claudeCopy())).toBe(false);
  });

  it("a no writes nothing", async () => {
    h = await harness({ isTTY: true });
    h.answers.yes = false;
    await putSource(claudeSource(), oauthFile("c1"));
    expect(await runCli(["agent", "login", "claude", "--copy"], h.deps)).toBe(0);
    expect(await exists(agentDirOf(h.deps, "claude"))).toBe(false);
  });

  it("says where it looked when there is no source, and mentions the Keychain on macOS", async () => {
    h = await harness({ isTTY: true, platform: "darwin" });
    expect(await runCli(["agent", "login", "claude", "--copy"], h.deps)).toBe(1);
    expect(printed()).toContain(claudeSource());
    expect(printed()).toContain("Keychain");
    expect(printed()).toContain("--login");
    expect(h.questions).toEqual([]);
  });

  it("honours CLAUDE_CONFIG_DIR as the place to read from, and never writes there", async () => {
    h = await harness({ isTTY: true });
    const dir = path.join(h.root, "elsewhere");
    h.deps.env = { ...h.deps.env, CLAUDE_CONFIG_DIR: dir };
    await putSource(path.join(dir, ".credentials.json"), oauthFile("c9"));
    expect(await runCli(["agent", "login", "claude", "--copy", "--yes"], h.deps)).toBe(0);
    expect(JSON.parse(await readFile(claudeCopy(), "utf8")).claudeAiOauth.accessToken).toBe("c9");
    expect(await readdir(dir)).toEqual([".credentials.json"]);
  });

  it("refuses to copy bridge's own folder onto itself (CLAUDE_CONFIG_DIR is bridge's folder: the same place)", async () => {
    h = await harness({ isTTY: true });
    h.deps.env = { ...h.deps.env, CLAUDE_CONFIG_DIR: agentDirOf(h.deps, "claude") };
    const login = oauthFile("c1");
    await putSource(claudeCopy(), login);
    expect(await runCli(["agent", "login", "claude", "--copy", "--yes"], h.deps)).toBe(1);
    expect(printed()).toContain("overlap");
    expect(printed()).toContain(agentDirOf(h.deps, "claude"));
    expect(await readFile(claudeCopy(), "utf8")).toBe(login);
  });
});

describe("bridge agent login --login", () => {
  it("runs claude's own login with its config dir in bridge's folder, after printing that folder", async () => {
    h = await harness({ isTTY: true });
    h.deps.env = { ...h.deps.env, KEEP: "1" };
    let beforeQuestion = "";
    h.deps.confirm = async (question) => {
      h.questions.push(question);
      beforeQuestion = printed();
      return true;
    };
    h.spawnResult.onRun = async () => putSource(claudeCopy(), oauthFile("fresh"));
    expect(await runCli(["agent", "login", "claude", "--login"], h.deps)).toBe(0);
    expect(beforeQuestion).toContain(agentDirOf(h.deps, "claude"));
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toMatchObject({ command: "claude", args: ["auth", "login"] });
    expect(h.spawned[0]!.env).toMatchObject({ CLAUDE_CONFIG_DIR: agentDirOf(h.deps, "claude"), KEEP: "1" });
    expect(h.spawned[0]!.env.CODEX_HOME).toBeUndefined();
    expect((await stat(agentDirOf(h.deps, "claude"))).mode & 0o777).toBe(0o700);
    expect(printed()).toContain(claudeCopy());
  });

  it("runs codex's own login with CODEX_HOME in bridge's folder; --yes answers the path consent", async () => {
    h = await harness({ isTTY: true });
    h.spawnResult.onRun = async () => putSource(codexCopy(), codexAuth);
    expect(await runCli(["agent", "login", "codex", "--login", "--yes"], h.deps)).toBe(0);
    expect(h.questions).toEqual([]);
    expect(h.spawned[0]).toMatchObject({ command: "codex", args: ["login"] });
    expect(h.spawned[0]!.env.CODEX_HOME).toBe(agentDirOf(h.deps, "codex"));
  });

  it("is refused without a terminal, even with --yes, and runs nothing", async () => {
    h = await harness({ isTTY: false });
    expect(await runCli(["agent", "login", "claude", "--login", "--yes"], h.deps)).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(await exists(agentDirOf(h.deps, "claude"))).toBe(false);
  });

  it("a no runs nothing", async () => {
    h = await harness({ isTTY: true });
    h.answers.yes = false;
    expect(await runCli(["agent", "login", "claude", "--login"], h.deps)).toBe(0);
    expect(h.spawned).toEqual([]);
  });

  it("exits 1 when the login did not land in bridge's folder (the macOS Keychain case)", async () => {
    h = await harness({ isTTY: true, platform: "darwin" });
    expect(await runCli(["agent", "login", "claude", "--login", "--yes"], h.deps)).toBe(1);
    expect(h.spawned).toHaveLength(1);
    expect(printed()).toContain(`the login did not land in ${claudeCopy()}; on macOS Claude Code may have stored it in the Keychain`);
  });

  it("exits 1 when the agent's login exits non-zero, or cannot start", async () => {
    h = await harness({ isTTY: true });
    h.spawnResult.exitCode = 3;
    expect(await runCli(["agent", "login", "codex", "--login", "--yes"], h.deps)).toBe(1);
    expect(printed()).toContain("exited with 3");
    h.deps.spawnInteractive = async () => {
      throw new Error("spawn codex ENOENT");
    };
    expect(await runCli(["agent", "login", "codex", "--login", "--yes"], h.deps)).toBe(1);
    expect(printed()).toContain("ENOENT");
  });
});

describe("bridge agent login --login: the agent folder's whole top level is bound", () => {
  it("prints that claude writes what it keeps (backups/ too) inside bridge's folder only", async () => {
    h = await harness({ isTTY: true });
    h.spawnResult.onRun = async () => putSource(claudeCopy(), oauthFile("fresh"));
    expect(await runCli(["agent", "login", "claude", "--login", "--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(
      `This runs \`claude auth login\` with its config folder set to bridge's own: ${agentDirOf(h.deps, "claude")}. claude writes whatever it keeps there (its login, settings and folders such as backups/) inside that folder and nothing outside it; your own ~/.claude is not touched.`,
    );
  });

  it("refuses a symlink named backups (to ~/.claude/backups) before the question: nothing asked, run or written there", async () => {
    for (const argv of [["--login"], ["--copy"]]) {
      h = await harness({ isTTY: true });
      await putSource(claudeSource(), oauthFile("mine"));
      const own = path.join(home(), ".claude/backups");
      await mkdir(own, { recursive: true });
      await mkdir(agentDirOf(h.deps, "claude"), { recursive: true });
      await symlink(own, path.join(agentDirOf(h.deps, "claude"), "backups"));
      h.spawnResult.onRun = async () => writeFile(path.join(agentDirOf(h.deps, "claude"), "backups", "x.json"), "written through");
      expect(await runCli(["agent", "login", "claude", ...argv], h.deps)).toBe(1);
      expect(h.questions).toEqual([]);
      expect(h.spawned).toEqual([]);
      expect(printed()).toContain(`${path.join(agentDirOf(h.deps, "claude"), "backups")} is a symlink in bridge's claude folder`);
      expect(await readdir(own)).toEqual([]);
      expect(await exists(claudeCopy())).toBe(false);
      await h.cleanup();
    }
  });

  it("a top-level entry added to the folder while the question is open is a changed plan: nothing is run", async () => {
    h = await harness({ isTTY: true });
    await mkdir(agentDirOf(h.deps, "claude"), { recursive: true });
    h.deps.confirm = async (question) => {
      h.questions.push(question);
      await symlink(path.join(home(), ".claude"), path.join(agentDirOf(h.deps, "claude"), "backups"));
      return true;
    };
    expect(await runCli(["agent", "login", "claude", "--login"], h.deps)).toBe(1);
    expect(h.spawned).toEqual([]);
    expect(printed()).toMatch(/changed while/i);
  });

  it("status reads only the login file: backups/ and other folders claude keeps there do not count", async () => {
    h = await harness({ isTTY: true });
    await mkdir(path.join(agentDirOf(h.deps, "claude"), "backups"), { recursive: true });
    await writeFile(path.join(agentDirOf(h.deps, "claude"), ".claude.json"), "{}");
    expect(await runCli(["agent", "status"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(`claude: absent (${claudeCopy()})`);
    await putSource(claudeCopy(), oauthFile("t"));
    h.out.length = 0;
    expect(await runCli(["agent", "status"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(`claude: present (${claudeCopy()})`);
  });
});

describe("bridge agent login without a flag", () => {
  it("asks copy first, then the agent's own login, each after its path", async () => {
    h = await harness({ isTTY: true });
    h.answers.yes = false;
    await putSource(claudeSource(), oauthFile("c1"));
    const seen: string[] = [];
    h.deps.confirm = async (question) => {
      seen.push(`${question} @ ${printed().includes(agentDirOf(h.deps, "claude")) ? "path-shown" : "no-path"}`);
      return false;
    };
    expect(await runCli(["agent", "login", "claude"], h.deps)).toBe(0);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^Copy your claude login.*path-shown$/);
    expect(seen[1]).toMatch(/^Sign in to claude.*path-shown$/);
    expect(printed()).toContain("bridge agent login claude");
    expect(h.spawned).toEqual([]);
    expect(await exists(claudeCopy())).toBe(false);
  });

  it("offers copying first, both questions defaulting to yes; an explicit --copy or --login defaults to no", async () => {
    h = await harness({ isTTY: true });
    await putSource(claudeSource(), oauthFile("c1"));
    const defaults: string[] = [];
    h.deps.confirm = async (question, options) => {
      defaults.push(`${question.split(" ").slice(0, 2).join(" ")}: ${options?.default}`);
      return false;
    };
    expect(await runCli(["agent", "login", "claude"], h.deps)).toBe(0);
    expect(defaults).toEqual(["Copy your: yes", "Sign in: yes"]);
    defaults.length = 0;
    expect(await runCli(["agent", "login", "claude", "--copy"], h.deps)).toBe(0);
    expect(await runCli(["agent", "login", "claude", "--login"], h.deps)).toBe(0);
    expect(defaults).toEqual(["Copy your: no", "Sign in: no"]);
  });

  it("with no current login to copy, says where it looked, still asks for the agent's own login, and declining is not a failure", async () => {
    h = await harness({ isTTY: true });
    h.answers.yes = false;
    expect(await runCli(["agent", "login", "claude"], h.deps)).toBe(0);
    expect(printed()).toContain(claudeSource());
    expect(h.questions).toHaveLength(1);
    expect(h.questions[0]).toMatch(/^Sign in to claude/);
    expect(printed()).toContain("bridge agent login claude");
    expect(h.spawned).toEqual([]);
  });

  it("with no current login to copy, a yes to the agent's own login runs it; a failed login exits 1", async () => {
    h = await harness({ isTTY: true });
    h.spawnResult.onRun = async () => putSource(claudeCopy(), oauthFile("fresh"));
    expect(await runCli(["agent", "login", "claude"], h.deps)).toBe(0);
    expect(h.spawned).toHaveLength(1);
    h.spawnResult.onRun = undefined;
    h.spawnResult.exitCode = 3;
    expect(await runCli(["agent", "login", "codex"], h.deps)).toBe(1);
  });

  it("skips the second question once the copy is done", async () => {
    h = await harness({ isTTY: true });
    await putSource(claudeSource(), oauthFile("c1"));
    expect(await runCli(["agent", "login", "claude"], h.deps)).toBe(0);
    expect(h.questions).toHaveLength(1);
    expect(h.spawned).toEqual([]);
    expect(await exists(claudeCopy())).toBe(true);
  });

  it("--yes alone never picks: on a terminal both questions are still asked, and a no copies nothing", async () => {
    h = await harness({ isTTY: true });
    h.answers.yes = false;
    await putSource(claudeSource(), oauthFile("c1"));
    expect(await runCli(["agent", "login", "claude", "--yes"], h.deps)).toBe(0);
    expect(h.questions).toHaveLength(2);
    expect(h.questions[0]).toMatch(/^Copy your claude login/);
    expect(h.questions[1]).toMatch(/^Sign in to claude/);
    expect(h.spawned).toEqual([]);
    expect(await exists(claudeCopy())).toBe(false);
  });

  it("is a usage error naming the flags without a terminal, with or without --yes: nothing asked, copied or run", async () => {
    h = await harness({ isTTY: false });
    await putSource(claudeSource(), oauthFile("c1"));
    for (const extra of [[], ["--yes"]]) {
      h.err.length = 0;
      expect(await runCli(["agent", "login", "claude", ...extra], h.deps)).toBe(2);
      expect(printed()).toContain("--copy");
      expect(printed()).toContain("--login");
    }
    expect(h.questions).toEqual([]);
    expect(h.spawned).toEqual([]);
    expect(await exists(claudeCopy())).toBe(false);
  });

  it("rejects an unknown agent and both flags together", async () => {
    h = await harness({ isTTY: true });
    expect(await runCli(["agent", "login", "gemini"], h.deps)).toBe(2);
    expect(await runCli(["agent", "login", "claude", "--copy", "--login"], h.deps)).toBe(2);
    expect(await runCli(["agent"], h.deps)).toBe(2);
  });
});

describe("bridge's login folders are never followed out by a symlink", () => {
  const personalClaude = (): string => path.join(h.root, "personal-claude");

  async function linkAgentDirToPersonal(): Promise<string> {
    await mkdir(personalClaude(), { recursive: true, mode: 0o755 });
    const personal = oauthFile("personal", { mcpOAuth: { vercel: "secret" } });
    await writeFile(path.join(personalClaude(), ".credentials.json"), personal);
    await chmod(personalClaude(), 0o755);
    await mkdir(path.dirname(agentDirOf(h.deps, "claude")), { recursive: true });
    await symlink(personalClaude(), agentDirOf(h.deps, "claude"));
    return personal;
  }

  it("--copy refuses a symlinked agent folder: nothing outside is chmodded, written or replaced", async () => {
    h = await harness({ isTTY: true });
    await putSource(claudeSource(), oauthFile("c1"));
    const personal = await linkAgentDirToPersonal();
    expect(await runCli(["agent", "login", "claude", "--copy", "--yes"], h.deps)).toBe(1);
    expect(printed()).toContain("is a symlink");
    expect(await readFile(path.join(personalClaude(), ".credentials.json"), "utf8")).toBe(personal);
    expect((await stat(personalClaude())).mode & 0o777).toBe(0o755);
    expect(await readdir(personalClaude())).toEqual([".credentials.json"]);
  });

  it("--copy re-checks after consent: a folder swapped to a symlink while the question was open gets nothing written, exit 1", async () => {
    for (const argv of [["--copy"], []]) {
      h = await harness({ isTTY: true });
      await putSource(claudeSource(), oauthFile("c1"));
      const personal = oauthFile("personal", { mcpOAuth: { vercel: "secret" } });
      await mkdir(personalClaude(), { recursive: true });
      await writeFile(path.join(personalClaude(), ".credentials.json"), personal);
      await chmod(personalClaude(), 0o755);
      h.deps.confirm = async (question) => {
        h.questions.push(question);
        await mkdir(path.dirname(agentDirOf(h.deps, "claude")), { recursive: true });
        await symlink(personalClaude(), agentDirOf(h.deps, "claude"));
        return true;
      };
      expect(await runCli(["agent", "login", "claude", ...argv], h.deps)).toBe(1);
      expect(h.questions).toHaveLength(1);
      expect(printed()).toContain("changed while waiting for confirmation");
      expect(await readFile(path.join(personalClaude(), ".credentials.json"), "utf8")).toBe(personal);
      expect((await stat(personalClaude())).mode & 0o777).toBe(0o755);
      expect(await readdir(personalClaude())).toEqual([".credentials.json"]);
      expect(h.spawned).toEqual([]);
      await h.cleanup();
    }
  });

  describe("an ancestor of bridge's folder (the config dir may be a symlink)", () => {
    // root/config is a symlink to root/real-config, as in a dotfiles setup; that is supported.
    async function symlinkedConfig(): Promise<{ claudeHome: string; snapshot: () => Promise<string[]> }> {
      await mkdir(path.join(h.root, "real-config"), { recursive: true });
      await symlink(path.join(h.root, "real-config"), h.deps.configDir);
      const claudeHome = path.join(home(), ".claude");
      await putSource(claudeSource(), oauthFile("c1"));
      const snapshot = async (): Promise<string[]> => (await readdir(claudeHome, { recursive: true })).map(String).sort();
      return { claudeHome, snapshot };
    }

    const retarget = async (to: string): Promise<void> => {
      await rm(h.deps.configDir);
      await symlink(to, h.deps.configDir);
    };

    for (const argv of [["--copy"], ["--login"], []]) {
      it(`retargeted into ~/.claude while the question is open: nothing is written, exit 1 (${argv.join(" ") || "no flag"})`, async () => {
        h = await harness({ isTTY: true });
        const { claudeHome, snapshot } = await symlinkedConfig();
        const before = await snapshot();
        h.spawnResult.onRun = async () => putSource(claudeCopy(), oauthFile("fresh"));
        h.deps.confirm = async (question) => {
          h.questions.push(question);
          await retarget(claudeHome);
          return true;
        };
        expect(await runCli(["agent", "login", "claude", ...argv], h.deps)).toBe(1);
        expect(h.questions).toHaveLength(1);
        expect(printed()).toContain("changed while waiting for confirmation");
        expect(await snapshot()).toEqual(before);
        expect(await readdir(path.join(h.root, "real-config"))).toEqual([]);
        expect(h.spawned).toEqual([]);
      });
    }

    for (const argv of [["--copy", "--yes"], ["--login", "--yes"], []]) {
      it(`with ~/.claude absent and the config dir (XDG_CONFIG_HOME) inside it, nothing is asked or written (${argv.join(" ") || "no flag"})`, async () => {
        h = await harness({ isTTY: true });
        const claudeHome = path.join(home(), ".claude");
        h.deps.configDir = path.join(claudeHome, "config");
        await putSource(codexSource(), codexAuth);
        h.spawnResult.onRun = async () => putSource(codexCopy(), codexAuth);
        expect(await runCli(["agent", "login", "codex", ...argv], h.deps)).toBe(1);
        expect(h.questions).toEqual([]);
        expect(h.spawned).toEqual([]);
        expect(printed()).toContain("never writes an agent's own folder");
        expect(await exists(claudeHome)).toBe(false);
      });
    }

    it("status calls a login whose folder really lies inside ~/.claude absent", async () => {
      h = await harness({ isTTY: true });
      const { claudeHome } = await symlinkedConfig();
      await retarget(claudeHome);
      await putSource(claudeCopy(), oauthFile("c1"));
      expect(await runCli(["agent", "status"], h.deps)).toBe(0);
      expect(h.out.join("")).toContain(`claude: absent (${claudeCopy()})`);
    });

    for (const argv of [["--copy", "--yes"], ["--login", "--yes"], []]) {
      it(`a dangling ~/.claude link into bridge's config dir is refused before asking (${argv.join(" ") || "no flag"})`, async () => {
        h = await harness({ isTTY: true });
        await putSource(codexSource(), codexAuth);
        // ~/.claude points at bridge's (not yet created) claude folder: it would be where the agent writes.
        await mkdir(home(), { recursive: true });
        await symlink(agentDirOf(h.deps, "claude"), path.join(home(), ".claude"));
        expect(await runCli(["agent", "login", "claude", ...argv], h.deps)).toBe(1);
        expect(h.questions).toEqual([]);
        expect(h.spawned).toEqual([]);
        expect(printed()).toContain("overlap");
        expect(printed()).toContain(path.join(home(), ".claude"));
        expect(await exists(agentDirOf(h.deps, "claude"))).toBe(false);
      });
    }

    for (const argv of [["--copy", "--yes"], ["--login", "--yes"], []]) {
      it(`CODEX_HOME with \`..\` after a link resolves as the kernel does, into the config dir: refused before asking (${argv.join(" ") || "no flag"})`, async () => {
        h = await harness({ isTTY: true });
        // Codex's layout: <v>/alias -> <v>/real/sub, CODEX_HOME=<v>/alias/../config/bridge (really <v>/real/config/bridge), XDG_CONFIG_HOME=<v>/real/config.
        const v = path.join(h.root, "v");
        await mkdir(path.join(v, "real/sub"), { recursive: true });
        await mkdir(path.join(v, "real/config"), { recursive: true });
        await symlink(path.join(v, "real/sub"), path.join(v, "alias"));
        h.deps.configDir = path.join(v, "real/config");
        h.deps.env = { ...h.deps.env, CODEX_HOME: `${v}/alias/../config/bridge` };
        await putSource(path.join(v, "config/bridge/auth.json"), codexAuth); // where a lexical reading of CODEX_HOME points
        h.spawnResult.onRun = async () => putSource(codexCopy(), codexAuth);
        expect(await runCli(["agent", "login", "codex", ...argv], h.deps)).toBe(1);
        expect(h.questions).toEqual([]);
        expect(h.spawned).toEqual([]);
        expect(printed()).toContain("overlap");
        expect(await readdir(path.join(v, "real/config"))).toEqual([]);
      });
    }

    it("a link loop at ~/.codex is unresolvable and refused before asking", async () => {
      h = await harness({ isTTY: true });
      await mkdir(home(), { recursive: true });
      await symlink(path.join(home(), ".codex"), path.join(home(), ".codex"));
      await putSource(claudeSource(), oauthFile("c1"));
      expect(await runCli(["agent", "login", "claude", "--copy", "--yes"], h.deps)).toBe(1);
      expect(printed()).toContain("unresolvable");
      expect(await exists(claudeCopy())).toBe(false);
    });

    for (const argv of [["--copy"], ["--login"], []]) {
      it(`~/.claude retargeted into bridge's folder while the question is open: changed while waiting, nothing written (${argv.join(" ") || "no flag"})`, async () => {
        h = await harness({ isTTY: true });
        const claudeHome = path.join(home(), ".claude");
        await putSource(claudeSource(), oauthFile("c1"));
        h.spawnResult.onRun = async () => putSource(claudeCopy(), oauthFile("fresh"));
        h.deps.confirm = async (question) => {
          h.questions.push(question);
          // The person's ~/.claude moves into bridge's folder: bridge's write would land in it.
          await rename(claudeHome, path.join(h.root, "moved-claude"));
          await symlink(agentDirOf(h.deps, "claude"), claudeHome);
          return true;
        };
        expect(await runCli(["agent", "login", "claude", ...argv], h.deps)).toBe(1);
        expect(h.questions).toHaveLength(1);
        expect(printed()).toContain("changed while waiting for confirmation");
        expect(await exists(agentDirOf(h.deps, "claude"))).toBe(false);
        expect(h.spawned).toEqual([]);
      });
    }

    it("a symlinked config dir apart from the agents' folders is fine: the login goes to the real folder", async () => {
      h = await harness({ isTTY: true });
      await symlinkedConfig();
      expect(await runCli(["agent", "login", "claude", "--copy", "--yes"], h.deps)).toBe(0);
      expect(await exists(path.join(h.root, "real-config/bridge/agents/claude/.credentials.json"))).toBe(true);
    });

    for (const argv of [["--copy", "--yes"], ["--login", "--yes"], []]) {
      it(`a destination already inside ~/.claude or $CODEX_HOME is refused before asking (${argv.join(" ") || "no flag"})`, async () => {
        h = await harness({ isTTY: true });
        const { claudeHome, snapshot } = await symlinkedConfig();
        await retarget(claudeHome);
        const before = await snapshot();
        expect(await runCli(["agent", "login", "claude", ...argv], h.deps)).toBe(1);
        expect(h.questions).toEqual([]);
        expect(h.spawned).toEqual([]);
        expect(printed()).toContain("never writes an agent's own folder");
        expect(await snapshot()).toEqual(before);

        h.err.length = 0;
        const codexHome = path.join(h.root, "codex-home");
        await mkdir(codexHome, { recursive: true });
        h.deps.env = { ...h.deps.env, CODEX_HOME: codexHome };
        await putSource(path.join(codexHome, "auth.json"), codexAuth);
        await retarget(codexHome);
        expect(await runCli(["agent", "login", "codex", ...argv], h.deps)).toBe(1);
        expect(h.questions).toEqual([]);
        expect(printed()).toContain("never writes an agent's own folder");
        expect(await readdir(codexHome)).toEqual(["auth.json"]);
      });
    }
  });

  it("--copy refuses a symlinked destination file and leaves what it points at alone", async () => {
    h = await harness({ isTTY: true });
    await putSource(claudeSource(), oauthFile("c1"));
    const elsewhere = path.join(h.root, "elsewhere.json");
    await putSource(elsewhere, "keep");
    await mkdir(agentDirOf(h.deps, "claude"), { recursive: true });
    await symlink(elsewhere, claudeCopy());
    expect(await runCli(["agent", "login", "claude", "--copy", "--yes"], h.deps)).toBe(1);
    expect(printed()).toContain("is a symlink");
    expect(await readFile(elsewhere, "utf8")).toBe("keep");
  });

  it("the two-question flow stops at the symlink refusal: said once, no login question, exit 1", async () => {
    h = await harness({ isTTY: true });
    await putSource(claudeSource(), oauthFile("c1"));
    await linkAgentDirToPersonal();
    expect(await runCli(["agent", "login", "claude"], h.deps)).toBe(1);
    expect(printed().split("is a symlink")).toHaveLength(2);
    expect(h.questions).toEqual([]);
    expect(h.spawned).toEqual([]);
  });

  it("--login refuses a symlinked agent folder or agents folder and runs nothing", async () => {
    h = await harness({ isTTY: true });
    await linkAgentDirToPersonal();
    expect(await runCli(["agent", "login", "claude", "--login", "--yes"], h.deps)).toBe(1);
    expect(h.spawned).toEqual([]);
    expect((await stat(personalClaude())).mode & 0o777).toBe(0o755);
    expect(printed()).toContain("is a symlink");

    await h.cleanup();
    h = await harness({ isTTY: true });
    await mkdir(path.join(h.root, "elsewhere"), { recursive: true });
    await mkdir(path.dirname(path.dirname(agentDirOf(h.deps, "codex"))), { recursive: true });
    await symlink(path.join(h.root, "elsewhere"), path.dirname(agentDirOf(h.deps, "codex")));
    expect(await runCli(["agent", "login", "codex", "--login", "--yes"], h.deps)).toBe(1);
    expect(h.spawned).toEqual([]);
    expect(await readdir(path.join(h.root, "elsewhere"))).toEqual([]);
  });

  it("--login refuses a symlinked login file in bridge's folder: no spawn, the file it points at is byte-identical", async () => {
    for (const [agent, file, contents] of [
      ["codex", codexCopy, codexAuth],
      ["claude", claudeCopy, oauthFile("personal", { mcpOAuth: { vercel: "secret" } })],
    ] as const) {
      h = await harness({ isTTY: true });
      const personal = path.join(h.root, `personal-${agent}-login.json`);
      await putSource(personal, contents);
      await mkdir(agentDirOf(h.deps, agent), { recursive: true });
      await symlink(personal, file());
      // Were the agent spawned, its login would write through the link.
      h.spawnResult.onRun = async () => writeFile(file(), "overwritten");
      expect(await runCli(["agent", "login", agent, "--login", "--yes"], h.deps)).toBe(1);
      expect(h.spawned).toEqual([]);
      expect(printed()).toContain("is a symlink");
      expect(await readFile(personal, "utf8")).toBe(contents);
      await h.cleanup();
    }
  });

  it("--login refuses a login file that is not a regular file, and runs nothing", async () => {
    h = await harness({ isTTY: true });
    await mkdir(codexCopy(), { recursive: true });
    expect(await runCli(["agent", "login", "codex", "--login", "--yes"], h.deps)).toBe(1);
    expect(h.spawned).toEqual([]);
    expect(printed()).toContain("not a regular file");
  });

  it("--login reports failure when the login file turns out to be a symlink after the agent ran", async () => {
    h = await harness({ isTTY: true });
    const elsewhere = path.join(h.root, "elsewhere-auth.json");
    h.spawnResult.onRun = async () => {
      await putSource(elsewhere, codexAuth);
      await symlink(elsewhere, codexCopy());
    };
    expect(await runCli(["agent", "login", "codex", "--login", "--yes"], h.deps)).toBe(1);
    expect(printed()).toContain(`did not land in ${codexCopy()}`);
  });

  it("status calls a login behind a symlinked folder or file absent", async () => {
    h = await harness({ isTTY: true });
    await linkAgentDirToPersonal();
    expect(await runCli(["agent", "status"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(`claude: absent (${claudeCopy()})`);

    await mkdir(agentDirOf(h.deps, "codex"), { recursive: true });
    await putSource(path.join(h.root, "personal-auth.json"), codexAuth);
    await symlink(path.join(h.root, "personal-auth.json"), codexCopy());
    h.out.length = 0;
    expect(await runCli(["agent", "status"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(`codex: absent (${codexCopy()})`);
  });
});

describe("bridge agent status", () => {
  it("reports present or absent per agent, from bridge's folder only", async () => {
    h = await harness();
    await putSource(claudeSource(), oauthFile("in-the-persons-home"));
    await putSource(codexCopy(), codexAuth);
    expect(await runCli(["agent", "status"], h.deps)).toBe(0);
    expect(h.out.join("")).toBe(`claude: absent (${claudeCopy()})\ncodex: present (${codexCopy()})\n`);
  });

  it("--json prints one object per agent", async () => {
    h = await harness();
    await putSource(claudeCopy(), oauthFile("c1"));
    expect(await runCli(["agent", "status", "--json"], h.deps)).toBe(0);
    const lines = h.out.join("").trim().split("\n").map((l) => JSON.parse(l) as unknown);
    expect(lines).toEqual([
      { agent: "claude", present: true, file: claudeCopy() },
      { agent: "codex", present: false, file: codexCopy() },
    ]);
  });
});

describe("the sources never write an agent's own folder", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = [here, path.join(here, "../../runner/src")];
  const WRITE = /\b(writeFile|appendFile|rename|mkdir|rm|rmdir|unlink|copyFile|cp|chmod|symlink|createWriteStream|writeFileSync|mkdirSync|renameSync|rmSync)\s*\(/;
  const OWN = /CLAUDE_CONFIG_DIR|CODEX_HOME|\.claude|\.codex/;

  async function sources(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await sources(p)));
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith("testkit.ts")) out.push(p);
    }
    return out;
  }

  it("has no write call whose line names ~/.claude, ~/.codex or their env vars", async () => {
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of await sources(root)) {
        (await readFile(file, "utf8")).split("\n").forEach((line, i) => {
          if (WRITE.test(line) && OWN.test(line)) offenders.push(`${path.relative(here, file)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("writes logins only inside credentials.ts's explicit source and agent.ts's bridge folder", async () => {
    // The write-back target is always `resolveAgentAuthFile(...)` of the sources the CLI builds, which
    // are bridge's copies; the only writers of a login file are these two modules.
    const writers: string[] = [];
    for (const root of roots) {
      for (const file of await sources(root)) {
        const text = await readFile(file, "utf8");
        if (/resolveAgentAuthFile|agentLoginFileOf|exportAgentLogin/.test(text) && /\b(writeFile|rename)\s*\(/.test(text)) writers.push(path.basename(file));
      }
    }
    expect(writers.sort()).toEqual(["agent.ts", "credentials.ts"]);
  });
});

describe("bridge-login.json: how bridge's login was made", () => {
  const sidecar = (agent: "claude" | "codex" = "claude"): string => path.join(agentDirOf(h.deps, agent), "bridge-login.json");
  const sourceOf = async (agent: "claude" | "codex" = "claude"): Promise<unknown> => (JSON.parse(await readFile(sidecar(agent), "utf8")) as { source: unknown }).source;

  it("is written by --copy (copy) and by --login (login); the runner's login file is untouched by it", async () => {
    h = await harness({ isTTY: true });
    await putSource(claudeSource(), oauthFile("mine"));
    expect(await runCli(["agent", "login", "claude", "--copy", "--yes"], h.deps)).toBe(0);
    expect(await sourceOf()).toBe("copy");
    expect(JSON.parse(await readFile(claudeCopy(), "utf8"))).toEqual({ claudeAiOauth: { accessToken: "mine", refreshToken: "r" } });

    h.spawnResult.onRun = async () => putSource(codexCopy(), codexAuth);
    expect(await runCli(["agent", "login", "codex", "--login", "--yes"], h.deps)).toBe(0);
    expect(await sourceOf("codex")).toBe("login");
    expect(((await stat(sidecar("codex"))).mode & 0o777).toString(8)).toBe("600");
  });

  it("is bound: edited while the question is open, the plan changed and nothing is written", async () => {
    h = await harness({ isTTY: true });
    await putSource(claudeSource(), oauthFile("new"));
    await putSource(claudeCopy(), oauthFile("old"));
    await writeFile(sidecar(), JSON.stringify({ source: "copy", at: "x" }));
    h.deps.confirm = async (question) => {
      h.questions.push(question);
      await writeFile(sidecar(), JSON.stringify({ source: "login", at: "y" }));
      return true;
    };
    expect(await runCli(["agent", "login", "claude", "--copy"], h.deps)).toBe(1);
    expect(printed()).toMatch(/changed while waiting/);
    expect(JSON.parse(await readFile(claudeCopy(), "utf8")).claudeAiOauth.accessToken).toBe("old");
  });

  it("a copy or login over a login bridge made signs that one out first (bridge's folder), and refuses to replace it when that fails", async () => {
    for (const argv of [["--copy"], ["--login"]]) {
      h = await harness({ isTTY: true });
      await putSource(claudeSource(), oauthFile("mine"));
      await putSource(claudeCopy(), oauthFile("bridges"));
      await writeFile(sidecar(), JSON.stringify({ source: "login", at: "x" }));
      h.spawnResult.onRun = async () => putSource(claudeCopy(), oauthFile("fresh"));
      h.quietResult.exitCode = 1;
      expect(await runCli(["agent", "login", "claude", ...argv, "--yes"], h.deps)).toBe(1);
      expect(h.out.join("")).toContain("bridge signs out the claude login it made there first (`claude auth logout`");
      expect(h.quiet).toHaveLength(1);
      expect(h.quiet[0]!.env.CLAUDE_CONFIG_DIR).toBe(agentDirOf(h.deps, "claude"));
      expect(printed()).toContain("nothing was replaced. Run `bridge agent logout claude` in a terminal, then this again.");
      expect(h.spawned).toEqual([]);
      expect(JSON.parse(await readFile(claudeCopy(), "utf8")).claudeAiOauth.accessToken).toBe("bridges");

      h.quietResult.exitCode = 0;
      h.quiet.length = 0;
      expect(await runCli(["agent", "login", "claude", ...argv, "--yes"], h.deps)).toBe(0);
      expect(h.quiet).toHaveLength(1);
      expect(await sourceOf()).toBe(argv[0] === "--copy" ? "copy" : "login");
      await h.cleanup();
    }
  });

  it("a copy over a copied login signs nothing out", async () => {
    h = await harness({ isTTY: true });
    await putSource(claudeSource(), oauthFile("mine"));
    await putSource(claudeCopy(), oauthFile("older"));
    await writeFile(sidecar(), JSON.stringify({ source: "copy", at: "x" }));
    expect(await runCli(["agent", "login", "claude", "--copy", "--yes"], h.deps)).toBe(0);
    expect(h.quiet).toEqual([]);
  });

  it("status ignores the note", async () => {
    h = await harness({ isTTY: true });
    await mkdir(agentDirOf(h.deps, "claude"), { recursive: true });
    await writeFile(sidecar(), JSON.stringify({ source: "login", at: "x" }));
    expect(await runCli(["agent", "status"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(`claude: absent (${claudeCopy()})`);
  });
});

describe("bridge agent logout", () => {
  const sidecar = (): string => path.join(agentDirOf(h.deps, "claude"), "bridge-login.json");

  it("signs out a login bridge made: interactive on a terminal, else with stdin closed and a timeout, in bridge's folder", async () => {
    h = await harness({ isTTY: true });
    await putSource(claudeCopy(), oauthFile("bridges"));
    await writeFile(sidecar(), JSON.stringify({ source: "login", at: "x" }));
    expect(await runCli(["agent", "logout", "claude"], h.deps)).toBe(0);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toMatchObject({ command: "claude", args: ["auth", "logout"] });
    expect(h.spawned[0]!.env.CLAUDE_CONFIG_DIR).toBe(agentDirOf(h.deps, "claude"));
    h.deps.isTTY = false;
    expect(await runCli(["agent", "logout", "claude"], h.deps)).toBe(0);
    expect(h.quiet[0]).toMatchObject({ command: "claude", args: ["auth", "logout"], timeoutMs: 30_000 });
    h.quietResult.exitCode = 4;
    expect(await runCli(["agent", "logout", "claude"], h.deps)).toBe(1);
    expect(printed()).toContain("exited with 4");
  });

  it("refuses a copied login or one with no note: signing it out could sign out the person's own", async () => {
    h = await harness({ isTTY: true });
    await putSource(claudeCopy(), oauthFile("mine"));
    expect(await runCli(["agent", "logout", "claude"], h.deps)).toBe(1);
    expect(printed()).toContain("there is no note (bridge-login.json)");
    await writeFile(sidecar(), JSON.stringify({ source: "copy", at: "x" }));
    expect(await runCli(["agent", "logout", "claude"], h.deps)).toBe(1);
    expect(printed()).toContain("is a copy of your own claude sign-in");
    expect(h.spawned).toEqual([]);
    expect(h.quiet).toEqual([]);
  });

  it("with no login in bridge's folder there is nothing to sign out", async () => {
    h = await harness({ isTTY: true });
    expect(await runCli(["agent", "logout", "codex"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("nothing to sign out");
    expect(h.spawned).toEqual([]);
  });
});
