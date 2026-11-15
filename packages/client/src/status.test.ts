import { describe, expect, it, vi } from "vitest";
import { deriveStatus } from "./status.js";

describe("deriveStatus", () => {
  it("derives the four states without looking up offline or missing runners", async () => {
    const isEnrolled = vi.fn(async () => false);
    expect(await deriveStatus({ runners: [], isEnrolled })).toEqual({ state: "no_runner" });
    const runner = { runnerId: "r1", online: false, hostname: "laptop" };
    expect(await deriveStatus({ runners: [runner], isEnrolled })).toEqual({ state: "runner_offline", runner });
    expect(isEnrolled).not.toHaveBeenCalled();
    runner.online = true;
    expect(await deriveStatus({ runners: [runner], isEnrolled })).toEqual({ state: "online_not_enrolled", runner });
    isEnrolled.mockResolvedValue(true);
    expect(await deriveStatus({ runners: [runner], isEnrolled })).toEqual({ state: "ready", runner });
    expect(isEnrolled).toHaveBeenLastCalledWith("r1");
  });

  it("selects the only online runner even when another known runner is offline", async () => {
    const input = { runners: [{ runnerId: "r1", online: false }, { runnerId: "r2", online: true }], isEnrolled: async () => true };
    expect(await deriveStatus(input)).toEqual({ state: "ready", runner: input.runners[1] });
    expect((await deriveStatus({ ...input, runnerId: "r1" })).state).toBe("runner_offline");
    expect((await deriveStatus({ ...input, runnerId: "r2" })).state).toBe("ready");
    expect(await deriveStatus({ ...input, runnerId: "unknown" })).toEqual({ state: "no_runner" });
  });

  it("reports ambiguity only for several online runners", async () => {
    const isEnrolled = vi.fn(async () => true);
    const runners = [{ runnerId: "r1", online: true }, { runnerId: "r2", online: true }];
    expect(await deriveStatus({ runners, isEnrolled })).toEqual({ state: "runner_selection_required" });
    expect(isEnrolled).not.toHaveBeenCalled();
  });

  it("prefers the most recent offline runner over asking for a pick", async () => {
    const runners = [{ runnerId: "new", online: false }, { runnerId: "old", online: false }];
    expect(await deriveStatus({ runners, isEnrolled: async () => true })).toEqual({ state: "runner_offline", runner: runners[0] });
  });
});
