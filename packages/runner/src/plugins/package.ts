import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { validatePluginManifest, type PluginManifest } from "@berdyh/bridge-protocol";

const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
/**
 * A package is read whole into memory, which the byte cap above bounds. The file count is high enough for a
 * real `bundleDependencies` tree (dependencies ride in the tarball), which easily passes 10,000 files.
 */
const MAX_PACKAGE_FILES = 100_000;
export interface PluginPackage {
  manifest: PluginManifest;
  version: string;
  files: Map<string, Buffer>;
}
function safeName(name: string): string {
  if (!name || name.includes("\\") || name.includes("\0") || path.posix.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.split("/").includes("..")) {
    throw new Error(`Unsafe package path: ${name}`);
  }
  return name.replace(/^\.\//, "").replace(/\/$/, "");
}
export function validVersion(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

/** SHA-256 (hex) of a file set: its sorted paths and the digest of each content, so equal sets hash equal. */
export function hashFileSet(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    hash.update(JSON.stringify([name, createHash("sha256").update(files.get(name)!).digest("hex")]) + "\n");
  }
  return hash.digest("hex");
}

export interface ReadPackageOptions {
  /**
   * The source is a version folder the host installed: everything in it is part of the package (`node_modules`,
   * the bundled dependencies kept when the package came from a tarball, and any `.git` or `.bk` folder the tarball
   * held), so a refresh compares like with like and a plugin that installed valid loads valid. A directory source
   * the person points at still omits `node_modules`, `.git` and `.bk`.
   */
  installed?: boolean;
}

/** Read a snapshot before consent. No extraction, package scripts, or network. */
export async function readPluginPackage(source: string, readOptions: ReadPackageOptions = {}): Promise<PluginPackage> {
  const files = new Map<string, Buffer>();
  let total = 0;
  function add(name: string, data: Buffer) {
    name = safeName(name);
    if (files.has(name)) throw new Error(`Duplicate package path: ${name}`);
    total += data.length;
    if (total > MAX_PACKAGE_BYTES || files.size >= MAX_PACKAGE_FILES) throw new Error("Plugin package is too large");
    files.set(name, data);
  }
  const stat = await lstat(source);
  if (stat.isDirectory()) {
    async function visit(dir: string, prefix = "") {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        // Dependencies must be bundled or vendored as regular package files.
        if (!readOptions.installed && [".git", ".bk", "node_modules"].includes(entry.name)) continue;
        const name = prefix + entry.name;
        const absolute = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Package symlinks are not supported: ${name}`);
        if (entry.isDirectory()) await visit(absolute, name + "/");
        else if (entry.isFile()) {
          if ((await lstat(absolute)).size > MAX_PACKAGE_BYTES - total) throw new Error("Plugin package is too large");
          add(name, await readFile(absolute));
        } else throw new Error(`Unsupported package file: ${name}`);
      }
    }
    await visit(source);
  } else if (stat.isFile()) {
    if (stat.size > MAX_PACKAGE_BYTES) throw new Error("Plugin package is too large");
    const raw = await readFile(source);
    const tar = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: MAX_PACKAGE_BYTES }) : raw;
    let pendingPath: string | undefined;
    for (let offset = 0; offset < tar.length;) {
      if (offset + 512 > tar.length) throw new Error("Truncated tar header");
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
      const octal = (start: number, length: number) => {
        const text = field(start, length).trim();
        if (!/^[0-7]+$/.test(text)) throw new Error("Invalid tar number");
        return Number.parseInt(text, 8);
      };
      const size = octal(124, 12);
      const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
      if (checksum !== octal(148, 8)) throw new Error("Invalid tar checksum");
      offset += 512;
      if (offset + size > tar.length) throw new Error("Truncated tar content");
      const body = tar.subarray(offset, offset + size);
      offset += Math.ceil(size / 512) * 512;
      const kind = field(156, 1);
      // Global metadata (e.g. git archive's commit hash) is not extracted and
      // never overrides paths or sizes. Bounds/checksum were checked above.
      if (kind === "g") continue;
      if (kind === "x") {
        // POSIX per-file extended headers (used by npm for long paths).
        for (let at = 0; at < body.length;) {
          const space = body.indexOf(32, at);
          const length = Number(body.subarray(at, space).toString());
          if (space < at || !Number.isSafeInteger(length) || length <= space - at + 1 || at + length > body.length) throw new Error("Invalid PAX record");
          const record = body.subarray(space + 1, at + length - 1).toString();
          const equals = record.indexOf("=");
          const key = record.slice(0, equals);
          if (key === "path") pendingPath = record.slice(equals + 1);
          if (["linkpath", "size"].includes(key)) throw new Error(`Unsupported PAX field: ${key}`);
          at += length;
        }
        continue;
      }
      if (kind !== "" && kind !== "0" && kind !== "5") throw new Error("Tar links and special files are not supported");
      const prefix = field(345, 155);
      const name = safeName(pendingPath ?? ((prefix ? prefix + "/" : "") + field(0, 100)));
      pendingPath = undefined;
      // npm pack uses package/; plain tar archives may use the package root.
      const relative = name.startsWith("package/") ? name.slice(8) : name;
      if (kind !== "5") add(relative, body);
    }
  } else throw new Error("Plugin source must be a directory or tarball");
  const manifestJson = files.get("bridge-plugin.json");
  const packageJson = files.get("package.json");
  if (!manifestJson || !packageJson) throw new Error("Plugin needs bridge-plugin.json and package.json");
  const validation = validatePluginManifest(JSON.parse(manifestJson.toString()));
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  const { version } = JSON.parse(packageJson.toString()) as { version?: unknown };
  if (!validVersion(version)) throw new Error("Invalid plugin package version");
  if (!files.has(safeName(validation.value.entry))) throw new Error("Plugin entry does not exist in the package");
  for (const [name, server] of Object.entries(validation.value.permissions.mcpServers ?? {})) {
    if (!files.has(safeName(server.entry))) throw new Error(`Plugin MCP server ${JSON.stringify(name)} entry does not exist in the package`);
  }
  // Reject file/parent collisions before creating any destination directories.
  for (const name of files.keys()) {
    let parent = path.posix.dirname(name);
    while (parent !== ".") {
      if (files.has(parent)) throw new Error(`Package file is also a directory: ${parent}`);
      parent = path.posix.dirname(parent);
    }
  }
  return { manifest: validation.value, version, files };
}

/** Resolve the configured base without creating it before consent. */
export async function resolveBaseDir(baseDir: string): Promise<{ baseDir: string; boundary: string }> {
  const absolute = path.resolve(baseDir);
  try {
    const resolved = await realpath(absolute);
    return { baseDir: resolved, boundary: resolved };
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A dangling base symlink must not become a trusted boundary.
    try {
      if ((await lstat(absolute)).isSymbolicLink()) throw new Error("Plugin base is a dangling symlink");
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    const resolved = await resolveBaseDir(parent);
    return { baseDir: path.join(resolved.baseDir, path.basename(absolute)), boundary: resolved.boundary };
  }
}

/**
 * Resolve an app's own `bridge/` data folder (`AppPaths.dataDir`) without creating it. The app's
 * parent (`<data>/<app>` and above) may be reached through links that exist now; the `bridge` folder
 * itself may not be one, and neither may anything inside it (`assertNoSymlinks` against the returned
 * boundary). When `bridge` or its parent is still missing, the boundary is the nearest existing
 * ancestor, so a parent link planted later (while the install waits for consent) is refused.
 */
export async function resolveAppDataDir(dataDir: string): Promise<{ baseDir: string; boundary: string }> {
  const absolute = path.resolve(dataDir);
  const parent = await resolveBaseDir(path.dirname(absolute));
  const resolved = path.join(parent.baseDir, path.basename(absolute));
  let stat;
  try {
    stat = await lstat(resolved);
  } catch (error) {
    // Not there yet: the boundary is the existing ancestor (as `resolveBaseDir` found it), never the
    // missing folder itself, so a link planted at or above `bridge/` before it is created is caught
    // by `assertNoSymlinks` walking down from that ancestor.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { baseDir: resolved, boundary: parent.boundary };
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing symlink in plugin path: ${resolved}`);
  return { baseDir: resolved, boundary: resolved };
}

/** Check below the canonical boundary, including base components absent at first load. */
export async function assertNoSymlinks(target: string, baseDir: string): Promise<void> {
  const absolute = path.resolve(target);
  const relative = path.relative(baseDir, absolute);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Plugin path is outside the base directory");
  let current = baseDir;
  for (const part of [".", ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing symlink in plugin path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
