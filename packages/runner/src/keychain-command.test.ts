import { describe, expect, it } from "vitest";
import { keychainCommand } from "./keychain-command.js";

describe("owned keychain command transport (synthetic Node child only)", () => {
  it("passes stdin and preserves a nonzero result without invoking a shell", async () => {
    const r = await keychainCommand(process.execPath, ["-e", 'process.stdin.on("data",b=>process.stdout.write(b));process.stdin.on("end",()=>process.exitCode=7)'], { stdin: "synthetic-value", timeoutMs: 2000 });
    expect(r).toEqual({ exitCode: 7, stdout: "synthetic-value", stderr: "" });
  });
  it("bounds hanging commands and supports cancellation", async () => {
    const args = ["-e", "setInterval(()=>{},1000)"];
    await expect(keychainCommand(process.execPath, args, { timeoutMs: 30 })).rejects.toMatchObject({ code: "ETIMEDOUT" });
    const controller = new AbortController();
    const pending = keychainCommand(process.execPath, args, { timeoutMs: 2000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });
  it("bounds output and emits no child payload in errors", async () => {
    const error: unknown = await keychainCommand(process.execPath, ["-e", 'process.stdout.write("synthetic-private".repeat(100000))'], { timeoutMs: 2000 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "EOUTPUTLIMIT" });
    expect(String(error)).not.toContain("synthetic-private");
  });
});
