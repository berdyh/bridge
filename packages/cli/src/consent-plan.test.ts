import { mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChangedWhileWaiting, assertUnchanged, canonicalPath, describePath, pathState, sha256, writeFileAtomically } from "./consent-plan.js";
import { type Harness, harness } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("consent plans", () => {
  it("canonicalPath resolves every existing ancestor, keeps missing parts and the last component as named", async () => {
    h = await harness();
    const real = path.join(h.root, "real");
    await mkdir(real, { recursive: true });
    await symlink(real, path.join(h.root, "link"));
    expect(await canonicalPath(path.join(h.root, "link/a/b/file"))).toBe(path.join(real, "a/b/file"));
    await symlink(path.join(h.root, "outside"), path.join(real, "leaf"));
    expect(await canonicalPath(path.join(h.root, "link/leaf"))).toBe(path.join(real, "leaf"));
    await symlink(path.join(h.root, "nowhere"), path.join(h.root, "dangling"));
    await expect(canonicalPath(path.join(h.root, "dangling/x"))).rejects.toThrow(/dangling symlink/);
  });

  it("pathState reports kinds without following the last component, hashes on request, and never throws", async () => {
    h = await harness();
    const file = path.join(h.root, "f");
    await writeFile(file, "abc");
    await symlink(file, path.join(h.root, "l"));
    await symlink(path.join(h.root, "gone"), path.join(h.root, "d"));
    expect(await pathState(file, { hash: true })).toEqual({ path: file, canonical: file, kind: "file", sha256: sha256("abc") });
    expect(await pathState(path.join(h.root, "l"))).toMatchObject({ kind: "symlink", link: file, target: file });
    expect(await pathState(path.join(h.root, "d"))).toMatchObject({ kind: "symlink", target: null });
    expect(await pathState(path.join(h.root, "d/x"))).toMatchObject({ kind: "unresolvable" });
    expect(await pathState(path.join(h.root, "none"))).toMatchObject({ kind: "missing" });
  });

  it("assertUnchanged refuses any difference", async () => {
    h = await harness();
    const before = await pathState(path.join(h.root, "x"));
    await writeFile(path.join(h.root, "x"), "");
    expect(() => assertUnchanged(before, before)).not.toThrow();
    const now = await pathState(path.join(h.root, "x"));
    expect(() => assertUnchanged(before, now)).toThrow(ChangedWhileWaiting);
    expect(() => assertUnchanged(before, now)).toThrow(/changed while waiting/);
  });

  it("writeFileAtomically replaces a symlink at the target instead of writing through it", async () => {
    h = await harness();
    const outside = path.join(h.root, "outside");
    await writeFile(outside, "keep");
    const target = path.join(h.root, "t");
    await symlink(outside, target);
    await writeFileAtomically(target, "new");
    expect(await readFile(outside, "utf8")).toBe("keep");
    expect(await readFile(target, "utf8")).toBe("new");
    await expect(readlink(target)).rejects.toThrow();
  });
});

describe("describePath", () => {
  it("calls a symlink dangling only when its target is known to resolve nowhere", () => {
    const link = { path: "/h/bin/bridge", canonical: "/h/bin/bridge", kind: "symlink" as const, link: "/h/v/run.js" };
    expect(describePath({ ...link, target: "/h/v/run.js" })).toBe("/h/bin/bridge [symlink to /h/v/run.js; the link itself]");
    expect(describePath({ ...link, target: null })).toBe("/h/bin/bridge [symlink to /h/v/run.js, dangling; the link itself]");
    expect(describePath({ ...link, target: undefined })).toBe("/h/bin/bridge [symlink to /h/v/run.js; the link itself]");
  });
});
