/** Package-private state. Kept out of channel.ts because the barrel exports it. */
import type { ChannelKeys } from "./contracts.js";
import { BridgeCryptoError } from "./errors.js";

export const channelSecrets = new WeakMap<ChannelKeys, { b2r: CryptoKey; r2b: CryptoKey }>();
/** Per-direction frame invocation budget, shared by codecs using the same key. */
export const frameEncryptionInvocations = new WeakMap<CryptoKey, number>();
export function getChannelSecrets(keys: ChannelKeys): { b2r: CryptoKey; r2b: CryptoKey } {
  const secret = channelSecrets.get(keys);
  if (!secret) throw new BridgeCryptoError("malformed");
  return secret;
}
