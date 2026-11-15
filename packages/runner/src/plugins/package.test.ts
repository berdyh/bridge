import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appPathsOf } from "../paths.js";
import { createPluginHost } from "./host.js";
import { hashFileSet, readPluginPackage } from "./package.js";

/** Small independent USTAR fixture writer, including deliberately unsafe records. */
function record(name: string, body = "", type = "0"): Buffer {
  const data = Buffer.from(body); const header = Buffer.alloc(512);
  header.write(name, 0, 100); header.write("0000600\0", 100);
  header.write("0000000\0", 108); header.write("0000000\0", 116);
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136); header.fill(32, 148, 156);
  header.write(type, 156); header.write("ustar\0", 257);
  const checksum = header.reduce((a, b) => a + b, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const normal = () => [record("package/package.json", '{"version":"1.0.0"}'), record("package/bridge-plugin.json", JSON.stringify({ id: "test", app: "app", entry: "entry.js", permissions: {} })), record("package/entry.js", "// entry")];
let temp: string;
beforeEach(async () => { temp = await mkdtemp(fileURLToPath(new URL(".test-", import.meta.url))); });
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });
async function archive(records: Buffer[], compressed = false) {
  const file = path.join(temp, "plugin.tar");
  const bytes = Buffer.concat([...records, Buffer.alloc(1024)]);
  await writeFile(file, compressed ? gzipSync(bytes) : bytes); return file;
}

describe("untrusted plugin archives", () => {
  it("installs git archive style tarballs with a global PAX commit header", async () => {
    const line = "52 comment=0123456789012345678901234567890123456789\n";
    const src = await archive([record("pax_global_header", line, "g"), ...normal()]);
    const host = createPluginHost({ apps: [appPathsOf({ config: path.join(temp, "cfg"), data: path.join(temp, "base"), state: path.join(temp, "st") }, "app")] });
    const installed = await host.install(src, { confirm: async () => true });
    expect(installed.manifest.id).toBe("test");
    expect(await readdir(installed.installDir)).toEqual(["bridge-plugin.json", "entry.js", "package.json"]);
  });
  it("ignores global PAX overrides and still validates the actual file paths", async () => {
    const src = await archive([record("pax_global_header", "26 path=../../outside.tar\n", "g"), ...normal()]);
    expect((await readPluginPackage(src)).files.has("entry.js")).toBe(true);
    await expect(readPluginPackage(await archive([record("pax_global_header", "comment=git\n", "g"), ...normal(), record("../escape", "bad")]))).rejects.toThrow("Unsafe package path");
  });
  it.each(["package/../../escape", "/absolute", "C:/absolute", "package\\..\\escape"])("rejects unsafe archive path %s before consent or writes", async (name) => {
    const source = await archive([...normal(), record(name, "bad")]);
    const confirm = vi.fn(async () => true);
    const host = createPluginHost({ apps: [appPathsOf({ config: path.join(temp, "cfg"), data: path.join(temp, "base"), state: path.join(temp, "st") }, "app")] });
    await expect(host.install(source, { confirm })).rejects.toThrow("Unsafe package path");
    expect(confirm).not.toHaveBeenCalled(); expect(await readdir(temp)).toEqual(["plugin.tar"]);
  });
  it.each(["1", "2", "3", "6"])("rejects links and special entries (%s)", async (type) => {
    await expect(readPluginPackage(await archive([...normal(), record("package/link", "", type)]))).rejects.toThrow("special files");
  });
  it("rejects duplicate and conflicting paths", async () => {
    await expect(readPluginPackage(await archive([...normal(), record("package/entry.js", "replaced")]))).rejects.toThrow("Duplicate");
    await expect(readPluginPackage(await archive([...normal(), record("package/entry.js/child", "bad")]))).rejects.toThrow("also a directory");
  });
  it("rejects corrupted checksums and truncated content", async () => {
    const broken = normal(); broken[0]![0] = 0x41;
    await expect(readPluginPackage(await archive(broken))).rejects.toThrow("checksum");
    const src = await archive(normal()); await writeFile(src, record("file", "x".repeat(2048)).subarray(0, 700));
    await expect(readPluginPackage(src)).rejects.toThrow("Truncated");
  });
  it("accepts gzip and POSIX extended paths", async () => {
    const name = "package/" + "nested/".repeat(20) + "asset.txt";
    let length = name.length + 8;
    let pax = "";
    do { pax = `${length} path=${name}\n`; if (Buffer.byteLength(pax) === length) break; length = Buffer.byteLength(pax); } while (true);
    const src = await archive([...normal(), record("PaxHeader", pax, "x"), record("short-name", "asset")], true);
    const pkg = await readPluginPackage(src);
    expect(pkg.files.get(name.slice(8))?.toString()).toBe("asset");
  });
});

const manifestRecord = (permissions: unknown) => record("package/bridge-plugin.json", JSON.stringify({ id: "test", app: "app", entry: "entry.js", permissions }));

describe("package limits and MCP server entries", () => {
  it("rejects a manifest whose MCP server entry is not in the package, and accepts one that is", async () => {
    const withServer = (entryName: string) => [record("package/package.json", '{"version":"1.0.0"}'), manifestRecord({ mcpServers: { corpus: { entry: entryName } } }), record("package/entry.js", "// entry"), record("package/dist/corpus.js", "// server")];
    await expect(readPluginPackage(await archive(withServer("dist/missing.js")))).rejects.toThrow('MCP server "corpus" entry does not exist');
    expect((await readPluginPackage(await archive(withServer("dist/corpus.js")))).manifest.permissions.mcpServers).toEqual({ corpus: { entry: "dist/corpus.js" } });
  });
  it.each(["node_modules/srv/server.js", ".bk/server.js", ".git/server.js"])("keeps a plugin valid on reload when its MCP server entry is %s, which an installed folder holds", async (entryName) => {
    const records = [record("package/package.json", '{"version":"1.0.0"}'), manifestRecord({ mcpServers: { corpus: { entry: entryName } } }), record("package/entry.js", "// entry"), record(`package/${entryName}`, "// server")];
    const base = { config: path.join(temp, "cfg"), data: path.join(temp, "base"), state: path.join(temp, "st") };
    const first = createPluginHost({ apps: [appPathsOf(base, "app")] });
    const installed = await first.install(await archive(records), { confirm: async () => true }, { terminal: true });
    // The installed folder is the package as installed: the same file set, so the same entry check, at load as at install.
    expect((await readPluginPackage(installed.installDir, { installed: true })).files.has(entryName)).toBe(true);
    const reloaded = createPluginHost({ apps: [appPathsOf(base, "app")] });
    expect((await reloaded.list()).map((p) => [p.manifest.id, p.version])).toEqual([["test", "1.0.0"]]);
    // A refresh of the same tarball is the same package (no prompt).
    const confirm = vi.fn(async () => true);
    await reloaded.install(await archive(records), { confirm }, { replace: true });
    expect(confirm).not.toHaveBeenCalled();
  });
  it("accepts more than 10,000 files and rejects more than 100,000", async () => {
    const filler = (count: number) => Array.from({ length: count }, (_, i) => record(`package/files/${i}`));
    const small = await readPluginPackage(await archive([...normal(), ...filler(10_500)], true));
    expect(small.files.size).toBe(10_503);
    await expect(readPluginPackage(await archive([...normal(), ...filler(100_001)], true))).rejects.toThrow("too large");
  }, 60_000);
  it("hashes a file set by its paths and contents, not by their order", () => {
    const a = new Map([["x", Buffer.from("1")], ["y", Buffer.from("2")]]);
    expect(hashFileSet(new Map([["y", Buffer.from("2")], ["x", Buffer.from("1")]]))).toBe(hashFileSet(a));
    expect(hashFileSet(new Map([["x", Buffer.from("1")], ["y", Buffer.from("3")]]))).not.toBe(hashFileSet(a));
    expect(hashFileSet(new Map([["x", Buffer.from("1")], ["z", Buffer.from("2")]]))).not.toBe(hashFileSet(a));
  });
});

describe("bundled dependencies (npm pack)", () => {
  const caller = { appId: "app", channelId: "a", browserKeyId: "browser-a" };
  it("installs a tarball whose bundleDependencies hold more than 10,000 files, and its entry imports one", async () => {
    // The scratch space is TMPDIR (the run sets it to a disk path), never a fixed /tmp path.
    const scratch = await mkdtemp(path.join(tmpdir(), "bridge-bundled-"));
    try {
      const fixture = path.join(scratch, "fixture"); const dep = path.join(fixture, "node_modules", "bigdep");
      await mkdir(path.join(dep, "data"), { recursive: true });
      await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "bigplug", version: "1.0.0", type: "module", dependencies: { bigdep: "1.0.0" }, bundleDependencies: ["bigdep"] }));
      await writeFile(path.join(fixture, "bridge-plugin.json"), JSON.stringify({ id: "bigplug", app: "app", entry: "entry.js", permissions: {} }));
      await writeFile(path.join(fixture, "entry.js"), `import { createInterface } from "node:readline";
import { answer } from "bigdep";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => { const m = JSON.parse(line); if (m.method === "plugin/call") send({ id: m.id, result: { answer } }); });
send({ method: "plugin/ready", params: {} });
`);
      await writeFile(path.join(dep, "package.json"), JSON.stringify({ name: "bigdep", version: "1.0.0", type: "module", main: "index.js" }));
      await writeFile(path.join(dep, "index.js"), "export const answer = 42;\n");
      for (let dir = 0; dir < 105; dir++) {
        await mkdir(path.join(dep, "data", String(dir)));
        await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(path.join(dep, "data", String(dir), `${i}.txt`), `${dir}-${i}`)));
      }
      const packDir = path.join(scratch, "pack"); await mkdir(packDir);
      execFileSync("npm", ["pack", "--pack-destination", packDir, "--ignore-scripts", "--silent"], {
        cwd: fixture, stdio: "pipe",
        env: { ...process.env, npm_config_cache: path.join(scratch, "npm-cache"), npm_config_update_notifier: "false", npm_config_userconfig: path.join(scratch, "npmrc"), npm_config_globalconfig: path.join(scratch, "npmrc-global") },
      });
      const tarball = path.join(packDir, "bigplug-1.0.0.tgz");
      expect((await readPluginPackage(tarball)).files.size).toBeGreaterThan(10_000);
      const base = { config: path.join(scratch, "cfg"), data: path.join(scratch, "base"), state: path.join(scratch, "st") };
      const host = createPluginHost({ apps: [appPathsOf(base, "app")], stopTimeoutMs: 200 });
      try {
        const installed = await host.install(tarball, { confirm: async () => true });
        expect(installed.manifest.id).toBe("bigplug");
        await host.start();
        expect(await host.router.request(caller, "_bigplug/answer", {})).toEqual({ answer: 42 });
        // The same tarball again is the same package, bundled dependencies included: a refresh is a no-op.
        const confirm = vi.fn(async () => true);
        await host.install(tarball, { confirm }, { replace: true });
        expect(confirm).not.toHaveBeenCalled();
      } finally { await host.stopAll(); }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }, 120_000);
});
