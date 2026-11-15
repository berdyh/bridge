import { isIP } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

/** A public address assigned to this machine is still a host-control address. */
export function hostInterfaceDenies(interfaces: Record<string, NetworkInterfaceInfo[] | undefined>): string[] {
  const denied = new Set<string>();
  for (const entries of Object.values(interfaces)) for (const entry of entries ?? []) {
    const address = entry.address.split("%", 1)[0]!;
    const family = isIP(address);
    if (family === 4) denied.add(`${address}/32`);
    else if (family === 6) {
      const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
      denied.add(`${canonical}/128`);
    }
  }
  return [...denied];
}
