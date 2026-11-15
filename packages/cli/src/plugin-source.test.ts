import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UsageError } from "./deps.js";
import { MAX_DOWNLOAD_BYTES, type SourceIo, defaultSourceIo, parseSource, resolveSource, stageDirOf } from "./plugin-source.js";
import { type Harness, harness } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const BYTES = Buffer.from("not really a tarball, the host parses it");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sri = (b: Buffer) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch over a table of https answers; an address it does not know is a test failure. */
function fakeFetch(routes: Record<string, Handler | Response | Buffer | string>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } });
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected fetch ${url}`);
    if (typeof route === "function") return route(url, init);
    if (route instanceof Response) return route.clone();
    return new Response(route);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

async function stagedEntries(): Promise<string[]> {
  return readdir(stageDirOf(h.deps)).catch(() => []);
}

const TARBALL = "https://registry.npmjs.org/demo/-/demo-1.0.0.tgz";
const META = "https://registry.npmjs.org/demo/1.0.0";
const metadata = (over: Record<string, unknown> = {}, dist: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "demo", version: "1.0.0", dist: { tarball: TARBALL, integrity: sri(BYTES), ...dist }, ...over });

describe("parseSource", () => {
  it("tells local paths, https URLs and exact npm versions apart", () => {
    expect(parseSource("./plugin")).toMatchObject({ kind: "local" });
    expect(parseSource("https://example.com/a.tgz")).toMatchObject({ kind: "https" });
    expect(parseSource("npm:demo@1.2.3")).toEqual({ kind: "npm", name: "demo", version: "1.2.3" });
    expect(parseSource("npm:@scope/demo@1.2.3-beta.1")).toEqual({ kind: "npm", name: "@scope/demo", version: "1.2.3-beta.1" });
  });
  it.each(["npm:demo@^1.0.0", "npm:demo@1", "npm:demo@latest", "npm:demo", "npm:demo@>=1.0.0", "npm:github:user/repo", "npm:demo@v1.0.0", "npm:demo@1.0.0 || 2.0.0"])(
    "refuses %s: a range, tag or git spec is not a published version", (source) => {
      expect(() => parseSource(source)).toThrow(UsageError);
    });
  it.each(["http://example.com/a.tgz", "git+https://example.com/a.git", "file:///tmp/a", "ftp://x/y", "https://user:pw@example.com/a.tgz"])("refuses %s", (source) => {
    expect(() => parseSource(source)).toThrow(UsageError);
  });
});

describe("https source", () => {
  it("installs a download whose sha256 matches: the pin is handed on, the file holds the hashed bytes", async () => {
    const { fn } = fakeFetch({ "https://example.com/a.tgz": BYTES });
    h = await harness({ fetch: fn });
    const source = await resolveSource(h.deps, "https://example.com/a.tgz", { sha256: sha256(BYTES).toUpperCase(), nonInteractive: true });
    expect(source.pinnedHash).toEqual({ algorithm: "sha256", digest: sha256(BYTES) });
    expect(source.path.startsWith(stageDirOf(h.deps) + path.sep)).toBe(true);
    expect(source.path).toContain(path.join(h.root, "home", ".cache", "bridge-install", "plugins"));
    expect(await readFile(source.path)).toEqual(BYTES);
    await source.cleanup();
    expect(await stagedEntries()).toEqual([]);
  });

  it("refuses a wrong sha256, printing both values, with nothing staged", async () => {
    const { fn } = fakeFetch({ "https://example.com/a.tgz": BYTES });
    h = await harness({ fetch: fn });
    const wrong = "0".repeat(64);
    const error = await resolveSource(h.deps, "https://example.com/a.tgz", { sha256: wrong, nonInteractive: false }).catch((e: Error) => e);
    expect((error as Error).message).toContain(wrong);
    expect((error as Error).message).toContain(sha256(BYTES));
    expect(await stagedEntries()).toEqual([]);
  });

  it("refuses an http URL and a missing or malformed --sha256 before any request", async () => {
    const { fn, calls } = fakeFetch({});
    h = await harness({ fetch: fn });
    await expect(resolveSource(h.deps, "http://example.com/a.tgz", { sha256: sha256(BYTES), nonInteractive: false })).rejects.toThrow(/https/);
    await expect(resolveSource(h.deps, "https://example.com/a.tgz", { nonInteractive: false })).rejects.toThrow(/--sha256/);
    await expect(resolveSource(h.deps, "https://example.com/a.tgz", { sha256: "abc", nonInteractive: false })).rejects.toThrow(/64 hexadecimal/);
    await expect(resolveSource(h.deps, "https://example.com/a.tgz", { sha256: sha256(BYTES), integrity: sri(BYTES), nonInteractive: false })).rejects.toThrow(/--integrity applies to npm/);
    expect(calls).toEqual([]);
    expect(await stagedEntries()).toEqual([]);
  });

  it("follows an https redirect, refuses a redirect to http, and stops after too many", async () => {
    const { fn, calls } = fakeFetch({
      "https://example.com/a.tgz": redirect("https://cdn.example.com/a.tgz", 301),
      "https://cdn.example.com/a.tgz": BYTES,
      "https://example.com/down.tgz": redirect("http://cdn.example.com/a.tgz"),
      "https://example.com/loop.tgz": redirect("https://example.com/loop.tgz"),
    });
    h = await harness({ fetch: fn });
    const flags = { sha256: sha256(BYTES), nonInteractive: false };
    const source = await resolveSource(h.deps, "https://example.com/a.tgz", flags);
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/a.tgz", "https://cdn.example.com/a.tgz"]);
    await source.cleanup();
    await expect(resolveSource(h.deps, "https://example.com/down.tgz", flags)).rejects.toThrow(/not https/);
    await expect(resolveSource(h.deps, "https://example.com/loop.tgz", flags)).rejects.toThrow(/redirected more than/);
    expect(await stagedEntries()).toEqual([]);
  });

  it("refuses an oversize download, declared or streamed, with nothing staged", async () => {
    const chunk = Buffer.alloc(8 * 1024 * 1024, 1);
    let sent = 0;
    const { fn } = fakeFetch({
      "https://example.com/declared.tgz": new Response("x", { headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1) } }),
      "https://example.com/streamed.tgz": () => new Response(new ReadableStream({
        pull(controller) { sent += chunk.length; controller.enqueue(chunk); if (sent > 10 * chunk.length) controller.close(); },
      })),
    });
    h = await harness({ fetch: fn });
    const flags = { sha256: sha256(BYTES), nonInteractive: false };
    await expect(resolveSource(h.deps, "https://example.com/declared.tgz", flags)).rejects.toThrow(/larger than/);
    await expect(resolveSource(h.deps, "https://example.com/streamed.tgz", flags)).rejects.toThrow(/larger than/);
    expect(sent).toBeLessThanOrEqual(10 * chunk.length);
    expect(await stagedEntries()).toEqual([]);
  });

  it("cleans the download folder when staging fails", async () => {
    const { fn } = fakeFetch({ "https://example.com/a.tgz": BYTES });
    h = await harness({ fetch: fn });
    const io: SourceIo = { ...defaultSourceIo, writeNew: async () => { throw new Error("disk full"); } };
    await expect(resolveSource(h.deps, "https://example.com/a.tgz", { sha256: sha256(BYTES), nonInteractive: false }, io)).rejects.toThrow("disk full");
    expect(await stagedEntries()).toEqual([]);
  });

  it("hash and install use one buffer: a file changed after the hash is written again from the hashed bytes", async () => {
    const { fn } = fakeFetch({ "https://example.com/a.tgz": BYTES });
    h = await harness({ fetch: fn });
    const evil = Buffer.from("swapped after the hash");
    // The fake fs swaps the staged file the moment it is written; a second write (the repair) is left alone.
    let writes = 0;
    const io: SourceIo = {
      ...defaultSourceIo,
      async writeNew(file, data) {
        await defaultSourceIo.writeNew(file, data);
        if (++writes === 1) { await defaultSourceIo.remove(file); await writeFile(file, evil); }
      },
    };
    const source = await resolveSource(h.deps, "https://example.com/a.tgz", { sha256: sha256(BYTES), nonInteractive: false }, io);
    expect(await readFile(source.path)).toEqual(evil);
    await source.recheck();
    expect(await readFile(source.path)).toEqual(BYTES);
    await source.cleanup();
  });

  it("refuses the install when the file cannot be made to hold the hashed bytes", async () => {
    const { fn } = fakeFetch({ "https://example.com/a.tgz": BYTES });
    h = await harness({ fetch: fn });
    const io: SourceIo = { ...defaultSourceIo, read: async () => Buffer.from("always different") };
    const source = await resolveSource(h.deps, "https://example.com/a.tgz", { sha256: sha256(BYTES), nonInteractive: false }, io);
    await expect(source.recheck()).rejects.toThrow(/changed after it was verified/);
    await source.cleanup();
  });
});

describe("npm source", () => {
  function registryRun(registry: string) {
    return async (command: string, args: readonly string[]) => {
      expect([command, ...args]).toEqual(["npm", "config", "get", "registry"]);
      return { exitCode: 0, stdout: `${registry}\n`, stderr: "" };
    };
  }

  it("installs a version whose tarball matches dist.integrity and the pinned --integrity", async () => {
    const { fn, calls } = fakeFetch({ [META]: metadata(), [TARBALL]: BYTES });
    h = await harness({ fetch: fn, run: registryRun("https://registry.npmjs.org/") });
    const source = await resolveSource(h.deps, "npm:demo@1.0.0", { integrity: sri(BYTES), nonInteractive: true });
    expect(calls.map((c) => c.url)).toEqual([META, TARBALL]);
    expect(source.pinnedHash).toEqual({ algorithm: "sha512", digest: sri(BYTES).slice(7) });
    expect(await readFile(source.path)).toEqual(BYTES);
    await source.cleanup();
    expect(await stagedEntries()).toEqual([]);
  });

  it("checks an interactive install against dist.integrity alone, and hands the host no pin", async () => {
    const { fn } = fakeFetch({ [META]: metadata(), [TARBALL]: BYTES });
    h = await harness({ fetch: fn, run: registryRun("https://registry.npmjs.org/") });
    const source = await resolveSource(h.deps, "npm:demo@1.0.0", { nonInteractive: false });
    expect(source.pinnedHash).toBeUndefined();
    await source.cleanup();
  });

  it("refuses a wrong dist.integrity, printing both values, with nothing staged", async () => {
    const other = sri(Buffer.from("other"));
    const { fn } = fakeFetch({ [META]: metadata({}, { integrity: other }), [TARBALL]: BYTES });
    h = await harness({ fetch: fn, run: registryRun("https://registry.npmjs.org/") });
    const error = (await resolveSource(h.deps, "npm:demo@1.0.0", { nonInteractive: false }).catch((e: Error) => e)) as Error;
    expect(error.message).toContain(other);
    expect(error.message).toContain(sri(BYTES));
    expect(await stagedEntries()).toEqual([]);
  });

  it("refuses a pinned --integrity that does not match, even when dist.integrity does", async () => {
    const pin = sri(Buffer.from("what the person pinned"));
    const { fn } = fakeFetch({ [META]: metadata(), [TARBALL]: BYTES });
    h = await harness({ fetch: fn, run: registryRun("https://registry.npmjs.org/") });
    const error = (await resolveSource(h.deps, "npm:demo@1.0.0", { integrity: pin, nonInteractive: true }).catch((e: Error) => e)) as Error;
    expect(error.message).toContain(pin);
    expect(error.message).toContain(sri(BYTES));
    expect(await stagedEntries()).toEqual([]);
  });

  it("a package or version the registry does not have says which one was asked for and that it was not found", async () => {
    const { fn } = fakeFetch({ [META]: new Response("{}", { status: 404 }) });
    h = await harness({ fetch: fn, run: registryRun("https://registry.npmjs.org/") });
    const error = (await resolveSource(h.deps, "npm:demo@1.0.0", { integrity: sri(BYTES), nonInteractive: true }).catch((e: Error) => e)) as Error;
    expect(error.message).toContain("demo");
    expect(error.message).toContain("1.0.0");
    expect(error.message).toContain("not found in the registry https://registry.npmjs.org");
    expect(error.message).not.toContain("metadata answered");
    expect(await stagedEntries()).toEqual([]);
  });

  it("any other registry status keeps its plain wording", async () => {
    const other = fakeFetch({ [META]: new Response("{}", { status: 500 }) });
    h = await harness({ fetch: other.fn, run: registryRun("https://registry.npmjs.org/") });
    await expect(resolveSource(h.deps, "npm:demo@1.0.0", { integrity: sri(BYTES), nonInteractive: true })).rejects.toThrow("The registry metadata answered 500");
  });

  it("refuses a version range or tag without a request", async () => {
    const { fn, calls } = fakeFetch({});
    h = await harness({ fetch: fn });
    for (const source of ["npm:demo@^1.0.0", "npm:demo@latest", "npm:demo@1.x"]) {
      await expect(resolveSource(h.deps, source, { nonInteractive: false })).rejects.toThrow(/exact version/);
    }
    expect(calls).toEqual([]);
    expect(await stagedEntries()).toEqual([]);
  });

  it("with --yes needs --integrity, before any request: dist.integrity alone is not a pin", async () => {
    const { fn, calls } = fakeFetch({ [META]: metadata(), [TARBALL]: BYTES });
    h = await harness({ fetch: fn, run: registryRun("https://registry.npmjs.org/") });
    await expect(resolveSource(h.deps, "npm:demo@1.0.0", { nonInteractive: true })).rejects.toThrow(/pin the package: --integrity/);
    expect(calls).toEqual([]);
    expect(await stagedEntries()).toEqual([]);
  });

  it("refuses a registry that is not https, a tarball URL that is not https, a redirect to http, and an oversize tarball", async () => {
    const flags = { nonInteractive: false };
    let { fn } = fakeFetch({});
    h = await harness({ fetch: fn, run: registryRun("http://registry.example.com/") });
    await expect(resolveSource(h.deps, "npm:demo@1.0.0", flags)).rejects.toThrow(/registry must use https/);
    await h.cleanup();

    ({ fn } = fakeFetch({ [META]: metadata({}, { tarball: "http://registry.npmjs.org/demo.tgz" }) }));
    h = await harness({ fetch: fn, run: registryRun("https://registry.npmjs.org/") });
    await expect(resolveSource(h.deps, "npm:demo@1.0.0", flags)).rejects.toThrow(/dist.tarball must be https/);
    await h.cleanup();

    ({ fn } = fakeFetch({ [META]: metadata(), [TARBALL]: redirect("http://evil.example/demo.tgz") }));
    h = await harness({ fetch: fn, run: registryRun("https://registry.npmjs.org/") });
    await expect(resolveSource(h.deps, "npm:demo@1.0.0", flags)).rejects.toThrow(/not https/);
    await h.cleanup();

    ({ fn } = fakeFetch({ [META]: metadata(), [TARBALL]: new Response("x", { headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1) } }) }));
    h = await harness({ fetch: fn, run: registryRun("https://registry.npmjs.org/") });
    await expect(resolveSource(h.deps, "npm:demo@1.0.0", flags)).rejects.toThrow(/larger than/);
    expect(await stagedEntries()).toEqual([]);
  });

  it("refuses an answer for another package or version, and one without a sha512 dist.integrity", async () => {
    const run = registryRun("https://registry.npmjs.org/");
    const cases: [string, RegExp][] = [
      [metadata({ version: "9.9.9" }), /not demo@1.0.0/],
      [metadata({ name: "other" }), /not demo@1.0.0/],
      [metadata({}, { integrity: undefined }), /no dist.integrity/],
      [metadata({}, { integrity: "sha1-AAAA" }), /no sha512/],
      ["not json", /not JSON/],
    ];
    for (const [body, message] of cases) {
      const { fn } = fakeFetch({ [META]: body, [TARBALL]: BYTES });
      h = await harness({ fetch: fn, run });
      await expect(resolveSource(h.deps, "npm:demo@1.0.0", { nonInteractive: false })).rejects.toThrow(message);
      expect(await stagedEntries()).toEqual([]);
      await h.cleanup();
    }
  });

  it("sends the .npmrc token only to the registry's origin, never along a redirect or to another host", async () => {
    const other = "https://cdn.example.com/demo.tgz";
    const { fn, calls } = fakeFetch({ [META]: metadata({}, { tarball: other }), [other]: BYTES });
    h = await harness({ fetch: fn, run: registryRun("https://registry.npmjs.org/"), env: { HOME: "x", PATH: "/usr/bin", NPM_TOKEN: "s3cret" } });
    await mkdir(path.join(h.root, "home"), { recursive: true });
    await writeFile(path.join(h.root, "home", ".npmrc"), "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n//other.example/:_authToken=nope\n");
    const source = await resolveSource(h.deps, "npm:demo@1.0.0", { nonInteractive: false });
    expect(calls[0]!.headers.authorization).toBe("Bearer s3cret");
    expect(calls[1]!.headers.authorization).toBeUndefined();
    await source.cleanup();
  });

  it("sends no authorization without a token for that host in .npmrc", async () => {
    const { fn, calls } = fakeFetch({ [META]: metadata(), [TARBALL]: BYTES });
    h = await harness({ fetch: fn, run: registryRun("https://registry.npmjs.org/") });
    await mkdir(path.join(h.root, "home"), { recursive: true });
    await writeFile(path.join(h.root, "home", ".npmrc"), "//other.example/:_authToken=nope\n");
    await (await resolveSource(h.deps, "npm:demo@1.0.0", { nonInteractive: false })).cleanup();
    expect(calls.every((c) => c.headers.authorization === undefined)).toBe(true);
  });
});

describe("local source", () => {
  it("is passed through unchanged, and takes no pin", async () => {
    h = await harness();
    const source = await resolveSource(h.deps, "./some/dir", { nonInteractive: true });
    expect(source.path).toBe(path.resolve("./some/dir"));
    expect(source.pinnedHash).toBeUndefined();
    await expect(resolveSource(h.deps, "./some/dir", { sha256: "a".repeat(64), nonInteractive: false })).rejects.toThrow(/https:\/\/ and npm:/);
  });
});
