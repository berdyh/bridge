import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { PermissionView } from "./contracts.js";
import { permissionPrompt } from "./permission.js";

const params: RequestPermissionRequest = {
  sessionId: "session", toolCall: { toolCallId: "tool", title: "Run <script>", kind: "execute", locations: [{ path: "/work", line: 3 }], rawInput: { command: "ls" } },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
    { optionId: "always", name: "Always", kind: "allow_always" },
  ],
};
const selected = (optionId = "deny") => ({ outcome: { outcome: "selected", optionId } });

afterEach(() => vi.useRealTimers());
describe("permissionPrompt", () => {
  it("denies without a mount, cancelling if no reject option exists", async () => {
    expect(await permissionPrompt()({ params })).toEqual(selected());
    expect(await permissionPrompt()({ params: { ...params, options: params.options.slice(0, 1) } })).toEqual({ outcome: { outcome: "cancelled" } });
  });
  it("forwards text and single-use options, selecting only a forwarded choice", async () => {
    let view!: PermissionView;
    let answer!: (id: string | null) => void;
    const cleanup = vi.fn();
    const pending = permissionPrompt({ mount: (v, a) => { view = v; answer = a; return cleanup; } })({ params });
    expect(view).toEqual({ sessionId: "session", title: "Run <script>", toolKind: "execute", locations: [{ path: "/work", line: 3 }], rawInput: { command: "ls" }, options: params.options.slice(0, 2) });
    answer("allow"); answer("deny");
    expect(await pending).toEqual(selected("allow"));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it.each([null, "always", "unknown"])("denies dismissal or invalid choice %s", async (id) => {
    expect(await permissionPrompt({ mount: (_, answer) => { answer(id); return () => {}; } })({ params })).toEqual(selected());
  });
  it("does not trust renderer mutations to the choice list", async () => {
    expect(await permissionPrompt({ mount: (view, answer) => {
      view.options.push({ optionId: "forged", name: "Forged", kind: "allow_once" });
      answer("forged"); return () => {};
    } })({ params })).toEqual(selected());
  });
  it("denies on timeout and ignores late clicks", async () => {
    vi.useFakeTimers();
    let answer!: (id: string) => void;
    const cleanup = vi.fn();
    const pending = permissionPrompt({ timeoutMs: 20, mount: (_, a) => { answer = a; return cleanup; } })({ params });
    await vi.advanceTimersByTimeAsync(20);
    answer("allow");
    expect(await pending).toEqual(selected()); expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("denies cancellation before and after mounting, removing listeners", async () => {
    const controller = new AbortController();
    const cleanup = vi.fn();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const mount = vi.fn(() => cleanup);
    const handler = permissionPrompt({ mount });
    const pending = handler({ params, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual(selected()); expect(cleanup).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(await handler({ params, signal: controller.signal })).toEqual(selected());
    expect(mount).toHaveBeenCalledOnce();
  });
  it("cleans up synchronous answers and denies mounting failures", async () => {
    const cleanup = vi.fn();
    expect(await permissionPrompt({ mount: (_, answer) => { answer(null); return cleanup; } })({ params })).toEqual(selected());
    expect(cleanup).toHaveBeenCalledOnce();
    expect(await permissionPrompt({ mount: () => { throw Error("render"); } })({ params })).toEqual(selected());
    expect(await permissionPrompt({ mount: (_, answer) => { answer(null); return () => { throw Error("cleanup"); }; } })({ params })).toEqual(selected());
  });
});
