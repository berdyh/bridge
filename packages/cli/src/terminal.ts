import path from "node:path";

import { type CliDeps, errorMessage, platformOf, runnerOf } from "./deps.js";

/**
 * How a terminal emulator takes the command to run. `exec` terminals take the argv straight
 * after their own name; the others take a flag first. Every entry runs the argv directly, never
 * through a shell string (xfce4-terminal's `-e` takes one string it splits itself, so it gets `-x`;
 * tilix's only `-e` is a string too, so it is left out).
 */
const TERMINAL_FLAGS: Readonly<Record<string, readonly string[]>> = {
  "xdg-terminal-exec": [],
  kitty: [],
  foot: [],
  ghostty: ["-e"],
  alacritty: ["-e"],
  konsole: ["-e"],
  xterm: ["-e"],
  "x-terminal-emulator": ["-e"],
  "gnome-terminal": ["--"],
  wezterm: ["start", "--"],
  "xfce4-terminal": ["-x"],
  "mate-terminal": ["-x"],
};

/** Tried after `$TERMINAL`, in this order. `xdg-terminal-exec` is the freedesktop default. */
const FIXED_TERMINALS = [
  "xdg-terminal-exec",
  "ghostty",
  "kitty",
  "alacritty",
  "foot",
  "wezterm",
  "gnome-terminal",
  "konsole",
  "xfce4-terminal",
  "mate-terminal",
  "xterm",
  "x-terminal-emulator",
] as const;

/** `$TERMINAL` is one program name or path, never split or interpreted; anything else is ignored. */
function terminalFromEnv(value: string | undefined): string | undefined {
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/** The argv that runs `command` in `terminal`. */
export function terminalArgv(terminal: string, command: readonly string[]): string[] {
  const flags = TERMINAL_FLAGS[path.basename(terminal)] ?? ["-e"];
  return [terminal, ...flags, ...command];
}

/**
 * Runs a command in a new terminal window. `deps.openTerminal` when injected (tests record the
 * command and open nothing), else the real default: `$TERMINAL`, `xdg-terminal-exec`, then a
 * fixed list; the first one that can be started wins. Linux only: macOS has no handler and
 * shows the command to paste instead. The command is always an argv array.
 */
export function openTerminalOf(deps: CliDeps): (command: string[]) => Promise<void> {
  if (deps.openTerminal) return deps.openTerminal;
  return async (command) => {
    if (command.length === 0 || command.some((part) => typeof part !== "string" || part.includes("\u0000"))) {
      throw new Error("not a command");
    }
    if (platformOf(deps) !== "linux") throw new Error("opening a terminal is only supported on Linux");
    const fromEnv = terminalFromEnv(deps.env.TERMINAL);
    const candidates = [...(fromEnv ? [fromEnv] : []), ...FIXED_TERMINALS.filter((name) => name !== fromEnv)];
    const run = runnerOf(deps);
    let lastError = "";
    for (const terminal of candidates) {
      const [program, ...args] = terminalArgv(terminal, command);
      try {
        // A terminal that starts has opened: its exit code is the command's, not ours to judge.
        const result = await run(program!, args);
        if (result.exitCode !== 127) return;
        lastError = `${terminal} exited with 127`;
      } catch (error) {
        lastError = errorMessage(error);
      }
    }
    throw new Error(`no terminal could be started (${lastError}); run this yourself: ${command.join(" ")}`);
  };
}
