/** Wire protocol version spoken by this build. Bump on breaking changes. */
export const PROTOCOL_VERSION = 1;

/**
 * True when a peer speaking `peerVersion` can talk to a side that supports
 * protocol versions `minSupported..PROTOCOL_VERSION` (or `current`).
 */
export function isProtocolCompatible(
  peerVersion: number,
  minSupported: number = PROTOCOL_VERSION,
  current: number = PROTOCOL_VERSION,
): boolean {
  return (
    Number.isInteger(peerVersion) &&
    peerVersion >= minSupported &&
    peerVersion <= current
  );
}
