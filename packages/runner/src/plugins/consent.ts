/**
 * The grant surface and the consent record. The types are in `./contracts.ts`; this module implements them.
 *
 * A surface is what a manifest asks for, as canonical items. The consent record is what a person approved:
 * one file per plugin in the app's `consentDir`, written only after the person answered yes (the host calls
 * `write`), read back at every contained session start. Every read and write walks the same link checks as the
 * plugin folders, so a planted link anywhere on the way is refused, never followed.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { isPluginId, type PluginManifest } from "@berdyh/bridge-protocol";

import { removeBound } from "../install/remove-bound.js";
import type { ConsentedGrant, ConsentStore, ConsentStoreOptions, GrantDiff, GrantItem, GrantItemKind, GrantSurface } from "./contracts.js";
import { assertNoSymlinks, resolveAppDataDir } from "./package.js";

const KINDS: readonly GrantItemKind[] = ["agent", "network", "fs", "localUi", "mcpServer", "headlessTool", "execution"];
/** A consent record is a few KiB at most (16 servers, 256 tools); anything bigger is not one. */
const MAX_RECORD_BYTES = 1024 * 1024;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (item: GrantItem): string => JSON.stringify([item.kind, item.value]);

/** Items sorted by kind then value, no duplicates, only `kind` and `value` kept. */
function canonicalItems(items: readonly GrantItem[]): GrantItem[] {
  const unique = new Map<string, GrantItem>();
  for (const item of items) unique.set(keyOf(item), { kind: item.kind, value: item.value });
  return [...unique.values()].sort((a, b) => compareText(a.kind, b.kind) || compareText(a.value, b.value));
}

/** What a manifest asks for, as canonical items. */
export function surfaceOf(manifest: PluginManifest): GrantSurface {
  const permissions = manifest.permissions;
  const items: GrantItem[] = [];
  for (const value of permissions.agents ?? []) items.push({ kind: "agent", value });
  for (const value of permissions.network ?? []) items.push({ kind: "network", value });
  for (const value of permissions.fs ?? []) items.push({ kind: "fs", value });
  if (permissions.execution) items.push({ kind: "execution", value: JSON.stringify({ profile: permissions.execution.profile, network: [...permissions.execution.network].sort(), ...(permissions.execution.broker ? { broker: permissions.execution.broker } : {}) }) });
  if (permissions.localUi) items.push({ kind: "localUi", value: String(permissions.localUi.port) });
  for (const [name, server] of Object.entries(permissions.mcpServers ?? {})) {
    items.push({ kind: "mcpServer", value: JSON.stringify({ name, entry: server.entry, args: server.args ?? [], ...(server.secretTransport ? { secretTransport: server.secretTransport } : {}) }) });
  }
  for (const value of permissions.headless?.tools ?? []) items.push({ kind: "headlessTool", value });
  return { items: canonicalItems(items) };
}

/** SHA-256 (hex) of the canonical JSON of a surface. The order and duplicates of `items` do not matter. */
export function surfaceSha256Of(surface: GrantSurface): string {
  return createHash("sha256").update(JSON.stringify({ items: canonicalItems(surface.items) })).digest("hex");
}

/** `next` compared with the consented `previous`. */
export function diffSurfaces(previous: GrantSurface | undefined, next: GrantSurface): GrantDiff {
  const before = new Map((previous?.items ?? []).map((item) => [keyOf(item), item] as const));
  const after = new Map(next.items.map((item) => [keyOf(item), item] as const));
  return {
    added: canonicalItems([...after].filter(([key]) => !before.has(key)).map(([, item]) => item)),
    removed: canonicalItems([...before].filter(([key]) => !after.has(key)).map(([, item]) => item)),
    unchanged: canonicalItems([...after].filter(([key]) => before.has(key)).map(([, item]) => item)),
  };
}

function isGrantItem(value: unknown): value is GrantItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.value === "string" && typeof item.kind === "string" && (KINDS as readonly string[]).includes(item.kind);
}

/** Reads a record's JSON. A file that is not a well-formed record throws (unreadable); the caller decides what a stale one means. */
function parseRecord(text: string): ConsentedGrant {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The consent record is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("The consent record is not an object");
  const record = parsed as Record<string, unknown>;
  const surface = record.surface as { items?: unknown } | null | undefined;
  if (
    typeof record.pluginId !== "string" || typeof record.appId !== "string" || typeof record.version !== "string" ||
    typeof record.surfaceSha256 !== "string" || typeof record.time !== "string" ||
    typeof surface !== "object" || surface === null || !Array.isArray(surface.items) || !surface.items.every(isGrantItem)
  ) {
    throw new Error("The consent record has an unexpected shape");
  }
  return {
    pluginId: record.pluginId, appId: record.appId, version: record.version,
    surface: { items: (surface.items as GrantItem[]).map((item) => ({ kind: item.kind, value: item.value })) },
    surfaceSha256: record.surfaceSha256, time: record.time,
  };
}

/** The folder is 0700, hardened through a handle on the folder itself (no link followed); refuses when it cannot be. */
async function ensurePrivate(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`Refusing symlink in consent path: ${dir}`);
    throw error;
  }
  try {
    if (((await handle.stat()).mode & 0o777) === 0o700) return;
    await handle.chmod(0o700);
    if (((await handle.stat()).mode & 0o777) !== 0o700) throw new Error(`The consent folder cannot be made private (0700): ${dir}`);
  } finally {
    await handle.close();
  }
}

function assertConsentId(pluginId: string): void {
  if (!isPluginId(pluginId) || pluginId === "bridge") throw new Error("Invalid plugin id");
}

/**
 * A consent store that can say where its folder really is (`bind`) and then act only there: a caller that asks the
 * person something binds first, and passes the bound folder to every read, write and revoke it does afterwards.
 */
export interface BoundConsentStore extends ConsentStore {
  /** The canonical consent folder now: `bridge/` resolved, nothing at or below it a link. Throws otherwise. */
  bind(): Promise<string>;
  /** `bound`, when given, is the folder `bind` returned; a store whose folder resolves elsewhere now refuses. */
  read(pluginId: string, bound?: string): Promise<ConsentedGrant | undefined>;
  write(grant: ConsentedGrant, bound?: string): Promise<void>;
  revoke(pluginId: string, bound?: string): Promise<void>;
}

/** The consent store of one app, in `paths.consentDir`. */
export function createConsentStore(options: ConsentStoreOptions): BoundConsentStore {
  const { appId, consentDir } = options.paths;

  /**
   * Where the record lives now. `bridge/` (the parent of `consentDir`) is resolved through its own parent, which
   * may be a link that exists now; nothing at or below `bridge/` may be one. Run before every read, write and
   * removal, so a link planted at any moment is caught at the next operation.
   */
  async function folder(bound?: string): Promise<{ dir: string; boundary: string }> {
    const bridge = await resolveAppDataDir(path.dirname(consentDir));
    const dir = path.join(bridge.baseDir, path.basename(consentDir));
    // A parent retargeted since the folder was bound (while the person decided) moves it: the answer was not for this folder.
    if (bound !== undefined && dir !== bound) throw new Error(`The consent folder moved during confirmation (${bound} is now ${dir}); retry`);
    await assertNoSymlinks(dir, bridge.boundary);
    return { dir, boundary: bridge.boundary };
  }
  async function locate(pluginId: string, bound?: string): Promise<{ dir: string; file: string; boundary: string }> {
    assertConsentId(pluginId);
    const { dir, boundary } = await folder(bound);
    const file = path.join(dir, `${pluginId}.consent.json`);
    await assertNoSymlinks(file, boundary);
    return { dir, file, boundary };
  }

  return {
    async bind() { return (await folder()).dir; },
    async read(pluginId, bound) {
      const { file } = await locate(pluginId, bound);
      let text: string;
      try {
        // O_NOFOLLOW: a link swapped in after the check above is refused by the kernel, not followed.
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error(`The consent record is not a regular file: ${file}`);
          if (stat.size > MAX_RECORD_BYTES) throw new Error(`The consent record is too large: ${file}`);
          text = await handle.readFile("utf8");
        } finally {
          await handle.close();
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return undefined;
        if (code === "ELOOP") throw new Error(`Refusing symlink in consent path: ${file}`);
        throw error;
      }
      const grant = parseRecord(text);
      // Another plugin's or app's record copied under this name, or a hand-edited surface whose hash was not
      // recomputed: not a consent for this plugin.
      if (grant.pluginId !== pluginId || grant.appId !== appId) return undefined;
      if (grant.surfaceSha256 !== surfaceSha256Of(grant.surface)) return undefined;
      return grant;
    },

    async write(grant, bound) {
      if (grant.appId !== appId) throw new Error(`Consent for app ${grant.appId} cannot be stored for app ${appId}`);
      if (grant.surfaceSha256 !== surfaceSha256Of(grant.surface)) throw new Error("The consent hash does not match its surface");
      const { dir, file, boundary } = await locate(grant.pluginId, bound);
      // Missing parents are created private, 0700. An existing consent folder is made 0700 before a record goes in
      // (or the write is refused when it cannot be): a record is never stored where another user could replace it.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await assertNoSymlinks(dir, boundary);
      await ensurePrivate(dir);
      const record = {
        pluginId: grant.pluginId, appId: grant.appId, version: grant.version,
        surfaceSha256: grant.surfaceSha256, surface: { items: grant.surface.items }, time: grant.time,
      };
      const temporary = path.join(dir, `.${grant.pluginId}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        await assertNoSymlinks(file, boundary);
        await rename(temporary, file);
      } catch (error) {
        await removeBound(temporary, { force: true }).catch(() => {});
        throw error;
      }
    },

    async revoke(pluginId, bound) {
      const { file } = await locate(pluginId, bound);
      await removeBound(file, { force: true });
    },
  };
}
