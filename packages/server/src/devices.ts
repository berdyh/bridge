import type { DeviceStore, RevokeResult } from "./contracts.js";

/** The device API's logic plus the last-seen throttle, independent of HTTP. */
export interface DeviceService {
  list(userId: string): ReturnType<DeviceStore["listDevices"]>;
  /**
   * Revokes in the store (which also revokes the device's bound credentials there),
   * then asks the verifier to revoke those credentials at the identity provider if it
   * supports it. Reports whether the device existed. The caller closes the socket.
   */
  revoke(userId: string, deviceId: string): Promise<boolean>;
  /**
   * Same as `revoke`, but returns the revoked credential ids (undefined when the
   * device was unknown), so the caller can also close sockets that hold those
   * credentials under other runner ids. A failing identity provider does not undo
   * the store revocation: the result then carries `idpRevokeFailed: true`.
   * `afterStoreRevoked` runs right after the store revocation and before the identity
   * provider is called, so the caller can disconnect sockets without waiting on a
   * slow or stalled provider.
   */
  revokeAndReport(
    userId: string,
    deviceId: string,
    afterStoreRevoked?: (result: RevokeResult) => Promise<void> | void,
  ): Promise<(RevokeResult & { idpRevokeFailed?: boolean }) | undefined>;
  /**
   * Calls `DeviceStore.touchLastSeen` with the configured interval and returns
   * whether it wrote. Holds no throttle state of its own: the store's atomic
   * operation is the throttle, so any number of connections may call it.
   */
  recordSeen(userId: string, deviceId: string): Promise<boolean>;
}

/** Default minimum gap between `lastSeen` writes per device: 5 minutes. */
export const DEFAULT_LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;

export function createDeviceService(options: {
  store: DeviceStore;
  revokeCredentials?: (userId: string, credentialIds: string[]) => Promise<void>;
  lastSeenIntervalMs?: number;
  now?: () => Date;
}): DeviceService {
  const { store, revokeCredentials } = options;
  const interval = options.lastSeenIntervalMs ?? DEFAULT_LAST_SEEN_INTERVAL_MS;
  const now = options.now ?? (() => new Date());

  async function revokeAndReport(
    userId: string,
    deviceId: string,
    afterStoreRevoked?: (result: RevokeResult) => Promise<void> | void,
  ): Promise<(RevokeResult & { idpRevokeFailed?: boolean }) | undefined> {
    const result = await store.revokeDevice(userId, deviceId);
    if (!result) return undefined;
    await afterStoreRevoked?.(result);
    if (revokeCredentials && result.credentialIds.length > 0) {
      try {
        await revokeCredentials(userId, result.credentialIds);
      } catch {
        return { ...result, idpRevokeFailed: true };
      }
    }
    return result;
  }

  return {
    list: (userId) => store.listDevices(userId),
    revoke: async (userId, deviceId) => (await revokeAndReport(userId, deviceId)) !== undefined,
    revokeAndReport,
    recordSeen: (userId, deviceId) => store.touchLastSeen(userId, deviceId, now().toISOString(), interval),
  };
}
