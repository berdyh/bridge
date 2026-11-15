import type { BridgeServerConfig, RelayGateway, RelayTransport } from "@berdyh/bridge-server";
import { describe, expect, expectTypeOf, it } from "vitest";

import { createBridgeWorker, createDoRelayGateway, createRelayDurableObject } from "./index.js";

describe("Workers split", () => {
  it("the Worker side is a gateway: no member exists only to throw", () => {
    expectTypeOf(createDoRelayGateway).returns.toEqualTypeOf<RelayGateway>();
    expectTypeOf(createDoRelayGateway).returns.not.toExtend<RelayTransport>();
  });

  it("the relay context is a Durable Object class built from the same config factory", () => {
    expectTypeOf(createRelayDurableObject<{ RELAY: unknown }>).parameters.toEqualTypeOf<[(env: { RELAY: unknown }) => BridgeServerConfig]>();
    expectTypeOf(createBridgeWorker).returns.toEqualTypeOf<ExportedHandler<unknown>>();
  });

});
