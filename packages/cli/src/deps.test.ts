import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import path from "node:path";

import { afterEach, describe, expect, it, onTestFinished as after, vi } from "vitest";

import { adapterOptionsOf } from "./adapters.js";
import { adaptersOf, createDefaultDeps, credentialStoreSettingOf, credentialsOf, DEFAULT_SETUP_CONFIG, guardedWriter, isTTYOf, keychainHint, keychainUsability, openUrlOf, setupConfigOf, UsageError } from "./deps.js";
import { nodeRun } from "./exec.js";
import { type Harness, harness } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("seams", () => {
  it("the harness records openUrl, openTerminal and notify and is not a TTY", async () => {
    h = await harness();
    expect(h.deps.isTTY).toBe(false);
    await h.deps.openUrl!("https://app.example/enroll");
    await h.deps.openTerminal!(["bridge", "run"]);
    await h.deps.notify!({ title: "t", body: "b" });
    expect(h.opened).toEqual(["https://app.example/enroll"]);
    expect(h.terminals).toEqual([["bridge", "run"]]);
    expect(h.notifications).toEqual([{ title: "t", body: "b" }]);
  });

  it("the real deps create nothing on disk and leave the optional seams to their owners", () => {
    const deps = createDefaultDeps({ HOME: "/nonexistent-home" });
    expect(deps.isTTY).toBeUndefined();
    expect(typeof isTTYOf(deps)).toBe("boolean");
    expect(deps.openUrl).toBeUndefined();
    expect(deps.openTerminal).toBeUndefined();
    expect(deps.notify).toBeUndefined();
    expect(deps.setupConfig).toBeUndefined();
  });

  it("isTTY is optional: an injected value wins, else it is resolved from the terminal", async () => {
    h = await harness();
    const { isTTY: _omitted, ...rest } = h.deps;
    expect(isTTYOf(h.deps)).toBe(false);
    expect(isTTYOf({ ...rest, isTTY: true })).toBe(true);
    expect(typeof isTTYOf(rest)).toBe("boolean");
  });

  it("adapter options come from the deps (see adapters.test.ts) and the injected adapters win", async () => {
    h = await harness();
    expect(adapterOptionsOf(h.deps).base?.state).toBe(path.join(h.root, "home/.local/state"));
    expect(adaptersOf({ ...h.deps, adapters: [] })).toEqual([]);
    expect(adaptersOf(h.deps).map((a) => a.id)).toEqual(["claude", "codex"]);
  });
});

describe("openUrlOf", () => {
  it("opens through the command runner: xdg-open on Linux, open on macOS", async () => {
    h = await harness({ openUrl: undefined });
    await openUrlOf(h.deps)("https://app.example/enroll#code=BCDFGHJK");
    expect(h.commands).toEqual([["xdg-open", "https://app.example/enroll#code=BCDFGHJK"]]);
    h.commands.length = 0;
    await openUrlOf({ ...h.deps, platform: "darwin" })("http://localhost:3000/");
    expect(h.commands).toEqual([["open", "http://localhost:3000/"]]);
  });

  it("refuses anything but http(s) and reports a failing opener", async () => {
    h = await harness({ openUrl: undefined });
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "bridge://run", "not a url"]) {
      await expect(openUrlOf(h.deps)(url)).rejects.toThrow();
    }
    expect(h.commands).toEqual([]);
    const failing = { ...h.deps, run: async () => ({ exitCode: 3, stdout: "", stderr: "" }) };
    await expect(openUrlOf(failing)("https://app.example/")).rejects.toThrow("exited with 3");
  });
});

describe("setupConfigOf", () => {
  const write = async (text: string) => {
    const file = path.join(h.deps.configDir, "bridge", "config.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };

  it("defaults to default-yes when there is no file, bad JSON or an unknown value", async () => {
    h = await harness();
    expect(await setupConfigOf(h.deps)).toEqual(DEFAULT_SETUP_CONFIG);
    await write("{nope");
    expect(await setupConfigOf(h.deps)).toEqual(DEFAULT_SETUP_CONFIG);
    await write(JSON.stringify({ setup: { service: "always" } }));
    expect(await setupConfigOf(h.deps)).toEqual(DEFAULT_SETUP_CONFIG);
    await write("null");
    expect(await setupConfigOf(h.deps)).toEqual(DEFAULT_SETUP_CONFIG);
  });

  it("reads setup.service from <config>/bridge/config.json, and an injected value wins", async () => {
    h = await harness();
    await write(JSON.stringify({ setup: { service: "ask" } }));
    expect(await setupConfigOf(h.deps)).toEqual({ service: "ask" });
    expect(await setupConfigOf({ ...h.deps, setupConfig: { service: "default-yes" } })).toEqual({ service: "default-yes" });
  });
});

describe("guardedWriter (`bridge status | head -1`)", () => {
  it("a reader that went away (EPIPE on a real pipe) is not a crash: onClosed runs once and later writes are dropped", async () => {
    // A child that closes its end of the pipe (as `head -1` does once it has its line) and lives on.
    const child = spawn("sh", ["-c", "exec 0<&-; echo ready; sleep 5"], { stdio: ["pipe", "pipe", "ignore"] });
    after(() => void child.kill());
    await once(child.stdout!, "data");
    let closed = 0;
    const write = guardedWriter(child.stdin!, { onClosed: () => void closed++ });
    for (let i = 0; i < 50 && closed === 0; i++) {
      write("status line\n");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(closed).toBe(1);
    write("more\n"); // dropped: no second error, no throw
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(1);
  });

  it("adds one error listener per stream however many writers are made, and other stream errors still throw", () => {
    const stream = new PassThrough();
    for (let i = 0; i < 20; i++) guardedWriter(stream);
    expect(stream.listenerCount("error")).toBe(1);
    expect(() => stream.emit("error", Object.assign(new Error("disk"), { code: "EIO" }))).toThrow("disk");
  });

  it("the real deps write through guarded writers", () => {
    createDefaultDeps({ HOME: "/nonexistent-home" });
    createDefaultDeps({ HOME: "/nonexistent-home" });
    // One guard each, not one per createDefaultDeps call.
    expect(process.stdout.listeners("error").length).toBeLessThanOrEqual(2);
  });
});

describe("the real deps on a closed stdout", () => {
  // Last in this file: it marks this worker's process.stdout closed.
  it("never exit on EPIPE: the command goes on to the end and returns its own code", () => {
    const deps = createDefaultDeps({ HOME: "/nonexistent-home" });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    after(() => exit.mockRestore());
    process.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    deps.stdout("dropped\n");
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("credentialsOf (BRIDGE_CREDENTIAL_STORE)", () => {
  async function bare(over: Record<string, string | undefined>) {
    h = await harness();
    const { credentials: _injected, ...rest } = h.deps;
    return { ...rest, env: { ...h.deps.env, ...over } };
  }

  it("without the override it is the OS keychain, through run: secret-tool on linux, security on macOS", async () => {
    for (const [platform, command] of [["linux", "secret-tool"], ["darwin", "security"]] as const) {
      const deps = { ...(await bare({})), platform };
      // Only which store command runs matters here; the harness answers every command with empty
      // output, which a real `security -g` never prints (the read parses its password line), so the read may fail.
      await credentialsOf(deps).get("demo/pairing.tokens").catch(() => null);
      expect(h.commands.at(-1)?.[0]).toBe(command);
      await h.cleanup();
    }
    const empty = await bare({ BRIDGE_CREDENTIAL_STORE: "" });
    expect(credentialStoreSettingOf(empty)).toEqual({ kind: "keychain" });
    await credentialsOf(empty).get("k");
    expect(h.commands.at(-1)?.[0]).toBe("secret-tool");
  });

  it("an injected store wins over the environment", async () => {
    const deps = await bare({ BRIDGE_CREDENTIAL_STORE: "file:/does/not/matter" });
    const injected = h.deps.credentials;
    expect(credentialsOf({ ...deps, credentials: injected })).toBe(injected);
  });

  it("file:<dir> selects a file store and the keychain is never called: set, get, replace, delete", async () => {
    const deps = await bare({});
    const fileDir = path.join(h.root, "creds");
    const withFile = { ...deps, env: { ...deps.env, BRIDGE_CREDENTIAL_STORE: `file:${fileDir}` } };
    expect(credentialStoreSettingOf(withFile)).toEqual({ kind: "file", dir: fileDir });
    const store = credentialsOf(withFile);
    expect(await store.get("demo/pairing.tokens")).toBeNull();
    await store.set("demo/pairing.tokens", "tok-1");
    await store.set("bridge/e2ee-identity-key/demo/runner-1", "wrap");
    await store.set("demo/pairing.tokens", "tok-2");
    expect(await store.get("demo/pairing.tokens")).toBe("tok-2");
    expect(await store.get("bridge/e2ee-identity-key/demo/runner-1")).toBe("wrap");
    await store.delete("demo/pairing.tokens");
    expect(await store.get("demo/pairing.tokens")).toBeNull();
    // Modes: the directory 0700, every credential file 0600; no temporary file is left behind.
    expect((await stat(fileDir)).mode & 0o777).toBe(0o700);
    const names = await readdir(fileDir);
    expect(names).toHaveLength(1);
    expect((await stat(path.join(fileDir, names[0]!))).mode & 0o777).toBe(0o600);
    // The keychain spy: run (secret-tool / security) was never called.
    expect(h.commands).toEqual([]);
  });

  it("a symlinked credential directory is refused through the CLI wiring too", async () => {
    const deps = await bare({});
    const real = path.join(h.root, "real");
    await mkdir(real, { mode: 0o700 });
    const link = path.join(h.root, "link");
    await symlink(real, link);
    const store = credentialsOf({ ...deps, env: { ...deps.env, BRIDGE_CREDENTIAL_STORE: `file:${link}` } });
    await expect(store.set("k", "v")).rejects.toThrow(/symbolic link/);
    expect(await readdir(real)).toEqual([]);
    expect(h.commands).toEqual([]);
  });

  it("anything but file:<absolute dir> is a usage error, not a quiet fall back to the keychain", async () => {
    for (const value of ["file:", "file:relative/dir", "keychain", "/abs/dir", "FILE:/abs"]) {
      const deps = await bare({ BRIDGE_CREDENTIAL_STORE: value });
      expect(() => credentialsOf(deps), value).toThrow(UsageError);
      await h.cleanup();
    }
  });
});

describe("the keychain probe", () => {
  it("nodeRun kills a command that outlives timeoutMs and rejects with ETIMEDOUT", async () => {
    const started = Date.now();
    await expect(nodeRun("sleep", ["30"], { timeoutMs: 100 })).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("the probe passes the command runner a finite, positive timeoutMs (an unbounded production probe would hang on a silent service)", async () => {
    h = await harness();
    delete h.deps.credentials;
    const seen: { command: string; timeoutMs: unknown }[] = [];
    h.deps.run = async (command, _args, options) => {
      seen.push({ command, timeoutMs: options?.timeoutMs });
      return { exitCode: 1, stdout: "", stderr: "" };
    };
    expect(await keychainUsability(h.deps)).toEqual({ usable: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.command).toBe("secret-tool");
    expect(Number.isFinite(seen[0]!.timeoutMs)).toBe(true);
    expect(seen[0]!.timeoutMs as number).toBeGreaterThan(0);
  });

  it("a probe that does not finish in time is not verified: unusable, marked timed out, with the unlock-or-file-store hint", async () => {
    h = await harness();
    delete h.deps.credentials;
    h.deps.run = async () => {
      throw Object.assign(new Error("secret-tool did not finish"), { code: "ETIMEDOUT" });
    };
    const result = await keychainUsability(h.deps);
    expect(result).toMatchObject({ usable: false, timedOut: true });
    if (result.usable) throw new Error("unreachable");
    const hint = keychainHint(result);
    expect(hint).toContain("did not answer within 5 s");
    expect(hint).toContain("unlock it and retry");
    expect(hint).toContain("BRIDGE_CREDENTIAL_STORE=file:<absolute directory>");
  });

  it("exit 0 and exit 1 with no output are usable; any other answer is not, with what the tool said", async () => {
    h = await harness();
    delete h.deps.credentials;
    const answer = (exitCode: number, stderr: string) => {
      h.deps.run = async () => ({ exitCode, stdout: "", stderr });
    };
    answer(0, "");
    expect(await keychainUsability(h.deps)).toEqual({ usable: true });
    answer(1, "");
    expect(await keychainUsability(h.deps)).toEqual({ usable: true });
    answer(1, "secret-tool: Cannot autolaunch D-Bus\u0007 without X11\nmore");
    expect(await keychainUsability(h.deps)).toEqual({ usable: false, reason: "secret-tool: Cannot autolaunch D-Bus without X11" });
    answer(1, "Cannot autolaunch D-Bus without X11 $DISPLAY");
    expect(await keychainUsability(h.deps)).toEqual({ usable: false, reason: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY" });
    answer(2, "");
    expect(await keychainUsability(h.deps)).toEqual({ usable: false, reason: "secret-tool exited 2" });
  });
});
