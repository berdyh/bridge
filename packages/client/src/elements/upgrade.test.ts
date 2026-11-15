// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { SetupInstructionsOptions } from "../contracts.js";
import { defineElements, type SetupClient } from "./index.js";

it("upgrades setup collaborators assigned before registration, connected or detached", async () => {
  const unsubscribe = vi.fn();
  const client: SetupClient = {
    status: vi.fn(async () => ({ state: "no_runner" as const })),
    onStatus: vi.fn(() => unsubscribe),
    runners: () => [],
    consumeEnrollLink: vi.fn(() => undefined),
  };
  const instructions = vi.fn((options: SetupInstructionsOptions) => ({
    flavor: options.flavor, oneLiner: "custom install command", steps: [],
    agentPrompt: "custom agent instructions", troubleshooting: [],
  }));
  const elements = [true, false].map((connected) => {
    const el = document.createElement("bridge-setup") as HTMLElement & {
      client: SetupClient; instructions: typeof instructions;
    };
    el.client = client;
    el.instructions = instructions;
    expect(Object.hasOwn(el, "client")).toBe(true);
    expect(Object.hasOwn(el, "instructions")).toBe(true);
    if (connected) document.body.append(el);
    return el;
  });
  try {
    defineElements();
    document.body.append(elements[1]!);
    await Promise.resolve();
    for (const el of elements) {
      expect(Object.hasOwn(el, "client")).toBe(false);
      expect(Object.hasOwn(el, "instructions")).toBe(false);
      expect(el.client).toBe(client);
      expect(el.instructions).toBe(instructions);
      expect(el.shadowRoot!.querySelector('[part="panel"]')!.getAttribute("data-state")).toBe("no_runner");
      expect(el.shadowRoot!.querySelector('[part="one-liner"]')!.textContent).toBe("custom install command");
      expect(el.shadowRoot!.querySelector('[part="agent-prompt"]')!.textContent).toBe("custom agent instructions");
    }
    expect(client.onStatus).toHaveBeenCalledTimes(2);
    const replacement = vi.fn((options: SetupInstructionsOptions) => ({
      ...instructions(options), oneLiner: "replacement command",
    }));
    elements[0]!.instructions = replacement;
    expect(elements[0]!.shadowRoot!.querySelector('[part="one-liner"]')!.textContent).toBe("replacement command");
    elements[0]!.client = { ...client, status: async () => ({ state: "ready" }) };
    await Promise.resolve();
    expect(elements[0]!.shadowRoot!.querySelector('[part="panel"]')!.getAttribute("data-state")).toBe("ready");
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally {
    document.body.replaceChildren();
  }
});
