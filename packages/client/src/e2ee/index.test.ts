import { createPlainLayer } from "@berdyh/bridge-protocol";
import { describe, expect, it } from "vitest";

import type { ClientE2eeContext } from "../contracts.js";
import { wrapClientLayer } from "./index.js";

const ctx: ClientE2eeContext = {
  handshakeFor: () => ({ send: () => {}, onMessage: () => () => {} }),
  keyStore: { load: async () => undefined, save: async () => {}, delete: async () => {} },
  browserKeyId: "pre-enrollment-id",
  rebind: async () => {},
  runnerId: "r1",
};

describe("wrapClientLayer", () => {
  it("returns a fresh encrypted layer, not the plaintext one it was given", () => {
    const plain = createPlainLayer();
    const layer = wrapClientLayer(plain, ctx);
    expect(layer).not.toBe(plain);
    expect(layer.kind).toBe("e2ee");
    expect(layer.kid).toBe("");
  });

  it("refuses to start for a browser that never enrolled with this runner", async () => {
    await expect(wrapClientLayer(createPlainLayer(), ctx).start(ctx.handshakeFor("r1"))).rejects.toThrow("not enrolled");
  });
});
