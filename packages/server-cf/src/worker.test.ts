import { expect, it, vi } from "vitest";
import type { BridgeServerConfig } from "@berdyh/bridge-server";
const core = vi.hoisted(() => ({ createBridgeApp: vi.fn() }));
vi.mock("@berdyh/bridge-server", () => ({ createBridgeApp: core.createBridgeApp }));
import { createBridgeWorker } from "./worker.js";

it("constructs one app per env identity and isolates different workers and environments", async () => {
  core.createBridgeApp.mockImplementation((config: { origin: string }) => ({ fetch: vi.fn(async () => new Response(config.origin)) }));
  const configFor = vi.fn((env: { origin: string }) => ({ origin: env.origin }) as BridgeServerConfig);
  const worker = createBridgeWorker(configFor);
  const env = { origin: "https://app.test" }; const other = { origin: "https://other.test" };
  const context = {} as ExecutionContext;
  for (const binding of [env, env, other, env, other]) {
    const response = await worker.fetch!(new Request("https://app.test/"), binding, context);
    expect(await response.text()).toBe(binding.origin);
  }
  expect(configFor.mock.calls.map(([binding]) => binding)).toEqual([env, other]);
  expect(core.createBridgeApp).toHaveBeenCalledTimes(2);
  const secondWorker = createBridgeWorker(configFor);
  await secondWorker.fetch!(new Request("https://app.test/"), env, context);
  expect(core.createBridgeApp).toHaveBeenCalledTimes(3);
});
