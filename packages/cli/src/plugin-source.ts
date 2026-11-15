import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PackagePin } from "@berdyh/bridge-runner";

import { printable } from "./config.js";
import { type CliDeps, UsageError, homeOf, runnerOf } from "./deps.js";

/** The host's own package limit (`package.ts`, `MAX_PACKAGE_BYTES`): a larger download could never install. */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** One version's registry answer; far above any real one, far below a memory problem. */
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 120_000;

/** `npm:<name>@<exact version>`: a scoped or plain package name and a full semver (no range, tag, `v` prefix or git spec). */
const NPM_SOURCE = /^npm:((?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA512_SRI = /^sha512-([A-Za-z0-9+/]{86}==)$/;

export type SourceSpec =
  | { kind: "local"; path: string }
  | { kind: "https"; url: URL }
  | { kind: "npm"; name: string; version: string };

/** Tells a local path from a published source. A scheme other than `https:` and `npm:` is refused, not read as a folder name. */
export function parseSource(source: string): SourceSpec {
  if (/^npm:/i.test(source)) {
    const match = NPM_SOURCE.exec(source);
    if (!match) throw new UsageError("an npm source is npm:<name>@<exact version> (for example npm:my-plugin@1.2.3); ranges, tags and git specs are refused");
    return { kind: "npm", name: match[1]!, version: match[2]! };
  }
  if (/^http:/i.test(source)) throw new UsageError("plugin sources must use https: an http: URL is refused");
  if (/^https:/i.test(source)) {
    let url: URL;
    try { url = new URL(source); } catch { throw new UsageError("not a valid https URL"); }
    if (url.username !== "" || url.password !== "") throw new UsageError("an https source cannot carry a user name or password");
    return { kind: "https", url };
  }
  if (/^[a-z][a-z0-9+.-]+:/i.test(source)) throw new UsageError(`unsupported plugin source scheme in ${printable(source.slice(0, 40))}; use a path, an https:// URL with --sha256, or npm:<name>@<version>`);
  return { kind: "local", path: path.resolve(source) };
}

/** What the person pinned on the command line, as typed. */
export interface SourceFlags {
  sha256?: string;
  integrity?: string;
  /** `--yes`: the answer is not a person's, so a published source must carry a pin. */
  nonInteractive: boolean;
}

/** Filesystem operations of the download stage; a test replaces them to move bytes under the code's feet. */
export interface SourceIo {
  /** Creates `dir` (0700) and its missing parents (0700). Fails when `dir` itself exists. */
  mkdirPrivate(dir: string): Promise<void>;
  /** Writes a new file (0600, `O_EXCL`). */
  writeNew(file: string, data: Buffer): Promise<void>;
  read(file: string): Promise<Buffer>;
  /** Removes a path (a folder this module created, or a file in it). */
  remove(target: string): Promise<void>;
}

export const defaultSourceIo: SourceIo = {
  async mkdirPrivate(dir) {
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    if (!(await lstat(dir)).isDirectory()) throw new Error("The download folder is not a directory");
  },
  writeNew: (file, data) => writeFile(file, data, { flag: "wx", mode: 0o600 }),
  read: (file) => readFile(file),
  remove: (target) => rm(target, { recursive: true, force: true }),
};

/** A source ready for `host.install`: a path, the pin to hand the host, and the cleanup of the download folder. */
export interface ResolvedSource {
  /** What `host.install` receives. */
  path: string;
  pinnedHash?: PackagePin;
  /** One line for the person: what was checked. Empty for a local path. */
  verified: string;
  /**
   * Run right before `host.install`: the staged file must still hold exactly the hashed bytes. The bytes
   * hashed are held in memory, so a changed file is written again from them (never trusted), and a file
   * that cannot be made equal refuses the install.
   */
  recheck(): Promise<void>;
  /** Removes the download folder. Safe to call twice. */
  cleanup(): Promise<void>;
}

const sha256Hex = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const sha512Base64 = (data: Buffer): string => createHash("sha512").update(data).digest("base64");

/** A value as the person typed it, shown back in an error: no control characters, capped. */
const shown = (text: string): string => printable(text.length > 200 ? `${text.slice(0, 200)}...` : text);

function mismatch(what: string, expected: string, actual: string): Error {
  return new Error(`${what} does not match: expected ${shown(expected)}, downloaded ${shown(actual)}. Nothing was installed.`);
}

/** Reads a body into one buffer, stopping at `limit` bytes. */
async function readBody(response: Response, limit: number, what: string): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`The ${what} is larger than ${limit} bytes (it declares ${declared}); refused`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => {});
      throw new Error(`The ${what} is larger than ${limit} bytes; refused`);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

/** A non-success answer from the server (not a redirect): the status is kept so a caller can say more than "answered 404". */
export class HttpStatusError extends Error {
  constructor(what: string, readonly status: number) {
    super(`The ${what} answered ${status}`);
    this.name = "HttpStatusError";
  }
}

export interface GetOptions {
  limit: number;
  what: string;
  accept?: string;
  /** Per request, redirect hops included (the body read too). Default: 120 s. */
  timeoutMs?: number;
  /** Aborts the request when it fires. */
  signal?: AbortSignal;
  /** Sent only to requests whose origin is this one (a redirect elsewhere never carries it). */
  auth?: { origin: string; token: string };
}

/** GET over https only: redirects are followed by hand, each target must be https, and the body is capped. */
export async function getHttps(deps: CliDeps, start: URL, options: GetOptions): Promise<Buffer> {
  let url = start;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "https:") throw new Error(`The ${options.what} must come over https; refused ${shown(url.protocol)}`);
    const headers: Record<string, string> = {};
    if (options.accept) headers.accept = options.accept;
    if (options.auth && options.auth.origin === url.origin) headers.authorization = `Bearer ${options.auth.token}`;
    // One controller per request: its timer runs until the body is read, and is stopped on every way out.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`The ${options.what} timed out`)), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const onAbort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await deps.fetch(url.href, { redirect: "manual", headers, signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        void response.body?.cancel().catch(() => {});
        if (!location) throw new Error(`The ${options.what} answered ${response.status} with no location`);
        if (hop >= MAX_REDIRECTS) throw new Error(`The ${options.what} redirected more than ${MAX_REDIRECTS} times`);
        let next: URL;
        try { next = new URL(location, url); } catch { throw new Error(`The ${options.what} redirected to an invalid address`); }
        if (next.protocol !== "https:") throw new Error(`The ${options.what} redirected to ${shown(next.protocol)}, which is not https; refused`);
        url = next;
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new HttpStatusError(options.what, response.status);
      }
      return await readBody(response, options.limit, options.what);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** The registry: `npm config get registry` (so a user's own config wins), https only. */
export async function registryOf(deps: CliDeps): Promise<URL> {
  let text = "";
  try {
    const result = await runnerOf(deps)("npm", ["config", "get", "registry"]);
    if (result.exitCode === 0) text = result.stdout.trim();
  } catch { /* no npm: the public registry */ }
  if (text === "" || text === "undefined") text = "https://registry.npmjs.org/";
  let registry: URL;
  try { registry = new URL(text); } catch { throw new Error("The npm registry address is not a URL"); }
  if (registry.protocol !== "https:") throw new Error(`The npm registry must use https; ${shown(registry.href)} is refused`);
  if (!registry.pathname.endsWith("/")) registry.pathname += "/";
  return registry;
}

/** The `_authToken` the user's own `.npmrc` holds for this registry, or none. Never read from anywhere else. */
async function registryToken(deps: CliDeps, registry: URL): Promise<string | undefined> {
  let text: string;
  try { text = await readFile(path.join(homeOf(deps), ".npmrc"), "utf8"); } catch { return undefined; }
  const tokens = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\/\/[^\s=]+\/):_authToken\s*=\s*(.+?)\s*$/.exec(line);
    if (match) tokens.set(match[1]!, match[2]!.replace(/^["']|["']$/g, ""));
  }
  const segments = registry.pathname.split("/").filter(Boolean);
  for (let keep = segments.length; keep >= 0; keep--) {
    const key = `//${registry.host}/${segments.slice(0, keep).join("/")}${keep ? "/" : ""}`;
    const raw = tokens.get(key);
    if (raw === undefined) continue;
    const expanded = raw.replace(/\$\{([^}]+)\}/g, (_all, name: string) => deps.env[name] ?? "\u0000");
    return expanded.includes("\u0000") || expanded === "" ? undefined : expanded;
  }
  return undefined;
}

async function downloadNpm(deps: CliDeps, spec: Extract<SourceSpec, { kind: "npm" }>, pin: PackagePin | undefined): Promise<{ bytes: Buffer; verified: string; pin?: PackagePin }> {
  const registry = await registryOf(deps);
  const token = await registryToken(deps, registry);
  const auth = token === undefined ? undefined : { origin: registry.origin, token };
  const metadataUrl = new URL(`${spec.name.replace("/", "%2f")}/${spec.version}`, registry);
  const metadataBytes = await getHttps(deps, metadataUrl, { limit: MAX_METADATA_BYTES, what: "registry metadata", accept: "application/json", ...(auth ? { auth } : {}) }).catch((error: unknown) => {
    if (error instanceof HttpStatusError && error.status === 404) {
      throw new Error(`The package ${shown(spec.name)} at version ${shown(spec.version)} was not found in the registry ${shown(registry.origin)} (it answered 404); check the package name and the exact version`);
    }
    throw error;
  });
  let metadata: unknown;
  try { metadata = JSON.parse(metadataBytes.toString("utf8")); } catch { throw new Error("The registry metadata is not JSON"); }
  const doc = (typeof metadata === "object" && metadata !== null ? metadata : {}) as { name?: unknown; version?: unknown; dist?: { tarball?: unknown; integrity?: unknown } };
  if (doc.name !== spec.name || doc.version !== spec.version) throw new Error(`The registry answered for ${shown(String(doc.name))}@${shown(String(doc.version))}, not ${spec.name}@${spec.version}`);
  const tarball = doc.dist?.tarball;
  const distIntegrity = doc.dist?.integrity;
  if (typeof tarball !== "string") throw new Error("The registry metadata has no dist.tarball");
  if (typeof distIntegrity !== "string") throw new Error("The registry metadata has no dist.integrity (sha512); refused");
  let tarballUrl: URL;
  try { tarballUrl = new URL(tarball); } catch { throw new Error("The registry's dist.tarball is not a URL"); }
  if (tarballUrl.protocol !== "https:") throw new Error(`The registry's dist.tarball must be https; ${shown(tarballUrl.protocol)} is refused`);
  const bytes = await getHttps(deps, tarballUrl, { limit: MAX_DOWNLOAD_BYTES, what: "package download", ...(auth ? { auth } : {}) });
  const actual = `sha512-${sha512Base64(bytes)}`;
  // The person's pin first: it is the only hash that did not come from the registry.
  if (pin && `sha512-${pin.digest}` !== actual) throw mismatch("--integrity", `sha512-${pin.digest}`, actual);
  const sums = distIntegrity.trim().split(/\s+/).filter((token) => token.startsWith("sha512-"));
  if (sums.length === 0) throw new Error("The registry's dist.integrity has no sha512 value; refused");
  if (!sums.includes(actual)) throw mismatch("The registry's dist.integrity", sums.join(" "), actual);
  return { bytes, verified: `Verified ${spec.name}@${spec.version}: ${actual}${pin ? " (matches your --integrity)" : ""}`, ...(pin ? { pin } : {}) };
}

async function downloadHttps(deps: CliDeps, spec: Extract<SourceSpec, { kind: "https" }>, pin: PackagePin): Promise<{ bytes: Buffer; verified: string; pin: PackagePin }> {
  const bytes = await getHttps(deps, spec.url, { limit: MAX_DOWNLOAD_BYTES, what: "package download" });
  const actual = sha256Hex(bytes);
  if (actual !== pin.digest) throw mismatch("--sha256", pin.digest, actual);
  return { bytes, verified: `Verified sha256 ${actual}`, pin };
}

/** The pin the person typed for this kind of source, or an error saying what to type. */
function pinOf(spec: SourceSpec, flags: SourceFlags): PackagePin | undefined {
  if (spec.kind === "local") {
    if (flags.sha256 !== undefined || flags.integrity !== undefined) throw new UsageError("--sha256 and --integrity apply to https:// and npm: sources only");
    return undefined;
  }
  if (spec.kind === "https") {
    if (flags.integrity !== undefined) throw new UsageError("--integrity applies to npm: sources; use --sha256 for an https:// URL");
    if (flags.sha256 === undefined) throw new UsageError("an https:// source needs --sha256 <64 hex characters>, the hash of the tarball");
    const digest = flags.sha256.trim().toLowerCase();
    if (!SHA256_HEX.test(digest)) throw new UsageError("--sha256 is 64 hexadecimal characters");
    return { algorithm: "sha256", digest };
  }
  if (flags.sha256 !== undefined) throw new UsageError("--sha256 applies to https:// sources; use --integrity sha512-<base64> for npm:");
  if (flags.integrity === undefined) {
    // `dist.integrity` alone is not a pin: it comes from the same registry answer as the tarball.
    if (flags.nonInteractive) throw new Error("--yes installs from npm need a pinned hash: pin the package: --integrity sha512-<base64 of the tarball>");
    return undefined;
  }
  const match = SHA512_SRI.exec(flags.integrity.trim());
  if (!match) throw new UsageError("--integrity is sha512-<88 base64 characters>, as the registry writes dist.integrity");
  return { algorithm: "sha512", digest: match[1]! };
}

/** Where a download is staged: `<home>/.cache/bridge-install/plugins/<random>/`. Never `/tmp`. */
export function stageDirOf(deps: CliDeps): string {
  return path.join(homeOf(deps), ".cache", "bridge-install", "plugins");
}

/**
 * Turns a source argument into something `host.install` can read. A local path is passed as given. A
 * published source is downloaded once into a buffer (64 MiB cap), hashed and verified over that buffer, and
 * only then written to a private staging file; the hash is compared before anything is written, so a bad
 * download leaves nothing behind. The staged file is for the host's reader alone and is removed by `cleanup`.
 */
export async function resolveSource(deps: CliDeps, source: string, flags: SourceFlags, io: SourceIo = defaultSourceIo): Promise<ResolvedSource> {
  const spec = parseSource(source);
  const pin = pinOf(spec, flags);
  if (spec.kind === "local") return { path: spec.path, verified: "", recheck: async () => {}, cleanup: async () => {} };
  const downloaded = spec.kind === "https" ? await downloadHttps(deps, spec, pin!) : await downloadNpm(deps, spec, pin);
  const { bytes } = downloaded;
  const dir = path.join(stageDirOf(deps), randomUUID());
  const file = path.join(dir, "package.tgz");
  const cleanup = (): Promise<void> => io.remove(dir).catch(() => {});
  try {
    await io.mkdirPrivate(dir);
    await io.writeNew(file, bytes);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    path: file,
    ...(downloaded.pin ? { pinnedHash: downloaded.pin } : {}),
    verified: downloaded.verified,
    async recheck() {
      try {
        if ((await io.read(file)).equals(bytes)) return;
      } catch { /* unreadable: written again below */ }
      // The file is not what was hashed. The hashed bytes are in memory: put them back, then look again.
      await io.remove(file);
      await io.writeNew(file, bytes);
      if (!(await io.read(file)).equals(bytes)) throw new Error("The downloaded file changed after it was verified; nothing was installed");
    },
    cleanup,
  };
}
