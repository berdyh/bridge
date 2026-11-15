import { describe, expect, it } from "vitest";
import { isSessionQuiescence } from "./plugin.js";

describe("quiescence receipt wire guards", () => {
  it("accepts the supported namespace witness and fixed incomplete reasons", () => {
    expect(isSessionQuiescence({ status: "quiescent", mechanism: "linux-pid-namespace" })).toBe(true);
    expect(isSessionQuiescence({ status: "incomplete", mechanism: "unknown", reason: "disconnected" })).toBe(true);
  });
  it.each([null, [], { status: "quiescent" }, { status: "quiescent", mechanism: "process-group" }, { status: "group-empty", mechanism: "process-group" }, { status: "quiescent", mechanism: "linux-pid-namespace", diagnostic: "untrusted detail" }, { status: "incomplete", mechanism: "unknown", reason: "arbitrary text" }])("rejects a malformed receipt (%j)", (receipt) => {
    expect(isSessionQuiescence(receipt)).toBe(false);
  });
});
