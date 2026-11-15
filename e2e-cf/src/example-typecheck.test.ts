import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("typechecks the example against Worker request types and isolated dependency declarations", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../run.mjs", import.meta.url)), "typecheck"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 30_000,
  });
  let output = "";
  child.stdout.on("data", (data) => { output += String(data); });
  child.stderr.on("data", (data) => { output += String(data); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  expect(code, output).toBe(0);
});
