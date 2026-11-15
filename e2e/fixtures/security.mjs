// A file-backed stand-in for macOS `security`, so the real bridge binary never touches the
// login keychain (on macOS the real /usr/bin/security would otherwise be found on PATH).
// Supports what the runner uses: find-generic-password -g (and -w), `-i` with an
// add-generic-password -U line on stdin, and delete-generic-password. Like /usr/bin/security,
// -g prints `password: "<text>"` for printable ASCII without a backslash, else
// `password: 0x<HEX>  "<escaped>"`, and -i refuses lines over its 4095-byte buffer. State lives in $E2E_KEYCHAIN_DIR, one file per
// (account, service), in the same layout as the fake secret-tool.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const NOT_FOUND = 44; // errSecItemNotFound
const dir = process.env.E2E_KEYCHAIN_DIR;
if (!dir) {
  process.stderr.write("fake security: E2E_KEYCHAIN_DIR is not set\n");
  process.exit(2);
}

function fileFor(account, service) {
  const pairs = [["account", account], ["service", service]];
  return { pairs, file: path.join(dir, createHash("sha256").update(JSON.stringify(pairs)).digest("hex") + ".json") };
}

/** Option values of `-a`, `-s`, `-w` in an argv-style token list. */
function options(tokens) {
  const out = {};
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i] === "-a") out.account = tokens[i + 1];
    else if (tokens[i] === "-s") out.service = tokens[i + 1];
    else if (tokens[i] === "-w") out.password = tokens[i + 1];
  }
  return out;
}

/** Splits a line into tokens: bare words and double-quoted strings with backslash escapes. */
function tokenize(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i])) {
      i++;
    } else if (line[i] === '"') {
      let value = "";
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) i++;
        value += line[i++];
      }
      i++;
      tokens.push(value);
    } else {
      let value = "";
      while (i < line.length && !/\s/.test(line[i])) value += line[i++];
      tokens.push(value);
    }
  }
  return tokens;
}

function run(verb, tokens) {
  const { account, service, password } = options(tokens);
  if (account === undefined || service === undefined) {
    process.stderr.write("fake security: -a and -s are required\n");
    return 2;
  }
  const { pairs, file } = fileFor(account, service);
  if (verb === "find-generic-password") {
    let secret;
    try {
      secret = JSON.parse(readFileSync(file, "utf8")).secret;
    } catch {
      return NOT_FOUND;
    }
    if (!tokens.includes("-g")) {
      process.stdout.write(secret + "\n");
      return 0;
    }
    // Like /usr/bin/security: the value line, then the item's attributes, on stderr.
    const dump = `keychain: "${path.join(dir, "fake.keychain-db")}"\nclass: "genp"\nattributes:\n    "acct"<blob>="${account}"\n    "svce"<blob>="${service}"\n`;
    process.stdout.write(dump);
    const printable = /^[\x20-\x5b\x5d-\x7e]*$/.test(secret);
    const hex = Buffer.from(secret, "utf8").toString("hex").toUpperCase();
    process.stderr.write((secret === "" ? "password: \n" : printable ? `password: "${secret}"\n` : `password: 0x${hex}  "(escaped)"\n`) + dump);
    return 0;
  }
  if (verb === "add-generic-password") {
    if (password === undefined) return 2;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ attributes: Object.fromEntries(pairs), secret: password }), { mode: 0o600 });
    return 0;
  }
  if (verb === "delete-generic-password") {
    try {
      readFileSync(file);
    } catch {
      return NOT_FOUND;
    }
    rmSync(file, { force: true });
    return 0;
  }
  process.stderr.write(`fake security: unsupported verb ${verb}\n`);
  return 2;
}

const args = process.argv.slice(2);
if (args[0] === "-i") {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    let code = 0;
    for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
      if (Buffer.byteLength(line) > 4095) {
        process.stderr.write("fake security: line exceeds the 4095-byte -i buffer\n");
        code = 1;
        continue;
      }
      const [verb, ...tokens] = tokenize(line);
      if (verb) code = run(verb, tokens) || code;
    }
    process.exit(code);
  });
} else {
  process.exit(run(args[0], args.slice(1)));
}
