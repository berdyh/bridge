import path from "node:path";

/** Linux sun_path holds 108 bytes including NUL. SRT's longest bridge name is 34 bytes. */
export function confinedSocketDirectoryFits(directory: string): boolean {
  return Buffer.byteLength(path.join(directory, `claude-socks-${"0".repeat(16)}.sock`)) <= 107;
}
