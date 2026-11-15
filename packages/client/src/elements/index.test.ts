import { describe, expect, it } from "vitest";

describe("the client barrel in Node", () => {
  it("imports without throwing and without a DOM", async () => {
    expect(typeof (globalThis as { HTMLElement?: unknown }).HTMLElement).toBe("undefined");
    const barrel = await import("../index.js");
    for (const name of ["connectBridge", "defineElements", "setupInstructions", "consumeEnrollLink", "permissionPrompt", "deriveStatus"]) {
      expect(typeof (barrel as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("defineElements does nothing where there is no HTMLElement", async () => {
    const { defineElements } = await import("./index.js");
    expect(() => defineElements()).not.toThrow();
  });
});
