import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { Machine, track } from "./machine.js";
import { scratchRoot, underSystemTmp } from "./scratch.js";

describe("track", () => {
  it("reports an early exit immediately instead of timing out", async () => {
    const proc = track(spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "pipe" }));
    const started = Date.now();
    await expect(proc.waitFor(/never appears/, { timeoutMs: 20_000 })).rejects.toThrow(/process exited before/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("scratch space", () => {
  const keep = process.env.TMPDIR;
  afterEach(() => {
    if (keep === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = keep;
  });

  it("is never /tmp, even when TMPDIR is unset or points there", () => {
    const cache = path.join(os.homedir(), ".cache", "bridge-e2e", "e2e");
    for (const tmp of [undefined, "/tmp", "/tmp/claude-1000/x", "/var/tmp"]) {
      expect(scratchRoot({ ...(tmp === undefined ? {} : { TMPDIR: tmp }) })).toBe(cache);
    }
    expect(underSystemTmp(scratchRoot({}))).toBe(false);
  });

  it("uses the run's disk TMPDIR when it has one", () => {
    const tmp = path.join(os.homedir(), ".cache", "bridge-e2e", "e2e-test-tmp");
    try {
      expect(scratchRoot({ TMPDIR: tmp })).toBe(tmp);
    } finally {
      // scratchRoot creates the folder: leave nothing behind.
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("puts a machine, and what its children get as TMPDIR, off /tmp when TMPDIR says /tmp", async () => {
    process.env.TMPDIR = "/tmp";
    const machine = await Machine.create();
    try {
      expect(underSystemTmp(machine.root)).toBe(false);
      expect(underSystemTmp(machine.env().TMPDIR!)).toBe(false);
    } finally {
      await machine.dispose();
    }
  });
});

describe("Machine decoys and snapshots", () => {
  it("the agents' own dirs are decoys the children see through the environment, and a snapshot notices a change", async () => {
    const machine = await Machine.create();
    try {
      expect(machine.env().CLAUDE_CONFIG_DIR).toBe(machine.decoys.claudeConfigDir);
      expect(machine.env().CODEX_HOME).toBe(machine.decoys.codexHomeDir);
      const before = await machine.protectedSnapshot();
      expect(Object.keys(before).length).toBeGreaterThan(8);
      expect(await machine.protectedSnapshot()).toEqual(before);
      await writeFile(path.join(machine.decoys.codexHome, "new.txt"), "x");
      expect(await machine.protectedSnapshot()).not.toEqual(before);
    } finally {
      await machine.dispose();
    }
  });

  it("a deferred machine holds nothing of bridge's until it is staged", async () => {
    const machine = await Machine.create({ defer: true });
    try {
      expect(Object.keys(await machine.snapshot()).filter((k) => k.includes(`${path.sep}bridge`))).toEqual([]);
      await machine.stageBridgeFiles();
      expect(Object.keys(await machine.snapshot())).toContain(path.relative(machine.root, machine.claudeLogin));
    } finally {
      await machine.dispose();
    }
  });
});
