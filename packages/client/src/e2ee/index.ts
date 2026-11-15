import type { ChannelLayer } from "@berdyh/bridge-protocol";

import type { ClientE2eeContext } from "../contracts.js";
import { createClientE2eeLayer } from "./layer.js";

export { enroll } from "./enroll.js";
export { EnrollError } from "./wire.js";

/**
 * The client always passes its channel layer through this. Returns the end-to-end
 * encrypted layer for `ctx.runnerId`; the plaintext `layer` it is given is not used
 * (BridgeClient only picks it with `e2ee: false`, which bypasses this result).
 * Nothing happens until `start`: the long-term key and the runner's public key come
 * from `ctx.keyStore`, and a browser that has not enrolled with that runner fails
 * there with "not enrolled".
 */
export function wrapClientLayer(layer: ChannelLayer, ctx: ClientE2eeContext): ChannelLayer {
  return createClientE2eeLayer(ctx);
}
