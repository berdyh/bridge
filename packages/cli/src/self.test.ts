import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CommandResult } from "@berdyh/bridge-runner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UsageError } from "./deps.js";
import { runDoctor } from "./doctor.js";
import { runService } from "./service.js";
import { installPathsOf, launchersCurrentFor, pathWarningOf, runSelfInstall, selfInstall, selfInstallPlan } from "./self.js";
import { runUninstall } from "./uninstall.js";
import { CLI_VERSION } from "./version.js";
import { type Harness, exists, harness } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

interface FakeNpm {
  /** Called when an `npm install` runs, before it writes anything; with no spec, `specs` are the `file:` paths of `<prefix>/package.json`. */
  onInstall?: (prefix: string, specs: string[]) => Promise<void> | void;
  /** What the "installed" `@berdyh/bridge` reports; default: the version in the spec or tarball name. */
  version?: string;
  fail?: boolean;
  /** Make the entry file a symlink to this path instead of a file. */
  entryLink?: string;
}

/** Replaces the runner with a fake `npm install` that lays out an npm-prefix install; records every command. */
function fakeNpm(h: Harness, options: FakeNpm = {}): void {
  h.deps.run = async (command, args): Promise<CommandResult> => {
    h.commands.push([command, ...args]);
    if (command !== "npm") return OK;
    if (options.fail) return { exitCode: 1, stdout: "", stderr: "npm error first\nnpm error network down" };
    const prefix = args[args.indexOf("--prefix") + 1]!;
    const named = args.slice(args.indexOf("--no-fund") + 1);
    const manifest = named.length > 0 ? undefined : await readFile(path.join(prefix, "package.json"), "utf8").then((t) => JSON.parse(t) as { dependencies: Record<string, string> }, () => undefined);
    const specs = manifest ? Object.values(manifest.dependencies).map((d) => d.replace(/^file:/, "")) : named;
    await options.onInstall?.(prefix, specs);
    const version =
      options.version ?? specs.map((s) => /@berdyh\/bridge@(.+)$/.exec(s)?.[1] ?? /berdyh-bridge-(\d[^/]*)\.tgz$/.exec(s)?.[1]).find((v) => v !== undefined) ?? "0.0.0";
    const pkg = path.join(prefix, "node_modules/@berdyh/bridge");
    await mkdir(path.join(pkg, "bin"), { recursive: true });
    await mkdir(path.join(pkg, "dist"), { recursive: true });
    await mkdir(path.join(prefix, "node_modules/.bin"), { recursive: true });
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@berdyh/bridge", version }));
    if (options.entryLink) await symlink(options.entryLink, path.join(pkg, "bin/run.js"));
    else await writeFile(path.join(pkg, "bin/run.js"), '#!/usr/bin/env node\nimport "../dist/main.js";\n', { mode: 0o755 });
    await writeFile(path.join(pkg, "dist/main.js"), "");
    return OK;
  };
}

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).sort();
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Writes a release tarball set (arbitrary bytes; the fake npm does not read them) and its SHA256SUMS. */
async function tarballSet(dir: string, version: string, over: { extra?: Record<string, string>; sums?: Record<string, string> } = {}): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: Record<string, string> = {
    [`berdyh-bridge-${version}.tgz`]: "bridge",
    [`berdyh-bridge-crypto-${version}.tgz`]: "crypto",
    [`berdyh-bridge-pairing-${version}.tgz`]: "pairing",
    [`berdyh-bridge-protocol-${version}.tgz`]: "protocol",
    [`berdyh-bridge-runner-${version}.tgz`]: "runner",
    ...over.extra,
  };
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body);
  const sums = Object.entries(files).map(([name, body]) => `${over.sums?.[name] ?? sha(body)}  ${name}`);
  await writeFile(path.join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  return Object.keys(files).sort().map((n) => path.join(dir, n));
}

const dirs = (h: Harness) => ({
  versions: path.join(h.root, "data/bridge/versions"),
  launcher: path.join(h.root, "home/.local/bin/bridge"),
  alias: path.join(h.root, "home/.local/bin/bridge-runner"),
  bin: path.join(h.root, "home/.local/bin"),
});
const entryOf = (h: Harness, v: string) => path.join(dirs(h).versions, v, "node_modules/@berdyh/bridge/bin/run.js");
const npmCommands = (h: Harness) => h.commands.filter((c) => c[0] === "npm");

describe("selfInstallPlan", () => {
  it("is pure: it names the paths and the one npm command and touches nothing", async () => {
    h = await harness();
    const plan = selfInstallPlan(h.deps, { version: "1.2.3" });
    expect(plan.paths).toEqual([path.join(dirs(h).versions, "1.2.3"), dirs(h).launcher, dirs(h).alias]);
    expect(plan.aliasLink).toBe(dirs(h).alias);
    expect(plan.entry).toBe(entryOf(h, "1.2.3"));
    expect(plan.command.slice(0, 1)).toEqual(["npm"]);
    expect(plan.command).toContain("--ignore-scripts");
    expect(plan.command.at(-1)).toBe("@berdyh/bridge@1.2.3");
    expect(await exists(h.root + "/data")).toBe(false);
    expect(h.commands).toEqual([]);
    expect(() => selfInstallPlan(h.deps, { version: "latest" })).toThrow(UsageError);
    expect(selfInstallPlan(h.deps, { from: "/some/dir" }).source).toEqual({ kind: "tarballs", dir: "/some/dir" });
  });
});

describe("bridge self install", () => {
  it("lists both links in the consent, and --yes writes both to the same entry", async () => {
    h = await harness();
    fakeNpm(h);
    h.answers.yes = false;
    expect(await runSelfInstall(["install", "--version", "0.1.0"], h.deps)).toBe(1);
    const out = h.out.join("");
    expect(out).toContain(dirs(h).launcher);
    expect(out).toContain(dirs(h).alias);
    expect(await exists(dirs(h).alias)).toBe(false);
    h.answers.yes = true;
    expect(await runSelfInstall(["install", "--version", "0.1.0", "--yes"], h.deps)).toBe(0);
    expect(await readlink(dirs(h).launcher)).toBe(entryOf(h, "0.1.0"));
    expect(await readlink(dirs(h).alias)).toBe(entryOf(h, "0.1.0"));
  });

  it("an install that has bridge current but no bridge-runner is relinked, and writes only the alias", async () => {
    h = await harness();
    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    await rm(dirs(h).alias);
    const before = await lstat(dirs(h).launcher);
    h.out.length = 0;
    h.commands.length = 0;
    const result = await selfInstall(h.deps, { yes: true, version: "0.1.0" });
    expect(result.outcome).toBe("relinked");
    expect(npmCommands(h)).toEqual([]);
    const printed = h.out.join("");
    expect(printed).toContain(dirs(h).alias);
    expect(printed).not.toMatch(new RegExp(`${dirs(h).launcher}  \\(launcher link`));
    expect(await readlink(dirs(h).alias)).toBe(entryOf(h, "0.1.0"));
    expect((await lstat(dirs(h).launcher)).ino).toBe(before.ino);
  });

  it("launchersCurrentFor (what one-click setup tests) is true only when both links are ours and alive at that version", async () => {
    h = await harness();
    fakeNpm(h);
    expect(await launchersCurrentFor(h.deps, "0.1.0")).toBe(false);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    expect(await launchersCurrentFor(h.deps, "0.1.0")).toBe(true);
    expect(await launchersCurrentFor(h.deps, "0.2.0")).toBe(false);
    await rm(dirs(h).alias);
    expect(await launchersCurrentFor(h.deps, "0.1.0")).toBe(false);
  });

  it("refuses a file that is not ours at the alias, like one at bridge, and installs nothing", async () => {
    h = await harness();
    fakeNpm(h);
    await mkdir(dirs(h).bin, { recursive: true });
    await writeFile(dirs(h).alias, "#!/bin/sh\necho mine\n");
    await expect(runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).rejects.toThrow(/bridge-runner exists and is not a bridge launcher/);
    expect(await readFile(dirs(h).alias, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(npmCommands(h)).toEqual([]);
    expect(await exists(dirs(h).launcher)).toBe(false);
  });

  it("prints the paths and asks first; a no leaves nothing behind and runs nothing", async () => {
    h = await harness();
    fakeNpm(h);
    h.answers.yes = false;
    expect(await runSelfInstall(["install", "--version", "0.1.0"], h.deps)).toBe(1);
    const out = h.out.join("");
    expect(out).toContain(path.join(dirs(h).versions, "0.1.0"));
    expect(out).toContain(dirs(h).launcher);
    expect(h.questions).toHaveLength(1);
    expect(h.commands).toEqual([]);
    expect(await exists(path.join(h.root, "data"))).toBe(false);
    expect(await exists(dirs(h).bin)).toBe(false);
  });

  it("installs with one npm invocation into a staging folder, renames it into place, and writes the launcher last", async () => {
    h = await harness();
    const seen: string[] = [];
    fakeNpm(h, {
      onInstall: async (prefix) => {
        seen.push(prefix);
        // Mid-install nothing is at the launcher or in the real version dir yet.
        expect(await exists(dirs(h).launcher)).toBe(false);
        expect(await exists(path.join(dirs(h).versions, "0.1.0"))).toBe(false);
      },
    });
    expect(await runSelfInstall(["install", "--version", "0.1.0"], h.deps)).toBe(0);
    const npm = npmCommands(h);
    expect(npm).toHaveLength(1);
    expect(npm[0]).toContain("--ignore-scripts");
    expect(npm[0]!.at(-1)).toBe("@berdyh/bridge@0.1.0");
    expect(path.dirname(seen[0]!)).toBe(dirs(h).versions);
    expect(path.basename(seen[0]!)).toMatch(/^\.staging-0\.1\.0-/);
    expect(await names(dirs(h).versions)).toEqual(["0.1.0"]); // no staging folder is left
    expect(await readlink(dirs(h).launcher)).toBe(entryOf(h, "0.1.0"));
    expect(await readlink(dirs(h).alias)).toBe(entryOf(h, "0.1.0")); // the alias points at the same entry
    expect(await names(dirs(h).bin)).toEqual(["bridge", "bridge-runner"]); // and no temp link
  });

  it("defaults the version to this CLI's", async () => {
    h = await harness();
    fakeNpm(h);
    expect(await runSelfInstall(["install", "--yes"], h.deps)).toBe(0);
    expect(npmCommands(h)[0]!.at(-1)).toMatch(/^@berdyh\/bridge@\d+\.\d+\.\d+$/);
  });

  it("--yes skips the question but still prints every path", async () => {
    h = await harness();
    fakeNpm(h);
    expect(await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).toBe(0);
    expect(h.questions).toEqual([]);
    expect(h.out.join("")).toContain("These paths will be written");
    expect(h.out.join("")).toContain(dirs(h).launcher);
  });

  it("re-running with the version present and the launcher current asks nothing and runs nothing", async () => {
    h = await harness();
    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    h.commands.length = 0;
    h.questions.length = 0;
    h.out.length = 0;
    expect(await runSelfInstall(["install", "--version", "0.1.0"], h.deps)).toBe(0);
    expect(h.commands).toEqual([]);
    expect(h.questions).toEqual([]);
    expect(h.out.join("")).toContain("already installed");
  });

  it("with the version present but the launcher missing, lists and writes only the launcher", async () => {
    h = await harness();
    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    await rm(dirs(h).launcher);
    h.commands.length = 0;
    h.out.length = 0;
    expect(await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).toBe(0);
    expect(h.commands).toEqual([]);
    const printed = h.out.join("");
    expect(printed).toContain(dirs(h).launcher);
    expect(printed).not.toContain("npm install");
    expect(await readlink(dirs(h).launcher)).toBe(entryOf(h, "0.1.0"));
  });

  it("upgrades to a second version: the launcher moves atomically and the old version stays until uninstall", async () => {
    h = await harness();
    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    fakeNpm(h, {
      onInstall: async () => {
        // While the new version installs, the launcher still resolves to the old one.
        expect(await readlink(dirs(h).launcher)).toBe(entryOf(h, "0.1.0"));
      },
    });
    expect(await runSelfInstall(["install", "--yes", "--version", "0.2.0"], h.deps)).toBe(0);
    expect(await readlink(dirs(h).launcher)).toBe(entryOf(h, "0.2.0"));
    expect(await names(dirs(h).versions)).toEqual(["0.1.0", "0.2.0"]);
    expect(await names(dirs(h).bin)).toEqual(["bridge", "bridge-runner"]);
    expect(await readlink(dirs(h).alias)).toBe(entryOf(h, "0.2.0"));
  });

  it("refuses to replace a launcher that is not ours (a file, or a link elsewhere) and installs nothing", async () => {
    h = await harness();
    fakeNpm(h);
    await mkdir(dirs(h).bin, { recursive: true });
    await writeFile(dirs(h).launcher, "#!/bin/sh\necho mine\n");
    await expect(runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).rejects.toThrow(/not a bridge launcher/);
    expect(await readFile(dirs(h).launcher, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(h.commands).toEqual([]);
    expect(await exists(dirs(h).versions)).toBe(false);

    await rm(dirs(h).launcher);
    await symlink("/usr/bin/true", dirs(h).launcher);
    await expect(runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).rejects.toThrow(/outside/);
    expect(await readlink(dirs(h).launcher)).toBe("/usr/bin/true");
    expect(h.commands).toEqual([]);
  });

  it("a failing npm leaves no version dir, no staging folder and no launcher", async () => {
    h = await harness();
    fakeNpm(h, { fail: true });
    await expect(runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).rejects.toThrow(/npm install exited with 1.*network down/s);
    expect(await names(dirs(h).versions)).toEqual([]);
    expect(await exists(dirs(h).launcher)).toBe(false);
    // the folders this run created are removed again
    expect(await exists(path.join(h.root, "data"))).toBe(true);
    expect(await exists(path.join(h.root, "data/bridge"))).toBe(false);
  });

  it("a failed install never removes ~/.local/bin, even an empty one this run created (a shared folder)", async () => {
    h = await harness();
    expect(await exists(dirs(h).bin)).toBe(false);
    fakeNpm(h, {
      onInstall: async () => {
        // Missing when the plan was bound, made during the run, empty when the install fails.
        await mkdir(dirs(h).bin, { recursive: true });
        throw new Error("network down");
      },
    });
    await expect(runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).rejects.toThrow(/network down/);
    expect(await exists(dirs(h).bin)).toBe(true);
    expect(await names(dirs(h).bin)).toEqual([]);
    // bridge's own folders still go.
    expect(await exists(path.join(h.root, "data/bridge"))).toBe(false);
  });

  it("explains a missing npm", async () => {
    h = await harness();
    h.deps.run = async () => {
      throw new Error("spawn npm ENOENT");
    };
    await expect(runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).rejects.toThrow(/could not run npm/);
    expect(await names(dirs(h).versions)).toEqual([]);
  });

  it("rejects an install that is not the version asked for", async () => {
    h = await harness();
    fakeNpm(h, { version: "9.9.9" });
    await expect(runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).rejects.toThrow(/9\.9\.9, not 0\.1\.0/);
    expect(await names(dirs(h).versions)).toEqual([]);
    expect(await exists(dirs(h).launcher)).toBe(false);
  });

  it("never links to an entry that resolves outside the version dir", async () => {
    h = await harness();
    const outside = path.join(h.root, "outside.js");
    await writeFile(outside, "evil");
    fakeNpm(h, { entryLink: outside });
    await expect(runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).rejects.toThrow(/not a regular file/);
    expect(await names(dirs(h).versions)).toEqual([]);
    expect(await exists(dirs(h).launcher)).toBe(false);
  });

  it("refuses a versions dir that is a symlink, and a half-made version dir", async () => {
    h = await harness();
    fakeNpm(h);
    const elsewhere = path.join(h.root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await mkdir(path.dirname(dirs(h).versions), { recursive: true });
    await symlink(elsewhere, dirs(h).versions);
    await expect(runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).rejects.toThrow(/not a directory/);
    expect(await names(elsewhere)).toEqual([]);
    expect(h.commands).toEqual([]);

    await rm(dirs(h).versions);
    await mkdir(path.join(dirs(h).versions, "0.1.0"), { recursive: true });
    await expect(runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).rejects.toThrow(/incomplete/);
    expect(h.commands).toEqual([]);
  });

  it("looks at the destinations again after the confirmation: a versions symlink made during the prompt installs nothing", async () => {
    h = await harness();
    fakeNpm(h);
    const elsewhere = path.join(h.root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    h.deps.confirm = async () => {
      await mkdir(path.dirname(dirs(h).versions), { recursive: true });
      await symlink(elsewhere, dirs(h).versions);
      return true;
    };
    await expect(runSelfInstall(["install", "--version", "0.1.0"], h.deps)).rejects.toThrow(/not a directory/);
    expect(await names(elsewhere)).toEqual([]);
    expect(h.commands).toEqual([]);
    expect(await exists(dirs(h).launcher)).toBe(false);
  });

  it("a symlinked bridge data dir made during the prompt is refused too", async () => {
    h = await harness();
    fakeNpm(h);
    const elsewhere = path.join(h.root, "elsewhere");
    await mkdir(path.join(elsewhere, "versions"), { recursive: true });
    h.deps.confirm = async () => {
      await mkdir(path.dirname(path.dirname(dirs(h).versions)), { recursive: true });
      await symlink(elsewhere, path.dirname(dirs(h).versions));
      return true;
    };
    await expect(runSelfInstall(["install", "--version", "0.1.0"], h.deps)).rejects.toThrow(/not a directory/);
    expect(await names(path.join(elsewhere, "versions"))).toEqual([]);
    expect(h.commands).toEqual([]);
  });

  it("a version dir that vanishes during the prompt is not reinstalled behind the user's back", async () => {
    h = await harness();
    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    await rm(dirs(h).launcher);
    h.commands.length = 0;
    h.deps.confirm = async () => {
      await rm(path.join(dirs(h).versions, "0.1.0"), { recursive: true });
      return true;
    };
    await expect(runSelfInstall(["install", "--version", "0.1.0"], h.deps)).rejects.toThrow(/changed while waiting/);
    expect(h.commands).toEqual([]);
    expect(await exists(dirs(h).launcher)).toBe(false);
  });

  it("rejects a version that is not a version, and unknown shapes", async () => {
    h = await harness();
    await expect(runSelfInstall(["install", "--version", "latest"], h.deps)).rejects.toThrow(UsageError);
    await expect(runSelfInstall([], h.deps)).rejects.toThrow(UsageError);
    await expect(runSelfInstall(["install", "extra"], h.deps)).rejects.toThrow(UsageError);
  });
});

describe("bridge self install --from", () => {
  it("verifies the set against SHA256SUMS and installs every tarball in one npm invocation", async () => {
    h = await harness();
    const staged: { dir: string; mode: number; bodies: string[]; manifest: { private?: boolean; dependencies: Record<string, string>; overrides: Record<string, string> } }[] = [];
    fakeNpm(h, {
      onInstall: async (prefix, specs) => {
        const dir = path.dirname(specs[0]!);
        const manifest = JSON.parse(await readFile(path.join(prefix, "package.json"), "utf8"));
        staged.push({ dir, mode: (await lstat(dir)).mode & 0o777, bodies: await Promise.all(specs.map((s) => readFile(s, "utf8"))), manifest });
      },
    });
    const files = await tarballSet(path.join(h.root, "set"), "0.3.0");
    expect(await runSelfInstall(["install", "--yes", "--from", path.join(h.root, "set")], h.deps)).toBe(0);
    const npm = npmCommands(h);
    expect(npm).toHaveLength(1);
    // No tarball on the command line: npm would ask the registry for their @berdyh/* edges. The staging
    // package.json names them as dependencies and overrides, so npm resolves the edges from these files.
    expect(npm[0]!.at(-1)).toBe("--no-fund");
    expect(npm[0]!.some((a) => a.endsWith(".tgz"))).toBe(false);
    const { manifest } = staged[0]!;
    expect(manifest.private).toBe(true);
    expect(manifest.overrides).toEqual(manifest.dependencies);
    expect(Object.keys(manifest.dependencies)).toEqual(["@berdyh/bridge", "@berdyh/bridge-crypto", "@berdyh/bridge-pairing", "@berdyh/bridge-protocol", "@berdyh/bridge-runner"]);
    // npm gets copies of the verified bytes in a private folder under the versions dir, never the set itself.
    const specs = Object.values(manifest.dependencies).map((d) => d.replace(/^file:/, ""));
    expect(specs.map((f) => path.basename(f))).toEqual(files.map((f) => path.basename(f)));
    expect(specs.every((f) => path.dirname(f) === staged[0]!.dir)).toBe(true);
    expect(path.dirname(staged[0]!.dir)).toBe(dirs(h).versions);
    expect(path.basename(staged[0]!.dir)).toMatch(/^\.tarballs-0\.3\.0-/);
    expect(staged[0]!.mode).toBe(0o700);
    expect(staged[0]!.bodies).toEqual(["bridge", "crypto", "pairing", "protocol", "runner"]);
    expect(await names(dirs(h).versions)).toEqual(["0.3.0"]); // the private folder is gone
    expect(npm[0]).toContain("--ignore-scripts");
    expect(await readlink(dirs(h).launcher)).toBe(entryOf(h, "0.3.0")); // the version came from the set
  });

  it("BRIDGE_INSTALL_BASE as a file:// dir is read as install.sh lays it out: the set of this CLI's version is at <base>/<version>/", async () => {
    h = await harness();
    fakeNpm(h);
    const base = path.join(h.root, "release");
    await tarballSet(path.join(base, CLI_VERSION), CLI_VERSION);
    h.deps.env.BRIDGE_INSTALL_BASE = `file://${base}`;
    expect(await runSelfInstall(["install", "--yes"], h.deps)).toBe(0);
    expect(npmCommands(h)[0]!.filter((a) => a.endsWith(".tgz"))).toHaveLength(0);
    const manifest = JSON.parse(await readFile(path.join(dirs(h).versions, `${CLI_VERSION}/package.json`), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies)).toHaveLength(5);
    expect(await readlink(dirs(h).launcher)).toBe(entryOf(h, CLI_VERSION));

    // --version picks <base>/<that version>/.
    await tarballSet(path.join(base, "0.3.0"), "0.3.0");
    expect(await runSelfInstall(["install", "--yes", "--version", "0.3.0"], h.deps)).toBe(0);
    expect(await readlink(dirs(h).launcher)).toBe(entryOf(h, "0.3.0"));
  });

  it("a BRIDGE_INSTALL_BASE set is never the base itself, and a <base>/<version>/ holding another version is refused", async () => {
    h = await harness();
    fakeNpm(h);
    const base = path.join(h.root, "release");
    await tarballSet(base, CLI_VERSION); // the flat layout of old: not where install.sh puts it
    h.deps.env.BRIDGE_INSTALL_BASE = `file://${base}`;
    await expect(runSelfInstall(["install", "--yes"], h.deps)).rejects.toThrow(`${path.join(base, CLI_VERSION)} is not a directory`);
    await tarballSet(path.join(base, CLI_VERSION), "0.3.0");
    await expect(runSelfInstall(["install", "--yes"], h.deps)).rejects.toThrow(`holds bridge 0.3.0, not ${CLI_VERSION}`);
    expect(h.commands).toEqual([]);
  });

  it("with this CLI's version present and no --version, a BRIDGE_INSTALL_BASE without a set is never read (setup's call after install.sh)", async () => {
    h = await harness();
    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", CLI_VERSION], h.deps);
    h.commands.length = 0;
    h.deps.env.BRIDGE_INSTALL_BASE = `file://${path.join(h.root, "release")}`;
    expect(await runSelfInstall(["install", "--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("already installed");
    expect(h.commands).toEqual([]);
    // Present but not linked: only relinked, still without reading the base.
    await rm(dirs(h).launcher);
    expect(await runSelfInstall(["install", "--yes"], h.deps)).toBe(0);
    expect(await readlink(dirs(h).launcher)).toBe(entryOf(h, CLI_VERSION));
    expect(h.commands).toEqual([]);
  });

  it("installs only the runner closure from a full release set, and refuses a set missing part of it", async () => {
    h = await harness();
    let installed: string[] = [];
    fakeNpm(h, { onInstall: (_prefix, specs) => void (installed = specs.map((s) => path.basename(s))) });
    const dir = path.join(h.root, "set");
    await tarballSet(dir, "0.3.0", { extra: { "berdyh-bridge-server-0.3.0.tgz": "server" } });
    expect(await runSelfInstall(["install", "--yes", "--from", dir], h.deps)).toBe(0);
    expect(installed).toEqual(["bridge", "bridge-crypto", "bridge-pairing", "bridge-protocol", "bridge-runner"].map((n) => `berdyh-${n}-0.3.0.tgz`));

    const partial = path.join(h.root, "partial");
    await tarballSet(partial, "0.4.0");
    await rm(path.join(partial, "berdyh-bridge-crypto-0.4.0.tgz"));
    const sums = (await readFile(path.join(partial, "SHA256SUMS"), "utf8")).split("\n").filter((l) => !l.includes("bridge-crypto")).join("\n");
    await writeFile(path.join(partial, "SHA256SUMS"), sums);
    h.commands.length = 0;
    await expect(runSelfInstall(["install", "--yes", "--from", partial], h.deps)).rejects.toThrow(/lacks berdyh-bridge-crypto-0\.4\.0\.tgz/);
    expect(h.commands).toEqual([]);
  });

  it("an https BRIDGE_INSTALL_BASE (install.sh's) is ignored: a present version is only relinked, a missing one comes from the registry", async () => {
    // PATH names the launcher's folder, so the machine's own /usr/bin/bridge cannot add a PATH warning to stderr.
    h = await harness();
    h.deps.env.PATH = dirs(h).bin;
    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    await rm(dirs(h).launcher);
    h.commands.length = 0;
    h.deps.env.BRIDGE_INSTALL_BASE = "https://example.test/release";
    expect(await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).toBe(0);
    expect(h.commands).toEqual([]);
    expect(h.err.join("")).toBe("");
    expect(await readlink(dirs(h).launcher)).toBe(entryOf(h, "0.1.0"));

    expect(await runSelfInstall(["install", "--yes", "--version", "0.4.0"], h.deps)).toBe(0);
    expect(npmCommands(h)[0]!.at(-1)).toBe("@berdyh/bridge@0.4.0");
    expect(h.err.join("")).toContain("npm registry");
  });

  it("with the version present, a bad BRIDGE_INSTALL_BASE directory is never read", async () => {
    h = await harness();
    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    h.deps.env.BRIDGE_INSTALL_BASE = `file://${path.join(h.root, "no-such-set")}`;
    expect(await runSelfInstall(["install", "--version", "0.1.0"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("already installed");
  });

  it("refuses a checksum mismatch before anything is written", async () => {
    h = await harness();
    fakeNpm(h);
    await tarballSet(path.join(h.root, "set"), "0.3.0", { sums: { "berdyh-bridge-runner-0.3.0.tgz": "0".repeat(64) } });
    await expect(runSelfInstall(["install", "--yes", "--from", path.join(h.root, "set")], h.deps)).rejects.toThrow(/checksum mismatch/);
    expect(h.commands).toEqual([]);
    expect(h.questions).toEqual([]);
    expect(await exists(path.join(h.root, "data"))).toBe(false);
  });

  it("refuses a tarball the sums do not list, a listed one that is missing, and a symlinked one", async () => {
    h = await harness();
    fakeNpm(h);
    const dir = path.join(h.root, "set");
    await tarballSet(dir, "0.3.0");
    await writeFile(path.join(dir, "extra.tgz"), "x");
    await expect(runSelfInstall(["install", "--yes", "--from", dir], h.deps)).rejects.toThrow(/extra\.tgz is not listed/);

    await rm(path.join(dir, "extra.tgz"));
    await rm(path.join(dir, "berdyh-bridge-runner-0.3.0.tgz"));
    await expect(runSelfInstall(["install", "--yes", "--from", dir], h.deps)).rejects.toThrow(/is missing/);

    // A symlink with the right bytes behind it is still refused.
    const real = path.join(h.root, "real.tgz");
    await writeFile(real, "runner");
    await symlink(real, path.join(dir, "berdyh-bridge-runner-0.3.0.tgz"));
    await expect(runSelfInstall(["install", "--yes", "--from", dir], h.deps)).rejects.toThrow(/not a regular file/);
    expect(h.commands).toEqual([]);
    expect(await exists(path.join(h.root, "data"))).toBe(false);
  });

  it("refuses a symlinked SHA256SUMS, a set with no bridge tarball, a mismatched --version and a bad sums line", async () => {
    h = await harness();
    fakeNpm(h);
    const dir = path.join(h.root, "set");
    await tarballSet(dir, "0.3.0");
    await expect(runSelfInstall(["install", "--yes", "--from", dir, "--version", "0.4.0"], h.deps)).rejects.toThrow(/does not match the tarball set/);

    await writeFile(path.join(dir, "SHA256SUMS"), `${sha("bridge")}  ../escape.tgz\n`);
    await expect(runSelfInstall(["install", "--yes", "--from", dir], h.deps)).rejects.toThrow(/not a plain tarball name/);
    await writeFile(path.join(dir, "SHA256SUMS"), "garbage\n");
    await expect(runSelfInstall(["install", "--yes", "--from", dir], h.deps)).rejects.toThrow(/unreadable line/);

    const other = path.join(h.root, "set2");
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "berdyh-bridge-runner-0.3.0.tgz"), "runner");
    await writeFile(path.join(other, "SHA256SUMS"), `${sha("runner")}  berdyh-bridge-runner-0.3.0.tgz\n`);
    await expect(runSelfInstall(["install", "--yes", "--from", other], h.deps)).rejects.toThrow(/exactly one @berdyh\/bridge tarball/);

    const linked = path.join(h.root, "set3");
    await mkdir(linked, { recursive: true });
    await symlink(path.join(dir, "SHA256SUMS"), path.join(linked, "SHA256SUMS"));
    await expect(runSelfInstall(["install", "--yes", "--from", linked], h.deps)).rejects.toThrow(/not a regular file/);
    expect(h.commands).toEqual([]);
  });
});

describe("bridge self install: the plan shown is the plan executed", () => {
  it("a launcher dir replaced by a link outside during the prompt gets no launcher and nothing is installed", async () => {
    h = await harness();
    fakeNpm(h);
    const outside = path.join(h.root, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(dirs(h).bin, { recursive: true });
    h.deps.confirm = async () => {
      await rm(dirs(h).bin, { recursive: true });
      await symlink(outside, dirs(h).bin);
      return true;
    };
    await expect(runSelfInstall(["install", "--version", "0.1.0"], h.deps)).rejects.toThrow(/changed while waiting/);
    expect(await readdir(outside)).toEqual([]);
    expect(h.commands).toEqual([]);
  });

  it("a data dir retargeted while a failing npm runs: the staging cleanup is refused and named, nothing outside is removed", async () => {
    h = await harness();
    await mkdir(path.join(h.root, "data"), { recursive: true });
    const outside = path.join(h.root, "outside");
    h.deps.run = async (command, args) => {
      h.commands.push([command, ...args]);
      const staging = args[args.indexOf("--prefix") + 1]!;
      // Someone moves the data dir away and points it at a tree that has a folder of that name.
      const inOutside = path.join(outside, path.relative(path.join(h.root, "data"), staging));
      await mkdir(inOutside, { recursive: true });
      await writeFile(path.join(inOutside, "precious"), "keep");
      await rename(path.join(h.root, "data"), path.join(h.root, "data-moved"));
      await symlink(outside, path.join(h.root, "data"));
      return { exitCode: 1, stdout: "", stderr: "npm error" };
    };
    await expect(runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).rejects.toThrow(/left behind/);
    const left = await readdir(path.join(outside, "bridge/versions"));
    expect(left).toHaveLength(1);
    expect(await readFile(path.join(outside, "bridge/versions", left[0]!, "precious"), "utf8")).toBe("keep");
    expect(await exists(dirs(h).launcher)).toBe(false);
  });

  it("a launcher dir retargeted while npm runs is the accepted window: the link lands where it resolves, nothing outside is removed", async () => {
    h = await harness();
    const outside = path.join(h.root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "precious"), "keep");
    await mkdir(dirs(h).bin, { recursive: true });
    fakeNpm(h, {
      onInstall: async () => {
        await rm(dirs(h).bin, { recursive: true });
        await symlink(outside, dirs(h).bin);
      },
    });
    expect(await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).toBe(0);
    expect(await readFile(path.join(outside, "precious"), "utf8")).toBe("keep");
    expect((await readdir(outside)).sort()).toEqual(["bridge", "bridge-runner", "precious"]);
  });

  it("a missing launcher dir whose parent is retargeted during the prompt is not created outside", async () => {
    h = await harness();
    fakeNpm(h);
    const outside = path.join(h.root, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(path.join(h.root, "home"), { recursive: true });
    h.deps.confirm = async () => {
      await symlink(outside, path.join(h.root, "home/.local"));
      return true;
    };
    await expect(runSelfInstall(["install", "--version", "0.1.0"], h.deps)).rejects.toThrow(/changed while waiting/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("a tarball edited during the prompt is refused by the recompute, before anything is written", async () => {
    h = await harness();
    fakeNpm(h);
    const dir = path.join(h.root, "set");
    await tarballSet(dir, "0.3.0");
    h.deps.confirm = async () => {
      await writeFile(path.join(dir, "berdyh-bridge-runner-0.3.0.tgz"), "edited");
      return true;
    };
    await expect(runSelfInstall(["install", "--from", dir], h.deps)).rejects.toThrow(/changed while waiting/);
    expect(npmCommands(h)).toEqual([]);
    expect(await exists(path.join(h.root, "data"))).toBe(false);
    expect(await exists(dirs(h).launcher)).toBe(false);
  });

  it("a tarball swapped for a symlink (even to the same bytes) during the prompt is refused before any write", async () => {
    h = await harness();
    fakeNpm(h);
    const dir = path.join(h.root, "set");
    await tarballSet(dir, "0.3.0");
    const same = path.join(h.root, "same.tgz");
    await writeFile(same, "runner");
    h.deps.confirm = async () => {
      await rm(path.join(dir, "berdyh-bridge-runner-0.3.0.tgz"));
      await symlink(same, path.join(dir, "berdyh-bridge-runner-0.3.0.tgz"));
      return true;
    };
    await expect(runSelfInstall(["install", "--from", dir], h.deps)).rejects.toThrow(/changed while waiting/);
    expect(npmCommands(h)).toEqual([]);
    expect(await exists(path.join(h.root, "data"))).toBe(false);
  });

  it("a launcher left dangling into the version being installed is relinked once that version is back", async () => {
    h = await harness();
    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    await rm(path.join(dirs(h).versions, "0.1.0"), { recursive: true });
    expect(await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).toBe(0);
    expect(await readlink(dirs(h).launcher)).toBe(entryOf(h, "0.1.0"));
    expect(await readFile(entryOf(h, "0.1.0"), "utf8")).toContain("main.js");
  });

  it("a data dir that is a symlink before the question is fine: install and re-run both work", async () => {
    h = await harness();
    fakeNpm(h);
    const real = path.join(h.root, "real-data");
    await mkdir(real, { recursive: true });
    await symlink(real, path.join(h.root, "data"));
    expect(await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(`really ${path.join(real, "bridge/versions/0.1.0")}`);
    expect(await names(path.join(real, "bridge/versions"))).toEqual(["0.1.0"]);
    h.out.length = 0;
    expect(await runSelfInstall(["install", "--version", "0.1.0"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("already installed");
  });
});

describe("rule A in self install and service install", () => {
  it("self install refuses an aliased layout (config is the bridge data dir) before the question", async () => {
    h = await harness();
    fakeNpm(h);
    await mkdir(path.join(h.root, "data/bridge"), { recursive: true });
    await symlink(path.join(h.root, "data/bridge"), path.join(h.root, "config"));
    await expect(runSelfInstall(["install", "--version", "0.1.0"], h.deps)).rejects.toThrow(/unusual layout/);
    expect(h.questions).toEqual([]);
    expect(h.commands).toEqual([]);
    expect(await readdir(path.join(h.root, "data/bridge"))).toEqual([]);
  });
});

describe("the layout is part of the one recompute", () => {
  it("self install: an alias made during the question (config becomes the bridge data dir) is refused before any write", async () => {
    h = await harness();
    fakeNpm(h);
    await mkdir(path.join(h.root, "data/bridge"), { recursive: true });
    await mkdir(path.join(h.root, "config"), { recursive: true });
    h.deps.confirm = async () => {
      await rm(path.join(h.root, "config"), { recursive: true });
      await symlink(path.join(h.root, "data/bridge"), path.join(h.root, "config"));
      return true;
    };
    await expect(runSelfInstall(["install", "--version", "0.1.0"], h.deps)).rejects.toThrow(/changed while waiting/);
    expect(h.commands).toEqual([]);
    expect(await readdir(path.join(h.root, "data/bridge"))).toEqual([]);
  });
});

describe("install, re-install, upgrade, uninstall", () => {
  it("ends with only the decoys in a fake home", async () => {
    h = await harness();
    const decoys = [
      path.join(h.root, "home/.local/bin/other-tool"),
      path.join(h.root, "data/other-app/keep"),
      path.join(h.root, "config/other-app/keep"),
      path.join(h.root, "home/.local/state/other-app/keep"),
    ];
    for (const d of decoys) {
      await mkdir(path.dirname(d), { recursive: true });
      await writeFile(d, "mine");
    }
    const snapshot = async (): Promise<string[]> => {
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else out.push(path.relative(h.root, p));
        }
      };
      await walk(h.root);
      return out.sort();
    };
    const before = await snapshot();

    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps); // re-install
    await runSelfInstall(["install", "--yes", "--version", "0.2.0"], h.deps); // upgrade
    expect(await readlink(dirs(h).launcher)).toBe(entryOf(h, "0.2.0"));
    expect(await snapshot()).not.toEqual(before);

    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(await lstat(decoys[0]!).then(() => true)).toBe(true);
  });
});

describe("a custom launcher path", () => {
  it("is the one self install creates, the service executes, doctor reports and uninstall removes", async () => {
    h = await harness();
    const custom = path.join(h.root, "home/.local/bin/custom-bridge");
    h.deps.launcher = custom;
    fakeNpm(h);
    expect(await runSelfInstall(["install", "--version", "0.1.0", "--yes"], h.deps)).toBe(0);
    expect(await readlink(custom)).toBe(entryOf(h, "0.1.0"));
    expect(await exists(dirs(h).launcher)).toBe(false);

    expect(await runService(["install", "--yes", "--no-activate"], h.deps)).toBe(0);
    const unit = await readFile(path.join(h.deps.configDir, "systemd", "user", "bridge-runner.service"), "utf8");
    expect(unit).toContain(`ExecStart=${custom} run`);

    h.out.length = 0;
    expect(await runDoctor(["--paths"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(custom);
    const listed = h.out.join("").split("\n").map((line) => line.split("\t")[0]);
    expect(listed).not.toContain(dirs(h).launcher);
    // The alias follows the launcher's folder.
    expect(listed).toContain(dirs(h).alias);

    expect(await runUninstall(["--yes"], h.deps)).toBe(0);
    expect(await exists(custom)).toBe(false);
    expect(await exists(dirs(h).alias)).toBe(false);
  });
});

/** A file named `bridge` in `dir` (executable unless `mode` says otherwise), standing in for iproute2's tool. */
async function fakeBridge(dir: string, mode = 0o755): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "bridge");
  await writeFile(file, "#!/bin/sh\nexit 255\n");
  await chmod(file, mode);
  return file;
}

describe("the launcher on PATH (iproute2's /usr/bin/bridge)", () => {
  it("warns when the first bridge on PATH is not the launcher: both paths, the fix and the second name", async () => {
    h = await harness();
    const other = await fakeBridge(path.join(h.root, "sbin-like/bin"));
    h.deps.env.PATH = [path.dirname(other), dirs(h).bin].join(":");
    const warning = await pathWarningOf(h.deps);
    expect(warning).toContain(`finds ${other} first`);
    expect(warning).toContain(`the launcher is ${dirs(h).launcher}`);
    expect(warning).toContain(`put ${dirs(h).bin} before ${path.dirname(other)} in PATH`);
    expect(warning).toContain("or run the launcher by its full path");
    expect(warning).toContain("`bridge-runner` is the same program under a name nothing else uses: apps and scripts can run that instead.");
    expect(warning).not.toContain("planned");
    expect(warning).not.toContain("iproute2");
  });

  it("names iproute2 when the other bridge is /usr/bin/bridge", async () => {
    h = await harness();
    h.deps.env.PATH = `/usr/bin:${dirs(h).bin}`;
    const real = await stat("/usr/bin/bridge").then(() => true, () => false);
    const warning = await pathWarningOf(h.deps);
    if (real) expect(warning).toContain("iproute2's network tool");
    else expect(warning).toBeUndefined();
  });

  it("is silent with the launcher first, even with another bridge behind it", async () => {
    h = await harness();
    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    const other = await fakeBridge(path.join(h.root, "later/bin"));
    h.deps.env.PATH = [dirs(h).bin, path.dirname(other)].join(":");
    expect(await pathWarningOf(h.deps)).toBeUndefined();
  });

  it("treats a bin dir reached through a link as the launcher's own", async () => {
    h = await harness();
    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    const via = path.join(h.root, "via-link");
    await symlink(dirs(h).bin, via);
    h.deps.env.PATH = via;
    expect(await pathWarningOf(h.deps)).toBeUndefined();
  });

  it("skips a bridge that is not executable and a directory named bridge", async () => {
    h = await harness();
    const noExec = await fakeBridge(path.join(h.root, "a"), 0o644);
    await mkdir(path.join(h.root, "b/bridge"), { recursive: true });
    h.deps.env.PATH = [path.dirname(noExec), path.join(h.root, "b"), dirs(h).bin].join(":");
    expect(await pathWarningOf(h.deps)).toBeUndefined();
  });

  it("resolves a relative PATH entry against the current directory, as command -v does", async () => {
    h = await harness();
    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    const rel = await fakeBridge(path.join(h.root, "work/rel"));
    vi.spyOn(process, "cwd").mockReturnValue(path.join(h.root, "work"));
    h.deps.env.PATH = ["rel", dirs(h).bin].join(":");
    const warning = await pathWarningOf(h.deps);
    expect(warning).toContain(`finds ${rel} first`);
  });

  it("treats an empty PATH entry (leading, middle, trailing) as the current directory", async () => {
    h = await harness();
    fakeNpm(h);
    await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps);
    const here = await fakeBridge(path.join(h.root, "work"));
    vi.spyOn(process, "cwd").mockReturnValue(path.dirname(here));
    h.deps.env.PATH = `:${dirs(h).bin}`;
    expect(await pathWarningOf(h.deps)).toContain(`finds ${here} first`);
    h.deps.env.PATH = `${dirs(h).bin}::${path.join(h.root, "nowhere")}`;
    expect(await pathWarningOf(h.deps)).toBeUndefined();
    h.deps.env.PATH = `${path.join(h.root, "nowhere")}::${dirs(h).bin}`;
    expect(await pathWarningOf(h.deps)).toContain(`finds ${here} first`);
    h.deps.env.PATH = `${dirs(h).bin}:`;
    expect(await pathWarningOf(h.deps)).toBeUndefined();
  });

  it("says nothing when no bridge is on PATH, or PATH is unset", async () => {
    h = await harness();
    h.deps.env.PATH = path.join(h.root, "empty");
    expect(await pathWarningOf(h.deps)).toBeUndefined();
    delete h.deps.env.PATH;
    expect(await pathWarningOf(h.deps)).toBeUndefined();
  });

  it("self install warns on stderr after the install, and after finding the launcher already current", async () => {
    h = await harness();
    fakeNpm(h);
    const other = await fakeBridge(path.join(h.root, "first/bin"));
    h.deps.env.PATH = [path.dirname(other), dirs(h).bin].join(":");
    expect(await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).toBe(0);
    expect(h.err.join("")).toContain(`finds ${other} first`);
    expect(h.out.join("")).not.toContain("WARNING");
    h.err.length = 0;
    expect(await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("the launcher");
    expect(h.err.join("")).toContain(`finds ${other} first`);
  });

  it("self install is silent about PATH when the launcher is first", async () => {
    h = await harness();
    fakeNpm(h);
    h.deps.env.PATH = dirs(h).bin;
    expect(await runSelfInstall(["install", "--yes", "--version", "0.1.0"], h.deps)).toBe(0);
    expect(h.err.join("")).toBe("");
  });

  it("a cancelled install says nothing about PATH", async () => {
    h = await harness();
    fakeNpm(h);
    const other = await fakeBridge(path.join(h.root, "first/bin"));
    h.deps.env.PATH = path.dirname(other);
    h.answers.yes = false;
    expect(await runSelfInstall(["install", "--version", "0.1.0"], h.deps)).toBe(1);
    expect(h.err.join("")).not.toContain("WARNING");
  });
});

describe("the launcher path and redirected XDG dirs", () => {
  it("stays at <home>/.local/bin/bridge by design: XDG_DATA_HOME, XDG_CONFIG_HOME and XDG_STATE_HOME move the versions, config and state, not the launcher", async () => {
    h = await harness();
    const redirected = {
      XDG_DATA_HOME: path.join(h.root, "xdg/data"),
      XDG_CONFIG_HOME: path.join(h.root, "xdg/config"),
      XDG_STATE_HOME: path.join(h.root, "xdg/state"),
    };
    const deps = { ...h.deps, env: { ...h.deps.env, ...redirected }, dataDir: redirected.XDG_DATA_HOME, configDir: redirected.XDG_CONFIG_HOME };
    const paths = installPathsOf(deps);
    expect(paths.versionsDir).toBe(path.join(redirected.XDG_DATA_HOME, "bridge/versions"));
    expect(paths.stateDir).toBe(path.join(redirected.XDG_STATE_HOME, "bridge"));
    expect(paths.launcherLink).toBe(path.join(h.root, "home/.local/bin/bridge"));
    expect(selfInstallPlan(deps, { version: "1.2.3" }).launcherLink).toBe(path.join(h.root, "home/.local/bin/bridge"));
  });
});
