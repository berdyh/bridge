import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_ENTRY_FILE } from "@berdyh/bridge-runner";
import { describe, expect, it } from "vitest";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));

describe("the package entry", () => {
  it("ships bin/run.js, which hands over to dist/main.js, and points bin at it", async () => {
    const pkg = JSON.parse(await readFile(`${pkgDir}package.json`, "utf8")) as { name: string; bin: Record<string, string>; files: string[] };
    expect(pkg.bin).toEqual({ bridge: "bin/run.js", "bridge-runner": "bin/run.js" });
    expect(pkg.files).toEqual(["dist", "bin", "NOTICE"]);
    const run = await readFile(`${pkgDir}bin/run.js`, "utf8");
    expect(run.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(run).toMatch(/^import "\.\.\/dist\/main\.js";$/m);
    expect((await stat(`${pkgDir}bin/run.js`)).mode & 0o111).not.toBe(0);
  });

  it("matches the entry file of an npm-prefix version dir", async () => {
    expect(DEFAULT_ENTRY_FILE).toBe("node_modules/@berdyh/bridge/bin/run.js");
  });
});
