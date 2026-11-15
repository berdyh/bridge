import { type CliDeps, type Notification, platformOf, runnerOf } from "./deps.js";

/** Control characters out of anything that reaches a notification daemon or an AppleScript string. */
function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
}

/** AppleScript string literal: backslash and double quote escaped. */
function appleScriptString(text: string): string {
  return `"${clean(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The desktop notification function: `deps.notify`, else `notify-send` (Linux) or `osascript` (macOS)
 * through the injected runner. A missing tool or a failing command is ignored: a notification is a
 * courtesy, never a reason for the runner to fail.
 */
export function notifyOf(deps: CliDeps): (notification: Notification) => Promise<void> {
  if (deps.notify) return deps.notify;
  return async ({ title, body }) => {
    try {
      const run = runnerOf(deps);
      if (platformOf(deps) === "darwin") {
        await run("osascript", ["-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`]);
      } else {
        await run("notify-send", ["--app-name=bridge", "--", clean(title), clean(body)]);
      }
    } catch {
      // No notification tool, or it failed: the same text is on stderr.
    }
  };
}
