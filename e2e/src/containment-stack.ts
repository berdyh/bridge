/**
 * The stub stand-in for the bundled claude adapter. A contained session runs only an adapter that passes the
 * runner's pin check (`containment/claude.ts`): the adapter package at the measured version, the SDK it finds, the
 * platform package that SDK finds and the sha256 of the claude binary in it. This builds that layout around the stub
 * agent, in a machine's scratch root:
 *
 *   <root>/stub-install/node_modules/@agentclientprotocol/claude-agent-acp/   package.json (version as given), dist/index.js
 *   <root>/stub-install/node_modules/.bin/claude-agent-acp                      a pnpm-style bin script
 *   <root>/stub-install/node_modules/@anthropic-ai/claude-agent-sdk -> the real SDK of the CLI's adapter
 *   <root>/stub-install/codex-acp                                               the same stub, playing codex
 *
 * The SDK link makes the platform package and the binary the real measured ones, so the hash check is the real one;
 * the binary is hashed, never run (the stub does not start it). The adapter entry is the stub: what runs is
 * `<runner node> <entry>`, with the contained env and cwd the runner chose.
 */
import { chmod, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STUB_AGENT = path.join(here, "containment-stub-agent.mjs");
const ADAPTER = "@agentclientprotocol/claude-agent-acp";
const SDK = "@anthropic-ai/claude-agent-sdk";

/** The measured adapter version (`MEASURED_CLAUDE_STACK.adapter`). */
export const MEASURED_ADAPTER_VERSION = "0.94.0";

/** The package root of `@berdyh/bridge` (the CLI), from its resolved entry. */
export function cliPackageDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.resolve("@berdyh/bridge")));
  while (!existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
  return dir;
}

/** Node's lookup of `name` from `fromDir`, on real paths (as the pin check does it). */
async function findPackage(name: string, fromDir: string): Promise<string> {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", ...name.split("/"));
      if (existsSync(path.join(candidate, "package.json"))) return realpath(candidate);
    }
    if (path.dirname(dir) === dir) throw new Error(`${name} not found from ${fromDir}`);
  }
}

/** The real SDK package the CLI's bundled adapter resolves (its platform package holds the measured binary). */
export async function realClaudeSdkDir(): Promise<string> {
  const adapter = await realpath(path.join(cliPackageDir(), "node_modules", ...ADAPTER.split("/")));
  return findPackage(SDK, adapter);
}

/** The CLI's real bundled adapter entry and the measured claude binary it runs. */
export async function realClaudeStack(): Promise<{ adapterEntry: string; binary: string }> {
  const adapter = await realpath(path.join(cliPackageDir(), "node_modules", ...ADAPTER.split("/")));
  const bin = (JSON.parse(await readFile(path.join(adapter, "package.json"), "utf8")) as { bin: Record<string, string> }).bin["claude-agent-acp"]!;
  const platform = await findPackage("@anthropic-ai/claude-agent-sdk-linux-x64", await findPackage(SDK, adapter));
  return { adapterEntry: await realpath(path.join(adapter, bin)), binary: await realpath(path.join(platform, "claude")) };
}

export interface StubStack {
  /** The claude adapter command to hand the CLI as `{ command, source: "bundled" }`. */
  claudeBin: string;
  /** The codex adapter command (the same stub, role codex; codex has no containment profile). */
  codexBin: string;
  /** The adapter's package.json: rewrite its version to move the stack off the pin. */
  adapterPackageJson: string;
  /** Where every stub process writes its unique record (`spawn-<uuid>.json`) and reads `behaviour.json`. */
  records: string;
}

const entryOf = (records: string, role: string): string =>
  `globalThis.__CONTAINMENT_STUB__ = ${JSON.stringify({ records, role })};\nawait import(${JSON.stringify(pathToFileURL(STUB_AGENT).href)});\n`;

export async function buildStubStack(root: string, options: { adapterVersion?: string } = {}): Promise<StubStack> {
  const install = path.join(root, "stub-install");
  const records = path.join(root, "stub-records");
  const adapterDir = path.join(install, "node_modules", ...ADAPTER.split("/"));
  await mkdir(path.join(adapterDir, "dist"), { recursive: true });
  await mkdir(records, { recursive: true });
  const adapterPackageJson = path.join(adapterDir, "package.json");
  await writeFile(adapterPackageJson, JSON.stringify({ name: ADAPTER, version: options.adapterVersion ?? MEASURED_ADAPTER_VERSION, type: "module", bin: { "claude-agent-acp": "dist/index.js" } }));
  const entry = path.join(adapterDir, "dist", "index.js");
  await writeFile(entry, entryOf(records, "claude"));
  await mkdir(path.join(install, "node_modules", ".bin"), { recursive: true });
  const claudeBin = path.join(install, "node_modules", ".bin", "claude-agent-acp");
  await writeFile(claudeBin, `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`);
  await chmod(claudeBin, 0o755);
  await mkdir(path.join(install, "node_modules", "@anthropic-ai"), { recursive: true });
  await symlink(await realClaudeSdkDir(), path.join(install, "node_modules", ...SDK.split("/")));
  const codexEntry = path.join(install, "codex-entry.mjs");
  await writeFile(codexEntry, entryOf(records, "codex"));
  const codexBin = path.join(install, "codex-acp");
  await writeFile(codexBin, `#!/bin/sh\nexec "${process.execPath}" "${codexEntry}" "$@"\n`);
  await chmod(codexBin, 0o755);
  return { claudeBin, codexBin, adapterPackageJson, records };
}

/** Sets the stub adapter's package version (the pin is decided again at every spawn). */
export async function setAdapterVersion(stack: StubStack, version: string): Promise<void> {
  const json = JSON.parse(await readFile(stack.adapterPackageJson, "utf8")) as Record<string, unknown>;
  await writeFile(stack.adapterPackageJson, JSON.stringify({ ...json, version }));
}
