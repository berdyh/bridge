import { mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { servicePromptDefault } from "./service.js";
import { type Harness, harness, exists } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("service", () => {
  it("lists the paths and asks before writing anything; a no leaves nothing behind", async () => {
    h = await harness();
    h.answers.yes = false;
    expect(await runCli(["service", "install"], h.deps)).toBe(1);
    expect(h.out.join("")).toContain("bridge-runner.service");
    expect(h.questions).toHaveLength(1);
    expect(h.commands).toEqual([]);
    expect(await exists(h.deps.configDir)).toBe(false);
  });

  it("installs the unit, activates it through the injected runner, and uninstall removes exactly it", async () => {
    h = await harness();
    expect(await runCli(["service", "install"], h.deps)).toBe(0);
    const unit = path.join(h.deps.configDir, "systemd", "user", "bridge-runner.service");
    const text = await readFile(unit, "utf8");
    expect(text).toContain(`ExecStart=${path.join(h.root, "home", ".local", "bin", "bridge")} run`);
    expect(h.commands.map((c) => c.slice(0, 5).join(" "))).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now bridge-runner.service",
    ]);

    h.commands.length = 0;
    expect(await runCli(["service", "uninstall"], h.deps)).toBe(0);
    expect(await exists(unit)).toBe(false);
    expect(h.commands.map((c) => c.slice(0, 3).join(" "))).toEqual([
      "systemctl --user disable",
      "systemctl --user daemon-reload",
    ]);
  });

  it("bakes PATH and the XDG roots into the unit so the service reads the CLI's own directories", async () => {
    h = await harness();
    h.deps.env.XDG_CONFIG_HOME = "/x/config";
    h.deps.env.XDG_DATA_HOME = "/x/data";
    expect(await runCli(["service", "install", "--no-activate"], h.deps)).toBe(0);
    const text = await readFile(path.join(h.deps.configDir, "systemd", "user", "bridge-runner.service"), "utf8");
    expect(text).toContain("XDG_CONFIG_HOME=/x/config");
    expect(text).toContain("XDG_DATA_HOME=/x/data");
    expect(text).toContain("PATH=/usr/bin");
  });

  it("also bakes CLAUDE_CONFIG_DIR and CODEX_HOME in when they are set, and only then, so the service protects the same agent folders", async () => {
    h = await harness();
    expect(await runCli(["service", "install", "--no-activate"], h.deps)).toBe(0);
    const unitPath = path.join(h.deps.configDir, "systemd", "user", "bridge-runner.service");
    const bare = await readFile(unitPath, "utf8");
    expect(bare).not.toContain("CLAUDE_CONFIG_DIR");
    expect(bare).not.toContain("CODEX_HOME");
    h.deps.env.CLAUDE_CONFIG_DIR = "/x/claude";
    h.deps.env.CODEX_HOME = "/x/codex";
    expect(await runCli(["service", "install", "--no-activate"], h.deps)).toBe(0);
    const text = await readFile(unitPath, "utf8");
    expect(text).toContain("CLAUDE_CONFIG_DIR=/x/claude");
    expect(text).toContain("CODEX_HOME=/x/codex");
  });

  it("carries BRIDGE_CREDENTIAL_STORE into the unit when it is set, and only then, so the service uses the CLI's credential store", async () => {
    h = await harness();
    const unitPath = path.join(h.deps.configDir, "systemd", "user", "bridge-runner.service");
    expect(await runCli(["service", "install", "--no-activate"], h.deps)).toBe(0);
    expect(await readFile(unitPath, "utf8")).not.toContain("BRIDGE_CREDENTIAL_STORE");
    h.deps.env.BRIDGE_CREDENTIAL_STORE = "file:/x/creds";
    expect(await runCli(["service", "install", "--no-activate"], h.deps)).toBe(0);
    expect(await readFile(unitPath, "utf8")).toContain("BRIDGE_CREDENTIAL_STORE=file:/x/creds");
  });

  it("--no-activate writes the unit and runs nothing", async () => {
    h = await harness();
    expect(await runCli(["service", "install", "--no-activate"], h.deps)).toBe(0);
    expect(h.commands).toEqual([]);
    expect(await exists(path.join(h.deps.configDir, "systemd", "user", "bridge-runner.service"))).toBe(true);
  });

  it("--yes skips the question but still prints every path", async () => {
    h = await harness();
    expect(await runCli(["service", "install", "--yes", "--no-activate"], h.deps)).toBe(0);
    expect(h.questions).toEqual([]);
    expect(h.out.join("")).toContain("These paths will be written");
    expect(h.out.join("")).toContain("bridge-runner.service");
  });

  it("--json keeps stdout to JSON lines (need_approval, then the result) and sends the text to stderr", async () => {
    h = await harness();
    expect(await runCli(["service", "install", "--yes", "--json"], h.deps)).toBe(0);
    const events = h.out.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const unit = path.join(h.deps.configDir, "systemd", "user", "bridge-runner.service");
    expect(events.map((e) => e.event)).toEqual(["need_approval", "service"]);
    expect(events[0]).toMatchObject({ what: "service install" });
    expect((events[0]!.paths as string[]).includes(unit)).toBe(true);
    expect(events[1]).toMatchObject({ action: "install", ok: true, service: "bridge-runner.service", activated: true });
    expect((events[1]!.paths as string[]).includes(unit)).toBe(true);
    expect(h.err.join("")).toContain("These paths will be written");

    h.out.length = 0;
    expect(await runCli(["service", "uninstall", "--yes", "--json"], h.deps)).toBe(0);
    const removal = h.out.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(removal.map((e) => e.event)).toEqual(["need_approval", "service"]);
    expect(removal[1]).toMatchObject({ action: "uninstall", ok: true });
    expect(await exists(unit)).toBe(false);
  });

  it("--json reports a no as ok:false and writes nothing; a failing activation as ok:false with the command", async () => {
    h = await harness();
    h.answers.yes = false;
    expect(await runCli(["service", "install", "--json"], h.deps)).toBe(1);
    const events = h.out.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.at(-1)).toMatchObject({ event: "service", ok: false, error: "cancelled", paths: [] });
    expect(await exists(h.deps.configDir)).toBe(false);

    h.out.length = 0;
    h.answers.yes = true;
    h.deps.run = async (command, args) => ({ exitCode: args.includes("enable") ? 1 : 0, stdout: "", stderr: `${command} refused` });
    expect(await runCli(["service", "install", "--json"], h.deps)).toBe(1);
    const failed = JSON.parse(h.out.join("").trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(failed).toMatchObject({ ok: false, activated: false });
    expect(String(failed.error)).toContain("systemctl --user enable --now bridge-runner.service");
  });

  it("on macOS it writes a launchd plist whose KeepAlive leaves a clean exit stopped", async () => {
    h = await harness({ platform: "darwin" });
    expect(await runCli(["service", "install", "--yes"], h.deps)).toBe(0);
    const plist = await readFile(path.join(h.root, "home", "Library", "LaunchAgents", "com.berdyh.bridge.runner.plist"), "utf8");
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(h.commands[0]!.slice(0, 2)).toEqual(["launchctl", "bootstrap"]);
    expect(h.commands[0]![2]).toMatch(/^gui\/\d+$/);
  });
});

describe("service: the plan shown is the plan written", () => {
  const unitOf = (h: Harness) => path.join(h.deps.configDir, "systemd", "user", "bridge-runner.service");

  it("refuses a service file that is a symlink: the write would land on a target never shown", async () => {
    h = await harness();
    const outside = path.join(h.root, "outside.txt");
    await writeFile(outside, "keep");
    await mkdir(path.dirname(unitOf(h)), { recursive: true });
    await symlink(outside, unitOf(h));
    expect(await runCli(["service", "install", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("not a regular file");
    expect(await readFile(outside, "utf8")).toBe("keep");
    expect(h.commands).toEqual([]);
  });

  it("a service file swapped for a symlink during the prompt is not written through", async () => {
    h = await harness();
    const outside = path.join(h.root, "outside.txt");
    await writeFile(outside, "keep");
    h.deps.confirm = async () => {
      await mkdir(path.dirname(unitOf(h)), { recursive: true });
      await symlink(outside, unitOf(h));
      return true;
    };
    expect(await runCli(["service", "install"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await readFile(outside, "utf8")).toBe("keep");
    expect(await readlink(unitOf(h))).toBe(outside);
    expect(h.commands).toEqual([]);
  });

  it("a service dir retargeted outside during the prompt gets nothing written into it", async () => {
    h = await harness();
    const outside = path.join(h.root, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(path.dirname(unitOf(h)), { recursive: true });
    h.deps.confirm = async () => {
      await rm(path.dirname(unitOf(h)), { recursive: true });
      await symlink(outside, path.dirname(unitOf(h)));
      return true;
    };
    expect(await runCli(["service", "install", "--json"], h.deps)).toBe(1);
    expect(await readdir(outside)).toEqual([]);
    const last = JSON.parse(h.out.join("").trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(last).toMatchObject({ event: "service", ok: false });
    expect(String(last.error)).toContain("changed while waiting");
  });

  it("an existing unit's contents are bound too: a unit edited during the prompt is left as it is", async () => {
    h = await harness();
    await mkdir(path.dirname(unitOf(h)), { recursive: true });
    await writeFile(unitOf(h), "old");
    h.deps.confirm = async () => {
      await writeFile(unitOf(h), "edited by hand");
      return true;
    };
    expect(await runCli(["service", "install"], h.deps)).toBe(1);
    expect(await readFile(unitOf(h), "utf8")).toBe("edited by hand");
  });

  it("writes through a symlinked config dir that was there before the prompt, and shows where", async () => {
    h = await harness();
    const real = path.join(h.root, "real-config");
    await mkdir(real, { recursive: true });
    await symlink(real, h.deps.configDir);
    expect(await runCli(["service", "install", "--yes", "--no-activate"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(`really ${path.join(real, "systemd", "user", "bridge-runner.service")}`);
    expect(await readFile(path.join(real, "systemd", "user", "bridge-runner.service"), "utf8")).toContain("ExecStart=");
  });
});

describe("service uninstall: the gate after deactivation", () => {
  it("the wants link that systemctl disable removes itself does not count as a change", async () => {
    h = await harness();
    expect(await runCli(["service", "install", "--yes"], h.deps)).toBe(0);
    const unit = path.join(h.deps.configDir, "systemd", "user", "bridge-runner.service");
    const wants = path.join(h.deps.configDir, "systemd", "user", "default.target.wants", "bridge-runner.service");
    await mkdir(path.dirname(wants), { recursive: true });
    await symlink(unit, wants);
    h.deps.run = async (_command, args) => {
      if (args.includes("disable")) await rm(wants);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await runCli(["service", "uninstall", "--yes"], h.deps)).toBe(0);
    expect(await exists(unit)).toBe(false);
  });

  it("a service dir retargeted while systemctl disable runs: the removal is refused and named, nothing outside goes", async () => {
    h = await harness();
    expect(await runCli(["service", "install", "--yes"], h.deps)).toBe(0);
    const dir = path.join(h.deps.configDir, "systemd", "user");
    const outside = path.join(h.root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "bridge-runner.service"), "someone else's unit");
    h.deps.run = async (_command, args) => {
      if (args.includes("disable")) {
        await rename(dir, `${dir}.moved`);
        await symlink(outside, dir);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await runCli(["service", "uninstall", "--yes"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("left behind");
    expect(await readFile(path.join(outside, "bridge-runner.service"), "utf8")).toBe("someone else's unit");
  });

});

describe("service: rule A and failed commands", () => {
  it("service install refuses an aliased layout (data is the config dir) before the question and writes nothing", async () => {
    h = await harness();
    await mkdir(h.deps.configDir, { recursive: true });
    await symlink(h.deps.configDir, h.deps.dataDir);
    expect(await runCli(["service", "install", "--json"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("unusual layout");
    expect(h.questions).toEqual([]);
    expect(await readdir(h.deps.configDir)).toEqual([]);
    const last = JSON.parse(h.out.join("").trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(last).toMatchObject({ event: "service", ok: false });
  });

  it("an alias made during the question (data becomes the config dir) is refused before any write", async () => {
    h = await harness();
    await mkdir(h.deps.configDir, { recursive: true });
    await mkdir(h.deps.dataDir, { recursive: true });
    h.deps.confirm = async () => {
      await rm(h.deps.dataDir, { recursive: true });
      await symlink(h.deps.configDir, h.deps.dataDir);
      return true;
    };
    expect(await runCli(["service", "install"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await readdir(h.deps.configDir)).toEqual([]);
    expect(h.commands).toEqual([]);
  });

  it("a launcher dir retargeted during the question is refused: ExecStart would run a launcher never shown", async () => {
    h = await harness();
    const bin = path.join(h.root, "home/.local/bin");
    await mkdir(bin, { recursive: true });
    const outside = path.join(h.root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "bridge"), "#!/bin/sh\n");
    h.deps.confirm = async () => {
      await rm(bin, { recursive: true });
      await symlink(outside, bin);
      return true;
    };
    expect(await runCli(["service", "install"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("changed while waiting");
    expect(await exists(path.join(h.deps.configDir, "systemd", "user", "bridge-runner.service"))).toBe(false);
    expect(h.commands).toEqual([]);
  });

  it("service uninstall reports a failed disable or daemon-reload: exit 1, ok:false naming the command", async () => {
    for (const failing of ["disable", "daemon-reload"]) {
      h = await harness();
      expect(await runCli(["service", "install", "--yes"], h.deps)).toBe(0);
      h.out.length = 0;
      h.deps.run = async (_command, args) => (args.includes(failing) ? { exitCode: 1, stdout: "", stderr: "boom" } : { exitCode: 0, stdout: "", stderr: "" });
      expect(await runCli(["service", "uninstall", "--yes", "--json"], h.deps), failing).toBe(1);
      const last = JSON.parse(h.out.join("").trim().split("\n").at(-1)!) as Record<string, unknown>;
      expect(last).toMatchObject({ event: "service", ok: false });
      expect(String(last.error)).toContain(failing);
      expect(h.err.join("")).toContain(`${failing}`);
      expect(await exists(path.join(h.deps.configDir, "systemd", "user", "bridge-runner.service"))).toBe(false);
      await h.cleanup();
    }
  });
});

describe("servicePromptDefault", () => {
  it("is yes unless the setting is ask", () => {
    expect(servicePromptDefault({ service: "default-yes" })).toBe("yes");
    expect(servicePromptDefault({ service: "ask" })).toBe("ask");
  });
});
