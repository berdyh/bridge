import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultBaseDirs } from "./paths.js";
import {
  type ServiceFs,
  installService,
  launchdPlist,
  captureServiceEnv,
  planPaths,
  planService,
  runServiceCommands,
  systemdUnit,
  uninstallService,
} from "./service.js";

const base = defaultBaseDirs("/home/u", {});
const spec = (platform: "linux" | "darwin") => ({
  app: "app-a",
  platform,
  base,
  launcher: "/home/u/.local/bin/app-a",
});

describe("generators", () => {
  it("renders a systemd user unit", () => {
    const unit = systemdUnit(spec("linux"));
    expect(unit).toContain("ExecStart=/home/u/.local/bin/app-a serve");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("StandardOutput=append:/home/u/.local/state/app-a/runner.log");
  });
  it("quotes systemd args with spaces", () => {
    expect(systemdUnit({ ...spec("linux"), launcher: "/home/u/my dir/run", args: ["a b"] })).toContain('ExecStart="/home/u/my dir/run" "a b"');
  });
  it("bakes PATH into the unit and the plist", () => {
    const env = captureServiceEnv({ PATH: "/home/u/.local/bin:/usr/bin", HOME: "/home/u", SECRET: "x" });
    expect(env).toEqual({ PATH: "/home/u/.local/bin:/usr/bin" });
    expect(systemdUnit({ ...spec("linux"), env })).toContain('Environment="PATH=/home/u/.local/bin:/usr/bin"');
    const plist = launchdPlist({ ...spec("darwin"), env });
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>PATH</key>\n    <string>/home/u/.local/bin:/usr/bin</string>");
    expect(systemdUnit(spec("linux"))).not.toContain("Environment=");
    expect(launchdPlist(spec("darwin"))).not.toContain("EnvironmentVariables");
    expect(() => systemdUnit({ ...spec("linux"), env: { "BAD KEY": "x" } })).toThrow();
  });
  it("escapes % (and $) so systemd does not expand specifiers", () => {
    const unit = systemdUnit({
      ...spec("linux"),
      launcher: "/home/u/100%/run",
      args: ["--x=%h", "$HOME"],
      base: { ...base, state: "/home/u/st%ate" },
      env: { PATH: "/a%b" },
    });
    expect(unit).toContain('ExecStart="/home/u/100%%/run" "--x=%%h" "$$HOME"');
    expect(unit).toContain("StandardOutput=append:/home/u/st%%ate/app-a/runner.log");
    expect(unit).toContain('Environment="PATH=/a%%b"');
  });
  it("renders an escaped launchd plist", () => {
    const plist = launchdPlist({ ...spec("darwin"), args: ["serve", "--x=<&>"] });
    expect(plist).toContain("<string>com.berdyh.app-a.runner</string>");
    expect(plist).toContain("<string>--x=&lt;&amp;&gt;</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });
  it("restarts the launchd agent only after a failure, so the runner's idle exit (0) stays stopped", () => {
    const plist = launchdPlist(spec("darwin"));
    expect(plist).toContain("<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>");
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    // systemd: Restart=on-failure already leaves a clean exit alone.
    expect(systemdUnit(spec("linux"))).toContain("Restart=on-failure");
  });
  it("plans file paths and activation commands without running them", () => {
    const linux = planService(spec("linux"));
    expect(linux.files.map((f) => f.path)).toEqual(["/home/u/.config/systemd/user/app-a-runner.service"]);
    expect(linux.links).toEqual([
      {
        path: "/home/u/.config/systemd/user/default.target.wants/app-a-runner.service",
        target: "/home/u/.config/systemd/user/app-a-runner.service",
      },
    ]);
    expect(linux.afterRemove).toEqual([["systemctl", "--user", "daemon-reload"]]);
    expect(linux.activate.at(-1)).toEqual(["systemctl", "--user", "enable", "--now", "app-a-runner.service"]);
    const mac = planService({ ...spec("darwin"), uid: 502 });
    expect(mac.activate).toEqual([["launchctl", "bootstrap", "gui/502", "/home/u/Library/LaunchAgents/com.berdyh.app-a.runner.plist"]]);
  });
  it("plans the log's parent directory so the service can open its log on first start", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const plan = planService(spec(platform));
      expect(plan.dirs).toEqual(["/home/u/.local/state/app-a"]);
      const unitOrPlist = plan.files[0]!.contents;
      expect(unitOrPlist).toContain("/home/u/.local/state/app-a/runner.log");
      expect(planPaths(plan)).toContain("/home/u/.local/state/app-a");
    }
  });
  it("rejects a relative launcher", () => {
    expect(() => planService({ ...spec("linux"), launcher: "app-a" })).toThrow(/absolute/);
  });
});

function recordingFs(log: string[] = []) {
  const fake: ServiceFs = {
    mkdir: async (d) => void log.push(`mkdir ${d}`),
    writeFile: async (f) => void log.push(`write ${f}`),
    rm: async (f) => void log.push(`rm ${f}`),
  };
  return { log, fake };
}

describe("installService / uninstallService", () => {
  it("calls confirm once with every path (dirs, files, activation symlink) before any write", async () => {
    const { log, fake } = recordingFs();
    const plan = planService(spec("linux"));
    let seen: readonly string[] = [];
    let confirms = 0;
    const r = await installService(plan, {
      fs: fake,
      confirm: (paths) => {
        confirms++;
        expect(log).toEqual([]); // nothing written yet
        seen = paths;
        return true;
      },
    });
    expect(confirms).toBe(1);
    expect(seen).toEqual([
      "/home/u/.local/state/app-a",
      "/home/u/.config/systemd/user/app-a-runner.service",
      "/home/u/.config/systemd/user/default.target.wants/app-a-runner.service",
    ]);
    expect(r.written).toEqual(seen.slice(0, 2));
    expect(log).toEqual([
      "mkdir /home/u/.local/state/app-a",
      "mkdir /home/u/.config/systemd/user",
      "write /home/u/.config/systemd/user/app-a-runner.service",
    ]);
  });

  it("activates through the same confirm, after the files exist", async () => {
    const log: string[] = [];
    const { fake } = recordingFs(log);
    const plan = planService(spec("linux"));
    const run = async (c: string, a: readonly string[]) => (log.push(`run ${[c, ...a].join(" ")}`), { exitCode: 0, stdout: "", stderr: "" });
    const r = await installService(plan, { fs: fake, confirm: () => true, run });
    expect(r.activation).toEqual({ ok: true });
    expect(log.indexOf("write /home/u/.config/systemd/user/app-a-runner.service")).toBeLessThan(log.findIndex((l) => l.startsWith("run ")));
    expect(log.at(-1)).toBe("run systemctl --user enable --now app-a-runner.service");
  });

  it("writes and runs nothing when declined, for install and uninstall", async () => {
    const { log, fake } = recordingFs();
    const run = async () => { throw new Error("must not run"); };
    const plan = planService(spec("linux"));
    expect(await installService(plan, { fs: fake, run, confirm: async () => false })).toEqual({ written: [] });
    expect(await uninstallService(plan, { fs: fake, run, confirm: async () => false })).toEqual({ removed: [] });
    expect(log).toEqual([]);
  });

  it("uninstall deactivates first, removes the files and the wants link, then reloads", async () => {
    const log: string[] = [];
    const { fake } = recordingFs(log);
    const plan = planService(spec("linux"));
    const run = async (c: string, a: readonly string[]) => (log.push(`run ${[c, ...a].join(" ")}`), { exitCode: 0, stdout: "", stderr: "" });
    const r = await uninstallService(plan, { fs: fake, confirm: () => true, run });
    expect(log).toEqual([
      "run systemctl --user disable --now app-a-runner.service",
      "rm /home/u/.config/systemd/user/default.target.wants/app-a-runner.service",
      "rm /home/u/.config/systemd/user/app-a-runner.service",
      "run systemctl --user daemon-reload",
    ]);
    expect(r.removed).toHaveLength(2);
  });

  it("uninstall still removes files when deactivate fails, and reports it", async () => {
    const { log, fake } = recordingFs();
    const plan = planService(spec("linux"));
    const run = async () => ({ exitCode: 1, stdout: "", stderr: "not loaded" });
    const r = await uninstallService(plan, { fs: fake, confirm: () => true, run });
    expect(r.deactivation?.ok).toBe(false);
    expect(log.filter((l) => l.startsWith("rm "))).toHaveLength(2);
  });

  it("uninstall removes exactly the manifest and leaves neighbours and the state dir alone (real temp dir)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "bridge-svc-"));
    try {
      const plan = planService({ ...spec("linux"), base: defaultBaseDirs(home, {}) });
      const dir = path.join(home, ".config", "systemd", "user");
      await installService(plan, { fs, confirm: () => true });
      // what `systemctl --user enable` would have done
      const link = plan.links[0]!;
      await mkdir(path.dirname(link.path), { recursive: true });
      await symlink(link.target, link.path);
      await writeFile(path.join(dir, "other.service"), "keep");
      expect(await readFile(plan.files[0]!.path, "utf8")).toBe(plan.files[0]!.contents);
      expect((await stat(plan.dirs[0]!)).isDirectory()).toBe(true); // fresh install created the log parent
      await uninstallService(plan, { fs, confirm: () => true });
      expect((await readdir(dir)).sort()).toEqual(["default.target.wants", "other.service"]);
      expect(await readdir(path.dirname(link.path))).toEqual([]); // no dangling symlink
      expect((await stat(plan.dirs[0]!)).isDirectory()).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("runServiceCommands", () => {
  it("runs through the injected runner and stops at the first failure", async () => {
    const seen: string[] = [];
    const run = async (c: string, a: readonly string[]) => {
      seen.push([c, ...a].join(" "));
      return { exitCode: seen.length === 2 ? 1 : 0, stdout: "", stderr: "boom" };
    };
    const r = await runServiceCommands(planService(spec("linux")).activate, run);
    expect(r).toEqual({ ok: false, failed: { command: ["systemctl", "--user", "enable", "--now", "app-a-runner.service"], stderr: "boom" } });
    expect(seen).toHaveLength(2);
  });
});
