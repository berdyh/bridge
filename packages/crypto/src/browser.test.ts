// @vitest-environment jsdom
// jsdom provides the DOM realm but has no SubtleCrypto. Use Node's real
// WebCrypto for that standard API; no production modules import node:*.
import { webcrypto } from "node:crypto";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import "./errors.test.js";
import "./encoding.test.js";
import "./spake2.test.js";
import "./keys.test.js";
import "./frame.test.js";

beforeAll(() => { vi.stubGlobal("crypto", webcrypto); });
afterAll(() => { vi.unstubAllGlobals(); });
it("runs the full crypto suite in the jsdom DOM realm with real WebCrypto", () => {
  expect(window.document).toBe(document);
  expect(crypto.subtle).toBeDefined();
});
