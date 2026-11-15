import { chmod } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MEASURED_ADAPTER_VERSION, setAdapterVersion } from "./containment-stack.js";
import { ContainedWorld, PLUGIN_ID, containedRequest } from "./containment-world.js";

const linuxX64 = process.platform === "linux" && process.arch === "x64";
const GENERIC = "Contained session unavailable";

// A plugin whose contained session is refused because the claude adapter is not
// installed sees -32016 with a fixed reason code and the install hint; every other refusal has no data.
describe.skipIf(!linuxX64)("the reason a contained session is refused for a missing claude adapter reaches the plugin", () => {
  let world: ContainedWorld;
  const contained = (over: Record<string, unknown> = {}) => containedRequest({ secret: "not-the-canary", ...over });

  beforeAll(async () => {
    world = await ContainedWorld.create({ e2ee: false });
  }, 120_000);
  afterAll(async () => {
    await world?.dispose();
  });

  it("a runner with no claude adapter: the plugin sees -32016, the generic message, the reason adapter_missing and the install hint, and nothing is spawned", async () => {
    // The adapter is looked up again at every session: a bin that is not executable is an adapter that is not installed.
    await chmod(world.stack.claudeBin, 0o644);
    try {
      const report = await world.run(contained());
      expect(report).toMatchObject({
        started: false,
        error: { code: -32016, message: GENERIC, data: { reason: "adapter_missing", hint: "bridge agent install claude" } },
      });
      expect(Object.keys(report.error!.data as object).sort()).toEqual(["hint", "reason"]);
      expect(report.spawned).toEqual([]);
      // Nothing of this machine rides along: no path, no exit code, no output.
      expect(JSON.stringify(report.error)).not.toContain(world.machine.root);
    } finally {
      await chmod(world.stack.claudeBin, 0o755);
    }
    // With the adapter back the same request starts: the refusal above was the missing adapter.
    expect((await world.run(contained())).started).toBe(true);
  });

  it("every other refusal keeps no data: no containment profile (codex), and an adapter outside the measured version", async () => {
    const codex = await world.run(contained({ agent: "codex" }));
    expect(codex).toMatchObject({ started: false, error: { code: -32016, message: GENERIC } });
    expect(codex.error).not.toHaveProperty("data");
    await setAdapterVersion(world.stack, "0.93.0");
    try {
      const old = await world.run(contained());
      expect(old).toMatchObject({ started: false, error: { code: -32016, message: GENERIC } });
      expect(old.error).not.toHaveProperty("data");
      expect(old.spawned).toEqual([]);
    } finally {
      await setAdapterVersion(world.stack, MEASURED_ADAPTER_VERSION);
    }
  });

  it("a plugin method that lets the refusal propagate fails for its caller with the reason and hint, and for no other refusal with data", async () => {
    const call = (request: Record<string, unknown>) =>
      world.connection.agent.request(`_${PLUGIN_ID}/start`, { request }).then(
        () => undefined,
        (error: unknown) => error as { code: number; message: string; data?: unknown },
      );
    await chmod(world.stack.claudeBin, 0o644);
    try {
      const refused = await call(contained());
      expect(refused).toMatchObject({ code: -32016, message: GENERIC, data: { reason: "adapter_missing", hint: "bridge agent install claude" } });
      expect(Object.keys(refused!.data as object).sort()).toEqual(["hint", "reason"]);
      expect(JSON.stringify(refused)).not.toContain(world.machine.root);
    } finally {
      await chmod(world.stack.claudeBin, 0o755);
    }
    // Another refusal keeps no data for the caller of the method either.
    const codex = await call(contained({ agent: "codex" }));
    expect(codex).toMatchObject({ code: -32016, message: GENERIC });
    expect(codex).not.toHaveProperty("data", expect.anything());
  });
});
