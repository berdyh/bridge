import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HANDLER_ADDED_LINE,
  HANDLER_MIME_LINE,
  HandleUrlRefused,
  desktopEntryOf,
  parseBridgeUrl,
  protocolHandlerFiles,
  protocolHandlerPaths,
  runHandleUrl,
  runProtocol,
  withOurMimeEntries,
  withoutOurMimeEntries,
} from "./protocol-handler.js";
import { type Harness, exists, harness } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const launcher = (): string => path.join(h.root, "home", ".local", "bin", "bridge");

describe("parseBridgeUrl", () => {
  it("accepts bridge://run and bridge://setup?url=<origin>", () => {
    expect(parseBridgeUrl("bridge://run")).toEqual({ kind: "run" });
    expect(parseBridgeUrl("bridge://setup?url=https%3A%2F%2Fapp.example")).toEqual({ kind: "setup", origin: "https://app.example" });
    expect(parseBridgeUrl("bridge://setup?url=https://app.example/")).toEqual({ kind: "setup", origin: "https://app.example" });
    expect(parseBridgeUrl("bridge://setup?url=https://app.example:8443")).toEqual({ kind: "setup", origin: "https://app.example:8443" });
    expect(parseBridgeUrl("bridge://setup?url=http://localhost:3000")).toEqual({ kind: "setup", origin: "http://localhost:3000" });
    expect(parseBridgeUrl("bridge://setup?url=http://127.0.0.1:3000")).toEqual({ kind: "setup", origin: "http://127.0.0.1:3000" });
    expect(parseBridgeUrl("bridge://setup?url=http://[::1]:3000")).toEqual({ kind: "setup", origin: "http://[::1]:3000" });
  });

  const refused: [string, string][] = [
    ["empty", ""],
    ["other scheme", "https://run"],
    ["javascript", "javascript:alert(1)"],
    ["javascript in url", "bridge://setup?url=javascript:alert(1)"],
    ["file url", "bridge://setup?url=file:///etc/passwd"],
    ["data url", "bridge://setup?url=data:text/html,x"],
    ["ftp", "bridge://setup?url=ftp://a.example"],
    ["http non-loopback", "bridge://setup?url=http://app.example"],
    ["http localhost lookalike", "bridge://setup?url=http://localhost.evil.example"],
    ["trailing-dot localhost", "bridge://setup?url=http://localhost."],
    ["unknown action", "bridge://exec"],
    ["run with query", "bridge://run?yes=1"],
    ["run with slash", "bridge://run/"],
    ["run with path", "bridge://run/x"],
    ["run with fragment", "bridge://run#x"],
    ["run prefix", "bridge://runx"],
    ["uppercase scheme", "BRIDGE://run"],
    ["setup without params", "bridge://setup"],
    ["setup empty query", "bridge://setup?"],
    ["setup without url", "bridge://setup?foo=https://a.example"],
    ["extra param", "bridge://setup?url=https://a.example&yes=1"],
    ["extra --yes param", "bridge://setup?url=https://a.example&--yes"],
    ["duplicate url", "bridge://setup?url=https://a.example&url=https://b.example"],
    ["fragment", "bridge://setup?url=https://a.example#x"],
    ["path in app url", "bridge://setup?url=https://a.example/path"],
    ["query in app url", "bridge://setup?url=https://a.example/%3Fx=1"],
    ["fragment in app url", "bridge://setup?url=https://a.example/%23x"],
    ["credentials", "bridge://setup?url=https://user:pw@a.example"],
    ["userinfo trick", "bridge://setup?url=https://a.example@evil.example"],
    ["backslash trick", "bridge://setup?url=https://a.example%5C@evil.example"],
    ["newline", "bridge://setup?url=https://a.example%0Abridge://run"],
    ["raw newline", "bridge://run\n"],
    ["carriage return", "bridge://setup?url=https://a.example%0D"],
    ["NUL", "bridge://setup?url=https://a.example%00"],
    ["escape sequence", "bridge://setup?url=https://a.example%1B%5B31m"],
    ["space", "bridge://setup?url=https://a.example%20--yes"],
    ["plus is a space", "bridge://setup?url=https://a.example+--yes"],
    ["raw space", "bridge://setup?url=https://a.example --yes"],
    ["unicode host", "bridge://setup?url=https://äpp.example"],
    ["percent-encoded unicode", "bridge://setup?url=https://%C3%A4pp.example"],
    ["C1 control", "bridge://run\u0085"],
    ["zero width", "bridge://run​"],
    ["shell characters in host", "bridge://setup?url=https://a$(id).example"],
    ["semicolon in host", "bridge://setup?url=https://a;b.example"],
    ["backtick in host", "bridge://setup?url=https://a%60id%60.example"],
    ["underscore host", "bridge://setup?url=https://a_b.example"],
    ["ipv6 literal over https", "bridge://setup?url=https://[2001:db8::1]"],
    ["relative url", "bridge://setup?url=//a.example"],
    ["bare host", "bridge://setup?url=a.example"],
    ["very long", `bridge://setup?url=https://${"a".repeat(3000)}.example`],
  ];
  it.each(refused)("refuses %s", (_name, raw) => {
    expect(() => parseBridgeUrl(raw)).toThrow(HandleUrlRefused);
  });

  it("only ever yields a normalized ASCII origin, whatever the input", () => {
    const alphabet = "abc.:/?&=%#@\\ \n-_~[]0123456789xnhtpsbridge";
    let seed = 7;
    const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let accepted = 0;
    for (let i = 0; i < 20000; i++) {
      const length = Math.floor(rand() * 40);
      let tail = "";
      for (let j = 0; j < length; j++) tail += alphabet[Math.floor(rand() * alphabet.length)];
      for (const raw of [`bridge://setup?url=https://${tail}`, `bridge://setup?url=${tail}`, `bridge://${tail}`]) {
        let parsed: ReturnType<typeof parseBridgeUrl> | undefined;
        try {
          parsed = parseBridgeUrl(raw);
        } catch (error) {
          expect(error).toBeInstanceOf(HandleUrlRefused);
        }
        if (parsed) {
          accepted++;
          if (parsed.kind === "setup") expect(parsed.origin).toMatch(/^https?:\/\/[a-z0-9.\-[\]:]+$/);
        }
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });
});

describe("handle-url", () => {
  it("bridge://run calls the start-runner action and opens nothing itself", async () => {
    h = await harness();
    let started = 0;
    expect(await runHandleUrl(["bridge://run"], h.deps, { startRunner: async () => void started++ })).toBe(0);
    expect(started).toBe(1);
    expect(h.terminals).toEqual([]);
  });

  it("bridge://run defaults to a terminal running `bridge run`, as an argv with no --yes", async () => {
    h = await harness();
    expect(await runHandleUrl(["bridge://run"], h.deps)).toBe(0);
    expect(h.terminals).toEqual([[launcher(), "run"]]);
  });

  it("bridge://setup opens a terminal running `bridge setup <origin>` and prints the origin", async () => {
    h = await harness();
    expect(await runHandleUrl(["bridge://setup?url=https%3A%2F%2Fapp.example%2F"], h.deps)).toBe(0);
    // `--from-link`: the one question defaults to no for a run a web page started.
    expect(h.terminals).toEqual([[launcher(), "setup", "https://app.example", "--from-link"]]);
    expect(h.out.join("")).toContain("https://app.example");
    expect(h.terminals.flat()).not.toContain("--yes");
  });

  it("uses deps.launcher when set", async () => {
    h = await harness({ launcher: "/opt/bridge/bin/bridge" });
    await runHandleUrl(["bridge://run"], h.deps);
    expect(h.terminals).toEqual([["/opt/bridge/bin/bridge", "run"]]);
  });

  it("refuses with exit 2, a message and no side effects", async () => {
    h = await harness();
    let started = 0;
    for (const raw of ["javascript:alert(1)", "bridge://setup?url=https://a.example&yes=1", "bridge://run\n", "bridge://exec"]) {
      expect(await runHandleUrl([raw], h.deps, { startRunner: async () => void started++ })).toBe(2);
    }
    expect(started).toBe(0);
    expect(h.terminals).toEqual([]);
    expect(h.commands).toEqual([]);
    expect(h.err.join("")).toContain("refused");
  });

  it("never echoes control characters from the URL", async () => {
    h = await harness();
    await runHandleUrl(["bridge://run\u001b[31m\u0085evil\n"], h.deps);
    // eslint-disable-next-line no-control-regex
    expect(h.err.join("")).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  });

  it("needs exactly one argument and no flags", async () => {
    h = await harness();
    await expect(runHandleUrl([], h.deps)).rejects.toThrow(/usage/);
    await expect(runHandleUrl(["bridge://run", "bridge://run"], h.deps)).rejects.toThrow(/usage/);
    await expect(runHandleUrl(["--yes", "bridge://run"], h.deps)).rejects.toThrow();
  });

  it("reports a terminal that cannot be opened with exit 1", async () => {
    h = await harness({
      openTerminal: async () => {
        throw new Error("no terminal");
      },
    });
    expect(await runHandleUrl(["bridge://run"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("no terminal");
  });
});

describe("protocol install and uninstall", () => {
  it("lists the desktop file, mimeapps.list and the added line before asking; a no writes nothing", async () => {
    h = await harness();
    h.answers.yes = false;
    expect(await runProtocol(["install"], h.deps)).toBe(1);
    const files = protocolHandlerFiles(h.deps);
    const out = h.out.join("");
    expect(out).toContain(files.desktopFile);
    expect(out).toContain(files.mimeapps);
    expect(out).toContain(HANDLER_MIME_LINE);
    expect(out).toContain(HANDLER_ADDED_LINE);
    expect(h.questions).toHaveLength(1);
    expect(h.commands).toEqual([]);
    expect(await exists(files.desktopFile)).toBe(false);
    expect(await exists(h.deps.dataDir)).toBe(false);
  });

  it("--yes still prints the paths and skips only the question", async () => {
    h = await harness();
    expect(await runProtocol(["install", "--yes"], h.deps)).toBe(0);
    expect(h.questions).toEqual([]);
    expect(h.out.join("")).toContain(protocolHandlerFiles(h.deps).desktopFile);
  });

  const read = (): Promise<string> => readFile(protocolHandlerFiles(h.deps).mimeapps, "utf8");
  const both = `[Default Applications]\n${HANDLER_MIME_LINE}\n\n[Added Associations]\n${HANDLER_ADDED_LINE}\n`;

  it("writes the desktop entry and both mimeapps.list lines into an absent file, running no command", async () => {
    h = await harness();
    expect(await runProtocol(["install"], h.deps)).toBe(0);
    const files = protocolHandlerFiles(h.deps);
    expect(files.desktopFile).toBe(path.join(h.root, "data", "applications", "bridge-url-handler.desktop"));
    const entry = await readFile(files.desktopFile, "utf8");
    expect(entry).toContain(`Exec=${launcher()} handle-url %u`);
    expect(entry).toContain("MimeType=x-scheme-handler/bridge;");
    expect(h.commands).toEqual([]);
    expect(await read()).toBe(both);
  });

  it("never invokes xdg-mime or any other command", async () => {
    h = await harness();
    const seen: string[] = [];
    h.deps.run = async (command) => {
      seen.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await runProtocol(["install", "--yes"], h.deps);
    await runProtocol(["uninstall", "--yes"], h.deps);
    expect(seen).toEqual([]);
    expect(h.commands).toEqual([]);
  });

  it("writes into an empty file, and into one with other entries in both sections", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    await mkdir(h.deps.configDir, { recursive: true });
    await writeFile(files.mimeapps, "");
    await runProtocol(["install", "--yes"], h.deps);
    expect(await read()).toBe(both);

    await runProtocol(["uninstall", "--yes"], h.deps);
    expect(await read()).toBe("[Default Applications]\n\n[Added Associations]\n");
    const original =
      "[Added Associations]\ntext/html=firefox.desktop;\n\n[Default Applications]\nx-scheme-handler/http=firefox.desktop\nx-scheme-handler/bridge=old.desktop\n";
    await writeFile(files.mimeapps, original);
    await runProtocol(["install", "--yes"], h.deps);
    expect(await read()).toBe(
      `[Added Associations]\n${HANDLER_ADDED_LINE}\ntext/html=firefox.desktop;\n\n[Default Applications]\nx-scheme-handler/http=firefox.desktop\n${HANDLER_MIME_LINE}\n`,
    );
  });

  it("merges our token into an existing Added Associations list without clobbering it", () => {
    const text = "[Added Associations]\nx-scheme-handler/bridge=other.desktop;third.desktop\n";
    expect(withOurMimeEntries(text)).toBe(
      `[Added Associations]\nx-scheme-handler/bridge=other.desktop;third.desktop;bridge-url-handler.desktop;\n[Default Applications]\n${HANDLER_MIME_LINE}\n`.replace(
        "[Default Applications]",
        "\n[Default Applications]",
      ),
    );
    // Already present: left as is.
    const present = `[Added Associations]\nx-scheme-handler/bridge=a.desktop;bridge-url-handler.desktop;\n`;
    expect(withOurMimeEntries(present)).toContain(present);
  });

  it("is idempotent: installing twice leaves the same files", async () => {
    h = await harness();
    await runProtocol(["install", "--yes"], h.deps);
    const files = protocolHandlerFiles(h.deps);
    const first = [await readFile(files.desktopFile, "utf8"), await read()];
    expect(await runProtocol(["install", "--yes"], h.deps)).toBe(0);
    expect([await readFile(files.desktopFile, "utf8"), await read()]).toEqual(first);
  });

  it("round-trips a CRLF file byte for byte except our lines", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    await mkdir(h.deps.configDir, { recursive: true });
    const original = "[Added Associations]\r\ntext/html=firefox.desktop;\r\n\r\n[Default Applications]\r\nx-scheme-handler/http=firefox.desktop\r\n";
    await writeFile(files.mimeapps, original);
    await runProtocol(["install", "--yes"], h.deps);
    const installed = await read();
    expect(installed).toContain(`${HANDLER_MIME_LINE}\r\n`);
    expect(installed).toContain(`${HANDLER_ADDED_LINE}\r\n`);
    expect(installed.replace(/\r\n/g, "")).not.toContain("\n");
    await runProtocol(["uninstall", "--yes"], h.deps);
    expect(await read()).toBe(original);
  });

  it("removing our entry when it is the unterminated last line keeps the previous line's terminator", () => {
    expect(withoutOurMimeEntries(`[Default Applications]\nx=y\n${HANDLER_MIME_LINE}`)).toBe("[Default Applications]\nx=y\n");
    expect(withoutOurMimeEntries(`[Default Applications]\r\nx=y\r\n${HANDLER_MIME_LINE}`)).toBe("[Default Applications]\r\nx=y\r\n");
    expect(withoutOurMimeEntries(`[Added Associations]\r\na=b;\r\n${HANDLER_ADDED_LINE}`)).toBe("[Added Associations]\r\na=b;\r\n");
  });

  it("uninstall removes only our token from a shared Added Associations list", () => {
    expect(withoutOurMimeEntries("[Added Associations]\nx-scheme-handler/bridge=a.desktop;bridge-url-handler.desktop;b.desktop;\n")).toBe(
      "[Added Associations]\nx-scheme-handler/bridge=a.desktop;b.desktop;\n",
    );
  });

  it("a symlinked mimeapps.list stays a symlink and its target is updated; the consent shows the target", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    await mkdir(h.deps.configDir, { recursive: true });
    const dotfiles = path.join(h.root, "dotfiles");
    await mkdir(dotfiles);
    const real = path.join(dotfiles, "mimeapps.list");
    await writeFile(real, "[Default Applications]\nother=a.desktop\n");
    await symlink(real, files.mimeapps);
    await runProtocol(["install", "--yes"], h.deps);
    expect((await lstat(files.mimeapps)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toContain(HANDLER_ADDED_LINE);
    expect(await readFile(real, "utf8")).toContain("other=a.desktop");
    expect(h.out.join("")).toContain(real);
    expect((await readdir(dotfiles)).sort()).toEqual(["mimeapps.list"]);
    await runProtocol(["uninstall", "--yes"], h.deps);
    expect((await lstat(files.mimeapps)).isSymbolicLink()).toBe(true);
    // Sections we created stay as empty headers; every other line is untouched.
    expect(await readFile(real, "utf8")).toBe("[Default Applications]\nother=a.desktop\n\n[Added Associations]\n");
  });

  it("refuses a symlinked or non-regular desktop file and changes nothing", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    await mkdir(path.dirname(files.desktopFile), { recursive: true });
    const victim = path.join(h.root, "victim.txt");
    await writeFile(victim, "precious");
    await symlink(victim, files.desktopFile);
    await expect(runProtocol(["install", "--yes"], h.deps)).rejects.toThrow(/not a regular file/);
    await expect(runProtocol(["uninstall", "--yes"], h.deps)).rejects.toThrow(/not a regular file/);
    expect(await readFile(victim, "utf8")).toBe("precious");
    expect((await lstat(files.desktopFile)).isSymbolicLink()).toBe(true);
    expect(await exists(files.mimeapps)).toBe(false);
  });

  it("matches `key = value` with whitespace, editing the existing line in place", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    await mkdir(h.deps.configDir, { recursive: true });
    await writeFile(files.mimeapps, "[Added Associations]\nx-scheme-handler/bridge = other.desktop;\n[Default Applications]\n  x-scheme-handler/bridge  =  other.desktop\n");
    await runProtocol(["install", "--yes"], h.deps);
    const text = await read();
    expect(text.match(/x-scheme-handler\/bridge\s*=/g)).toHaveLength(2);
    expect(text).toBe(`[Added Associations]\nx-scheme-handler/bridge=other.desktop;bridge-url-handler.desktop;\n[Default Applications]\n${HANDLER_MIME_LINE}\n`);
    await runProtocol(["uninstall", "--yes"], h.deps);
    expect(await read()).toBe("[Added Associations]\nx-scheme-handler/bridge=other.desktop;\n[Default Applications]\n");
    expect(withoutOurMimeEntries("[Default Applications]\nx-scheme-handler/bridge = bridge-url-handler.desktop\n")).toBe("[Default Applications]\n");
  });

  it("refuses a file with duplicate bridge keys in one section", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    await mkdir(h.deps.configDir, { recursive: true });
    const dup = "[Default Applications]\nx-scheme-handler/bridge=a.desktop\nx-scheme-handler/bridge = b.desktop\n";
    await writeFile(files.mimeapps, dup);
    await expect(runProtocol(["install", "--yes"], h.deps)).rejects.toThrow(/more than once/);
    await expect(runProtocol(["uninstall", "--yes"], h.deps)).rejects.toThrow(/more than once/);
    expect(await read()).toBe(dup);
    expect(await exists(files.desktopFile)).toBe(false);
  });

  it("aborts without writing when the symlink target changes while the prompt is open", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    await mkdir(h.deps.configDir, { recursive: true });
    const one = path.join(h.root, "one.list");
    const two = path.join(h.root, "two.list");
    await writeFile(one, "a=b\n");
    await writeFile(two, "c=d\n");
    await symlink(one, files.mimeapps);
    h.deps.confirm = async () => {
      await rm(files.mimeapps);
      await symlink(two, files.mimeapps);
      return true;
    };
    await expect(runProtocol(["install"], h.deps)).rejects.toThrow(/changed while waiting for confirmation/);
    expect(await readFile(one, "utf8")).toBe("a=b\n");
    expect(await readFile(two, "utf8")).toBe("c=d\n");
    expect(await exists(files.desktopFile)).toBe(false);
    await rm(files.mimeapps);
    await symlink(one, files.mimeapps);
    await writeFile(one, `[Default Applications]\n${HANDLER_MIME_LINE}\n`);
    h.deps.confirm = async () => {
      await rm(files.mimeapps);
      await symlink(two, files.mimeapps);
      return true;
    };
    await expect(runProtocol(["uninstall"], h.deps)).rejects.toThrow(/changed while waiting for confirmation/);
    expect(await readFile(one, "utf8")).toBe(`[Default Applications]\n${HANDLER_MIME_LINE}\n`);
  });

  it("refuses a mimeapps.list that is not valid UTF-8 and leaves its bytes alone", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    await mkdir(h.deps.configDir, { recursive: true });
    const bytes = Buffer.concat([Buffer.from("[Added Associations]\n# "), Buffer.from([0xff]), Buffer.from("\n")]);
    await writeFile(files.mimeapps, bytes);
    await expect(runProtocol(["install", "--yes"], h.deps)).rejects.toThrow(/not valid UTF-8/);
    await expect(runProtocol(["uninstall", "--yes"], h.deps)).rejects.toThrow(/not valid UTF-8/);
    expect(await readFile(files.mimeapps)).toEqual(bytes);
    expect(await exists(files.desktopFile)).toBe(false);
  });

  it("appending a missing section terminates an unterminated final line (accepted)", () => {
    const out = withOurMimeEntries(`[Default Applications]\n${HANDLER_MIME_LINE}`);
    expect(out).toBe(`[Default Applications]\n${HANDLER_MIME_LINE}\n\n[Added Associations]\n${HANDLER_ADDED_LINE}\n`);
  });

  it("fails before writing anything when mimeapps.list cannot be read", async () => {
    h = await harness();
    await mkdir(h.deps.configDir, { recursive: true });
    // A directory where the file should be makes the read fail.
    await mkdir(protocolHandlerFiles(h.deps).mimeapps);
    await expect(runProtocol(["install", "--yes"], h.deps)).rejects.toThrow(/not a regular file/);
    expect(await exists(protocolHandlerFiles(h.deps).desktopFile)).toBe(false);
  });

  it("keeps a desktop entry that was already installed when a re-install fails", async () => {
    h = await harness();
    await runProtocol(["install", "--yes"], h.deps);
    const files = protocolHandlerFiles(h.deps);
    await rm(files.mimeapps);
    await mkdir(files.mimeapps);
    await expect(runProtocol(["install", "--yes"], h.deps)).rejects.toThrow(/not a regular file/);
    expect(await exists(files.desktopFile)).toBe(true);
  });

  it("uninstall refuses, changing nothing, if mimeapps.list is edited during the prompt (the plan is bound to what consent listed)", async () => {
    h = await harness();
    await runProtocol(["install", "--yes"], h.deps);
    const files = protocolHandlerFiles(h.deps);
    let edited = "";
    h.deps.confirm = async () => {
      // The desktop edits mimeapps.list while the question is open.
      const now = await readFile(files.mimeapps, "utf8");
      edited = `${now}[Added Associations]\nimage/png=viewer.desktop;\n`;
      await writeFile(files.mimeapps, edited);
      return true;
    };
    await expect(runProtocol(["uninstall"], h.deps)).rejects.toThrow(/changed while waiting for confirmation/);
    expect(await readFile(files.mimeapps, "utf8")).toBe(edited);
    expect(await exists(files.desktopFile)).toBe(true);
  });

  it("refuses, changing nothing, when the parent directory of mimeapps.list is retargeted during consent", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    const dirA = path.join(h.root, "dirA");
    const dirB = path.join(h.root, "dirB");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const text = `[Default Applications]\n${HANDLER_MIME_LINE}\n`;
    await writeFile(path.join(dirA, "mimeapps.list"), text);
    await writeFile(path.join(dirB, "mimeapps.list"), text);
    await rm(path.dirname(files.mimeapps), { recursive: true, force: true });
    await mkdir(path.dirname(path.dirname(files.mimeapps)), { recursive: true });
    await symlink(dirA, path.dirname(files.mimeapps));
    for (const sub of ["install", "uninstall"] as const) {
      h.deps.confirm = async () => {
        await rm(path.dirname(files.mimeapps));
        await symlink(dirB, path.dirname(files.mimeapps));
        return true;
      };
      await expect(runProtocol([sub], h.deps)).rejects.toThrow(/changed while waiting for confirmation/);
      expect(await readFile(path.join(dirA, "mimeapps.list"), "utf8")).toBe(text);
      expect(await readFile(path.join(dirB, "mimeapps.list"), "utf8")).toBe(text);
      await rm(path.dirname(files.mimeapps));
      await symlink(dirA, path.dirname(files.mimeapps));
    }
  });

  it("binds a canonical destination when the parent is missing: retargeting an ancestor link during consent refuses", async () => {
    for (const which of ["desktop", "mimeapps"] as const) {
      h = await harness();
      const a = path.join(h.root, `A-${which}`);
      const b = path.join(h.root, `B-${which}`);
      const link = path.join(h.root, `link-${which}`);
      await mkdir(a, { recursive: true });
      await mkdir(b, { recursive: true });
      await symlink(a, link);
      const deps = { ...h.deps };
      if (which === "desktop") deps.dataDir = path.join(link, "data");
      else deps.configDir = path.join(link, "config");
      deps.confirm = async () => {
        await rm(link);
        await symlink(b, link);
        return true;
      };
      await expect(runProtocol(["install"], deps)).rejects.toThrow(/changed while waiting for confirmation/);
      expect(await readdir(a)).toEqual([]);
      expect(await readdir(b)).toEqual([]);
      await h.cleanup();
    }
  });

  it("refuses a multi-hop dangling symlink chain and leaves the intermediate link untouched", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    await mkdir(path.dirname(files.mimeapps), { recursive: true });
    const intermediate = path.join(h.root, "intermediate");
    const missing = path.join(h.root, "missing.list");
    await symlink(missing, intermediate);
    await symlink(intermediate, files.mimeapps);
    for (const sub of ["install", "uninstall"] as const) {
      await expect(runProtocol([sub, "--yes"], h.deps)).rejects.toThrow(/symlink whose target does not exist/);
    }
    expect((await lstat(intermediate)).isSymbolicLink()).toBe(true);
    expect(await exists(missing)).toBe(false);
    expect((await lstat(files.mimeapps)).isSymbolicLink()).toBe(true);
    expect(await exists(files.desktopFile)).toBe(false);
  });

  it("treats an indented section header as a header: uninstall leaves Removed Associations alone", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    await mkdir(h.deps.configDir, { recursive: true });
    const text = "[Default Applications]\n [Removed Associations]\nx-scheme-handler/bridge=bridge-url-handler.desktop\n";
    await writeFile(files.mimeapps, text);
    expect(withoutOurMimeEntries(text)).toBeUndefined();
    expect(await runProtocol(["uninstall", "--yes"], h.deps)).toBe(0);
    expect(await readFile(files.mimeapps, "utf8")).toBe(text);
  });

  it("install sees an indented [Added Associations] header and merges into it instead of adding a second section", () => {
    const out = withOurMimeEntries("  [Added Associations]  \nx-scheme-handler/bridge=other.desktop;\n");
    expect(out.match(/\[Added Associations\]/g)).toHaveLength(1);
    expect(out).toContain("x-scheme-handler/bridge=other.desktop;bridge-url-handler.desktop;");
  });

  it("uninstall validates the fresh mimeapps.list before removing the desktop entry", async () => {
    h = await harness();
    await runProtocol(["install", "--yes"], h.deps);
    const files = protocolHandlerFiles(h.deps);
    const dup = "[Default Applications]\nx-scheme-handler/bridge=bridge-url-handler.desktop\nx-scheme-handler/bridge=b.desktop\n";
    h.deps.confirm = async () => {
      await writeFile(files.mimeapps, dup);
      return true;
    };
    await expect(runProtocol(["uninstall"], h.deps)).rejects.toThrow(/more than once/);
    expect(await exists(files.desktopFile)).toBe(true);
    expect(await readFile(files.mimeapps, "utf8")).toBe(dup);
  });

  it("uninstall keeps the desktop entry when mimeapps.list turns into invalid UTF-8 during the prompt", async () => {
    h = await harness();
    await runProtocol(["install", "--yes"], h.deps);
    const files = protocolHandlerFiles(h.deps);
    const bad = Buffer.from([0x5b, 0xff, 0xfe, 0x5d, 0x0a]);
    h.deps.confirm = async () => {
      await writeFile(files.mimeapps, bad);
      return true;
    };
    await expect(runProtocol(["uninstall"], h.deps)).rejects.toThrow(/not valid UTF-8/);
    expect(await exists(files.desktopFile)).toBe(true);
    expect(await readFile(files.mimeapps)).toEqual(bad);
  });

  it("uninstall validates fresh mimeapps.list even when the entries initially pointed elsewhere", async () => {
    for (const injected of [
      Buffer.from("[Default Applications]\nx-scheme-handler/bridge=a.desktop\nx-scheme-handler/bridge=b.desktop\n"),
      Buffer.from([0x5b, 0xff, 0xfe, 0x5d, 0x0a]),
    ]) {
      h = await harness();
      await runProtocol(["install", "--yes"], h.deps);
      const files = protocolHandlerFiles(h.deps);
      await writeFile(files.mimeapps, "[Default Applications]\nx-scheme-handler/bridge=other.desktop\n");
      h.deps.confirm = async () => {
        await writeFile(files.mimeapps, injected);
        return true;
      };
      await expect(runProtocol(["uninstall"], h.deps)).rejects.toThrow(/more than once|not valid UTF-8/);
      expect(await exists(files.desktopFile)).toBe(true);
      expect(await readFile(files.mimeapps)).toEqual(injected);
      await h.cleanup();
    }
  });

  it("uninstall refuses, changing nothing, if our line vanished while the prompt was open", async () => {
    h = await harness();
    await runProtocol(["install", "--yes"], h.deps);
    const files = protocolHandlerFiles(h.deps);
    const theirs = "[Default Applications]\nx-scheme-handler/bridge=other.desktop\n";
    h.deps.confirm = async () => {
      await writeFile(files.mimeapps, theirs);
      return true;
    };
    await expect(runProtocol(["uninstall"], h.deps)).rejects.toThrow(/changed while waiting for confirmation/);
    expect(await readFile(files.mimeapps, "utf8")).toBe(theirs);
    expect(await exists(files.desktopFile)).toBe(true);
  });

  it("uninstall refuses if our entry appears in mimeapps.list during consent (consent did not list it)", async () => {
    h = await harness();
    await runProtocol(["install", "--yes"], h.deps);
    const files = protocolHandlerFiles(h.deps);
    const elsewhere = "[Default Applications]\nx-scheme-handler/bridge=other.desktop\n";
    const ours = "[Default Applications]\nx-scheme-handler/bridge=bridge-url-handler.desktop\n";
    await writeFile(files.mimeapps, elsewhere);
    h.deps.confirm = async () => {
      await writeFile(files.mimeapps, ours);
      return true;
    };
    await expect(runProtocol(["uninstall"], h.deps)).rejects.toThrow(/changed while waiting for confirmation/);
    expect(await readFile(files.mimeapps, "utf8")).toBe(ours);
    expect(await exists(files.desktopFile)).toBe(true);
  });

  it("install refuses if mimeapps.list stops needing a write during consent", async () => {
    h = await harness();
    await runProtocol(["install", "--yes"], h.deps);
    const files = protocolHandlerFiles(h.deps);
    const installed = await readFile(files.mimeapps, "utf8");
    const desktopBefore = await readFile(files.desktopFile, "utf8");
    const elsewhere = "[Default Applications]\nx-scheme-handler/bridge=other.desktop\n";
    h.deps.confirm = async () => {
      await writeFile(files.mimeapps, elsewhere);
      return true;
    };
    // At prompt time nothing needed writing in mimeapps.list; during consent it does.
    await expect(runProtocol(["install"], h.deps)).rejects.toThrow(/changed while waiting for confirmation/);
    expect(await readFile(files.mimeapps, "utf8")).toBe(elsewhere);
    expect(await readFile(files.desktopFile, "utf8")).toBe(desktopBefore);
    expect(installed).toContain(HANDLER_MIME_LINE);
  });

  it("uninstall removes the entry and only our line, leaving every other byte of mimeapps.list", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    await mkdir(h.deps.configDir, { recursive: true });
    const original =
      "# my mime apps\r\n[Added Associations]\ntext/html=firefox.desktop;\n\n[Default Applications]\nx-scheme-handler/http=firefox.desktop\nx-scheme-handler/bridge2=other.desktop\nx-scheme-handler/mailto=thunderbird.desktop\n\n[Removed Associations]\nx-scheme-handler/bridge=bridge-url-handler.desktop\n";
    await writeFile(files.mimeapps, original);
    await runProtocol(["install", "--yes"], h.deps);
    const installed = await readFile(files.mimeapps, "utf8");
    expect(installed).toContain(`${HANDLER_MIME_LINE}\r\n`);
    expect(installed).toContain(`${HANDLER_ADDED_LINE}\r\n`);

    h.out.length = 0;
    expect(await runProtocol(["uninstall"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain(files.desktopFile);
    expect(h.out.join("")).toContain(files.mimeapps);
    expect(await exists(files.desktopFile)).toBe(false);
    // Byte for byte what we started with, including the lookalike lines under other sections.
    expect(await readFile(files.mimeapps, "utf8")).toBe(original);
  });

  it("leaves mimeapps.list alone when the bridge entry now points at another application", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    await mkdir(path.dirname(files.desktopFile), { recursive: true });
    await mkdir(h.deps.configDir, { recursive: true });
    await writeFile(files.desktopFile, desktopEntryOf(launcher()));
    const mine = "[Default Applications]\nx-scheme-handler/bridge=my-own-handler.desktop\n";
    await writeFile(files.mimeapps, mine);
    expect(await runProtocol(["uninstall", "--yes"], h.deps)).toBe(0);
    expect(await readFile(files.mimeapps, "utf8")).toBe(mine);
    expect(await exists(files.desktopFile)).toBe(false);
    expect(h.out.join("")).not.toContain("only the line");
  });

  it("uninstall follows a symlinked mimeapps.list without replacing it", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    await mkdir(h.deps.configDir, { recursive: true });
    const real = path.join(h.root, "dotfiles-mimeapps.list");
    await writeFile(real, `[Default Applications]\n${HANDLER_MIME_LINE}\nother=a.desktop\n`);
    await symlink(real, files.mimeapps);
    expect(await runProtocol(["uninstall", "--yes"], h.deps)).toBe(0);
    expect(await readFile(real, "utf8")).toBe("[Default Applications]\nother=a.desktop\n");
    expect(await readFile(files.mimeapps, "utf8")).toBe("[Default Applications]\nother=a.desktop\n");
  });

  it("uninstall with nothing installed asks nothing and exits 0; a no changes nothing", async () => {
    h = await harness();
    expect(await runProtocol(["uninstall"], h.deps)).toBe(0);
    expect(h.questions).toEqual([]);

    await runProtocol(["install", "--yes"], h.deps);
    h.answers.yes = false;
    expect(await runProtocol(["uninstall"], h.deps)).toBe(1);
    expect(await exists(protocolHandlerFiles(h.deps).desktopFile)).toBe(true);
    expect(await readFile(protocolHandlerFiles(h.deps).mimeapps, "utf8")).toContain(HANDLER_MIME_LINE);
  });

  it("uninstalling twice is a no-op the second time", async () => {
    h = await harness();
    await runProtocol(["install", "--yes"], h.deps);
    expect(await runProtocol(["uninstall", "--yes"], h.deps)).toBe(0);
    h.out.length = 0;
    expect(await runProtocol(["uninstall", "--yes"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("nothing to remove");
  });

  it("says the handler is Linux-only elsewhere and exits 0 without touching anything", async () => {
    h = await harness({ platform: "darwin" });
    expect(await runProtocol(["install"], h.deps)).toBe(0);
    expect(await runProtocol(["uninstall"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("Linux-only");
    expect(h.commands).toEqual([]);
    expect(h.questions).toEqual([]);
    expect(protocolHandlerPaths(h.deps)).toEqual([]);
  });

  it("exports the paths for doctor --paths and the uninstall manifest", async () => {
    h = await harness();
    const files = protocolHandlerFiles(h.deps);
    expect(protocolHandlerPaths(h.deps).map((e) => [e.path, e.removeOnUninstall])).toEqual([
      [files.desktopFile, true],
      [files.mimeapps, false],
    ]);
  });

  it("rejects bad usage", async () => {
    h = await harness();
    await expect(runProtocol([], h.deps)).rejects.toThrow(/usage/);
    await expect(runProtocol(["install", "extra"], h.deps)).rejects.toThrow(/usage/);
  });
});

describe("desktop entry", () => {
  it("quotes a launcher with spaces and refuses one the Exec key cannot carry", () => {
    expect(desktopEntryOf("/home/a b/bin/bridge")).toContain('Exec="/home/a b/bin/bridge" handle-url %u');
    for (const bad of ["relative/bridge", "/x/$HOME/bridge", "/x/\"y/bridge", "/x/%u/bridge", "/x/`id`/bridge", "/x/a\nb/bridge", "/x/a\\b"]) {
      expect(() => desktopEntryOf(bad)).toThrow(/cannot be used/);
    }
  });

  it("withoutOurMimeEntries keeps text byte for byte when there is nothing of ours", () => {
    expect(withoutOurMimeEntries("[Default Applications]\na=b.desktop\n")).toBeUndefined();
    expect(withoutOurMimeEntries("")).toBeUndefined();
    expect(withoutOurMimeEntries(`[Default Applications]\n${HANDLER_MIME_LINE};\r\nx=y\r\n`)).toBe("[Default Applications]\nx=y\r\n");
  });
});
