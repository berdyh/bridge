import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type Harness, exists, harness } from "./testkit.js";

/** A one-shot hook on the atomic writer: lets a test make one write land differently. */
const hook: { onWrite?: (target: string, data: string | Uint8Array) => string | Uint8Array | undefined } = {};

vi.mock("./consent-plan.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./consent-plan.js")>();
  return {
    ...real,
    writeFileAtomically: async (target: string, data: string | Uint8Array, ...rest: [number?, { exactMode?: boolean }?]) => {
      const replaced = hook.onWrite?.(target, data);
      if (replaced !== undefined) hook.onWrite = undefined;
      return real.writeFileAtomically(target, replaced ?? data, ...rest);
    },
  };
});

const { protocolHandlerFiles, runProtocol } = await import("./protocol-handler.js");

let h: Harness;
afterEach(async () => {
  hook.onWrite = undefined;
  await h?.cleanup();
});

describe("bridge protocol install: a failed registration", () => {
  it("never deletes a mimeapps.list it created: the file stays, without our lines, and the desktop entry goes", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    expect(await exists(files.mimeapps)).toBe(false);
    // The mimeapps.list write lands without our entries, so the check after writing fails.
    hook.onWrite = (target) => (target === files.mimeapps ? "[Default Applications]\n" : undefined);
    await expect(runProtocol(["install", "--yes"], h.deps)).rejects.toThrow(/could not register the handler/);
    expect(await exists(files.mimeapps)).toBe(true);
    expect(await readFile(files.mimeapps, "utf8")).not.toContain("bridge");
    expect(await exists(files.desktopFile)).toBe(false);
  });
});
