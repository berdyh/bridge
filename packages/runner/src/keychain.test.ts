import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner } from "./contracts.js";
import { KeychainError, createFileCredentialStore, createKeychainCredentialStore } from "./keychain.js";

function fake(results: CommandResult[]) {
  const calls: { command: string; args: readonly string[]; stdin?: string }[] = [];
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, stdin: options?.stdin });
    return results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}
const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

describe("linux keychain (secret-tool)", () => {
  it("stores the secret over stdin, never argv", async () => {
    const f = fake([ok()]);
    const store = createKeychainCredentialStore({ platform: "linux", run: f.run, service: "berdyh-x" });
    await store.set("device", "s3cret");
    expect(f.calls[0]).toEqual({
      command: "secret-tool",
      args: ["store", "--label=berdyh-x device", "service", "berdyh-x", "account", "device"],
      stdin: "s3cret",
    });
    expect(JSON.stringify(f.calls[0]?.args)).not.toContain("s3cret");
  });

  it("looks up, and treats exit 1 with no stderr as not found", async () => {
    const f = fake([ok("tok"), { exitCode: 1, stdout: "", stderr: "" }]);
    const store = createKeychainCredentialStore({ platform: "linux", run: f.run, service: "svc" });
    expect(await store.get("a")).toBe("tok");
    expect(await store.get("a")).toBeNull();
    expect(f.calls[0]?.args).toEqual(["lookup", "service", "svc", "account", "a"]);
  });

  it("throws on real lookup errors and on a missing binary", async () => {
    const f = fake([{ exitCode: 1, stdout: "", stderr: "Cannot autolaunch D-Bus" }]);
    const store = createKeychainCredentialStore({ platform: "linux", run: f.run, service: "svc" });
    await expect(store.get("a")).rejects.toBeInstanceOf(KeychainError);
    const missing = createKeychainCredentialStore({
      platform: "linux",
      service: "svc",
      run: async () => {
        throw new Error("spawn secret-tool ENOENT");
      },
    });
    await expect(missing.get("a")).rejects.toThrow(/could not run secret-tool/);
  });

  it("clears", async () => {
    const f = fake([ok()]);
    await createKeychainCredentialStore({ platform: "linux", run: f.run, service: "svc" }).delete("a");
    expect(f.calls[0]?.args).toEqual(["clear", "service", "svc", "account", "a"]);
  });
});

describe("macOS keychain (security)", () => {
  const found = (passwordLine: string): CommandResult => ({ exitCode: 0, stdout: 'keychain: "/k"\nclass: "genp"\n', stderr: `${passwordLine}\n` });

  it("adds, finds through the -g password line, and maps 44 to null", async () => {
    const f = fake([ok(), found('password: "tok"'), { exitCode: 44, stdout: "", stderr: "" }]);
    const store = createKeychainCredentialStore({ platform: "darwin", run: f.run, service: "svc" });
    await store.set("a", "v");
    expect(await store.get("a")).toBe("tok");
    expect(await store.get("a")).toBeNull();
    expect(f.calls[0]).toEqual({
      command: "security",
      args: ["-i"],
      stdin: 'add-generic-password -U -a "a" -s "svc" -w "v"\n',
    });
    expect(f.calls[1]?.args).toEqual(["find-generic-password", "-a", "a", "-s", "svc", "-g"]);
  });

  // Lines as /usr/bin/security printed them on macOS 26.5.1.
  it.each([
    ["empty", "password: ", ""],
    ["plain", 'password: "plain123"', "plain123"],
    ["inner quotes are not escaped", 'password: "he said "hi""', 'he said "hi"'],
    ["a value that only looks like hex", 'password: "0xdead"', "0xdead"],
    ["a -w style hex dump stored as text", 'password: "deadbeef"', "deadbeef"],
    ["non-ASCII as hex", 'password: 0xD0BAD0BBD18ED1872DF09F94912DE580A4  "\\320\\272\\320\\273\\321\\216\\321\\207-\\360\\237\\224\\221-\\345\\200\\244"', "ключ-🔑-値"],
    ["tab as hex", 'password: 0x7461620978  "tab\\011x"', "tab\tx"],
    ["backslashes as hex with no escaped copy", "password: 0x5C5C ", "\\\\"],
    ["quote and backslash as hex", 'password: 0x6122625C63  "a"b\\134c"', 'a"b\\c'],
    ["trailing spaces stay plain", 'password: "sp  "', "sp  "],
    ["a leading BOM is kept", 'password: 0xEFBBBF78  "\\357\\273\\277x"', "\uFEFFx"],
    ["a value holding a password: line, as hex", 'password: 0x70770A70617373776F72643A20227A7A22  "pw\\012password: "zz""', 'pw\npassword: "zz"'],
  ])("decodes the native password line: %s", async (_name, line, value) => {
    // CRLF and the attribute dump that follows on the same stream must not change the result.
    expect(await createKeychainCredentialStore({ platform: "darwin", run: fake([{ exitCode: 0, stdout: "", stderr: `${line}\r\nkeychain: "/k"\r\n    "acct"<blob>="password: x"\r\n` }]).run, service: "svc" }).get("a")).toBe(value);
    const f = fake([found(line)]);
    const store = createKeychainCredentialStore({ platform: "darwin", run: f.run, service: "svc" });
    expect(await store.get("a")).toBe(value);
  });

  it.each([
    ["no password line", { exitCode: 0, stdout: "", stderr: "" }],
    ["odd-length hex", found("password: 0xABC")],
    ["hex that is not UTF-8", found('password: 0xFF  "\\377"')],
    ["an unknown shape", found("password: <redacted>")],
  ])("refuses a read it cannot decode exactly: %s", async (_name, result) => {
    const store = createKeychainCredentialStore({ platform: "darwin", run: fake([result]).run, service: "svc" });
    await expect(store.get("a")).rejects.toBeInstanceOf(KeychainError);
  });

  it.each(["darwin", "linux"] as const)("%s: refuses a lone surrogate in key, value or service before running anything", async (platform) => {
    const f = fake([]);
    const store = createKeychainCredentialStore({ platform, run: f.run, service: "svc" });
    await expect(store.set("a", "x\ud800")).rejects.toThrow(/not well-formed/);
    await expect(store.set("\udc00", "v")).rejects.toThrow(/not well-formed/);
    await expect(store.get("\ud800")).rejects.toThrow(/not well-formed/);
    await expect(store.delete("\ud800")).rejects.toThrow(/not well-formed/);
    await expect(createKeychainCredentialStore({ platform, run: f.run, service: "s\ud800" }).get("a")).rejects.toThrow(/not well-formed/);
    expect(f.calls).toEqual([]);
    await expect(store.set("a", "ok 🔑")).resolves.toBeUndefined();
  });

  it("refuses a security -i line over the 4095-byte buffer before running security", async () => {
    const f = fake([ok()]);
    const store = createKeychainCredentialStore({ platform: "darwin", run: f.run, service: "svc" });
    const overhead = Buffer.byteLength('add-generic-password -U -a "a" -s "svc" -w ""');
    await store.set("a", "y".repeat(4095 - overhead));
    expect(Buffer.byteLength(f.calls[0]!.stdin!)).toBe(4096);
    await expect(store.set("a", "y".repeat(4096 - overhead))).rejects.toThrow(/too long for security -i/);
    await expect(store.set("a", "é".repeat(2100))).rejects.toThrow(/too long for security -i/);
    expect(f.calls).toHaveLength(1);
  });

  it("never puts the secret in argv, and escapes quotes and backslashes", async () => {
    const f = fake([ok()]);
    const store = createKeychainCredentialStore({ platform: "darwin", run: f.run, service: "svc" });
    await store.set("device", 's3"cr\\et');
    expect(JSON.stringify(f.calls[0]?.args)).not.toContain("s3");
    expect(f.calls[0]?.stdin).toBe('add-generic-password -U -a "device" -s "svc" -w "s3\\"cr\\\\et"\n');
  });

  it("rejects secrets with line breaks and reports security failures", async () => {
    const f = fake([{ exitCode: 0, stdout: "", stderr: "security: SecKeychainItemCreate failed" }]);
    const store = createKeychainCredentialStore({ platform: "darwin", run: f.run, service: "svc" });
    await expect(store.set("a", "x\ny")).rejects.toBeInstanceOf(KeychainError);
    expect(f.calls).toHaveLength(0);
    await expect(store.set("a", "v")).rejects.toBeInstanceOf(KeychainError);
  });

  it("a failed macOS write never quotes what security printed", async () => {
    const f = fake([{ exitCode: 1, stdout: "", stderr: 'security: bad command: add-generic-password -w "SYNTHETIC_TOKEN"' }]);
    const store = createKeychainCredentialStore({ platform: "darwin", run: f.run, service: "svc" });
    const error = await store.set("a", "SYNTHETIC_TOKEN").catch((e: unknown) => e as KeychainError);
    expect(error).toBeInstanceOf(KeychainError);
    expect(String(error)).toMatch(/security add failed \(1\)/);
    expect(String(error)).not.toContain("SYNTHETIC_TOKEN");
  });

  it("delete tolerates a missing item but not other failures", async () => {
    const f = fake([{ exitCode: 44, stdout: "", stderr: "" }, { exitCode: 1, stdout: "", stderr: "denied" }]);
    const store = createKeychainCredentialStore({ platform: "darwin", run: f.run, service: "svc" });
    await expect(store.delete("a")).resolves.toBeUndefined();
    await expect(store.delete("a")).rejects.toBeInstanceOf(KeychainError);
  });

  /** Every string an error can show: message, name, String(), and the whole cause chain. */
  function everything(error: unknown): string {
    const seen: string[] = [];
    for (let e: unknown = error, depth = 0; e !== undefined && depth < 8; depth++) {
      seen.push(String(e), e instanceof Error ? e.message : "", JSON.stringify(e) ?? "");
      e = e instanceof KeychainError ? e.cause_ : e instanceof Error ? e.cause : undefined;
    }
    return seen.join("\n");
  }

  it("a password line followed by an abnormal exit never reaches the error (message, cause, String)", async () => {
    for (const stderr of ['password: "SYNTHETIC_TOKEN"\n', 'password: 0x53594E5448455449435F544F4B454E  "SYNTHETIC_TOKEN"\n', 'keychain: "/k"\npassword: "SYNTHETIC_TOKEN"\nline two SYNTHETIC_TOKEN\n']) {
      const store = createKeychainCredentialStore({ platform: "darwin", run: fake([{ exitCode: 1, stdout: "", stderr }]).run, service: "svc" });
      const error = await store.get("a").then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(KeychainError);
      expect(everything(error)).not.toContain("SYNTHETIC_TOKEN");
      expect(everything(error)).not.toContain("53594E54");
      expect((error as Error).message).toContain("(1)");
    }
  });

  it("a stored value is not a not-found diagnosis on a nonzero exit, a real not-found still is", async () => {
    const lying = createKeychainCredentialStore({ platform: "darwin", run: fake([{ exitCode: 1, stdout: "", stderr: 'password: "The specified item could not be found in the keychain."\n' }]).run, service: "svc" });
    await expect(lying.get("a")).rejects.toBeInstanceOf(KeychainError);
    const missing = createKeychainCredentialStore({ platform: "darwin", run: fake([{ exitCode: 1, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n" }, { exitCode: 44, stdout: "", stderr: 'password: "x"' }]).run, service: "svc" });
    expect(await missing.get("a")).toBeNull();
    expect(await missing.get("a")).toBeNull();
  });

  it("a transport failure whose text carries the token is not reported on the macOS read path", async () => {
    const cause = Object.assign(new Error('spawn security failed after printing password: "SYNTHETIC_TOKEN"'), { code: "EPIPE", stderr: 'password: "SYNTHETIC_TOKEN"' });
    const store = createKeychainCredentialStore({ platform: "darwin", run: async () => { throw cause; }, service: "svc" });
    const error = await store.get("a").then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(KeychainError);
    expect(everything(error)).not.toContain("SYNTHETIC_TOKEN");
    expect((error as KeychainError).cause_).toBeUndefined();
    expect((error as Error).message).toMatch(/could not run security/);
  });

  it("a malformed password line or non-UTF-8 hex reports a fixed diagnosis with no cause", async () => {
    for (const stderr of ["password: 0x4\n", "password: 0xFF\n", "password: SYNTHETIC_TOKEN\n"]) {
      const store = createKeychainCredentialStore({ platform: "darwin", run: fake([{ exitCode: 0, stdout: "", stderr }]).run, service: "svc" });
      const error = await store.get("a").then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(KeychainError);
      expect((error as KeychainError).cause_).toBeUndefined();
      expect(everything(error)).not.toContain("SYNTHETIC_TOKEN");
    }
  });

  const T = "SYNTHETIC_TOKEN";
  it("get rejects a runner's own KeychainError (text and cause) into a fixed message with no cause", async () => {
    const forged = new KeychainError(`command output password: "${T}"`, new Error(T));
    const store = createKeychainCredentialStore({ platform: "darwin", run: async () => { throw forged; }, service: "svc" });
    const error = await store.get("a").then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(KeychainError);
    expect(error).not.toBe(forged);
    expect((error as KeychainError).cause_).toBeUndefined();
    expect(everything(error)).not.toContain(T);
    expect((error as Error).message).toMatch(/could not run security/);
  });

  const operations: [string, (store: ReturnType<typeof createKeychainCredentialStore>) => Promise<unknown>][] = [
    ["get", (s) => s.get("a")],
    ["set", (s) => s.set("a", "v")],
    ["delete", (s) => s.delete("a")],
  ];

  it.each(operations)("%s rejects a runner's own KeychainError (text and cause) into a fixed message with no cause", async (_name, operation) => {
    const forged = new KeychainError(`command output password: "${T}"`, new Error(T));
    const store = createKeychainCredentialStore({ platform: "darwin", run: async () => { throw forged; }, service: "svc" });
    const error = await operation(store).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(KeychainError);
    expect(error).not.toBe(forged);
    expect((error as KeychainError).cause_).toBeUndefined();
    expect(everything(error)).not.toContain(T);
    expect((error as Error).message).toMatch(/could not run security/);
  });

  it.each(operations)("%s turns a rejected transport error into a fixed message with no cause", async (_name, operation) => {
    const cause = Object.assign(new Error(`spawn failed, output ${T}`), { code: "EPIPE", stderr: T });
    const store = createKeychainCredentialStore({ platform: "darwin", run: async () => { throw cause; }, service: "svc" });
    const error = await operation(store).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(KeychainError);
    expect((error as KeychainError).cause_).toBeUndefined();
    expect(everything(error)).not.toContain(T);
  });

  it("a failed macOS delete names the exit code only, and a missing item is still tolerated", async () => {
    const f = fake([{ exitCode: 1, stdout: "", stderr: `security: ${T}` }, { exitCode: 44, stdout: "", stderr: T }]);
    const store = createKeychainCredentialStore({ platform: "darwin", run: f.run, service: "svc" });
    const error = await store.delete("a").catch((e: unknown) => e);
    expect(String(error)).toMatch(/security delete failed \(1\)/);
    expect(everything(error)).not.toContain(T);
    await expect(store.delete("a")).resolves.toBeUndefined();
  });

  it("the linux transport message and cause are unchanged", async () => {
    const cause = new Error("spawn secret-tool ENOENT");
    const store = createKeychainCredentialStore({ platform: "linux", run: async () => { throw cause; }, service: "svc" });
    const error = (await store.get("a").then(() => undefined, (e: unknown) => e)) as KeychainError;
    expect(error.message).toBe("could not run secret-tool: spawn secret-tool ENOENT");
    expect(error.cause_).toBe(cause);
  });
});

describe("file credential store", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });
  async function root(): Promise<string> {
    const r = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "bridge-filestore-"));
    roots.push(r);
    return r;
  }
  const mode = async (p: string) => (await stat(p)).mode & 0o777;

  it("round-trips values, replaces, deletes, and treats a missing key or directory as not found", async () => {
    const dir = path.join(await root(), "creds");
    const store = createFileCredentialStore({ dir });
    expect(await store.get("a")).toBeNull(); // no directory yet, and none is created by a read
    await expect(lstat(dir)).rejects.toThrow();
    await store.delete("a"); // nothing to delete is fine
    await store.set("demo/pairing.tokens", '{"t":"x"}\n');
    await store.set("bridge/e2ee-identity-key/demo/r1", "wrap");
    expect(await store.get("demo/pairing.tokens")).toBe('{"t":"x"}\n');
    await store.set("demo/pairing.tokens", "second");
    expect(await store.get("demo/pairing.tokens")).toBe("second");
    await store.delete("demo/pairing.tokens");
    expect(await store.get("demo/pairing.tokens")).toBeNull();
    expect(await store.get("bridge/e2ee-identity-key/demo/r1")).toBe("wrap");
  });

  it("creates the directory 0700 and every file 0600 whatever the umask, and leaves no temporary file", async () => {
    const dir = path.join(await root(), "creds");
    const before = process.umask(0o277);
    try {
      const store = createFileCredentialStore({ dir });
      await store.set("k1", "v1");
      await store.set("k1", "v2");
      await store.set("k2", "v");
    } finally {
      process.umask(before);
    }
    expect(await mode(dir)).toBe(0o700);
    const names = await readdir(dir);
    expect(names).toHaveLength(2);
    for (const name of names) expect(await mode(path.join(dir, name))).toBe(0o600);
  });

  it("refuses a symlinked directory for get, set and delete, and writes nothing through it", async () => {
    const r = await root();
    const real = path.join(r, "real");
    await mkdir(real, { mode: 0o700 });
    const link = path.join(r, "link");
    await symlink(real, link);
    const store = createFileCredentialStore({ dir: link });
    for (const op of [() => store.get("k"), () => store.set("k", "v"), () => store.delete("k")]) {
      await expect(op()).rejects.toThrow(/symbolic link/);
    }
    expect(await readdir(real)).toEqual([]);
  });

  it("refuses a symlinked directory however the path is spelled (trailing slash, trailing dot, doubled slash, dot segments)", async () => {
    const r = await root();
    const real = path.join(r, "real");
    await mkdir(real, { mode: 0o700 });
    const link = path.join(r, "link");
    await symlink(real, link);
    for (const spelled of [`${link}/`, `${link}//`, `${link}/.`, `${link}/./`, path.join(r, "x", "..", "link") + "/", path.join(r, "link", "..", "link")]) {
      const store = createFileCredentialStore({ dir: spelled });
      for (const op of [() => store.get("k"), () => store.set("k", "v"), () => store.delete("k")]) {
        await expect(op()).rejects.toThrow(/symbolic link/);
      }
    }
    expect(await readdir(real)).toEqual([]);
  });

  it("refuses a directory or file that others can reach, naming the chmod to run, and a non-directory", async () => {
    const r = await root();
    const dir = path.join(r, "creds");
    const store = createFileCredentialStore({ dir });
    await store.set("k", "v");
    await chmod(dir, 0o755);
    await expect(store.get("k")).rejects.toThrow(/chmod 700/);
    await expect(store.set("k", "v2")).rejects.toThrow(/accessible to others/);
    await chmod(dir, 0o700);
    const file = path.join(dir, (await readdir(dir))[0]!);
    await chmod(file, 0o644);
    await expect(store.get("k")).rejects.toThrow(/chmod 600/);
    await chmod(file, 0o640);
    await expect(store.get("k")).rejects.toBeInstanceOf(KeychainError);
    await chmod(file, 0o600);
    expect(await store.get("k")).toBe("v");

    const plain = path.join(r, "plain");
    await writeFile(plain, "");
    await expect(createFileCredentialStore({ dir: plain }).set("k", "v")).rejects.toThrow(/not a directory/);
  });

  it("never follows a link planted at a credential file: read refuses, write replaces the link, delete removes the link only", async () => {
    const r = await root();
    const dir = path.join(r, "creds");
    const store = createFileCredentialStore({ dir });
    await store.set("k", "v");
    const file = path.join(dir, (await readdir(dir))[0]!);
    const outside = path.join(r, "outside");
    await writeFile(outside, "precious", { mode: 0o600 });
    await rm(file);
    await symlink(outside, file);
    await expect(store.get("k")).rejects.toThrow(/symbolic link/);
    await store.set("k", "new");
    expect((await lstat(file)).isSymbolicLink()).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("precious");
    expect(await store.get("k")).toBe("new");
    await rm(file);
    await symlink(outside, file);
    await store.delete("k");
    expect(await readFile(outside, "utf8")).toBe("precious");
    expect(await store.get("k")).toBeNull();
  });

  it("keys cannot escape the directory or collide, and an empty key is refused", async () => {
    const r = await root();
    const dir = path.join(r, "creds");
    const store = createFileCredentialStore({ dir });
    await store.set("../outside", "1");
    await store.set("..", "2");
    await store.set("a/b", "3");
    await store.set("a%2Fb", "4");
    expect(await store.get("../outside")).toBe("1");
    expect(await store.get("..")).toBe("2");
    expect(await store.get("a/b")).toBe("3");
    expect(await store.get("a%2Fb")).toBe("4");
    expect(await readdir(r)).toEqual(["creds"]);
    expect(await readdir(dir)).toHaveLength(4);
    await expect(store.set("", "x")).rejects.toBeInstanceOf(KeychainError);
    await expect(store.get("x".repeat(300))).rejects.toBeInstanceOf(KeychainError);
  });

  it("needs an absolute directory", () => {
    expect(() => createFileCredentialStore({ dir: "relative/creds" })).toThrow(/absolute/);
  });
});
