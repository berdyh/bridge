import { describe, expect, expectTypeOf, it } from "vitest";

import type { ChildLike } from "../agent/types.js";
import { boundedCleanup, cleanupDeadlineMs, type ProcessCleanupResult, type RawProcessCleanupResult } from "./cleanup.js";
import type { AcpAgentAdapterOptions } from "./adapters.js";
import type { AgentProcess } from "./contracts.js";
import type { RawAgentProcess } from "./process.js";

describe("public cleanup types (checked by the package typecheck)", () => {
  it("never include the runner-internal group-empty status", () => {
    expectTypeOf<ProcessCleanupResult["status"]>().toEqualTypeOf<"quiescent" | "incomplete">();
    expectTypeOf<Awaited<ReturnType<NonNullable<AgentProcess["cleanup"]>>>>().toEqualTypeOf<ProcessCleanupResult>();
    expectTypeOf<Awaited<ReturnType<NonNullable<ChildLike["cleanup"]>>>>().toEqualTypeOf<ProcessCleanupResult>();
    // A host that handles quiescent and incomplete exhaustively keeps compiling.
    const exhaustive = (r: ProcessCleanupResult): string => {
      switch (r.status) {
        case "quiescent": return r.mechanism;
        case "incomplete": return r.reason;
        default: { const never: never = r; return never; }
      }
    };
    // @ts-expect-error group-empty is not a public receipt
    const leaked: ProcessCleanupResult = { status: "group-empty", mechanism: "process-group" };
    expect(exhaustive({ status: "quiescent", mechanism: "linux-pid-namespace" })).toBe("linux-pid-namespace");
    expect(leaked.status).toBe("group-empty");
  });

  it("keeps the internal status on the raw process only, and out of the package barrel", () => {
    expectTypeOf<Extract<RawProcessCleanupResult, { status: "group-empty" }>>().not.toBeNever();
    expectTypeOf<Awaited<ReturnType<NonNullable<RawAgentProcess["cleanup"]>>>>().toEqualTypeOf<RawProcessCleanupResult>();
    // @ts-expect-error the raw process is not an AgentProcess
    const publicProcess: AgentProcess = {} as RawAgentProcess;
    expect(publicProcess).toBeDefined();
    // The exported adapter option's callback returns the public result type, so it cannot carry group-empty.
    type SpawnSeam = NonNullable<AcpAgentAdapterOptions["spawnProcess"]>;
    type BarrelSeam = NonNullable<import("../index.js").AcpAgentAdapterOptions["spawnProcess"]>;
    expectTypeOf<SpawnSeam>().returns.resolves.toEqualTypeOf<AgentProcess>();
    expectTypeOf<BarrelSeam>().returns.resolves.toEqualTypeOf<AgentProcess>();
    type SeamProcess = Awaited<ReturnType<BarrelSeam>>;
    type SeamCleanup = Awaited<ReturnType<NonNullable<SeamProcess["cleanup"]>>>;
    expectTypeOf<SeamCleanup["status"]>().toEqualTypeOf<"quiescent" | "incomplete">();
    // @ts-expect-error not exported from the barrel
    type Leaked = import("../index.js").RawProcessCleanupResult;
    // @ts-expect-error not exported from the barrel
    type LeakedProcess = import("../index.js").RawAgentProcess;
    expectTypeOf<[Leaked, LeakedProcess]>().not.toBeNever();
  });
});

describe("bounded cleanup evidence", () => {
  it("does not turn a hung teardown into a quiescence receipt", async () => {
    const started = Date.now();
    await expect(boundedCleanup(() => new Promise<never>(() => undefined), 10, "linux-pid-namespace"))
      .resolves.toEqual({ status: "incomplete", mechanism: "linux-pid-namespace", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("returns an explicit failure when termination throws", async () => {
    await expect(boundedCleanup(async () => { throw new Error("failed"); }, 100, "process-group"))
      .resolves.toEqual({ status: "incomplete", mechanism: "process-group", reason: "termination-failed" });
  });

  it("bounds invalid and excessive deadlines", () => {
    expect(cleanupDeadlineMs(Infinity)).toBe(3_000);
    expect(cleanupDeadlineMs(NaN)).toBe(3_000);
    expect(cleanupDeadlineMs(100_000)).toBe(30_000);
    expect(cleanupDeadlineMs(-1)).toBe(1);
  });
});
