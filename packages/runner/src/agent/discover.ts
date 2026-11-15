import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { AGENT_BIN_NAMES, type AgentId } from "./types.js";

export interface Resolution {
  command: string;
  source: "override" | "npx-cache" | "path";
}

export interface DiscoverOptions {
  homedir: string;
  /** PATH value to search (from the injected env). */
  pathEnv: string | undefined;
  /** Explicit absolute path or bare command per agent. */
  overrides?: Partial<Record<AgentId, string>>;
  delimiter?: string;
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(command: string, pathEnv: string | undefined, delimiter: string): string | undefined {
  if (path.isAbsolute(command)) return executable(command) ? command : undefined;
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

/** `npx` shims re-download on every call; the cache copy is the real binary. */
function isLikelyNpxWrapper(file: string): boolean {
  try {
    const fd = openSync(file, "r");
    try {
      const head = Buffer.alloc(4096);
      const n = readSync(fd, head, 0, head.length, 0);
      const text = head.toString("utf8", 0, n);
      return text.includes("npx") && text.includes("--prefer-online");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Newest executable among ~/.npm/_npx/<hash>/node_modules/.bin/<bin>. */
function newestNpxBin(homedir: string, binName: string): string | undefined {
  const root = path.join(homedir, ".npm", "_npx");
  if (!existsSync(root)) return undefined;
  const found: { file: string; mtimeMs: number }[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, "node_modules", ".bin", binName);
    if (!executable(file)) continue;
    found.push({ file, mtimeMs: statSync(file).mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0]?.file;
}

/** Order: explicit override, npx cache (codex), PATH (skipping npx wrappers). */
export function resolveAgentCommand(agent: AgentId, opts: DiscoverOptions): Resolution | undefined {
  const delimiter = opts.delimiter ?? path.delimiter;
  const override = opts.overrides?.[agent]?.trim();
  if (override) {
    const resolved = findOnPath(override, opts.pathEnv, delimiter);
    return resolved ? { command: resolved, source: "override" } : undefined;
  }
  const bin = AGENT_BIN_NAMES[agent];
  if (agent === "codex-cli") {
    const cached = newestNpxBin(opts.homedir, bin);
    if (cached) return { command: cached, source: "npx-cache" };
  }
  const onPath = findOnPath(bin, opts.pathEnv, delimiter);
  if (onPath && !isLikelyNpxWrapper(onPath)) return { command: onPath, source: "path" };
  return undefined;
}
