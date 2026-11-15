// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresenceBody } from "@berdyh/bridge-protocol";
import type { BridgeStatus, PermissionPromptOptions, SetupInstructionsOptions } from "../contracts.js";
import { permissionPrompt } from "../permission.js";
import { defineElements, type SetupClient } from "./index.js";
import { wordsOf } from "@berdyh/bridge-protocol";

type PermissionElement = HTMLElement & { mount: NonNullable<PermissionPromptOptions["mount"]> };
type SetupElement = HTMLElement & { client?: SetupClient; instructions: (options: SetupInstructionsOptions) => import("../contracts.js").SetupInstructions };
const request = {
  sessionId: "session", toolCall: { toolCallId: "tool", title: "<img src=x onerror=alert(1)>", kind: "execute" as const, locations: [{ path: "<script>bad</script>", line: 2 }], rawInput: { html: "<button>Allow</button>" } },
  options: [{ optionId: "yes", kind: "allow_once" as const, name: "<b>Allow</b>" }, { optionId: "no", kind: "reject_once" as const, name: "Deny" }],
};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const part = (el: HTMLElement, name: string) => el.shadowRoot!.querySelector<HTMLElement>(`[part="${name}"]`)!;

beforeEach(() => defineElements());
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("bridge-permission", () => {
  beforeEach(() => { vi.spyOn(performance, "now").mockReturnValue(0); });
  const arm = (time = 500) => vi.mocked(performance.now).mockReturnValue(time);
  function create() {
    const el = document.createElement("bridge-permission") as PermissionElement;
    document.body.append(el); return el;
  }
  it("registers idempotently, renders untrusted values as text, and allows only on a click", async () => {
    expect(() => defineElements()).not.toThrow();
    const el = create();
    let settled = false;
    const pending = permissionPrompt({ mount: el.mount })({ params: request }).then((result) => { settled = true; return result; });
    await flush(); expect(settled).toBe(false);
    expect(part(el, "title").textContent).toBe(request.toolCall.title);
    expect(part(el, "location").textContent).toBe("<script>bad</script>:2");
    expect(part(el, "raw-input").textContent).toContain("<button>Allow</button>");
    expect(el.shadowRoot!.querySelector("img, script, b")).toBeNull();
    expect(el.shadowRoot!.activeElement).toBe(part(el, "prompt"));
    arm();
    part(el, "allow").click();
    expect(await pending).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    expect(el.shadowRoot!.childNodes).toHaveLength(0);
  });
  it.each(["deny", "dismiss", "escape", "disconnect"])("denies on %s", async (action) => {
    const el = create();
    const pending = permissionPrompt({ mount: el.mount })({ params: request });
    if (action === "escape") part(el, "prompt").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else if (action === "disconnect") el.remove();
    else part(el, action).click();
    expect(await pending).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
  });
  it("denies an unconnected element and keeps concurrent prompts independent", async () => {
    const detached = document.createElement("bridge-permission") as PermissionElement;
    expect(await permissionPrompt({ mount: detached.mount })({ params: request })).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    const el = create();
    const handler = permissionPrompt({ mount: el.mount });
    const first = handler({ params: request });
    const second = handler({ params: { ...request, sessionId: "second" } });
    expect(el.shadowRoot!.querySelectorAll('[part="prompt"]')).toHaveLength(1);
    arm();
    part(el, "allow").click(); el.remove();
    expect(await first).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    expect(await second).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
  });
  it("requires a fresh deliberate click after a queued prompt becomes visible", async () => {
    const el = create();
    const handler = permissionPrompt({ mount: el.mount });
    const first = handler({ params: request });
    const answerSecond = vi.fn();
    const second = handler({ params: { ...request, sessionId: "second", toolCall: { ...request.toolCall, title: "Second request" } } }).then(answerSecond);
    const firstAllow = part(el, "allow");
    firstAllow.click();
    arm(499); firstAllow.click();
    expect(part(el, "allow")).toBe(firstAllow);
    arm(); firstAllow.click();
    expect(await first).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    expect(part(el, "title").textContent).toBe("Second request");
    expect(el.shadowRoot!.activeElement).toBe(part(el, "prompt"));
    const secondAllow = part(el, "allow");
    secondAllow.click();
    arm(999); secondAllow.click();
    await flush(); expect(answerSecond).not.toHaveBeenCalled();
    arm(1000);
    secondAllow.dispatchEvent(new MouseEvent("click", { detail: 2, bubbles: true }));
    firstAllow.click();
    await flush(); expect(answerSecond).not.toHaveBeenCalled();
    secondAllow.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    await second;
    expect(answerSecond).toHaveBeenCalledExactlyOnceWith({ outcome: { outcome: "selected", optionId: "yes" } });
    expect(el.shadowRoot!.childNodes).toHaveLength(0);
  });
  it("cancels queued requests without showing them and arms the next prompt after cancellation", async () => {
    const el = create();
    const handler = permissionPrompt({ mount: el.mount });
    const firstController = new AbortController();
    const queuedController = new AbortController();
    const first = handler({ params: request, signal: firstController.signal });
    const queued = handler({ params: request, signal: queuedController.signal });
    const last = handler({ params: request });
    const firstPanel = part(el, "prompt");
    queuedController.abort();
    expect(part(el, "prompt")).toBe(firstPanel);
    arm(); firstController.abort();
    part(el, "allow").click();
    expect(el.shadowRoot!.querySelectorAll('[part="prompt"]')).toHaveLength(1);
    arm(1000); part(el, "allow").click();
    expect(await first).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(await queued).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(await last).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    expect(el.shadowRoot!.childNodes).toHaveLength(0);
  });
  it("removes the UI when cancelled or timed out and cannot answer via stale buttons", async () => {
    const el = create(); const controller = new AbortController();
    const pending = permissionPrompt({ mount: el.mount })({ params: request, signal: controller.signal });
    const allow = part(el, "allow"); controller.abort(); allow.click();
    expect(await pending).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(el.shadowRoot!.childNodes).toHaveLength(0);
    expect(await permissionPrompt({ mount: el.mount, timeoutMs: 0 })({ params: request })).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(el.shadowRoot!.childNodes).toHaveLength(0);
  });
});

function fixture(state: BridgeStatus["state"], withLink = false) {
  const runner = { runnerId: "runner", online: true, hostname: "<b>Workstation</b>" };
  let notify!: (status: BridgeStatus) => void;
  const unsubscribe = vi.fn();
  const client: SetupClient = {
    status: vi.fn(async () => ({ state, runner })),
    onStatus: vi.fn((handler) => { notify = handler; return unsubscribe; }),
    runners: () => [runner],
    consumeEnrollLink: vi.fn(() => withLink ? { code: "ABCDEFGH", runnerId: "runner" } : undefined),
    enroll: vi.fn(async (_code, _runnerId, options) => {
      options?.onBrowserKey?.("browser-key");
      return { runnerId: "runner", browserKeyId: "browser-key", enrolledAt: "now" };
    }),
  };
  const instructions = vi.fn((options: SetupInstructionsOptions) => ({ flavor: options.flavor, oneLiner: "bridge setup https://app.example", steps: [], agentPrompt: "<script>Agent instructions</script>", troubleshooting: [] }));
  const el = document.createElement("bridge-setup") as SetupElement;
  el.setAttribute("app-url", "https://app.example"); el.setAttribute("app-name", "Example");
  el.instructions = instructions; el.client = client; document.body.append(el);
  return { el, client, instructions, unsubscribe, notify: (next: BridgeStatus) => notify(next), runner };
}

const el_options = (el: HTMLElement) => [...el.shadowRoot!.querySelectorAll('[part="runner-option"]')].map((o) => o.textContent);

describe("bridge-setup", () => {
  it.each(["no_runner", "runner_offline", "online_not_enrolled", "ready"] as const)("shows the %s panel", async (state) => {
    const { el, instructions } = fixture(state); await flush();
    expect(part(el, "panel").getAttribute("data-state")).toBe(state);
    expect(!!part(el, "one-liner")).toBe(state === "no_runner" || state === "runner_offline");
    expect(!!part(el, "restart")).toBe(state === "runner_offline");
    if (state !== "ready") {
      expect(part(el, "agent").tagName).toBe("DETAILS");
      expect(part(el, "agent-prompt").textContent).toBe("<script>Agent instructions</script>");
      expect(el.shadowRoot!.querySelector("script")).toBeNull();
      expect(instructions).toHaveBeenCalledWith({ appUrl: "https://app.example", appName: "Example", platform: "linux", flavor: "human" });
    }
  });
  it("lists online runners when several are online and picks one with status(runnerId)", async () => {
    const a = { runnerId: "a", online: true, hostname: "<b>Laptop</b>" };
    const b = { runnerId: "b", online: true };
    const off = { runnerId: "c", online: false, hostname: "Old" };
    const { el, client } = fixture("runner_selection_required");
    client.runners = () => [a, off, b];
    vi.mocked(client.status).mockImplementation(async (id?: string) => id ? { state: "ready", runner: id === "a" ? a : b } : { state: "runner_selection_required" });
    el.setAttribute("platform", "darwin"); await flush();
    expect(part(el, "status").textContent).toBe("Choose a runner");
    expect(part(el, "panel").getAttribute("data-state")).toBe("runner_selection_required");
    expect(part(el, "runner-picker").getAttribute("role")).toBe("group");
    expect(part(el, "one-liner")).toBeNull(); expect(part(el, "agent")).toBeNull();
    const options = [...el.shadowRoot!.querySelectorAll<HTMLElement>('[part="runner-option"]')];
    expect(options.map((o) => o.textContent)).toEqual(["<b>Laptop</b>", "b"]);
    expect(el.shadowRoot!.querySelector("b")).toBeNull();
    expect(client.status).not.toHaveBeenCalledWith("a");
    options[0]!.dispatchEvent(new MouseEvent("click", { detail: 2 })); await flush();
    expect(client.status).not.toHaveBeenCalledWith("a");
    options[0]!.click(); await flush();
    expect(client.status).toHaveBeenCalledWith("a");
    expect(part(el, "status").textContent).toBe("Ready");
    expect(part(el, "runner-picker")).toBeNull();
  });
  /** A fake whose onStatus honours the runner scope the way BridgeClient does. */
  function scopedFake(link?: string, initial: Record<string, BridgeStatus> = {}) {
    const handlers = new Map<string | undefined, (s: BridgeStatus) => void>();
    const runnerHandlers = new Set<() => void>();
    let runners: PresenceBody[] = [{ runnerId: "A", online: true, hostname: "alpha" }, { runnerId: "B", online: true, hostname: "beta" }];
    const statuses = new Map<string | undefined, BridgeStatus>(Object.entries(initial));
    const client: SetupClient = {
      status: vi.fn(async (id?: string): Promise<BridgeStatus> => statuses.get(id) ?? { state: "runner_selection_required" }),
      onStatus: vi.fn((handler, id) => { handlers.set(id, handler); return () => { if (handlers.get(id) === handler) handlers.delete(id); }; }),
      onRunners: vi.fn((handler) => { runnerHandlers.add(() => handler(runners)); return () => {}; }),
      runners: () => runners,
      consumeEnrollLink: () => link ? { code: "ABCDEFGH", runnerId: link } : undefined,
    };
    const el = document.createElement("bridge-setup") as SetupElement;
    el.client = client; document.body.append(el);
    return { el, client, handlers, statuses, setRunners(next: typeof runners) { runners = next; runnerHandlers.forEach((h) => h()); } };
  }
  it("shows a runner that comes online while the picker is open", async () => {
    const f = scopedFake(); await flush();
    expect(el_options(f.el)).toEqual(["alpha", "beta"]);
    f.setRunners([...f.client.runners(), { runnerId: "C", online: true, hostname: "gamma" }]);
    expect(el_options(f.el)).toEqual(["alpha", "beta", "gamma"]);
  });
  it("follows the picked runner's own status, not the default summary", async () => {
    const f = scopedFake(undefined, { A: { state: "ready" } }); await flush();
    part(f.el, "runner-option").click(); await flush();
    expect(part(f.el, "status").textContent).toBe("Ready");
    expect(f.client.onStatus).toHaveBeenLastCalledWith(expect.any(Function), "A");
    f.handlers.get("A")!({ state: "online_not_enrolled" });
    expect(part(f.el, "status").textContent).toBe("Pair this browser");
    expect(f.handlers.has(undefined)).toBe(false); // the default summary is no longer followed
  });
  it("keeps the enrollment link's runner as the status target over default notifications", async () => {
    const f = scopedFake("A", { A: { state: "runner_offline", runner: { runnerId: "A", online: false } } }); await flush();
    expect(f.client.onStatus).toHaveBeenCalledWith(expect.any(Function), "A");
    expect(f.client.onStatus).not.toHaveBeenCalledWith(expect.any(Function), undefined);
    expect(part(f.el, "panel").getAttribute("data-state")).toBe("runner_offline");
    f.handlers.get(undefined)?.({ state: "ready", runner: { runnerId: "B", online: true } }); // never subscribed
    expect(part(f.el, "panel").getAttribute("data-state")).toBe("runner_offline");
  });
  it("reports a failed pick without leaving the picker", async () => {
    const { el, client } = fixture("runner_selection_required"); await flush();
    vi.mocked(client.status).mockRejectedValue(new Error("private"));
    part(el, "runner-option").click(); await flush();
    expect(part(el, "error").textContent).toBe("Unable to read runner status.");
    expect((part(el, "runner-option") as HTMLButtonElement).disabled).toBe(false);
  });
  it("copies the exact command and offers Linux restart only", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { el } = fixture("runner_offline"); await flush();
    expect(part(el, "restart").getAttribute("href")).toBe("bridge://run");
    part(el, "copy").click(); await flush();
    expect(writeText).toHaveBeenCalledWith("bridge setup https://app.example");
    el.setAttribute("platform", "darwin"); expect(part(el, "restart")).toBeNull();
  });
  it("pairs only on click, shows the matching hostname as text and four browser-key words", async () => {
    const { el, client } = fixture("online_not_enrolled", true); await flush();
    expect(client.enroll).not.toHaveBeenCalled();
    expect(part(el, "pair").textContent).toBe("Pair with <b>Workstation</b>");
    expect(el.shadowRoot!.querySelector("b")).toBeNull();
    let finish!: () => void;
    client.enroll = vi.fn(async (_code, _runner, options) => {
      options?.onBrowserKey?.("browser-key");
      await new Promise<void>((resolve) => { finish = resolve; });
      return { runnerId: "runner", browserKeyId: "browser-key", enrolledAt: "now" };
    });
    part(el, "pair").click();
    expect(client.enroll).toHaveBeenCalledWith("ABCDEFGH", "runner", expect.objectContaining({ onBrowserKey: expect.any(Function) }));
    expect(part(el, "words").textContent).toBe(wordsOf("browser-key").join(" "));
    expect((part(el, "pair") as HTMLButtonElement).disabled).toBe(true);
    finish(); await flush(); expect(part(el, "pair")).toBeNull();
  });
  it("uses generic pairing copy without a hostname and handles enrollment failure", async () => {
    const { el, client, runner } = fixture("online_not_enrolled", true);
    runner.hostname = ""; client.enroll = vi.fn(async () => { throw Error("private failure"); });
    await flush(); expect(part(el, "pair").textContent).toBe("Pair this browser");
    part(el, "pair").click(); await flush();
    expect(part(el, "error").textContent).toContain("Pairing failed");
    expect((part(el, "pair") as HTMLButtonElement).disabled).toBe(false);
  });
  it("subscribes, unsubscribes, reconnects, and ignores stale status results", async () => {
    const f = fixture("no_runner"); await flush();
    f.notify({ state: "ready" }); expect(part(f.el, "status").textContent).toBe("Ready");
    f.el.remove(); expect(f.unsubscribe).toHaveBeenCalledOnce();
    f.notify({ state: "runner_offline" }); expect(part(f.el, "status").textContent).toBe("Ready");
    document.body.append(f.el); await flush(); expect(f.client.onStatus).toHaveBeenCalledTimes(2);
    const replacement = fixture("ready");
    f.el.client = replacement.client; await flush();
    f.notify({ state: "no_runner" }); expect(part(f.el, "status").textContent).toBe("Ready");
  });
  it("ignores the old enrollment status after replacing its client", async () => {
    const f = fixture("online_not_enrolled", true); await flush();
    let resolveStatus!: (status: BridgeStatus) => void;
    f.client.status = vi.fn(() => new Promise<BridgeStatus>((resolve) => { resolveStatus = resolve; }));
    part(f.el, "pair").click(); await flush();
    const replacement = fixture("ready");
    f.el.client = replacement.client; await flush();
    resolveStatus({ state: "runner_offline" }); await flush();
    expect(part(f.el, "status").textContent).toBe("Ready");
  });
  it("recovers from disconnection during enrollment and ignores its stale callback", async () => {
    const f = fixture("online_not_enrolled", true); await flush();
    let onKey!: (key: string) => void;
    let finish!: () => void;
    f.client.enroll = vi.fn(async (_code, _runner, options) => {
      onKey = options!.onBrowserKey!;
      await new Promise<void>((resolve) => { finish = resolve; });
      return { runnerId: "runner", browserKeyId: "old-key", enrolledAt: "now" };
    });
    part(f.el, "pair").click(); f.el.remove(); document.body.append(f.el); await flush();
    onKey("old-key"); finish(); await flush();
    expect(part(f.el, "words")).toBeNull();
    expect((part(f.el, "pair") as HTMLButtonElement).disabled).toBe(false);
  });
  it("does not let initial status overwrite a newer notification", async () => {
    const f = fixture("no_runner");
    f.notify({ state: "ready" }); await flush();
    expect(part(f.el, "status").textContent).toBe("Ready");
  });
});
