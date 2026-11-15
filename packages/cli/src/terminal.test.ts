import { afterEach, describe, expect, it } from "vitest";

import { type Harness, harness } from "./testkit.js";
import { openTerminalOf, terminalArgv } from "./terminal.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("terminal", () => {
  it("uses the injected openTerminal as is", async () => {
    h = await harness();
    await openTerminalOf(h.deps)(["/x/bridge", "run"]);
    expect(h.terminals).toEqual([["/x/bridge", "run"]]);
  });

  it("builds argv arrays per terminal and defaults to -e", () => {
    expect(terminalArgv("alacritty", ["b", "run"])).toEqual(["alacritty", "-e", "b", "run"]);
    expect(terminalArgv("/usr/bin/kitty", ["b", "run"])).toEqual(["/usr/bin/kitty", "b", "run"]);
    expect(terminalArgv("xdg-terminal-exec", ["b"])).toEqual(["xdg-terminal-exec", "b"]);
    expect(terminalArgv("xfce4-terminal", ["b"])).toEqual(["xfce4-terminal", "-x", "b"]);
    expect(terminalArgv("gnome-terminal", ["b"])).toEqual(["gnome-terminal", "--", "b"]);
    expect(terminalArgv("mystery-term", ["b"])).toEqual(["mystery-term", "-e", "b"]);
  });

  it("tries $TERMINAL first, then xdg-terminal-exec, and stops at the first one that starts", async () => {
    const calls: string[][] = [];
    h = await harness({
      openTerminal: undefined,
      env: { HOME: "/h", TERMINAL: "myterm" },
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (command === "myterm" || command === "xdg-terminal-exec") throw new Error("ENOENT");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await openTerminalOf(h.deps)(["/x/bridge", "setup", "https://a.example"]);
    expect(calls).toEqual([
      ["myterm", "-e", "/x/bridge", "setup", "https://a.example"],
      ["xdg-terminal-exec", "/x/bridge", "setup", "https://a.example"],
      ["ghostty", "-e", "/x/bridge", "setup", "https://a.example"],
    ]);
  });

  it("does not fall through when a terminal ran and its command failed", async () => {
    const calls: string[][] = [];
    h = await harness({
      openTerminal: undefined,
      run: async (command, args) => {
        calls.push([command, ...args]);
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    });
    await openTerminalOf(h.deps)(["/x/bridge", "run"]);
    expect(calls).toHaveLength(1);
  });

  it("ignores a $TERMINAL that is not one plain program name", async () => {
    const calls: string[][] = [];
    h = await harness({
      openTerminal: undefined,
      env: { HOME: "/h", TERMINAL: "xterm -e rm -rf ~" },
      run: async (command, args) => {
        calls.push([command, ...args]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await openTerminalOf(h.deps)(["/x/bridge", "run"]);
    expect(calls).toEqual([["xdg-terminal-exec", "/x/bridge", "run"]]);
  });

  it("fails with the command to run by hand when no terminal can be started", async () => {
    h = await harness({
      openTerminal: undefined,
      run: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(openTerminalOf(h.deps)(["/x/bridge", "run"])).rejects.toThrow(/run this yourself: \/x\/bridge run/);
  });

  it("refuses an empty command and a non-Linux platform", async () => {
    h = await harness({ openTerminal: undefined });
    await expect(openTerminalOf(h.deps)([])).rejects.toThrow("not a command");
    h.deps.platform = "darwin";
    await expect(openTerminalOf(h.deps)(["b"])).rejects.toThrow(/Linux/);
  });
});
