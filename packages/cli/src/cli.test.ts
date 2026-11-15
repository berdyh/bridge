import { describe, expect, it } from "vitest";

import { createDefaultDeps, helpText, runCli } from "./cli.js";
import { harness } from "./testkit.js";

describe("createDefaultDeps", () => {
  it("derives the base dirs from XDG variables, then from HOME", () => {
    const xdg = createDefaultDeps({ HOME: "/h", XDG_CONFIG_HOME: "/c", XDG_DATA_HOME: "/d" });
    expect([xdg.configDir, xdg.dataDir]).toEqual(["/c", "/d"]);
    const home = createDefaultDeps({ HOME: "/h" });
    expect([home.configDir, home.dataDir]).toEqual(["/h/.config", "/h/.local/share"]);
  });
});

describe("command parsing", () => {
  const COMMANDS = ["setup", "connect", "run", "enroll", "status", "browsers", "apps", "plugin", "doctor", "service", "self", "uninstall", "protocol"];

  it("--help lists every command and exits 0", async () => {
    const h = await harness();
    expect(await runCli(["--help"], h.deps)).toBe(0);
    const text = h.out.join("");
    for (const c of COMMANDS) expect(text).toContain(`  ${c} `);
    expect(text).toBe(helpText());
    // The URL handler is run by the desktop entry, not typed: it is not advertised.
    expect(text).not.toContain("handle-url");
    await h.cleanup();
  });

  it("the agent command lists the adapter install", async () => {
    const h = await harness();
    expect(await runCli(["--help"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("agent install <claude|codex> [--yes]");
    h.out.length = 0;
    expect(await runCli(["agent", "--help"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("agent install <claude|codex> [--yes]");
    h.err.length = 0;
    expect(await runCli(["agent", "install"], h.deps)).toBe(2);
    expect(h.err.join("")).toContain("usage: bridge agent install <claude|codex> [--yes]");
    // Both agents are known names; without a terminal and without --yes neither is installed.
    expect(await runCli(["agent", "install", "codex"], h.deps)).toBe(2);
    expect(await runCli(["agent", "install", "nope"], h.deps)).toBe(2);
    expect(h.commands).toEqual([]);
    await h.cleanup();
  });

  it("registers the hidden handle-url, and refuses what is not a bridge:// link", async () => {
    const h = await harness();
    expect(await runCli(["handle-url", "https://evil.example"], h.deps)).toBe(2);
    expect(h.err.join("")).toContain("refused");
    expect(await runCli(["handle-url", "--help"], h.deps)).toBe(0);
    await h.cleanup();
  });

  it("no command prints the help on stderr and exits 2", async () => {
    const h = await harness();
    expect(await runCli([], h.deps)).toBe(2);
    expect(h.err.join("")).toContain("Usage: bridge");
    await h.cleanup();
  });

  it("an unknown command or flag is a usage error (exit 2) that touches nothing", async () => {
    const h = await harness();
    expect(await runCli(["nope"], h.deps)).toBe(2);
    expect(h.err.join("")).toContain("unknown command 'nope'");
    h.err.length = 0;
    expect(await runCli(["doctor", "--bogus"], h.deps)).toBe(2);
    expect(await runCli(["connect"], h.deps)).toBe(2);
    expect(await runCli(["apps", "frobnicate"], h.deps)).toBe(2);
    expect(await runCli(["service", "restart"], h.deps)).toBe(2);
    expect(await runCli(["setup"], h.deps)).toBe(2);
    expect(await runCli(["status", "extra"], h.deps)).toBe(2);
    expect(await runCli(["protocol", "frobnicate"], h.deps)).toBe(2);
    expect(await runCli(["self", "frobnicate"], h.deps)).toBe(2);
    expect(h.commands).toEqual([]);
    await h.cleanup();
  });

  it("<command> --help shows that command's usage without running it", async () => {
    const h = await harness();
    expect(await runCli(["connect", "--help"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("bridge connect <app-url>");
    await h.cleanup();
  });

  it("plugin --help names every plugin command and the three sources", async () => {
    const h = await harness();
    expect(await runCli(["plugin", "--help"], h.deps)).toBe(0);
    const text = h.out.join("");
    for (const part of ["add <path", "https://...tgz --sha256 <hex>", "npm:<name>@<version>", "[--integrity <sri>]", "[--replace]", "list", "remove <id> [--keep-data]", "revoke <id>", "audit <id>"]) expect(text).toContain(part);
    await h.cleanup();
  });

  it("--help lists the flags its commands take: --no-restart on plugin add, remove and revoke, --yes on apps remove", async () => {
    const h = await harness();
    expect(await runCli(["plugin", "--help"], h.deps)).toBe(0);
    const plugin = h.out.join("");
    for (const part of ["[--replace] [--yes] [--no-restart] | list", "remove <id> [--keep-data] [--yes] [--no-restart]", "revoke <id> [--yes] [--no-restart]"]) expect(plugin).toContain(part);
    h.out.length = 0;
    expect(await runCli(["apps", "--help"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("remove <app> [--yes]");
    await h.cleanup();
  });

  it("--version prints the version", async () => {
    const h = await harness();
    expect(await runCli(["--version"], h.deps)).toBe(0);
    expect(h.out.join("")).toMatch(/^\d+\.\d+\.\d+\n$/);
    await h.cleanup();
  });
});
