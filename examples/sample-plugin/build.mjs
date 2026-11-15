// Ship the two workspace libraries alongside the sample. The host deliberately
// does not download dependencies or run npm lifecycle scripts on installation.
import { cp, readFile, writeFile } from 'node:fs/promises';
const base = new URL('./', import.meta.url);
await cp(new URL('../../packages/plugin-sdk/dist', base), new URL('dist/sdk', base), { recursive: true });
await cp(new URL('../../packages/protocol/dist', base), new URL('dist/protocol', base), { recursive: true });
for (const file of ['dist/sdk/runtime.js', 'dist/sdk/rpc.js']) {
  const url = new URL(file, base);
  await writeFile(url, (await readFile(url, 'utf8')).replaceAll('"@berdyh/bridge-protocol"', '"../protocol/index.js"'));
}
const entry = new URL('dist/plugin.js', base);
await writeFile(entry, (await readFile(entry, 'utf8')).replaceAll('"@berdyh/bridge-plugin-sdk"', '"./sdk/runtime.js"'));
