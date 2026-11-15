import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RemoveRefused, removeBound } from "./remove-bound.js";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("removeBound", () => {
  it("removes a bound path whose folder still resolves where it was bound", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "bridge-rb-"));
    await mkdir(path.join(root, "a/dir"), { recursive: true });
    await writeFile(path.join(root, "a/dir/f"), "x");
    await removeBound(path.join(root, "a/dir"), { recursive: true });
    expect(await readdir(path.join(root, "a"))).toEqual([]);
    await removeBound(path.join(root, "a/missing"), { force: true });
    await removeBound(path.join(root, "no-parent/missing"), { force: true });
  });

  it("refuses when the folder was retargeted, and removes nothing outside", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "bridge-rb-"));
    await mkdir(path.join(root, "a/dir"), { recursive: true });
    await mkdir(path.join(root, "outside/dir"), { recursive: true });
    await writeFile(path.join(root, "outside/dir/precious"), "keep");
    await rename(path.join(root, "a"), path.join(root, "a-moved"));
    await symlink(path.join(root, "outside"), path.join(root, "a"));
    const target = path.join(root, "a/dir");
    await expect(removeBound(target, { recursive: true, force: true })).rejects.toThrow(RemoveRefused);
    await expect(removeBound(target, { recursive: true, force: true })).rejects.toThrow(/left behind/);
    expect(await readFile(path.join(root, "outside/dir/precious"), "utf8")).toBe("keep");
  });

  it("unlinks a symlink leaf instead of descending into it", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "bridge-rb-"));
    await mkdir(path.join(root, "outside"), { recursive: true });
    await writeFile(path.join(root, "outside/precious"), "keep");
    await symlink(path.join(root, "outside"), path.join(root, "link"));
    await removeBound(path.join(root, "link"), { recursive: true });
    expect(await readFile(path.join(root, "outside/precious"), "utf8")).toBe("keep");
    expect(await readdir(root)).toEqual(["outside"]);
  });

  it("emptyDir removes only an empty folder", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "bridge-rb-"));
    await mkdir(path.join(root, "empty"));
    await mkdir(path.join(root, "full"));
    await writeFile(path.join(root, "full/f"), "x");
    await removeBound(path.join(root, "empty"), { emptyDir: true });
    await expect(removeBound(path.join(root, "full"), { emptyDir: true })).rejects.toThrow();
    expect(await readdir(root)).toEqual(["full"]);
  });

  it("emptyDirOnly removes an empty parent, keeps a non-empty one and reports which", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "bridge-rb-"));
    await mkdir(path.join(root, "empty"));
    await mkdir(path.join(root, "full"));
    await writeFile(path.join(root, "full/theirs"), "x");
    expect(await removeBound(path.join(root, "empty"), { emptyDirOnly: true })).toBe(true);
    expect(await removeBound(path.join(root, "full"), { emptyDirOnly: true })).toBe(false);
    expect((await readdir(root)).sort()).toEqual(["full"]);
    expect(await readFile(path.join(root, "full/theirs"), "utf8")).toBe("x");
    // a missing target is not "not empty": it still throws, as without the option
    await expect(removeBound(path.join(root, "missing"), { emptyDirOnly: true })).rejects.toThrow();
  });

  it("emptyDirOnly on a retargeted parent refuses and removes nothing outside", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "bridge-rb-"));
    await mkdir(path.join(root, "a/app"), { recursive: true });
    await mkdir(path.join(root, "outside/app"), { recursive: true });
    await rename(path.join(root, "a"), path.join(root, "a-moved"));
    await symlink(path.join(root, "outside"), path.join(root, "a"));
    await expect(removeBound(path.join(root, "a/app"), { emptyDirOnly: true })).rejects.toThrow(RemoveRefused);
    expect(await readdir(path.join(root, "outside"))).toEqual(["app"]);
  });

  it("emptyDirOnly does not follow a symlink leaf", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "bridge-rb-"));
    await mkdir(path.join(root, "outside"));
    await symlink(path.join(root, "outside"), path.join(root, "link"));
    await expect(removeBound(path.join(root, "link"), { emptyDirOnly: true })).rejects.toThrow();
    expect(await readdir(path.join(root, "outside"))).toEqual([]);
  });

  it("refuses a relative path and a root", async () => {
    await expect(removeBound("relative/x")).rejects.toThrow(RemoveRefused);
    await expect(removeBound("/")).rejects.toThrow(RemoveRefused);
  });
});
