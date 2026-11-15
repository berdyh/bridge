import { fileURLToPath } from "node:url";

// Source resolution keeps this harness independent of generated dist files and
// needs no new install or lockfile change in an already-installed checkout.
export const aliases = Object.fromEntries([
  ["bridge", "cli"], ["bridge-protocol", "protocol"], ["bridge-pairing", "pairing"],
  ["bridge-crypto", "crypto"], ["bridge-client", "client"], ["bridge-runner", "runner"],
  ["bridge-plugin-sdk", "plugin-sdk"], ["bridge-server", "server"],
  ["bridge-server-cf", "server-cf"], ["bridge-server-d1", "server-d1"],
].map(([name, dir]) => [`@berdyh/${name}`, fileURLToPath(new URL(`../packages/${dir}/src/index.ts`, import.meta.url))]));
