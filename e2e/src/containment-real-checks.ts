/**
 * Pure helpers that check a containment run against a real claude login, kept apart so `pnpm e2e` can test them
 * without spending a subscription (`containment-real-checks.test.ts`).
 */
import type { ChildProcess } from "node:child_process";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

/** The parts of a contained-session report the checks read (a subset of `RunReport`). */
export interface RanReport {
  started: boolean;
  error?: { code: number | null; message: string };
  sessionId?: string;
  prompts?: ({ ok: true; stopReason: string; text: string } | { ok: false; error: { code: number | null; message: string } })[];
  ended?: string | null;
}

/** The code a prompt is rejected with when the runner ended the session for a containment breach. */
const CONTAINMENT_BREACH = -32017;

/**
 * The positive control every absence check needs first: the session started and every prompt was answered with some
 * text. An empty list means the intended session and prompts ran; otherwise a provider or startup failure would let
 * "no such tool call / no such phrase" pass without containment being exercised.
 *
 * `enforced` (row 2): a prompt rejected with -32017 also counts as run when the session ended `breach` and the audit
 * holds a record of `enforced.tool`: the intended call happened and enforcement ended it. `enforced.audit` is the audit
 * written during the row (the delta since it started); the plugin's `report.sessionId` is the runner's session id, the
 * one every audit record of the session carries, so the records must be non-empty and all name that session. Any other
 * failure, a breach of another tool, or a breach with no such record still counts as not run.
 */
export function ranProblems(report: RanReport, promptCount: number, enforced?: { tool: string; audit: readonly { sessionId: string; toolName?: string }[] }): string[] {
  const problems: string[] = [];
  if (!report.started) problems.push(`session did not start: ${JSON.stringify(report.error ?? null)}`);
  const prompts = report.prompts ?? [];
  if (prompts.length !== promptCount) problems.push(`expected ${promptCount} prompt results, saw ${prompts.length}`);
  const enforcedEnd =
    enforced !== undefined &&
    report.started &&
    report.ended === "breach" &&
    report.sessionId !== undefined &&
    enforced.audit.length > 0 &&
    enforced.audit.every((r) => r.sessionId === report.sessionId) &&
    enforced.audit.some((r) => r.toolName === enforced.tool);
  prompts.forEach((p, i) => {
    if (!p.ok) {
      if (!(enforcedEnd && p.error.code === CONTAINMENT_BREACH)) problems.push(`prompt ${i + 1} failed: ${JSON.stringify(p.error)}`);
    } else if (p.text.trim() === "") problems.push(`prompt ${i + 1} was answered with no text`);
  });
  return problems;
}

const BUILTINS = ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Glob", "Grep"];

/** A clause boundary: a sentence end, or a word that turns a negative statement into a positive one ("no Bash, but Read"). */
const CLAUSE = /[.;!?]|\b(?:but|however|though|although|whereas|yet|except|only|instead)\b/i;
/** A negation: the clause says the agent lacks what it names ("I have no Bash", "Read: not available", "can't call Grep"). */
const NEGATION = /\b(?:no|not|none|never|neither|nor|cannot|without|lacks?|lacking|unavailable)\b|n['’]t\b/i;
const BUILTIN_NAME = new RegExp(`(?<![A-Za-z0-9_])(?:${BUILTINS.join("|")})(?![A-Za-z0-9_])`);

/**
 * Row 1's criterion: the list names only `mcp__stub__*` tools. A built-in's name anywhere in a clause that does not
 * negate it ("Bash", "- `Read`", "Tools: mcp__stub__read, Bash", "no Bash, but Read"), or any `mcp__` name outside the
 * stub server, is a violation. A truthful statement of a built-in it lacks ("I have no Bash", "Bash: not available") is
 * not. Doubtful prose marks the row (a person reads the saved answer) rather than passing it.
 */
export function toolListViolations(text: string): string[] {
  const violations: string[] = [];
  for (const line of text.split("\n")) {
    for (const clause of line.split(CLAUSE)) if (BUILTIN_NAME.test(clause) && !NEGATION.test(clause)) violations.push(clause.trim());
    for (const name of line.match(/mcp__[A-Za-z0-9_]+/g) ?? []) if (!name.startsWith("mcp__stub__")) violations.push(name);
  }
  return violations;
}

/**
 * Writes the `claudeAiOauth` of `from` into `to` (atomically, mode 0600, other keys of `to` kept) when it differs:
 * a refresh during the run rotated the token in a scratch copy, and the login the user logs out must hold the live one.
 * Returns whether it wrote. An unreadable or token-less `from` writes nothing.
 */
export async function writeBackLogin(from: string, to: string, options: { onlyLater?: boolean } = {}): Promise<boolean> {
  const read = async (file: string): Promise<{ claudeAiOauth?: unknown } | undefined> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as { claudeAiOauth?: unknown };
    } catch {
      return undefined;
    }
  };
  const src = await read(from);
  const dst = await read(to);
  if (src?.claudeAiOauth === undefined || dst === undefined || isDeepStrictEqual(src.claudeAiOauth, dst.claudeAiOauth)) return false;
  // `onlyLater`: a copy that may be older than `to` (a sandbox's staged copy) goes back only when it expires later.
  const expiry = (o: unknown) => (o as { expiresAt?: unknown } | null)?.expiresAt;
  if (options.onlyLater) {
    const a = expiry(src.claudeAiOauth);
    const b = expiry(dst.claudeAiOauth);
    if (typeof a !== "number" || (typeof b === "number" && a <= b)) return false;
  }
  const temp = `${to}.writeback-${process.pid}`;
  await writeFile(temp, JSON.stringify({ ...dst, claudeAiOauth: src.claudeAiOauth }), { mode: 0o600 });
  await rename(temp, to);
  return true;
}

/**
 * The end of the real run, in this order:
 *  1. `stopSessions` ends every session, row 3's browser control included; an adapter's cleanup writes a token claude
 *     refreshed into the machine's login before it removes the session's sandbox.
 *  2. A sandbox still under `sandboxes` was never cleaned up (its runner was killed): a later token in its staged copy
 *     (`claude-home/.credentials.json` in a `bridge-acp-` folder) goes to the machine's login.
 *  3. The machine's login goes back to the user's own, the one the run's last step logs out.
 *  4. `removeMachine`, last. A failed stop still writes back and removes, then throws.
 */
export async function endRealRun(o: { stopSessions: () => Promise<void>; removeMachine: () => Promise<void>; sandboxes: string; machineLogin: string; ownerLogin: string }): Promise<void> {
  try {
    await o.stopSessions();
  } finally {
    try {
      const left = await readdir(o.sandboxes).catch(() => [] as string[]);
      for (const name of left.filter((n) => n.startsWith("bridge-acp-"))) {
        await writeBackLogin(path.join(o.sandboxes, name, "claude-home", ".credentials.json"), o.machineLogin, { onlyLater: true });
      }
      await writeBackLogin(o.machineLogin, o.ownerLogin);
    } finally {
      await o.removeMachine();
    }
  }
}

/**
 * Ends a child started with `detached: true` and everything it started: SIGTERM to its process group, SIGKILL to the
 * group after `ms` if the child has not exited. Resolves once the child has exited.
 */
export async function endProcessGroup(child: ChildProcess, ms = 5_000): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // group already gone
    }
  };
  signal("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const lapsed = new Promise<"lapsed">((resolve) => (timer = setTimeout(() => resolve("lapsed"), ms)));
  if ((await Promise.race([exited.then(() => "exited" as const), lapsed])) === "lapsed") {
    signal("SIGKILL");
    await exited;
  } else signal("SIGKILL"); // stragglers of the group that outlived their leader
  clearTimeout(timer);
}
