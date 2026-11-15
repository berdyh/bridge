import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { upsertApp, tokenKey } from "./config.js";
import { type E2eeOps, guardedWriter } from "./deps.js";
import { installProtocolHandler, runProtocol } from "./protocol-handler.js";
import { runService } from "./service.js";
import { type Harness, exists, harness, memoryCredentials, record } from "./testkit.js";
import { wrapKeyNameOf } from "@berdyh/bridge-runner";
import { runUninstall, removableEntries } from "./uninstall.js";
import { manifestOf, runDoctor } from "./doctor.js";
import { runCli } from "./cli.js";
import { appPathsOf, runnerLockPath, workerLockPath } from "./paths.js";
import { runAgent } from "./agent.js";
import { runSelfInstall } from "./self.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const p = (...parts: string[]) => path.join(h.root, ...parts);
/** Whether nothing, not even a dangling link, is at `file`. */
const gone = (file: string): Promise<boolean> => lstat(file).then(() => false, () => true);
const MIME = "[Default Applications]\ntext/html=firefox.desktop\n\n[Added Associations]\ntext/html=firefox.desktop;\n";

/** Every file and symlink under the fake root, relative, sorted. */
async function snapshot(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(path.relative(h.root, full));
    }
  };
  await walk(h.root);
  return out.sort();
}

/** Files that belong to other tools, next to every dir uninstall removes. */
async function decoys(): Promise<string[]> {
  const files = [
    p("home/.local/bin/other-tool"),
    p("data/other-app/keep"),
    p("config/other-app/keep"),
    p("config/systemd/user/other.service"),
    p("data/applications/other.desktop"),
    p("home/.local/state/other-app/keep"),
    p("home/.claude/.credentials.json"),
    p("home/.codex/auth.json"),
  ];
  for (const f of files) {
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, "mine");
  }
  await writeFile(p("config/mimeapps.list"), MIME);
  return files;
}

/** A full install by hand, one app connected, the service and the handler registered. */
async function installEverything(): Promise<void> {
  const entry = p("data/bridge/versions/0.1.0/node_modules/@berdyh/bridge/bin/run.js");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "");
  await symlink(entry, p("home/.local/bin/bridge"));
  await symlink(entry, p("home/.local/bin/bridge-runner"));
  await upsertApp(h.deps, record({ appId: "demo" }));
  await h.deps.credentials!.set(tokenKey("demo"), "secret");
  await writeFile(p("config/demo/bridge/trust.json"), "[]");
  await mkdir(p("data/demo/bridge/plugins/x"), { recursive: true });
  await writeFile(p("data/demo/bridge/plugins/x/entry.js"), "");
  await mkdir(p("config/bridge/agents/claude"), { recursive: true });
  await writeFile(p("config/bridge/agents/claude/.credentials.json"), "{}");
  await mkdir(p("home/.local/state/demo/bridge/work"), { recursive: true });
  await writeFile(p("home/.local/state/demo/bridge/work/notes.txt"), "work");
  await mkdir(p("home/.local/state/bridge"), { recursive: true });
  await writeFile(p("home/.local/state/bridge/runner.log"), "log");
  await runService(["install", "--yes"], h.deps);
  await installProtocolHandler(h.deps, { yes: true });
  h.commands.length = 0;
  h.out.length = 0;
}

describe("bridge uninstall", () => {
  it("removes exactly the manifest: afterwards only the decoys (and mimeapps.list's other lines) remain", async () => {
    h = await harness();
    const keep = await decoys();
    const before = await snapshot();
    await installEverything();
    expect(await snapshot()).not.toEqual(before);

    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await snapshot()).toEqual(before);
    for (const f of keep) expect(await readFile(f, "utf8")).toBe("mine");
    const mime = await readFile(p("config/mimeapps.list"), "utf8");
    expect(mime).toContain("text/html=firefox.desktop");
    expect(mime).not.toContain("bridge");
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBeNull();
    expect(h.commands.map((c) => c.slice(0, 3).join(" "))).toEqual(["systemctl --user disable", "systemctl --user daemon-reload"]);
  });

  it("names the credential store in use where it says the tokens are deleted", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${h.root}/creds`;
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("Also deleted from the credential files (BRIDGE_CREDENTIAL_STORE): the tokens");
    expect(h.out.join("")).not.toContain("OS keychain");
  });

  it("prints the whole manifest before it asks, and --yes still prints it", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    await writeFile(p("config/bridge/config.json"), "{}");
    h.answers.yes = false;
    expect(await runUninstall([], h.deps)).toBe(1);
    const out = h.out.join("");
    for (const needle of [
      p("data/bridge"),
      p("config/bridge"),
      p("home/.local/state/bridge"),
      p("home/.local/bin/bridge"),
      p("config/systemd/user/bridge-runner.service"),
      p("data/applications/bridge-url-handler.desktop"),
      p("config/mimeapps.list"),
      p("home/.local/state/demo/bridge/work"),
      p("config/demo/bridge/app.json"),
      p("config/bridge/config.json"),
    ]) {
      expect(out).toContain(needle);
    }
    expect(out).toContain("demo");
    expect(out).toContain("Left alone");
    // The agents' own login folders are not listed as anything bridge handles.
    expect(out.split("\n").filter((l) => l.startsWith("Left alone: your coding agents")).join("")).not.toMatch(/\.claude|\.codex/);
    expect(h.questions).toHaveLength(1);

    h.out.length = 0;
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(p("data/bridge"));
  });

  it("a no removes nothing and runs nothing", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const before = await snapshot();
    h.answers.yes = false;
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(await snapshot()).toEqual(before);
    expect(h.commands).toEqual([]);
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret");
  });

  it("leaves every agent's login file alone and forgets each app's keychain items and state files", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const store = h.deps.credentials as ReturnType<typeof memoryCredentials>;
    await store.set(wrapKeyNameOf({ appId: "demo", runnerId: "runner-1" }), "wrap");
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await store.get(wrapKeyNameOf({ appId: "demo", runnerId: "runner-1" }))).toBeNull();
    expect(await gone(p("config/demo/bridge/trust.json"))).toBe(true);
    expect(await exists(p("home/.claude/.credentials.json"))).toBe(true);
    expect(await exists(p("home/.codex/auth.json"))).toBe(true);
  });

  it("never follows a symlink out of the manifest: links inside the dirs are unlinked, their targets stay", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const outside = p("outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "precious"), "keep");
    await symlink(outside, p("data/bridge/versions/0.0.9"));
    await symlink(outside, p("config/bridge/trust-link"));
    await symlink(path.join(outside, "precious"), p("home/.local/state/demo/bridge/link-to-file"));
    await rm(p("home/.local/state/demo/bridge/work"), { recursive: true });
    await symlink(outside, p("home/.local/state/demo/bridge/work"));

    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await readFile(path.join(outside, "precious"), "utf8")).toBe("keep");
    expect(await readdir(outside)).toEqual(["precious"]);
    expect(await gone(p("data/bridge"))).toBe(true);
    expect(await gone(p("config/bridge"))).toBe(true);
    expect(await gone(p("home/.local/state/bridge"))).toBe(true);
  });

  it("a manifest dir that is itself a symlink is unlinked and its target survives", async () => {
    h = await harness();
    await decoys();
    const outside = p("outside");
    await mkdir(path.join(outside, "versions"), { recursive: true });
    await writeFile(path.join(outside, "versions/precious"), "keep");
    await mkdir(p("outside-state"), { recursive: true });
    await writeFile(p("outside-state/precious"), "keep");
    await mkdir(p("data"), { recursive: true });
    await symlink(outside, p("data/bridge"));
    await mkdir(p("home/.local/state"), { recursive: true });
    await symlink(p("outside-state"), p("home/.local/state/bridge"));
    await writeFile(p("outside-state/runner.json"), "{}");
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    // What sits behind a link is named as left alone, never under "will be removed".
    const out = h.out.join("");
    const removing = out.split("These paths will be removed:\n")[1]!.split(/\n(?! )/)[0]!;
    expect(removing).not.toContain(p("home/.local/state/bridge/runner.json"));
    expect(removing).not.toContain(p("data/bridge/versions"));
    expect(out).toContain(`  ${p("home/.local/state/bridge/runner.json")}  (inside a link; left alone)\n`);
    expect(out).toContain(`  ${p("data/bridge/versions")}  (inside a link; left alone)\n`);
    expect(await readFile(p("outside-state/runner.json"), "utf8")).toBe("{}");
    expect(await readFile(path.join(outside, "versions/precious"), "utf8")).toBe("keep");
    expect(await readFile(p("outside-state/precious"), "utf8")).toBe("keep");
    expect(await gone(p("data/bridge"))).toBe(true);
    expect(await gone(p("home/.local/state/bridge"))).toBe(true);
    expect(await readFile(p("data/other-app/keep"), "utf8")).toBe("mine");
  });

  it("removes the launcher only when it points into our versions dir", async () => {
    h = await harness();
    await decoys();
    const launcher = p("home/.local/bin/bridge");
    await writeFile(launcher, "#!/bin/sh\nmine\n");
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await readFile(launcher, "utf8")).toBe("#!/bin/sh\nmine\n");
    expect(h.out.join("")).toContain("not a bridge launcher");

    await rm(launcher);
    await symlink("/usr/bin/true", launcher);
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await readlink(launcher)).toBe("/usr/bin/true");

    await rm(launcher);
    await symlink(p("data/bridge/versions/9.9.9/gone.js"), launcher); // dangling, but into our dir
    h.out.length = 0;
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await exists(launcher)).toBe(false);
    expect(h.out.join("")).toContain(`${launcher} [symlink to ${p("data/bridge/versions/9.9.9/gone.js")}, dangling; the link itself]`);
  });

  it("removes both launcher links when they are ours, and leaves a foreign bridge-runner alone with the message", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const alias = p("home/.local/bin/bridge-runner");
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await gone(p("home/.local/bin/bridge"))).toBe(true);
    expect(await gone(alias)).toBe(true);
    expect(h.out.join("")).toContain(`  ${alias} [symlink to`);

    await installEverything();
    await rm(alias);
    await writeFile(alias, "#!/bin/sh\nmine\n");
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await gone(p("home/.local/bin/bridge"))).toBe(true);
    expect(await readFile(alias, "utf8")).toBe("#!/bin/sh\nmine\n");
    expect(h.out.join("")).toContain(`Left alone: ${alias} is not a bridge launcher (it is not a symlink).`);
  });

  it("labels a live launcher with its real target, not as dangling", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const launcher = p("home/.local/bin/bridge");
    const entry = p("data/bridge/versions/0.1.0/node_modules/@berdyh/bridge/bin/run.js");
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    const line = h.out.join("").split("\n").find((l) => l.startsWith(`  ${launcher} `))!;
    expect(line).toContain(`[symlink to ${entry}; the link itself]`);
    expect(line).not.toContain("dangling");
  });

  it("lists only the entries that are there: an absent install.sh download folder or policy.json is not named", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    h.answers.yes = false;
    expect(await runUninstall([], h.deps)).toBe(1);
    const consent = h.out.join("").split("These paths will be removed:\n")[1]!.split("\n").filter((l) => l.startsWith("  "));
    expect(consent.join("\n")).not.toContain(p("home/.cache/bridge-install"));
    expect(consent.join("\n")).not.toContain(p("config/bridge/policy.json"));
    expect(consent.join("\n")).toContain(p("data/bridge"));

    // Once there, each is listed.
    await mkdir(p("home/.cache/bridge-install"), { recursive: true });
    await writeFile(p("config/bridge/policy.json"), "{}");
    h.out.length = 0;
    expect(await runUninstall([], h.deps)).toBe(1);
    const shown = h.out.join("");
    expect(shown).toContain(`  ${p("home/.cache/bridge-install")}  (dir: install.sh's download folder (bridge-install))\n`);
    expect(shown).toContain(`  ${p("config/bridge/policy.json")}  (file: `);
  });

  it("does nothing, quietly, when nothing is installed", async () => {
    h = await harness();
    await decoys();
    const before = await snapshot();
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(h.commands).toEqual([]);
  });

  it("on a machine with nothing of bridge's, the consent says there is nothing to remove", async () => {
    h = await harness();
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("These paths will be removed: none (no file or folder of bridge's is here).\n");
  });

  it("reports a failed step, still runs the others, and exits 1", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    h.deps.credentials!.delete = async () => {
      throw new Error("keychain locked");
    };
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("app demo: keychain locked");
    // A failed keychain step stops before any file or folder: a retry finds everything it needs.
    expect(await exists(p("data/bridge"))).toBe(true);
    // apps.json is what a second run needs to forget the app, so the config dir stays.
    expect(await exists(p("config/bridge/apps.json"))).toBe(true);
    expect(h.err.join("")).toContain("kept");
    expect(await exists(p("config/systemd/user/bridge-runner.service"))).toBe(false);
  });

  it("removes the service files even when systemctl cannot run, and says so", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    h.deps.run = async () => {
      throw new Error("spawn systemctl ENOENT");
    };
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("could not stop it");
    expect(await exists(p("config/systemd/user/bridge-runner.service"))).toBe(false);
    expect(await exists(p("data/bridge"))).toBe(false);
  });

  it("leaves a desktop entry that is a symlink (the handler fails closed) but removes the rest", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const desktop = p("data/applications/bridge-url-handler.desktop");
    await rm(desktop);
    await symlink(p("data/other-app/keep"), desktop);
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("bridge:// handler");
    expect(await readlink(desktop)).toBe(p("data/other-app/keep"));
    expect(await exists(p("data/bridge"))).toBe(false);
    expect(await readFile(p("data/other-app/keep"), "utf8")).toBe("mine");
  });

  it("stdout closed after the question (`bridge uninstall | head -1`): every removal still runs and the exit code is the command's", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    // From the answer on, stdout is a pipe whose reader closed its end (and lives on), as `head -1` does.
    const reader = spawn("sh", ["-c", "exec 0<&-; echo ready; sleep 5"], { stdio: ["pipe", "pipe", "ignore"] });
    onTestFinished(() => void reader.kill());
    await once(reader.stdout!, "data");
    let closed = 0;
    h.deps.confirm = async () => {
      h.deps.stdout = guardedWriter(reader.stdin!, { onClosed: () => void closed++ });
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(1);
    for (const gone of ["data/bridge", "config/bridge", "home/.local/bin/bridge", "config/demo/bridge", "home/.local/state/bridge"]) expect(await exists(p(gone))).toBe(false);
  });

  it("warns about a runner started by hand", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    await writeFile(p("home/.local/state/bridge/runner.json"), JSON.stringify({ version: 1, pid: process.pid, startedAt: "x", apps: {}, browsers: 0 }));
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.err.join("")).toContain(`still running (pid ${process.pid})`);
  });

  it("a runner that is the service's main pid is not called hand-started: uninstall stops the service first", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    await writeFile(p("home/.local/state/bridge/runner.json"), JSON.stringify({ version: 1, pid: process.pid, startedAt: "x", apps: {}, browsers: 0 }));
    let mainPid = process.pid;
    const shows: string[][] = [];
    h.deps.run = async (command, args) => {
      h.commands.push([command, ...args]);
      if (command === "systemctl" && args.includes("MainPID")) {
        shows.push([...args]);
        return { exitCode: 0, stdout: `${mainPid}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(shows).toEqual([["--user", "show", "-p", "MainPID", "--value", "bridge-runner.service"]]);
    expect(h.err.join("")).not.toContain("by hand");
    expect(h.out.join("")).toContain(`The runner (pid ${process.pid}) runs under the background service, which uninstall stops first.`);
    // The service is stopped before anything is removed.
    expect(h.commands.findIndex((c) => c.includes("disable"))).toBeGreaterThan(h.commands.findIndex((c) => c.includes("MainPID")));

    // Another main pid (the service runs a different runner): the runner here was started by hand.
    await h.cleanup();
    h = await harness();
    await decoys();
    await installEverything();
    await writeFile(p("home/.local/state/bridge/runner.json"), JSON.stringify({ version: 1, pid: process.pid, startedAt: "x", apps: {}, browsers: 0 }));
    mainPid = process.pid + 1;
    h.deps.run = async (command, args) => ({ exitCode: 0, stdout: command === "systemctl" && args.includes("MainPID") ? `${mainPid}\n` : "", stderr: "" });
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.err.join("")).toContain(`still running (pid ${process.pid})`);
  });

  it("asks systemd nothing when no runner is running or no service is installed", async () => {
    h = await harness();
    await decoys();
    await mkdir(p("home/.local/state/bridge"), { recursive: true });
    await writeFile(p("home/.local/state/bridge/runner.json"), JSON.stringify({ version: 1, pid: process.pid, startedAt: "x", apps: {}, browsers: 0 }));
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.commands.filter((c) => c.includes("MainPID"))).toEqual([]);
    expect(h.err.join("")).toContain(`still running (pid ${process.pid})`);
  });

  it("an unreadable apps.json fails the uninstall: the config dir with apps.json is kept for a second run, the rest goes", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    await writeFile(p("config/bridge/apps.json"), "{nope");
    h.answers.yes = false;
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.out.join("")).not.toContain(`${p("config/bridge")}  (`);
    h.answers.yes = true;
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("cannot be removed from the OS keychain");
    expect(h.err.join("")).toContain("run bridge uninstall again");
    // The apps that have a folder of their own are offered, so the person can see what is left.
    expect(h.err.join("")).toContain(`demo (${p("config/demo/bridge/app.json")})`);
    expect(h.out.join("")).not.toContain("Uninstalled bridge.");
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toBe("{nope");
    // Not listed, so not removed: the app's own folders are left for the second run.
    expect(await exists(p("config/demo/bridge/trust.json"))).toBe(true);
    expect(await exists(p("home/.local/state/demo/bridge/work/notes.txt"))).toBe(true);
    expect(await gone(p("data/bridge"))).toBe(true);
    expect(await gone(p("home/.local/state/bridge"))).toBe(true);
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret");
  });

  it("takes no arguments", async () => {
    h = await harness();
    await expect(runUninstall(["now"], h.deps)).rejects.toThrow(/usage/);
  });
});

describe("bridge uninstall: nothing changes between the consent and the removal", () => {
  it("never deletes through a symlinked bridge/ dir: what is inside the target survives and the link goes", async () => {
    for (const linked of ["config/demo/bridge", "home/.local/state/demo/bridge", "data/demo/bridge", "config/bridge"]) {
      h = await harness();
      await decoys();
      await installEverything();
      const outside = p("outside");
      await rename(p(linked), outside);
      await writeFile(path.join(outside, "precious"), "keep");
      await symlink(outside, p(linked));
      const inTarget = (await readdir(outside)).sort();
      expect(await runUninstall(["--yes"], h.deps), linked).toBe(0);
      expect((await readdir(outside)).sort(), linked).toEqual(inTarget);
      expect(await readFile(path.join(outside, "precious"), "utf8"), linked).toBe("keep");
      expect(await gone(p(linked)), linked).toBe(true);
      expect(await gone(p("config/bridge"))).toBe(true);
      await h.cleanup();
    }
  });

  it("a symlinked <config>/bridge whose target holds the apps: the link goes, the target and its files stay, exit 0", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const outside = p("outside");
    await rename(p("config/bridge"), outside);
    await symlink(outside, p("config/bridge"));
    const before = await readFile(path.join(outside, "apps.json"), "utf8");
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await gone(p("config/bridge"))).toBe(true);
    expect(await readFile(path.join(outside, "apps.json"), "utf8")).toBe(before);
    // The apps' own folders are not inside <config>/bridge: they go through their own entries.
    expect(await gone(p("config/demo"))).toBe(true);
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBeNull();
  });

  it("a symlink put in a state dir while the prompt was open is not followed either", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const outside = p("outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "demo.runner-1.json"), "keep");
    h.deps.confirm = async () => {
      await rename(p("home/.local/state/demo/bridge"), p("moved-state"));
      await symlink(outside, p("home/.local/state/demo/bridge"));
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await readFile(path.join(outside, "demo.runner-1.json"), "utf8")).toBe("keep");
    expect(await readlink(p("home/.local/state/demo/bridge"))).toBe(outside);
    expect(await exists(p("config/bridge/apps.json"))).toBe(true);
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret");
  });

  it("shows where a symlinked mimeapps.list really lands, and leaves it alone when the link moves during the prompt", async () => {
    h = await harness();
    await decoys();
    await writeFile(p("config/mime-a.list"), MIME);
    await rm(p("config/mimeapps.list"));
    await symlink(p("config/mime-a.list"), p("config/mimeapps.list"));
    await installEverything();
    const other = await readFile(p("config/mime-a.list"), "utf8");
    expect(other).toContain("bridge");
    await writeFile(p("config/mime-b.list"), other);

    h.deps.confirm = async () => {
      await rm(p("config/mimeapps.list"));
      await symlink(p("config/mime-b.list"), p("config/mimeapps.list"));
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.out.join("")).toContain(`${p("config/mimeapps.list")} -> ${p("config/mime-a.list")}`);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await readFile(p("config/mime-b.list"), "utf8")).toBe(other);
    expect(await readFile(p("config/mime-a.list"), "utf8")).toBe(other);
    expect(await readlink(p("config/mimeapps.list"))).toBe(p("config/mime-b.list"));
    // rule B: the first change stops the whole uninstall, so nothing else was removed either
    expect(await exists(p("data/bridge"))).toBe(true);
    expect(h.commands).toEqual([]);
  });

  it("a launcher replaced by someone else's file during the prompt is left alone", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const launcher = p("home/.local/bin/bridge");
    h.deps.confirm = async () => {
      await rm(launcher);
      await writeFile(launcher, "#!/bin/sh\nmine\n");
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await readFile(launcher, "utf8")).toBe("#!/bin/sh\nmine\n");
    expect(await exists(p("data/bridge"))).toBe(true);
  });

  it("a launcher replaced by a directory during the prompt is not removed recursively", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const launcher = p("home/.local/bin/bridge");
    h.deps.confirm = async () => {
      await rm(launcher);
      await mkdir(launcher);
      await writeFile(path.join(launcher, "mine"), "keep");
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(await readFile(path.join(launcher, "mine"), "utf8")).toBe("keep");
  });
});

describe("bridge uninstall: a parent retargeted during the prompt", () => {
  /** A copy of `dir` outside, with a precious file, that `dir` is then replaced by a symlink to. */
  async function retarget(dir: string): Promise<string> {
    const outside = p("outside", path.basename(dir));
    await mkdir(path.dirname(outside), { recursive: true });
    await rename(dir, `${dir}.moved`);
    await mkdir(outside, { recursive: true });
    await symlink(outside, dir);
    return outside;
  }

  it("the data dir: nothing outside is deleted and the uninstall fails", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    h.deps.confirm = async () => {
      const outside = await retarget(p("data"));
      await mkdir(path.join(outside, "bridge/versions"), { recursive: true });
      await writeFile(path.join(outside, "bridge/versions/precious"), "keep");
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await readFile(p("outside/data/bridge/versions/precious"), "utf8")).toBe("keep");
  });

  it("the config dir: the app state, apps.json and service files outside survive", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const precious = ["bridge/apps.json", "bridge/trust/demo.runner-1.json", "bridge/identity/demo.runner-1.json", "systemd/user/bridge-runner.service", "mimeapps.list"];
    h.deps.confirm = async () => {
      const outside = await retarget(p("config"));
      for (const f of precious) {
        await mkdir(path.dirname(path.join(outside, f)), { recursive: true });
        await writeFile(path.join(outside, f), "keep");
      }
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    for (const f of precious) expect(await readFile(p("outside/config", f), "utf8"), f).toBe("keep");
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret");
    expect(h.commands).toEqual([]);
  });

  it("the launcher's dir: a bridge link outside is not removed", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const entry = p("data/bridge/versions/0.1.0/node_modules/@berdyh/bridge/bin/run.js");
    h.deps.confirm = async () => {
      const outside = await retarget(p("home/.local/bin"));
      await symlink(entry, path.join(outside, "bridge"));
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await readlink(p("outside/bin/bridge"))).toBe(entry);
  });

  it("mimeapps.list edited during the prompt is not rewritten: the consent bound its planned text", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    let edited = "";
    h.deps.confirm = async () => {
      edited = `${await readFile(p("config/mimeapps.list"), "utf8")}[Default Applications]\nx-scheme-handler/other=other.desktop\n`;
      await writeFile(p("config/mimeapps.list"), edited);
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await readFile(p("config/mimeapps.list"), "utf8")).toBe(edited);
  });
});

describe("bridge uninstall: credentials first, and the apps shown are the apps forgotten", () => {
  it("a symlinked <config>/bridge is unlinked as a leaf: a trust link inside its target is never touched", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const outside = p("outside");
    await rename(p("config/bridge"), outside);
    await symlink(outside, p("config/bridge"));
    const elsewhere = p("elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "demo.runner-1.json"), "[]");
    await symlink(elsewhere, path.join(outside, "trust-link"));
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await gone(p("config/bridge"))).toBe(true);
    expect(await readlink(path.join(outside, "trust-link"))).toBe(elsewhere);
    expect(await readFile(path.join(elsewhere, "demo.runner-1.json"), "utf8")).toBe("[]");
  });

  it("an app added to apps.json during the prompt keeps apps.json and its token, and the uninstall fails", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    h.deps.confirm = async () => {
      await upsertApp(h.deps, record({ appId: "late", runnerId: "runner-2" }));
      await h.deps.credentials!.set(tokenKey("late"), "late-secret");
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toContain("late");
    expect(await h.deps.credentials!.get(tokenKey("late"))).toBe("late-secret");
  });

  it("an app added during the prompt when none was connected keeps apps.json too", async () => {
    h = await harness();
    await decoys();
    h.deps.confirm = async () => {
      await upsertApp(h.deps, record({ appId: "late" }));
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toContain("late");
  });

  it("a failing keychain removes nothing a retry needs (not even the config link), and the retry finishes", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const outside = p("outside");
    await rename(p("config/bridge"), outside);
    await symlink(outside, p("config/bridge"));
    const store = h.deps.credentials!;
    const del = store.delete.bind(store);
    store.delete = async () => {
      throw new Error("keychain locked");
    };
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("keychain locked");
    expect(await readlink(p("config/bridge"))).toBe(outside);
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toContain("demo");
    // The failing app's own config dir stays too: its app.json names the wrapping key the retry must forget.
    expect(await exists(p("config/demo/bridge/trust.json"))).toBe(true);
    expect(await exists(p("config/demo/bridge/app.json"))).toBe(true);
    expect(await store.get(tokenKey("demo"))).toBe("secret");

    store.delete = del;
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await store.get(tokenKey("demo"))).toBeNull();
    expect(await gone(p("config/bridge"))).toBe(true);
    expect(await gone(p("config/demo"))).toBe(true);
  });
});

describe("bridge uninstall: rule A (aliased layouts) and rule B (one gate before every step)", () => {
  it("a config dir that is the bridge data dir is refused before the question; nothing, not even other apps' files, is removed", async () => {
    h = await harness();
    await mkdir(p("data/bridge"), { recursive: true });
    await symlink(p("data/bridge"), p("config"));
    await decoys();
    await installEverything();
    h.answers.yes = true;
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.questions).toEqual([]);
    const err = h.err.join("");
    expect(err).toContain("unusual layout");
    expect(err).toContain(p("config"));
    expect(err).toContain(p("data/bridge"));
    expect(err).toContain("Remove these by hand");
    expect(err).toContain("and the apps' items in the OS keychain.");
    expect(await readFile(p("data/bridge/other-app/keep"), "utf8")).toBe("mine");
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toContain("demo");
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret");
    expect(h.commands).toEqual([]);
  });

  it("the aliased-layout refusal names the credential files under BRIDGE_CREDENTIAL_STORE=file:<dir>", async () => {
    h = await harness();
    await mkdir(p("data/bridge"), { recursive: true });
    await symlink(p("data/bridge"), p("config"));
    await decoys();
    await installEverything();
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${h.root}/creds`;
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("and the apps' items in the credential files (BRIDGE_CREDENTIAL_STORE).");
    expect(h.err.join("")).not.toContain("keychain");
  });

  it("a data dir that is the config dir is refused too, so a failing keychain cannot lose apps.json through it", async () => {
    h = await harness();
    await mkdir(p("config"), { recursive: true });
    await symlink(p("config"), p("data"));
    await decoys();
    await installEverything();
    h.deps.credentials!.delete = async () => {
      throw new Error("keychain locked");
    };
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("unusual layout");
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toContain("demo");
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret");
  });

  it("an app added while the keychain is cleaned is the accepted window: the config link goes, its target is untouched", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const outside = p("outside");
    await rename(p("config/bridge"), outside);
    await symlink(outside, p("config/bridge"));
    const store = h.deps.credentials!;
    const del = store.delete.bind(store);
    let added = false;
    store.delete = async (key) => {
      if (!added) {
        added = true;
        await upsertApp(h.deps, record({ appId: "late", runnerId: "runner-2" }));
      }
      await del(key);
    };
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await gone(p("config/bridge"))).toBe(true);
    expect(await readFile(path.join(outside, "apps.json"), "utf8")).toContain("late");
  });

  it("a symlinked config dir that overlaps nothing still uninstalls: the bridge parts go, the real base and its other files stay", async () => {
    h = await harness();
    await mkdir(p("real-config"), { recursive: true });
    await symlink(p("real-config"), p("config"));
    await decoys();
    await installEverything();
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await gone(p("real-config/bridge"))).toBe(true);
    expect(await gone(p("real-config/systemd/user/bridge-runner.service"))).toBe(true);
    expect(await readFile(p("real-config/other-app/keep"), "utf8")).toBe("mine");
    expect(await readFile(p("real-config/systemd/user/other.service"), "utf8")).toBe("mine");
    expect(await readFile(p("real-config/mimeapps.list"), "utf8")).not.toContain("bridge");
    expect(await readlink(p("config"))).toBe(p("real-config"));
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBeNull();
  });
});

describe("bridge uninstall: the gate after every piece of external work, item by item", () => {
  it("trust retargeted during one app's keychain call: the next app's cleanup removes nothing outside", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    await upsertApp(h.deps, record({ appId: "second", runnerId: "runner-2" }));
    const outside = p("outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "second.runner-2.json"), "keep");
    await writeFile(path.join(outside, "demo.runner-1.json"), "keep");
    const store = h.deps.credentials!;
    const del = store.delete.bind(store);
    let moved = false;
    store.delete = async (key) => {
      if (!moved) {
        moved = true;
        await rename(p("config/demo/bridge"), p("moved-demo-bridge"));
        await symlink(outside, p("config/demo/bridge"));
      }
      await del(key);
    };
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await readFile(path.join(outside, "second.runner-2.json"), "utf8")).toBe("keep");
    expect(await readFile(path.join(outside, "demo.runner-1.json"), "utf8")).toBe("keep");
    expect(await gone(p("config/bridge"))).toBe(true);
  });

  it("the data dir retargeted during a keychain call: removing data/bridge is refused and named, and the uninstall stops", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const outside = p("outside");
    await mkdir(path.join(outside, "bridge"), { recursive: true });
    await writeFile(path.join(outside, "bridge/precious"), "keep");
    const store = h.deps.credentials!;
    const del = store.delete.bind(store);
    let moved = false;
    store.delete = async (key) => {
      if (!moved) {
        moved = true;
        await rename(p("data"), p("data.moved"));
        await symlink(outside, p("data"));
      }
      await del(key);
    };
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("left behind");
    expect(h.err.join("")).toContain("stopped here");
    expect(await readFile(path.join(outside, "bridge/precious"), "utf8")).toBe("keep");
  });

  it("the service dir retargeted while systemctl disable runs: its removal is refused and named, and nothing after it runs", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const dir = p("config/systemd/user");
    const outside = p("outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "bridge-runner.service"), "someone else's unit");
    h.deps.run = async (_command, args) => {
      if (args.includes("disable")) {
        await rename(dir, `${dir}.moved`);
        await symlink(outside, dir);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("left behind");
    expect(await readFile(path.join(outside, "bridge-runner.service"), "utf8")).toBe("someone else's unit");
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret");
    expect(await exists(p("data/bridge"))).toBe(true);
  });

  it("the wants link systemctl disable removes itself is expected: the uninstall finishes", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const unit = p("config/systemd/user/bridge-runner.service");
    const wants = p("config/systemd/user/default.target.wants/bridge-runner.service");
    await mkdir(path.dirname(wants), { recursive: true });
    await symlink(unit, wants);
    h.deps.run = async (_command, args) => {
      if (args.includes("disable")) await rm(wants);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await gone(unit)).toBe(true);
  });
});

describe("bridge uninstall: a failed daemon-reload", () => {
  it("is a failure: exit 1, no 'Uninstalled bridge.', the command named", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    h.deps.run = async (_command, args) => (args.includes("daemon-reload") ? { exitCode: 1, stdout: "", stderr: "bus gone" } : { exitCode: 0, stdout: "", stderr: "" });
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("systemctl --user daemon-reload` failed: bus gone");
    expect(h.out.join("")).not.toContain("Uninstalled bridge.");
    expect(await gone(p("data/bridge"))).toBe(true);
  });
});

describe("bridge uninstall: the layout is part of the one recompute", () => {
  it("an alias made during the question (data becomes the config dir) is refused and nothing runs", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    h.deps.confirm = async () => {
      await rename(p("data"), p("data.moved"));
      await symlink(p("config"), p("data"));
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await readFile(p("config/other-app/keep"), "utf8")).toBe("mine");
    expect(await exists(p("config/bridge/apps.json"))).toBe(true);
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret");
    expect(h.commands).toEqual([]);
  });
});

describe("removableEntries", () => {
  it("keeps only the outermost manifest entries it owns, never the service, the launcher or the external files", async () => {
    h = await harness();
    await upsertApp(h.deps, record({ appId: "demo" }));
    const entries = removableEntries(await manifestOf(h.deps), h.deps).map((e) => e.path);
    // The machine-wide dirs, then each app's three bridge/ dirs (what is inside them is nested, so not listed again),
    // then install.sh's download folder.
    expect(entries).toEqual([p("data/bridge"), p("config/bridge"), p("home/.local/state/bridge"), p("config/demo/bridge"), p("data/demo/bridge"), p("home/.local/state/demo/bridge"), p("home/.cache/bridge-install")]);
    expect(entries.some((e) => e.endsWith(path.join("config", "demo")))).toBe(false);
  });
});

describe("bridge uninstall: the apps' own folders", () => {
  async function twoApps(): Promise<void> {
    await installEverything();
    await upsertApp(h.deps, record({ appId: "other", name: "Other", origin: "https://other.example", runnerId: "runner-2" }));
    await h.deps.credentials!.set(tokenKey("other"), "secret-other");
    await h.deps.credentials!.set(wrapKeyNameOf({ appId: "demo", runnerId: "runner-1" }), "wrap-demo");
    await h.deps.credentials!.set(wrapKeyNameOf({ appId: "other", runnerId: "runner-2" }), "wrap-other");
    await mkdir(p("home/.local/state/other/bridge/work"), { recursive: true });
    await writeFile(p("home/.local/state/other/bridge/work/notes.txt"), "work");
  }

  it("one app's keychain failing after another's succeeded removes no file: both records and apps.json stay, and the retry finishes with nothing left", async () => {
    h = await harness();
    await decoys();
    const before = await snapshot();
    await twoApps();
    const store = h.deps.credentials!;
    const del = store.delete.bind(store);
    store.delete = async (key) => {
      if (key === wrapKeyNameOf({ appId: "other", runnerId: "runner-2" })) throw new Error("keychain locked");
      await del(key);
    };
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("app other: keychain locked");
    // demo's keychain items went, but none of its files: its record is what the retry reads.
    expect(await store.get(wrapKeyNameOf({ appId: "demo", runnerId: "runner-1" }))).toBeNull();
    expect(await exists(p("config/demo/bridge/app.json"))).toBe(true);
    expect(await exists(p("config/other/bridge/app.json"))).toBe(true);
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toMatch(/demo[\s\S]*other/);
    expect(await exists(p("data/demo/bridge/plugins/x/entry.js"))).toBe(true);
    expect(await exists(p("data/bridge"))).toBe(true);

    store.delete = del;
    h.err.length = 0;
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.err.join("")).toBe("");
    expect([...(store as ReturnType<typeof memoryCredentials>).data.keys()]).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("an app folder that cannot be removed keeps its app.json and apps.json; once readable again the retry finishes with nothing left", async () => {
    h = await harness();
    await decoys();
    const before = await snapshot();
    await twoApps();
    const stuck = p("home/.local/state/demo/bridge");
    await chmod(stuck, 0o000);
    try {
      expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    } finally {
      await chmod(stuck, 0o700);
    }
    expect(h.err.join("")).toContain("app demo");
    // demo is still recorded (its record and its apps.json entry), so the retry finds its work files.
    expect(await exists(p("config/demo/bridge/app.json"))).toBe(true);
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toContain("demo");
    expect(await exists(p("home/.local/state/demo/bridge/work/notes.txt"))).toBe(true);
    // The other app finished; the machine-wide paths wait for every app, the launcher included.
    expect(await gone(p("config/other"))).toBe(true);
    expect(await exists(p("data/bridge"))).toBe(true);
    expect(await exists(p("home/.local/bin/bridge"))).toBe(true);

    h.err.length = 0;
    const second = await runUninstall(["--yes"], h.deps);
    expect(h.err.join("")).toBe("");
    expect(second).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("under BRIDGE_CREDENTIAL_STORE=file:<dir> the failure lines name the credential files, not the keychain", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${h.root}/creds`;
    await writeFile(p("config/bridge/apps.json"), "{nope");
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    const err = h.err.join("");
    expect(err).toContain("cannot be removed from the credential files (BRIDGE_CREDENTIAL_STORE)");
    expect(err).toContain("remove the remaining apps' credentials from the credential files (BRIDGE_CREDENTIAL_STORE)");
    expect(err).not.toContain("keychain");
  });

  it("under BRIDGE_CREDENTIAL_STORE=file:<dir> a store that fails to delete is reported as credential items of that store", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${h.root}/creds`;
    h.deps.credentials!.delete = async () => {
      throw new Error("disk full");
    };
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    const err = h.err.join("");
    expect(err).toContain("app demo: disk full");
    expect(err).toContain("the credential items of demo could not be removed from the credential files (BRIDGE_CREDENTIAL_STORE)");
    expect(err).not.toContain("keychain");
  });

  const asRoot = process.getuid?.() === 0;

  it.skipIf(asRoot)("(a) a config parent that cannot be written: app.json goes but bridge/ stays; after restoring, the retry removes the half-removed app and exits 0", async () => {
    h = await harness();
    await decoys();
    const before = await snapshot();
    await installEverything();
    await chmod(p("config/demo"), 0o500);
    try {
      expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    } finally {
      await chmod(p("config/demo"), 0o700);
    }
    // The half removal: app.json is gone, apps.json still lists demo and its bridge/ dir is left.
    expect(await gone(p("config/demo/bridge/app.json"))).toBe(true);
    expect(await exists(p("config/demo/bridge"))).toBe(true);
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toContain("demo");
    h.out.length = 0;
    h.err.length = 0;
    h.deps.env.BRIDGE_CREDENTIAL_STORE = `file:${h.root}/creds`;
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("Half removed (listed, but their app.json is gone): demo");
    // The half-removed record's line is store-neutral: it names no keychain when the files are the store.
    expect(h.out.join("")).toContain("(credential items go first)");
    expect(h.out.join("")).not.toContain("keychain");
    expect(h.err.join("")).toBe("");
    delete h.deps.env.BRIDGE_CREDENTIAL_STORE;
    expect(await snapshot()).toEqual(before);
  });

  it.skipIf(asRoot)("(b) one app's state dir and <config>/bridge locked: the finished app cannot be pruned from apps.json; after restoring, the retry exits 0 and leaves nothing", async () => {
    h = await harness();
    await decoys();
    const before = await snapshot();
    await twoApps();
    const stuck = p("home/.local/state/other/bridge");
    await chmod(stuck, 0o000);
    await chmod(p("config/bridge"), 0o500);
    try {
      expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    } finally {
      await chmod(stuck, 0o700);
      await chmod(p("config/bridge"), 0o700);
    }
    // demo finished (its record is gone) but is still listed: the lock beside apps.json could not be taken.
    expect(await gone(p("config/demo/bridge/app.json"))).toBe(true);
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toMatch(/demo[\s\S]*other/);
    h.err.length = 0;
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.err.join("")).toBe("");
    expect(await snapshot()).toEqual(before);
  });

  it("an app.json recreated during the question changes the plan: nothing is removed", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const record = await readFile(p("config/demo/bridge/app.json"), "utf8");
    await rm(p("config/demo/bridge/app.json"));
    h.deps.confirm = async () => {
      await writeFile(p("config/demo/bridge/app.json"), record);
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await exists(p("config/demo/bridge/trust.json"))).toBe(true);
    expect(await exists(p("data/bridge"))).toBe(true);
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret");
  });

  it("a corrupt app.json deleted during the question (broken, then absent) is refused as changed: nothing the consent said was kept is removed", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    await writeFile(p("config/demo/bridge/app.json"), "{nope");
    h.deps.confirm = async () => {
      await rm(p("config/demo/bridge/app.json"));
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    // The consent (one snapshot) said the broken app's folder and <config>/bridge stay.
    expect(h.err.join("")).toContain(`${p("config/demo/bridge")} and ${p("config/bridge")} are kept`);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await exists(p("config/demo/bridge/trust.json"))).toBe(true);
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toContain("demo");
    expect(await exists(p("data/bridge"))).toBe(true);
  });

  it("the consent text comes from the plan it runs: a half-removed app is listed, its config dir is shown as removed and is removed", async () => {
    h = await harness();
    await decoys();
    const before = await snapshot();
    await installEverything();
    await rm(p("config/demo/bridge/app.json"));
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    const out = h.out.join("");
    expect(out).toContain("Half removed (listed, but their app.json is gone): demo");
    expect(out).toContain(`  ${p("config/demo/bridge")}  (dir: demo: bridge config folder)`);
    expect(h.err.join("")).not.toContain("are kept");
    expect(await snapshot()).toEqual(before);
  });

  it("an app.json that is a dangling link is broken, not absent: its config dir is kept and the wrapping key is named as unknown", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    await rm(p("config/demo/bridge/app.json"));
    await symlink(p("nowhere/app.json"), p("config/demo/bridge/app.json"));
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    const err = h.err.join("");
    expect(err).toContain("wrapping key cannot be named");
    expect(h.out.join("")).not.toContain("Half removed");
    expect(await readlink(p("config/demo/bridge/app.json"))).toBe(p("nowhere/app.json"));
    expect(await exists(p("config/demo/bridge/trust.json"))).toBe(true);
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toContain("demo");
  });

  it("removes every app's three bridge/ dirs and the agents folder; the keychain items are the same names as before", async () => {
    h = await harness();
    await decoys();
    await twoApps();
    const store = h.deps.credentials as ReturnType<typeof memoryCredentials>;
    expect([...store.data.keys()].sort()).toEqual(
      ["bridge/e2ee-identity-key/demo/runner-1", "bridge/e2ee-identity-key/other/runner-2", "demo/pairing.tokens", "other/pairing.tokens"],
    );
    expect(await exists(p("config/bridge/agents/claude/.credentials.json"))).toBe(true);
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect([...store.data.keys()]).toEqual([]);
    for (const f of ["config/bridge", "config/demo", "config/other", "data/demo", "home/.local/state/demo", "home/.local/state/other", "data/bridge", "home/.local/state/bridge"]) {
      expect(await gone(p(f)), f).toBe(true);
    }
    expect(await readFile(p("config/other-app/keep"), "utf8")).toBe("mine");
  });

  it("lists every parent as removed only if empty before it asks; a decoy next to bridge/ keeps its parent, and a link stays", async () => {
    h = await harness();
    await decoys();
    await twoApps();
    await writeFile(p("config/demo/their-settings.toml"), "the app's own");
    const outside = p("outside-state");
    await mkdir(outside, { recursive: true });
    await rename(p("home/.local/state/other"), p("outside-other"));
    await symlink(p("outside-other"), p("home/.local/state/other"));
    h.answers.yes = false;
    expect(await runUninstall([], h.deps)).toBe(1);
    const asked = h.out.join("");
    expect(asked).toContain("Removed only if empty");
    for (const parent of ["config/demo", "data/demo", "home/.local/state/demo", "config/other", "data/other", "home/.local/state/other"]) expect(asked).toContain(p(parent));
    expect(await exists(p("config/demo/bridge/app.json"))).toBe(true);

    h.answers.yes = true;
    expect(await runUninstall([], h.deps)).toBe(0);
    expect(await readFile(p("config/demo/their-settings.toml"), "utf8")).toBe("the app's own");
    expect(await gone(p("config/demo/bridge"))).toBe(true);
    expect(await gone(p("data/demo"))).toBe(true);
    expect(await gone(p("home/.local/state/demo"))).toBe(true);
    // The linked state parent is the app's own link: it stays, bridge/ inside its target goes.
    expect((await lstat(p("home/.local/state/other"))).isSymbolicLink()).toBe(true);
    expect(await gone(p("outside-other/bridge"))).toBe(true);
    expect(await exists(p("outside-other"))).toBe(true);
  });

  it("a symlinked app parent is never followed: the files in its target outside bridge/ survive", async () => {
    h = await harness();
    await decoys();
    const real = p("elsewhere/demo-config");
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, "theirs.txt"), "mine");
    await mkdir(h.deps.configDir, { recursive: true });
    await symlink(real, p("config/demo"));
    await installEverything();
    expect(await exists(path.join(real, "bridge", "app.json"))).toBe(true);
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await readFile(path.join(real, "theirs.txt"), "utf8")).toBe("mine");
    expect(await gone(path.join(real, "bridge"))).toBe(true);
    expect((await lstat(p("config/demo"))).isSymbolicLink()).toBe(true);
  });

  it("an app whose app.json is broken: its token goes, <config>/bridge and that app's config dir stay, the others are removed, exit 1", async () => {
    h = await harness();
    await decoys();
    await twoApps();
    await writeFile(p("config/other/bridge/app.json"), "{nope");
    h.answers.yes = false;
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("other");
    h.answers.yes = true;
    expect(await runUninstall([], h.deps)).toBe(1);
    const err = h.err.join("");
    expect(err).toContain(p("config/other/bridge"));
    expect(err).toContain("bridge apps remove other");
    expect(await h.deps.credentials!.get(tokenKey("other"))).toBeNull();
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBeNull();
    expect(await h.deps.credentials!.get(wrapKeyNameOf({ appId: "demo", runnerId: "runner-1" }))).toBeNull();
    // What a second run needs stays: apps.json and the broken app's config dir.
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toContain("other");
    expect(await exists(p("config/other/bridge/app.json"))).toBe(true);
    // The healthy app is gone.
    expect(await gone(p("config/demo"))).toBe(true);
    expect(await gone(p("data/bridge"))).toBe(true);
  });

  it("with apps.json unreadable the refusal offers the apps that have a folder of their own (config/*/bridge/app.json)", async () => {
    h = await harness();
    await decoys();
    await twoApps();
    await writeFile(p("config/bridge/apps.json"), "{nope");
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    const err = h.err.join("");
    expect(err).toContain(`demo (${p("config/demo/bridge/app.json")})`);
    expect(err).toContain(`other (${p("config/other/bridge/app.json")})`);
    expect(await readFile(p("config/bridge/apps.json"), "utf8")).toBe("{nope");
  });

  it("a bridge/ dir of one app retargeted into another's during the question is refused as a changed plan", async () => {
    h = await harness();
    await decoys();
    await twoApps();
    h.deps.confirm = async () => {
      await rename(p("data/demo/bridge"), p("moved"));
      await symlink(p("home/.local/state/other/bridge"), p("data/demo/bridge"));
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await exists(p("home/.local/state/other/bridge/work/notes.txt"))).toBe(true);
    expect(await h.deps.credentials!.get(tokenKey("demo"))).toBe("secret");
  });

  it("an aliased app dir is refused before the question (Rule A), nothing removed", async () => {
    h = await harness();
    await decoys();
    await twoApps();
    await rm(p("data/demo/bridge"), { recursive: true });
    await symlink(p("home/.local/state/other/bridge"), p("data/demo/bridge"));
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("unusual layout");
    expect(await exists(p("home/.local/state/other/bridge/work/notes.txt"))).toBe(true);
    expect(h.questions).toEqual([]);
  });
});

describe("bridge uninstall and the agents' logins bridge made", () => {
  const claudeDir = () => p("config/bridge/agents/claude");
  const LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r" } });
  async function withLogin(source: "login" | "copy" | undefined): Promise<void> {
    h = await harness();
    await decoys();
    await installEverything();
    await writeFile(path.join(claudeDir(), ".credentials.json"), LOGIN, { mode: 0o600 });
    if (source !== undefined) await writeFile(path.join(claudeDir(), "bridge-login.json"), JSON.stringify({ source, at: "2026-10-23T00:00:00.000Z" }));
  }

  it("signs out a login bridge made (source login) with CLAUDE_CONFIG_DIR at bridge's canonical folder, before any file of bridge's is removed", async () => {
    await withLogin("login");
    let stillThere: boolean[] = [];
    h.quietResult.onRun = async () => {
      stillThere = await Promise.all([claudeDir(), p("config/demo/bridge/trust.json"), p("home/.local/bin/bridge"), p("data/bridge/versions")].map(exists));
    };
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(`Also: bridge signs out the claude login it made (\`claude auth logout\` with its config folder ${claudeDir()}; your own claude sign-in is not touched). If that fails, bridge's login folder is kept so you can retry.`);
    expect(h.quiet).toHaveLength(1);
    expect(h.quiet[0]).toMatchObject({ command: "claude", args: ["auth", "logout"], timeoutMs: 30_000 });
    expect(h.quiet[0]!.env.CLAUDE_CONFIG_DIR).toBe(claudeDir());
    expect(stillThere).toEqual([true, true, true, true]);
    expect(await exists(claudeDir())).toBe(false);
    // Said once it succeeded, after the question: what ran, and no claim about the provider's side.
    const after = h.out.join("").split("Uninstalled bridge.")[0]!;
    expect(after).toContain("Signed out the claude login bridge made (claude auth logout).\n");
    const line = h.out.join("").split("\n").find((l) => l.startsWith("Signed out"))!;
    expect(line).not.toMatch(/revok|server/i);
  });

  it("never signs out a copied login, and says why", async () => {
    await withLogin("copy");
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.quiet).toEqual([]);
    expect(h.out.join("")).toContain("Deleted here only: your copied claude login. It shares your own sign-in, which is kept, so bridge does not sign it out.");
    expect(await exists(claudeDir())).toBe(false);
  });

  it("never signs out a login with no note of how it was made, and warns", async () => {
    await withLogin(undefined);
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.quiet).toEqual([]);
    expect(h.err.join("")).toContain("there is no note (bridge-login.json) of how the claude login");
    expect(await exists(claudeDir())).toBe(false);
  });

  it("a sign-out that fails or times out keeps bridge's login folder, <config>/bridge and the launcher, and exits 1 with the retry", async () => {
    for (const result of [{ exitCode: 2 }, { exitCode: 0, timedOut: true }]) {
      await withLogin("login");
      Object.assign(h.quietResult, result);
      expect(await runUninstall(["--yes"], h.deps)).toBe(1);
      expect(h.err.join("")).toContain("run `bridge agent logout claude` in a terminal, then `bridge uninstall` again");
      expect(h.err.join("")).toContain(result.timedOut ? "did not finish within 30 s" : "exited with 2");
      expect(h.out.join("")).not.toContain("Signed out the claude login");
      expect(await exists(path.join(claudeDir(), ".credentials.json"))).toBe(true);
      expect(await exists(p("config/bridge/apps.json"))).toBe(true);
      expect(await exists(p("home/.local/bin/bridge"))).toBe(true);
      // The app itself is gone (keychain and folders); its apps.json entry left, so a retry finishes with nothing listed.
      expect(await exists(p("config/demo/bridge"))).toBe(false);
      expect(await readFile(p("config/bridge/apps.json"), "utf8")).not.toContain("demo");
      // The retry, once the person signed out by hand (the login is gone), finishes.
      await rm(path.join(claudeDir(), ".credentials.json"));
      h.err.length = 0;
      expect(await runUninstall(["--yes"], h.deps)).toBe(0);
      expect(await exists(p("config/bridge"))).toBe(false);
      await h.cleanup();
    }
  });

  it("an agent that is not installed: the files go, exit 1, and the grant is named as still live", async () => {
    await withLogin("login");
    h.quietResult.missing = true;
    expect(await runUninstall(["--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("`claude` is not installed here, so bridge could not sign out the login it made; its files are removed, but the grant stays live; revoke it in your Anthropic account");
    expect(h.err.join("")).not.toMatch(/revoked/);
    expect(await exists(claudeDir())).toBe(false);
    expect(await exists(p("config/bridge"))).toBe(false);
  });

  it("a symlinked agent folder (into ~/.claude) with a planted login note is never signed out: the warning says why, ~/.claude stays", async () => {
    h = await harness();
    await decoys();
    await installEverything();
    const own = p("home/.claude");
    await writeFile(path.join(own, "bridge-login.json"), JSON.stringify({ source: "login", at: "x" }));
    await writeFile(path.join(own, ".credentials.json"), LOGIN);
    await rm(claudeDir(), { recursive: true, force: true });
    await symlink(own, claudeDir());
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.quiet).toEqual([]);
    expect(h.err.join("")).toContain(`there is no note bridge can trust of how the claude login in ${claudeDir()} was made (${claudeDir()} is a symlink`);
    expect(h.out.join("")).not.toContain("Also: bridge signs out the claude login");
    expect(await readFile(path.join(own, ".credentials.json"), "utf8")).toBe(LOGIN);
    expect(await exists(claudeDir())).toBe(false);
  });

  it("the note edited while the question is open is a changed plan: nothing runs", async () => {
    await withLogin("copy");
    h.deps.confirm = async () => {
      await writeFile(path.join(claudeDir(), "bridge-login.json"), JSON.stringify({ source: "login", at: "x" }));
      return true;
    };
    expect(await runUninstall([], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(h.quiet).toEqual([]);
    expect(await exists(claudeDir())).toBe(true);
  });
});

describe("bridge uninstall never removes a shared folder", () => {
  /** Every dir, file and link under the fake root, relative, sorted (dirs included: an empty folder counts). */
  async function tree(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        out.push(`${path.relative(h.root, full)}${e.isDirectory() ? "/" : ""}`);
        if (e.isDirectory() && !e.isSymbolicLink()) await walk(full);
      }
    };
    await walk(h.root);
    return out.sort();
  }

  /** What setup does on a fresh machine: self install, the service, the handler, a copied login. */
  async function setUp(): Promise<void> {
    h.deps.run = async (command, args) => {
      h.commands.push([command, ...args]);
      if (command === "npm") {
        const prefix = args[args.indexOf("--prefix") + 1]!;
        const pkg = path.join(prefix, "node_modules/@berdyh/bridge");
        await mkdir(path.join(pkg, "bin"), { recursive: true });
        await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@berdyh/bridge", version: "0.1.0" }));
        await writeFile(path.join(pkg, "bin/run.js"), "", { mode: 0o755 });
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).toBe(0);
    expect(await runService(["install", "--yes", "--no-activate"], h.deps)).toBe(0);
    expect(await installProtocolHandler(h.deps, { yes: true })).toBe("done");
    h.deps.isTTY = true;
    expect(await runAgent(["login", "claude", "--copy", "--yes"], h.deps)).toBe(0);
    h.deps.isTTY = false;
    h.out.length = 0;
    h.err.length = 0;
  }

  async function freshMachine(): Promise<void> {
    h = await harness();
    await mkdir(p("home/.claude"), { recursive: true });
    await writeFile(p("home/.claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "mine" } }));
  }

  /**
   * The shared and system folders setup may have had to create (the bases, the unit dir, the desktop entries dir,
   * ~/.cache, ~/.local): they stay after uninstall, even when bridge made them, and must then be empty of anything else.
   */
  const SHARED = [
    "config/", "config/systemd/", "config/systemd/user/", "config/systemd/user/default.target.wants/",
    "data/", "data/applications/",
    "home/.cache/", "home/.local/", "home/.local/bin/", "home/.local/share/", "home/.local/state/",
  ];

  it("takes back only bridge's own entries: the shared folders setup created stay, empty, and the consent says so", async () => {
    await freshMachine();
    const before = await tree();
    await setUp();
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    const out = h.out.join("");
    expect(out).not.toContain("Removed only if still empty (bridge setup");
    expect(out).toContain(`Left alone: the shared folders bridge's files sit in (${p("config")}, ${p("data")}, ${p("home/.local/state")}, ${p("home/.local/bin")}, ${p("home/.cache")} and the like), even ones bridge setup created; only bridge's own entries inside them go.`);
    expect(out).toContain(`Left alone: ${p("home/.npm")} (npm's cache).`);
    const after = await tree();
    // Nothing that was there is gone, and all that is new is a shared folder (each empty but for other shared
    // folders: anything inside one would be a new entry too) or mimeapps.list without our lines.
    expect(before.filter((e) => !after.includes(e))).toEqual([]);
    const added = after.filter((e) => !before.includes(e));
    expect(added.filter((e) => !SHARED.includes(e) && e !== "config/mimeapps.list")).toEqual([]);
    expect(added).toEqual(expect.arrayContaining(["config/", "config/systemd/user/", "data/", "data/applications/", "home/.local/bin/"]));
    expect(await readFile(p("config/mimeapps.list"), "utf8")).not.toContain("bridge");
  });

  it("an empty ~/.local/bin that was there before stays, and a shared folder holding someone else's file is untouched", async () => {
    await freshMachine();
    await mkdir(p("home/.local/bin"), { recursive: true });
    await setUp();
    await writeFile(p("config/systemd/user/other.service"), "mine");
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await readdir(p("home/.local/bin"))).toEqual([]);
    expect(await readFile(p("config/systemd/user/other.service"), "utf8")).toBe("mine");
    expect(await exists(p("data/bridge"))).toBe(false);
    expect(h.err.join("")).not.toContain("problems");
  });

  it("mimeapps.list is never deleted, even one bridge setup created with only headers left: only our lines go", async () => {
    await freshMachine();
    await setUp();
    expect(await readFile(p("config/mimeapps.list"), "utf8")).toContain("bridge");
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(`  ${p("config/mimeapps.list")}  (edited: only our bridge:// lines are removed, every other line is kept)`);
    expect(h.out.join("")).not.toContain("created by bridge setup");
    expect(await exists(p("config/mimeapps.list"))).toBe(true);
    expect(await readFile(p("config/mimeapps.list"), "utf8")).not.toContain("bridge");

    // After a standalone `protocol uninstall` the headers-only file stays too, and uninstall does not list it.
    await h.cleanup();
    await freshMachine();
    await setUp();
    expect(await runProtocol(["uninstall", "--yes"], h.deps)).toBe(0);
    h.out.length = 0;
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await exists(p("config/mimeapps.list"))).toBe(true);
    expect(h.out.join("")).not.toContain(`${p("config/mimeapps.list")}  (`);
  });

  it("a mimeapps.list that was there keeps every other line; one that is a link stays a link, its target untouched", async () => {
    await freshMachine();
    await mkdir(p("config"), { recursive: true });
    await writeFile(p("config/mimeapps.list"), "[Default Applications]\ntext/html=firefox.desktop\n");
    await setUp();
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    const after = await readFile(p("config/mimeapps.list"), "utf8");
    expect(after).toContain("text/html=firefox.desktop");
    expect(after).not.toContain("bridge");

    await h.cleanup();
    h = await harness();
    await mkdir(p("home/dotfiles"), { recursive: true });
    await writeFile(p("home/dotfiles/mimeapps.list"), "[Default Applications]\n");
    await mkdir(p("config"), { recursive: true });
    await symlink(p("home/dotfiles/mimeapps.list"), p("config/mimeapps.list"));
    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await readFile(p("home/dotfiles/mimeapps.list"), "utf8")).toBe("[Default Applications]\n");
    expect(await readlink(p("config/mimeapps.list"))).toBe(p("home/dotfiles/mimeapps.list"));
  });

  it("doctor --paths lists bridge's own entries only (no recorded folders), the install.sh download folder among them", async () => {
    await freshMachine();
    await setUp();
    expect(await runDoctor(["--paths", "--json"], h.deps)).toBe(0);
    const entries = JSON.parse(h.out.join("")) as { path: string; role: string; removeOnUninstall: boolean }[];
    expect(entries.some((e) => e.role === "created")).toBe(false);
    expect(entries.map((e) => e.path)).not.toContain(p("home/.local/bin"));
    expect(entries.find((e) => e.path === p("home/.cache/bridge-install"))).toMatchObject({ role: "install", removeOnUninstall: true });
  });
});

// --- the lock files and the contained-session folders -----------------------------------------------------------

/** What `bridge run` and a contained session leave for one app: audit log, consent record, session folder, secrets folder, worker lock. */
async function plantContainedPaths(appId: string): Promise<string[]> {
  const a = appPathsOf(h.deps, appId);
  const files = [
    path.join(a.auditDir, "demo.sync.jsonl"),
    path.join(a.consentDir, "demo.sync.consent.json"),
    path.join(a.sessionsDir, "s-0123456789abcdef", "note.txt"),
    path.join(a.tmpDir, "bridge-acp-secrets-s-0123456789abcdef", "files"),
    workerLockPath(a),
  ];
  for (const f of files) {
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, "x");
  }
  return files;
}

describe("bridge uninstall and apps remove: the new folders and locks", () => {
  it("uninstall lists them and leaves none behind: only the decoys remain", async () => {
    h = await harness();
    await decoys();
    const before = await snapshot();
    await installEverything();
    const planted = [...(await plantContainedPaths("demo"))];
    await writeFile(runnerLockPath(h.deps), '{"version":1,"pid":2000000001,"startedAt":"2026-11-03T10:00:00.000Z"}\n');
    planted.push(runnerLockPath(h.deps));

    // doctor --paths names every one of them (or a folder that holds it).
    const manifest = (await manifestOf(h.deps)).map((e) => e.path);
    for (const file of planted) expect(manifest.some((m) => file === m || file.startsWith(m + path.sep)), file).toBe(true);
    const a = appPathsOf(h.deps, "demo");
    for (const named of [a.auditDir, a.consentDir, a.sessionsDir, workerLockPath(a), runnerLockPath(h.deps)]) expect(manifest).toContain(named);

    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    for (const file of planted) expect(await gone(file), file).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it("apps remove takes that app's folders and worker.lock and no other app's, nor runner.lock", async () => {
    h = await harness();
    await upsertApp(h.deps, record({ appId: "demo" }));
    await upsertApp(h.deps, record({ appId: "other", name: "Other" }));
    const demo = await plantContainedPaths("demo");
    const other = await plantContainedPaths("other");
    await mkdir(path.dirname(runnerLockPath(h.deps)), { recursive: true });
    await writeFile(runnerLockPath(h.deps), "x");

    expect(await runCli(["apps", "remove", "demo", "--yes"], h.deps)).toBe(0);
    for (const file of demo) expect(await gone(file), file).toBe(true);
    for (const file of [...other, runnerLockPath(h.deps)]) expect(await gone(file), file).toBe(false);
  });
});
