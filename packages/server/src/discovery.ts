import { PROTOCOL_RANGE, validateDiscovery, type BridgeDiscovery } from "@berdyh/bridge-protocol";

import type { BridgeServerConfig } from "./contracts.js";

/** The `relayUrl` used when the config gives none: `<origin as ws(s)>/relay`. */
export function defaultRelayUrl(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}/relay`;
}

/** Builds the `/.well-known/bridge.json` document from the config, applying the defaults. */
export function buildDiscovery(config: BridgeServerConfig): BridgeDiscovery {
  const origin = new URL(config.origin).origin;
  const protocol = config.protocol ?? PROTOCOL_RANGE;
  const discovery: BridgeDiscovery = {
    app: { ...config.app },
    origin,
    auth: { ...config.auth },
    relayUrl: config.relayUrl ?? defaultRelayUrl(origin),
    ...(config.enrollPage !== undefined ? { enrollPage: config.enrollPage } : {}),
    protocol: { min: protocol.min, max: protocol.max },
  };
  const validation = validateDiscovery(discovery);
  if (!validation.ok) throw new Error(`Invalid bridge discovery: ${validation.errors.join("; ")}`);
  return discovery;
}
