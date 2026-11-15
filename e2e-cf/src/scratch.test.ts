import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scratchRoot, underSystemTmp } from "../scratch.mjs";

describe("scratch space of the wrangler harness", () => {
  const cache = path.join(os.homedir(), ".cache", "bridge-e2e", "e2e-cf");

  it("is never /tmp, even when TMPDIR is unset or points there, and never inside the package", () => {
    for (const tmp of [undefined, "/tmp", "/tmp/claude-1000/x", "/var/tmp"]) {
      expect(scratchRoot(tmp === undefined ? {} : { TMPDIR: tmp })).toBe(cache);
    }
    expect(underSystemTmp(scratchRoot({}))).toBe(false);
    expect(scratchRoot({})).not.toContain(`${path.sep}.runtime`);
  });

  it("uses a subfolder of the run's disk TMPDIR when it has one", () => {
    const tmp = path.join(os.homedir(), ".cache", "bridge-e2e", "e2e-cf-test-tmp");
    try {
      expect(scratchRoot({ TMPDIR: tmp })).toBe(path.join(tmp, "e2e-cf"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
