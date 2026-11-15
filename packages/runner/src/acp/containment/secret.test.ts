import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContainmentRefused, type ContainmentRequest } from "../contracts.js";

import { checkContainmentRequest, createEmptySessionDir, sessionNewOf } from "./profile.js";
import { isInside, secretDirOf, writeSessionSecrets } from "./secret.js";

const ID = "6f1c2b0e-8d6a-4f55-9e0a-3c1f6a7b9d10";
const SECRET = new TextEncoder().encode("topsecret-value-123");

let root: string;
let appTmp: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-secret-"));
  appTmp = path.join(root, "tmp");
  await mkdir(appTmp);
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("writeSessionSecrets", () => {
  it("writes <app tmp>/bridge-acp-secrets-<id>/<server>: dir 0700, file 0600, the secret's bytes", async () => {
    const written = await writeSessionSecrets(appTmp, ID, ["corpus", "notes"], SECRET, []);
    expect(written.dir).toBe(path.join(appTmp, `bridge-acp-secrets-${ID}`));
    expect((await stat(written.dir)).mode & 0o777).toBe(0o700);
    expect([...written.files.keys()]).toEqual(["corpus", "notes"]);
    for (const [name, file] of written.files) {
      expect(file).toBe(path.join(written.dir, name));
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(file, "utf8")).toBe("topsecret-value-123");
    }
    await written.remove();
    await expect(stat(written.dir)).rejects.toThrow();
    await written.remove(); // idempotent
  });

  it("refuses a directory that already exists, and never removes it", async () => {
    const dir = secretDirOf(appTmp, ID);
    await mkdir(dir);
    await writeFile(path.join(dir, "keep"), "mine");
    await expect(writeSessionSecrets(appTmp, ID, ["corpus"], SECRET, [])).rejects.toBeInstanceOf(ContainmentRefused);
    expect(await readFile(path.join(dir, "keep"), "utf8")).toBe("mine");
  });

  it("refuses a planted symlink at the directory name, and writes nothing through it", async () => {
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, secretDirOf(appTmp, ID));
    await expect(writeSessionSecrets(appTmp, ID, ["corpus"], SECRET, [])).rejects.toBeInstanceOf(ContainmentRefused);
    expect(await readdir(elsewhere)).toEqual([]);
    expect((await lstat(secretDirOf(appTmp, ID))).isSymbolicLink()).toBe(true);
  });

  it("refuses a directory inside any directory the agent's env names", async () => {
    const home = path.join(appTmp, `bridge-acp-secrets-${ID}`, "home");
    await expect(writeSessionSecrets(appTmp, ID, ["corpus"], SECRET, [home, appTmp])).rejects.toBeInstanceOf(ContainmentRefused);
    // A sibling of the sandbox is outside it.
    const sandbox = path.join(appTmp, "bridge-acp-AbCdEf");
    const written = await writeSessionSecrets(appTmp, ID, ["corpus"], SECRET, [sandbox, path.join(sandbox, "home")]);
    await written.remove();
  });

  it("refuses unsafe server names, duplicates and an unsafe session id before writing anything", async () => {
    for (const name of ["../x", "a/b", "A", "", ".hidden", "x".repeat(33), "a_b"]) {
      await expect(writeSessionSecrets(appTmp, ID, [name], SECRET, []), name).rejects.toBeInstanceOf(ContainmentRefused);
    }
    await expect(writeSessionSecrets(appTmp, ID, ["a", "a"], SECRET, [])).rejects.toBeInstanceOf(ContainmentRefused);
    for (const id of ["../etc", "a/b", "", "short", "x y z q r s t u"]) {
      await expect(writeSessionSecrets(appTmp, id, ["a"], SECRET, []), id).rejects.toBeInstanceOf(ContainmentRefused);
    }
    expect(await readdir(appTmp)).toEqual([]);
  });
});

describe("isInside", () => {
  it("is lexical containment, the directory itself included", () => {
    expect(isInside("/a/b", "/a")).toBe(true);
    expect(isInside("/a", "/a")).toBe(true);
    expect(isInside("/ab", "/a")).toBe(false);
    expect(isInside("/a/../b", "/a")).toBe(false);
  });
  it("a child whose first component merely starts with two dots is inside", () => {
    expect(isInside("/a/..hidden", "/a")).toBe(true);
    expect(isInside("/a/..hidden/x", "/a")).toBe(true);
    expect(isInside("/a/...", "/a")).toBe(true);
    expect(isInside("/a/..", "/a")).toBe(false);
    expect(isInside("/a/../a/b", "/a")).toBe(true); // lexically /a/b
    expect(isInside("/", "/a")).toBe(false);
    expect(isInside("/b", "/a/b/c")).toBe(false);
  });
});

describe("createEmptySessionDir", () => {
  it("creates an empty 0700 directory and its missing sessions dir, and removes only what it made", async () => {
    const cwd = path.join(root, "sessions", ID);
    const made = await createEmptySessionDir(cwd);
    expect((await stat(cwd)).mode & 0o777).toBe(0o700);
    expect(await readdir(cwd)).toEqual([]);
    await made.remove();
    await expect(stat(cwd)).rejects.toThrow();
    expect(await readdir(path.join(root, "sessions"))).toEqual([]);
  });

  it("refuses a cwd that exists, and leaves it alone", async () => {
    const cwd = path.join(root, "sessions", ID);
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "file"), "x");
    await expect(createEmptySessionDir(cwd)).rejects.toBeInstanceOf(ContainmentRefused);
    expect(await readFile(path.join(cwd, "file"), "utf8")).toBe("x");
  });

  it("refuses a cwd that is a link, and a sessions dir that is a link", async () => {
    await mkdir(path.join(root, "target"));
    await mkdir(path.join(root, "sessions"));
    await symlink(path.join(root, "target"), path.join(root, "sessions", ID));
    await expect(createEmptySessionDir(path.join(root, "sessions", ID))).rejects.toBeInstanceOf(ContainmentRefused);
    await symlink(path.join(root, "target"), path.join(root, "linked"));
    await expect(createEmptySessionDir(path.join(root, "linked", ID))).rejects.toBeInstanceOf(ContainmentRefused);
    expect(await readdir(path.join(root, "target"))).toEqual([]);
  });

  it("the whole tail bridge/sessions/<id> is link-free, whichever component is the link, before and after", async () => {
    // The runner owns three levels: `bridge`, `sessions`, `<id>`. A link at the first one moved every session
    // cwd out of the protected folder while the two-level check passed.
    const target = path.join(root, "target");
    await mkdir(target);
    await mkdir(path.join(root, "state"));
    await symlink(target, path.join(root, "state", "bridge"));
    await expect(createEmptySessionDir(path.join(root, "state", "bridge", "sessions", ID))).rejects.toBeInstanceOf(ContainmentRefused);
    await mkdir(path.join(root, "real", "bridge"), { recursive: true });
    await symlink(target, path.join(root, "real", "bridge", "sessions"));
    await expect(createEmptySessionDir(path.join(root, "real", "bridge", "sessions", ID))).rejects.toBeInstanceOf(ContainmentRefused);
    expect(await readdir(target)).toEqual([]); // nothing was created through either link
    // A plain tail (no `bridge` yet) is created, and a link above the tail stays allowed (`~/.local` often is one).
    await symlink(path.join(root, "state"), path.join(root, "above"));
    const made = await createEmptySessionDir(path.join(root, "above", "plain", "bridge", "sessions", ID));
    expect((await stat(made.dir)).isDirectory()).toBe(true);
    await made.remove();
  });

  it("tightens nothing it does not own: an existing sessions dir keeps its mode", async () => {
    await mkdir(path.join(root, "sessions"), { mode: 0o750 });
    await chmod(path.join(root, "sessions"), 0o750);
    const made = await createEmptySessionDir(path.join(root, "sessions", ID));
    expect((await stat(path.join(root, "sessions"))).mode & 0o777).toBe(0o750);
    await made.remove();
  });
});

describe("checkContainmentRequest and sessionNewOf", () => {
  const server = (o: object = {}) => ({ name: "corpus", command: "/usr/bin/node", args: ["/p/c.js", "${SESSION_SECRET_FILE}"], ...o });
  const request = (o: Partial<ContainmentRequest> = {}): ContainmentRequest => ({ sessionId: ID, servers: [server()], allow: ["mcp__corpus__read"], ...o });
  const cwd = `/sessions/${ID}`;

  it("accepts a plain request", () => {
    expect(() => checkContainmentRequest(request(), cwd)).not.toThrow();
  });

  it("refuses a cwd that is not <sessions dir>/<session id>, an unsafe id, model, name, command or a duplicate", () => {
    const refuses = (r: ContainmentRequest, c = cwd) => expect(() => checkContainmentRequest(r, c)).toThrow(ContainmentRefused);
    refuses(request(), "/sessions/other");
    refuses(request(), `sessions/${ID}`);
    refuses(request({ sessionId: "../x" }), "/s/../x");
    refuses(request({ model: "a b" }));
    refuses(request({ model: "--flag" }));
    refuses(request({ servers: [server({ name: "Bad_Name" })] }));
    refuses(request({ servers: [server({ command: "node" })] }));
    refuses(request({ servers: [server(), server()] }));
  });

  it("substitutes ${SESSION_SECRET_FILE} with the server's own file in one pass; no env entry; no other change", () => {
    const meta = { claudeCode: { options: {} } };
    const out = sessionNewOf(request({ servers: [server({ args: ["/p/c.js", "--f=${SESSION_SECRET_FILE}", "${PLUGIN_DATA}-kept"] })] }), new Map([["corpus", "/s/corpus"]]), meta);
    expect(out).toEqual({ mcpServers: [{ name: "corpus", command: "/usr/bin/node", args: ["/p/c.js", "--f=/s/corpus", "${PLUGIN_DATA}-kept"], env: [] }], _meta: meta });
  });

  it("refuses a server that wants the secret file when none was written", () => {
    expect(() => sessionNewOf(request(), new Map(), {})).toThrow(ContainmentRefused);
  });

  it("a server that does not use the placeholder needs no file", () => {
    const out = sessionNewOf(request({ servers: [server({ args: ["/p/c.js"] })] }), new Map(), {});
    expect(out.mcpServers[0]!.args).toEqual(["/p/c.js"]);
  });
});
