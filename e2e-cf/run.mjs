import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scratchRoot } from "./scratch.mjs";

// Execute already-installed tools directly; never install or invoke nested pnpm.
const require = createRequire(new URL("../package.json", import.meta.url));
const command = process.argv[2];
const tools = {
  typecheck: ["typescript", "bin/tsc", ["-p", "tsconfig.json"]],
  test: ["vitest", "vitest.mjs", ["run", "--config", "vitest.config.ts"]],
};
if (!Object.hasOwn(tools, command)) throw new Error("Usage: node e2e-cf/run.mjs <test|typecheck>");
const [tool, relative, ...runs] = tools[command];
let binary;
try { binary = path.join(path.dirname(require.resolve(`${tool}/package.json`)), relative); }
catch { throw new Error(`Missing preinstalled ${tool}; restore this clone's dependencies offline before running the harness.`); }
async function run(args) {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [binary, ...args, ...process.argv.slice(3)], {
      cwd: fileURLToPath(new URL("./", import.meta.url)), stdio: "inherit", env: process.env,
    });
    child.on("error", (error) => { console.error(error); resolve(1); });
    child.on("exit", (code) => resolve(code ?? 1));
  });
  if (result !== 0) process.exitCode = result;
  return result;
}
for (const args of runs) {
  if (await run(args) !== 0) break;
}
if (command === "typecheck" && !process.exitCode) {
  // Check dependency implementations with browser/Node types, then expose only
  // declarations to the Worker. Never write builds into another task's package.
  const root = fileURLToPath(new URL("../", import.meta.url));
  const runtime = scratchRoot();
  await mkdir(runtime, { recursive: true });
  const dir = await mkdtemp(path.join(runtime, "typecheck-"));
  const source = (name) => path.join(root, `packages/${name}/src/index.ts`);
  const declarations = (name) => path.join(dir, `types/${name}/src/index.d.ts`);
  const dependencyConfig = path.join(dir, "dependencies.json");
  const workerConfig = path.join(dir, "worker.json");
  try {
    await writeFile(dependencyConfig, JSON.stringify({
      extends: path.join(root, "tsconfig.base.json"),
      compilerOptions: {
        lib: ["ES2023", "DOM"], noEmit: false, emitDeclarationOnly: true,
        rootDir: path.join(root, "packages"), outDir: path.join(dir, "types"),
        paths: { "@berdyh/bridge-protocol": [source("protocol")] },
      },
      files: [source("protocol"), source("server")],
    }));
    await writeFile(workerConfig, JSON.stringify({
      extends: path.join(root, "packages/server-cf/example/tsconfig.json"),
      compilerOptions: { types: ["node", path.join(root, "packages/server-cf/node_modules/@cloudflare/workers-types")], paths: {
        "@berdyh/bridge-server-cf": [source("server-cf")],
        "@berdyh/bridge-server-d1": [source("server-d1")],
        "@berdyh/bridge-server": [declarations("server")],
        "@berdyh/bridge-protocol": [declarations("protocol")],
      } },
    }));
    if (await run(["-p", dependencyConfig]) === 0) await run(["-p", workerConfig]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
