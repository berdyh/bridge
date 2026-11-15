import { execFileSync } from "node:child_process";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { setImmediate as nextIo, setTimeout as realDelay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { UPDATE_CHECK_ENV, UPDATE_CHECK_MAX_BYTES, UPDATE_CHECK_TIMEOUT_MS, checkForUpdate } from "./update-check.js";
import { type Harness, harness } from "./testkit.js";
import { CLI_VERSION } from "./version.js";

// A hook lets a test make the config file's stat or read hang, which real I/O on a local file never does.
const fsHook = vi.hoisted(() => ({ stat: undefined as undefined | (() => Promise<never>), readFile: undefined as undefined | (() => Promise<never>) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: ((...args: Parameters<typeof actual.stat>) => (fsHook.stat ? fsHook.stat() : actual.stat(...args))) as typeof actual.stat,
    readFile: ((...args: Parameters<typeof actual.readFile>) => (fsHook.readFile ? fsHook.readFile() : actual.readFile(...args))) as typeof actual.readFile,
  };
});

let h: Harness;
afterEach(async () => {
  fsHook.stat = undefined;
  fsHook.readFile = undefined;
  vi.useRealTimers();
  await h?.cleanup();
});

const URL_LATEST = "https://registry.npmjs.org/@berdyh%2fbridge/latest";
const manifest = (version: unknown) => JSON.stringify({ name: "@berdyh/bridge", version });

type Answer = Response | ((url: string, init: RequestInit | undefined) => Response | Promise<Response>);

/** A fetch that records every request and answers from `answer`. */
function fakeFetch(answer: Answer) {
  const calls: { url: string; headers: Record<string, string>; signal: AbortSignal | undefined }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string> | undefined) }, signal: init?.signal ?? undefined });
    return typeof answer === "function" ? answer(String(input), init) : answer.clone();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** A harness whose fetch is `fn`, the check switched on, `npm_config_registry` set to `registry` when given, and no `npm` allowed to run. */
async function world(fn: typeof fetch, registry = ""): Promise<Harness> {
  const w = await harness({ fetch: fn });
  delete w.deps.env[UPDATE_CHECK_ENV];
  if (registry !== "") w.deps.env.npm_config_registry = registry;
  w.deps.run = async (command, args) => {
    w.commands.push([command, ...args]);
    throw new Error(`the update check must not run ${command}`);
  };
  return w;
}

/**
 * Real I/O (the .npmrc read) does not move fake timers: let it finish until `ready`. A loaded machine can need more
 * than a few event-loop turns for that read, so after them the wait goes on in real 10 ms steps, up to about 3 s.
 */
async function untilReady(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !ready(); i++) await (i < 200 ? nextIo() : realDelay(10));
  expect(ready()).toBe(true);
}

async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) out.push(path.join(e.parentPath, e.name));
  return out.sort();
}

describe("checkForUpdate", () => {
  it("returns the newer version and the command that installs it", async () => {
    const { fn } = fakeFetch(new Response(manifest("99.1.2")));
    h = await world(fn);
    expect(await checkForUpdate(h.deps)).toEqual({ latest: "99.1.2", command: "bridge self install --version 99.1.2" });
  });

  it.each([
    ["the same version", CLI_VERSION],
    ["an older version", "0.0.1"],
    ["a prerelease that is newer", "99.0.0-beta.1"],
  ])("says nothing for %s", async (_name, version) => {
    const { fn } = fakeFetch(new Response(manifest(version)));
    h = await world(fn);
    expect(await checkForUpdate(h.deps)).toBeUndefined();
  });

  it("asks exactly one URL (the dist-tag manifest) with no token, and writes nothing: nothing is downloaded", async () => {
    const { fn, calls } = fakeFetch(new Response(manifest("99.0.0")));
    h = await world(fn);
    // A user token in .npmrc is never sent: the check is anonymous.
    await mkdir(path.join(h.root, "home"), { recursive: true });
    await writeFile(path.join(h.root, "home/.npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
    const before = await tree(h.root);
    expect(await checkForUpdate(h.deps)).toBeDefined();
    expect(calls.map((c) => c.url)).toEqual([URL_LATEST]);
    expect(calls[0]!.headers).toEqual({ accept: "application/json" });
    expect(h.commands).toEqual([]);
    expect(await tree(h.root)).toEqual(before);
  });

  it("uses the registry npm is configured with", async () => {
    const { fn, calls } = fakeFetch(new Response(manifest("99.0.0")));
    h = await world(fn, "https://registry.example/npm\n");
    expect(await checkForUpdate(h.deps)).toBeDefined();
    expect(calls.map((c) => c.url)).toEqual(["https://registry.example/npm/@berdyh%2fbridge/latest"]);
  });

  it.each([
    ["a 404", new Response("not found", { status: 404 })],
    ["a server error", new Response("boom", { status: 503 })],
    ["a body that is not JSON", new Response("<html>nope</html>")],
    ["JSON that is not an object", new Response("null")],
    ["a document without a version", new Response(JSON.stringify({ name: "@berdyh/bridge" }))],
    ["a version that is not text", new Response(manifest(2))],
    ["a version that is not semver", new Response(manifest("latest"))],
    ["a body over 64 KiB", new Response(JSON.stringify({ version: "99.0.0", pad: "x".repeat(UPDATE_CHECK_MAX_BYTES) }))],
  ])("says nothing, and throws nothing, for %s", async (_name, response) => {
    const { fn } = fakeFetch(response);
    h = await world(fn);
    await expect(checkForUpdate(h.deps)).resolves.toBeUndefined();
  });

  it("says nothing when the fetch throws", async () => {
    h = await world((async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch);
    await expect(checkForUpdate(h.deps)).resolves.toBeUndefined();
  });

  it("says nothing for an http registry (https only), and asks nobody", async () => {
    const { fn, calls } = fakeFetch(new Response(manifest("99.0.0")));
    h = await world(fn, "http://localhost:4873/\n");
    await expect(checkForUpdate(h.deps)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it.each([
    ["the unscoped registry= line of ~/.npmrc", "; mine\nregistry = \"https://npmrc.example/r\"\n", {}, "https://npmrc.example/r/@berdyh%2fbridge/latest"],
    ["a scoped @berdyh:registry line of ~/.npmrc over its registry= line", "registry=https://npmrc.example/\n@berdyh:registry=https://scoped.example/\n", {}, "https://scoped.example/@berdyh%2fbridge/latest"],
    ["a scoped @berdyh:registry line of ~/.npmrc over npm_config_registry", "@berdyh:registry=https://scoped.example/\n", { npm_config_registry: "https://env.example/" }, "https://scoped.example/@berdyh%2fbridge/latest"],
    ["a scoped npm_config_@berdyh:registry over everything", "@berdyh:registry=https://scoped.example/\n", { "npm_config_@berdyh:registry": "https://scopedenv.example/", npm_config_registry: "https://env.example/" }, "https://scopedenv.example/@berdyh%2fbridge/latest"],
    ["npm_config_registry over ~/.npmrc", "registry=https://npmrc.example/\n", { npm_config_registry: "https://env.example/" }, "https://env.example/@berdyh%2fbridge/latest"],
    ["NPM_CONFIG_REGISTRY", "", { NPM_CONFIG_REGISTRY: "https://upper.example/" }, "https://upper.example/@berdyh%2fbridge/latest"],
    ["the public registry when nothing names one", "//registry.npmjs.org/:_authToken=x\n", {}, URL_LATEST],
  ])("reads the registry from %s, without running npm", async (_name, npmrc, env, url) => {
    const { fn, calls } = fakeFetch(new Response(manifest("99.0.0")));
    h = await world(fn);
    Object.assign(h.deps.env, env);
    await mkdir(path.join(h.root, "home"), { recursive: true });
    if (npmrc !== "") await writeFile(path.join(h.root, "home/.npmrc"), npmrc);
    expect(await checkForUpdate(h.deps)).toBeDefined();
    expect(calls.map((c) => c.url)).toEqual([url]);
    expect(h.commands).toEqual([]);
  });

  it("an http registry named by ~/.npmrc or the environment asks nobody", async () => {
    const { fn, calls } = fakeFetch(new Response(manifest("99.0.0")));
    h = await world(fn);
    await mkdir(path.join(h.root, "home"), { recursive: true });
    await writeFile(path.join(h.root, "home/.npmrc"), "registry=http://localhost:4873/\n");
    await expect(checkForUpdate(h.deps)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("ends within one 3 s deadline across redirect hops, not 3 s per hop", async () => {
    vi.useFakeTimers();
    let hop = 0;
    const { fn, calls } = fakeFetch((_url, init) => new Promise<Response>((resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
      const next = hop++;
      // Each hop takes 2 s and redirects: three of them would be 6 s.
      setTimeout(() => resolve(new Response(null, { status: 302, headers: { location: `https://registry.npmjs.org/hop${next + 1}` } })), 2_000);
    }));
    h = await world(fn);
    const result = checkForUpdate(h.deps);
    let settled = false;
    void result.then(() => { settled = true; });
    await untilReady(() => calls.length === 1);
    await vi.advanceTimersByTimeAsync(2_000);
    await untilReady(() => calls.length === 2);
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)!.signal!.aborted).toBe(true);
  });

  it("a body that stalls after the headers is cut at the same deadline", async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeFetch((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason));
        },
      });
      return new Response(body);
    });
    h = await world(fn);
    const result = checkForUpdate(h.deps);
    await untilReady(() => calls.length === 1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS);
    await expect(result).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up after 3 seconds on a registry that never answers", async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))));
    h = await world(fn);
    const result = checkForUpdate(h.deps);
    await untilReady(() => calls.length === 1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS - 1);
    expect(calls[0]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[0]!.signal!.aborted).toBe(true);
    await expect(result).resolves.toBeUndefined();
    expect(UPDATE_CHECK_TIMEOUT_MS).toBe(3000);
  });

  it("is aborted by the caller's signal", async () => {
    const controller = new AbortController();
    const { fn, calls } = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))));
    h = await world(fn);
    const result = checkForUpdate(h.deps, { signal: controller.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    await expect(result).resolves.toBeUndefined();
    expect(calls[0]!.signal!.aborted).toBe(true);
    // An already aborted signal asks nobody.
    await expect(checkForUpdate(h.deps, { signal: controller.signal })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["npm_config_userconfig", "npm_config_userconfig"],
    ["NPM_CONFIG_USERCONFIG", "NPM_CONFIG_USERCONFIG"],
  ])("reads the alternate user config named by %s, and never asks the public registry", async (_name, key) => {
    const { fn, calls } = fakeFetch(new Response(manifest("99.0.0")));
    h = await world(fn);
    await mkdir(path.join(h.root, "home"), { recursive: true });
    await writeFile(path.join(h.root, "home/.npmrc"), "registry=https://home.example/\n");
    await writeFile(path.join(h.root, "alt.npmrc"), "registry=https://alt.example/\n");
    h.deps.env[key] = path.join(h.root, "alt.npmrc");
    expect(await checkForUpdate(h.deps)).toBeDefined();
    expect(calls.map((c) => c.url)).toEqual(["https://alt.example/@berdyh%2fbridge/latest"]);
  });

  it("npm_config_registry wins over the registry= line of the user config, and a missing alternate user config falls back to the public registry", async () => {
    const { fn, calls } = fakeFetch(new Response(manifest("99.0.0")));
    h = await world(fn, "https://env.example/");
    h.deps.env.npm_config_userconfig = path.join(h.root, "alt.npmrc");
    await writeFile(path.join(h.root, "alt.npmrc"), "registry=https://alt.example/\n");
    expect(await checkForUpdate(h.deps)).toBeDefined();
    h.deps.env.npm_config_userconfig = path.join(h.root, "missing.npmrc");
    delete h.deps.env.npm_config_registry;
    expect(await checkForUpdate(h.deps)).toBeDefined();
    expect(calls.map((c) => c.url)).toEqual(["https://env.example/@berdyh%2fbridge/latest", URL_LATEST]);
  });

  it("opens regular files only: a FIFO or a directory as the user config is skipped, never read, and the check still answers", async () => {
    const { fn, calls } = fakeFetch(new Response(manifest("99.0.0")));
    h = await world(fn);
    const fifo = path.join(h.root, "fifo.npmrc");
    execFileSync("mkfifo", [fifo]);
    h.deps.env.npm_config_userconfig = fifo;
    expect(await checkForUpdate(h.deps)).toBeDefined();
    await mkdir(path.join(h.root, "dir.npmrc"));
    h.deps.env.npm_config_userconfig = path.join(h.root, "dir.npmrc");
    expect(await checkForUpdate(h.deps)).toBeDefined();
    expect(calls.map((c) => c.url)).toEqual([URL_LATEST, URL_LATEST]);
  });

  it("follows a symlinked user config to a regular file (dotfile managers link ~/.npmrc), but still skips a link to a FIFO or a directory", async () => {
    const { fn, calls } = fakeFetch(new Response(manifest("99.0.0")));
    h = await world(fn);
    await writeFile(path.join(h.root, "real.npmrc"), "registry=https://linked.example/\n");
    await symlink(path.join(h.root, "real.npmrc"), path.join(h.root, "link.npmrc"));
    h.deps.env.npm_config_userconfig = path.join(h.root, "link.npmrc");
    expect(await checkForUpdate(h.deps)).toBeDefined();
    // The default ~/.npmrc may be a link too.
    delete h.deps.env.npm_config_userconfig;
    await mkdir(path.join(h.root, "home"), { recursive: true });
    await symlink(path.join(h.root, "real.npmrc"), path.join(h.root, "home/.npmrc"));
    expect(await checkForUpdate(h.deps)).toBeDefined();
    const fifo = path.join(h.root, "fifo.npmrc");
    execFileSync("mkfifo", [fifo]);
    await symlink(fifo, path.join(h.root, "fifolink.npmrc"));
    await mkdir(path.join(h.root, "dir.npmrc"));
    await symlink(path.join(h.root, "dir.npmrc"), path.join(h.root, "dirlink.npmrc"));
    for (const name of ["fifolink.npmrc", "dirlink.npmrc"]) {
      h.deps.env.npm_config_userconfig = path.join(h.root, name);
      expect(await checkForUpdate(h.deps)).toBeDefined();
    }
    expect(calls.map((c) => c.url)).toEqual([
      "https://linked.example/@berdyh%2fbridge/latest",
      "https://linked.example/@berdyh%2fbridge/latest",
      URL_LATEST,
      URL_LATEST,
    ]);
  });

  it.each(["stat", "readFile"] as const)("a pending config %s settles at the 3 s deadline, asking nobody", async (which) => {
    vi.useFakeTimers();
    const { fn, calls } = fakeFetch(new Response(manifest("99.0.0")));
    h = await world(fn);
    await writeFile(path.join(h.root, "alt.npmrc"), "registry=https://alt.example/\n");
    h.deps.env.npm_config_userconfig = path.join(h.root, "alt.npmrc");
    let started = 0;
    fsHook[which] = () => { started++; return new Promise<never>(() => undefined); };
    const result = checkForUpdate(h.deps);
    let settled = false;
    void result.then(() => { settled = true; });
    await untilReady(() => started === 1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stat", "readFile"] as const)("a pending config %s settles when the caller aborts, asking nobody", async (which) => {
    const { fn, calls } = fakeFetch(new Response(manifest("99.0.0")));
    h = await world(fn);
    await writeFile(path.join(h.root, "alt.npmrc"), "registry=https://alt.example/\n");
    h.deps.env.npm_config_userconfig = path.join(h.root, "alt.npmrc");
    let started = 0;
    fsHook[which] = () => { started++; return new Promise<never>(() => undefined); };
    const controller = new AbortController();
    const result = checkForUpdate(h.deps, { signal: controller.signal });
    await vi.waitFor(() => expect(started).toBe(1));
    controller.abort();
    await expect(result).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it.each([
    ["BRIDGE_UPDATE_CHECK=0", { BRIDGE_UPDATE_CHECK: "0" }],
    ["npm_config_offline=true", { npm_config_offline: "true" }],
  ])("%s calls neither npm nor the registry", async (_name, env) => {
    const { fn, calls } = fakeFetch(new Response(manifest("99.0.0")));
    h = await world(fn);
    Object.assign(h.deps.env, env);
    await expect(checkForUpdate(h.deps)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(h.commands).toEqual([]);
  });
});
