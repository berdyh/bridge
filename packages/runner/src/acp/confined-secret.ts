/** Broker-only bootstrap inside SRT: private stdin prelude -> broker descriptor 3. */
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";

let prelude = Buffer.alloc(0);
const start = (chunk: Buffer) => {
  prelude = Buffer.concat([prelude, chunk]);
  const newline = prelude.indexOf(10);
  if (newline < 0) { if (prelude.length > 8192) process.exit(1); return; }
  process.stdin.off("data", start);
  process.stdin.pause();
  const secret = Buffer.from(prelude.subarray(0, newline).toString(), "base64");
  const rest = Buffer.from(prelude.subarray(newline + 1));
  prelude.fill(0);
  const child = spawn(process.argv[2]!, process.argv.slice(3), { env: process.env, stdio: ["pipe", "inherit", "inherit", "pipe"] });
  const fd = child.stdio[3] as Writable;
  fd.on("error", () => {});
  fd.end(secret, () => { secret.fill(0); fd.destroy(); });
  child.stdin!.on("error", () => {});
  if (rest.length) child.stdin!.write(rest);
  process.stdin.pipe(child.stdin!);
  child.on("error", () => { secret.fill(0); process.exit(1); });
  child.on("close", (code) => process.exit(code ?? 1));
};
process.stdin.on("data", start);
