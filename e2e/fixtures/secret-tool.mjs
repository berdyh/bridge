// A file-backed stand-in for libsecret's `secret-tool`, so the real bridge binary never
// touches the OS keychain. Supports the three verbs the runner uses: lookup, store, clear.
// State lives in $E2E_KEYCHAIN_DIR, one file per attribute set.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.E2E_KEYCHAIN_DIR;
if (!dir) {
  process.stderr.write("fake secret-tool: E2E_KEYCHAIN_DIR is not set\n");
  process.exit(2);
}
const [verb, ...rest] = process.argv.slice(2);
const attrs = rest.filter((a) => !a.startsWith("--"));
const pairs = [];
for (let i = 0; i + 1 < attrs.length; i += 2) pairs.push([attrs[i], attrs[i + 1]]);
pairs.sort((a, b) => (a[0] + "\0" + a[1]).localeCompare(b[0] + "\0" + b[1]));
const file = path.join(dir, createHash("sha256").update(JSON.stringify(pairs)).digest("hex") + ".json");

if (verb === "lookup") {
  try {
    process.stdout.write(JSON.parse(readFileSync(file, "utf8")).secret);
  } catch {
    process.exit(1);
  }
} else if (verb === "store") {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ attributes: Object.fromEntries(pairs), secret: Buffer.concat(chunks).toString("utf8") }), { mode: 0o600 });
  });
} else if (verb === "clear") {
  rmSync(file, { force: true });
} else {
  process.stderr.write(`fake secret-tool: unsupported verb ${verb}\n`);
  process.exit(2);
}
