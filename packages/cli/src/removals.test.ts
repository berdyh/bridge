import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerSrc = path.resolve(here, "../../runner/src");

/** The modules that remove paths for install, uninstall and the service (consent-plan.ts, rule B). */
async function removalModules(): Promise<string[]> {
  const install = (await readdir(path.join(runnerSrc, "install")))
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "remove-bound.ts")
    .map((n) => path.join(runnerSrc, "install", n));
  return [
    ...["self.ts", "uninstall.ts", "service.ts", "protocol-handler.ts", "consent-plan.ts", "apps.ts", "legacy.ts", "layout-rule.ts"].map((n) => path.join(here, n)),
    path.join(runnerSrc, "service.ts"),
    ...install,
  ];
}

describe("every install, uninstall and service removal goes through removeBound", () => {
  it("no removal module imports rm, unlink or rmdir from node:fs, or node:fs as a whole", async () => {
    const offenders: string[] = [];
    for (const file of await removalModules()) {
      const text = await readFile(file, "utf8");
      for (const m of text.matchAll(/import\s+([^;]*?)\s+from\s+"(node:)?fs(\/promises)?"/g)) {
        const what = m[1]!;
        if (/\b(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\b/.test(what) || /\*\s+as\b/.test(what) || /^\s*[A-Za-z_$][\w$]*\s*(,|$)/.test(what)) {
          offenders.push(`${path.relative(path.resolve(here, "../.."), file)}: import ${what.replace(/\s+/g, " ")}`);
        }
      }
      if (/\brequire\(\s*"(node:)?fs/.test(text)) offenders.push(`${file}: require("fs")`);
    }
    expect(offenders).toEqual([]);
  });
});
