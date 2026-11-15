import { formatEnrollFragment, wordsOf } from "@berdyh/bridge-protocol";
import { EnrollError, readEnrollWindow, recordDecision, type E2eeApp, type EnrollPrompt } from "@berdyh/bridge-runner";

import { parse } from "./args.js";
import { type HostedAppRecord, printable, resolveApp } from "./config.js";
import { type CliDeps, UsageError, credentialsOf, e2eeOf, errorMessage, isTTYOf, openUrlOf, readStdinOf } from "./deps.js";
import { assertNoLegacyLayout } from "./legacy.js";
import { appPathsOf } from "./paths.js";
import { readRunnerStatus, servedAs } from "./status.js";

/**
 * The E2EE identity of a connected app: the arguments `enroll`, `listBrowsers`, `revokeBrowser` and
 * `startRunner` take. Its state files live in the app's own `<config>/<app>/bridge/` folder; the identity
 * wrapping key goes to the same credential store (keychain) as the app's tokens, not to a file there.
 */
export function e2eeAppOf(app: HostedAppRecord, deps: CliDeps): E2eeApp {
  return { appId: app.appId, runnerId: app.runnerId, paths: appPathsOf(deps, app.appId), secrets: credentialsOf(deps) };
}

/**
 * What the agent-facing events and prompts say about the four words. The words confirm a browser
 * only because the agent asks the person for them: never changed to relax the rule, and no prompt
 * prints an approve command with the words filled in.
 */
export const WORDS_RULE = "Ask the person for the four words their browser page shows, then approve with those. Never guess, invent or reuse words.";

/** How often the non-TTY confirm looks at the enroll window. */
const WINDOW_POLL_MS = 100;

const sleepMs = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * The answer to a trust request when nobody can type: waits for a decision on the attempt that was
 * asked about, written to the enroll window by `bridge enroll approve|deny` (another process).
 * It is bound to ONE attempt: the pending attempt it reads first, and only if that is the browser
 * `keyId` that was shown. It answers `false` at once when that attempt is no longer the pending one
 * (the window is gone, a deny withdrew it, or another attempt took its place), so a deny is seen at
 * once and a decision meant for another browser is never taken for this one.
 */
export async function confirmFromWindow(app: E2eeApp, browser: { keyId: string }, signal?: AbortSignal): Promise<boolean> {
  const first = await readEnrollWindow(app);
  const pending = first?.pending;
  if (!first || !pending || pending.keyId !== browser.keyId) return false;
  const { codeId } = first;
  const { attemptId } = pending;
  while (!signal?.aborted) {
    const window = await readEnrollWindow(app);
    if (!window || window.codeId !== codeId) return false;
    if (window.decision?.attemptId === attemptId) return window.decision.accepted;
    if (window.pending?.attemptId !== attemptId) return false;
    await sleepMs(WINDOW_POLL_MS, signal);
  }
  return false;
}

/** `bridge enroll [<app>] [--open] [--json]` and `bridge enroll approve|deny <app> --words "<w1 w2 w3 w4>" | -`. */
export async function runEnroll(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, { open: { type: "boolean" }, json: { type: "boolean" }, words: { type: "string" } });
  await assertNoLegacyLayout(deps);
  if ((positionals[0] === "approve" || positionals[0] === "deny") && positionals.length === 2) return runEnrollApprove(args, deps);
  if (positionals.length > 1 || values.words !== undefined) throw new UsageError("usage: bridge enroll [<app>] [--open] [--json] | bridge enroll approve|deny <app> --words \"<w1 w2 w3 w4>\" | -");
  const app = await resolveApp(deps, positionals[0]);
  const json = values.json === true;
  const emit = (event: Record<string, unknown>): void => deps.stdout(`${JSON.stringify(event)}\n`);

  // The runner is the one that answers the browser: with no runner the window opens for nobody.
  const runner = await readRunnerStatus(deps);
  if (!runner) throw new Error("start `bridge run` first (nothing is serving browsers); `bridge setup <app-url>` does both");
  if (servedAs(runner, app) === "not_served") throw new Error(`the running bridge does not serve ${printable(app.name)} yet; restart \`bridge run\``);

  const e2eeApp = e2eeAppOf(app, deps);
  const interactive = isTTYOf(deps) && !json;
  const opening: Promise<void>[] = [];
  const prompt: EnrollPrompt = {
    showCode(code, expiresAt) {
      const url = app.enrollPage ? `${app.origin}${app.enrollPage}${formatEnrollFragment({ code, runnerId: app.runnerId })}` : undefined;
      const showPlain = (): void => deps.stdout(`Enter this code in the browser for ${printable(app.name)}:\n\n    ${code}\n\nIt expires at ${expiresAt}.\n`);
      if (json) emit({ event: "code", code, expiresAt, ...(url ? { enrollUrl: url } : {}) });
      if (values.open && url) {
        opening.push(
          openUrlOf(deps)(url).then(
            () => {
              if (!json) deps.stdout(`Opened ${printable(app.name)}'s enroll page in your browser; the code is in the link, nothing to type. It expires at ${expiresAt}.\n`);
            },
            () => {
              if (!json) deps.stdout(`Could not open a browser. Open this link yourself:\n\n    ${url}\n\nIt expires at ${expiresAt}.\n`);
            },
          ),
        );
      } else if (!json) {
        showPlain();
        if (values.open) deps.stdout(`${printable(app.name)} has no enroll page; enter the code on its page.\n`);
      }
    },
    async confirm({ label, keyId }, options) {
      const words = wordsOf(keyId);
      const shownLabel = printable(label);
      if (json) emit({ event: "trust_request", trust_request: { label: shownLabel, words, keyId } });
      if (interactive) return deps.confirm(`Trust the browser '${shownLabel}' (key ${keyId}, words ${words.join(" ")})?`);
      if (!json) {
        deps.stdout(
          `The browser '${shownLabel}' (key ${keyId}) asks to be trusted.\nIts words: ${words.join(" ")}\n` +
          `${WORDS_RULE}\nThen run: bridge enroll approve ${app.appId} --words "<the four words from the page>"\n` +
          `(or \`bridge enroll deny ${app.appId}\`). Waiting for the decision...\n`,
        );
      }
      return confirmFromWindow(e2eeApp, { keyId }, options?.signal);
    },
  };

  try {
    const result = await e2eeOf(deps).enroll(e2eeApp, prompt);
    await Promise.all(opening);
    if (json) emit({ event: "outcome", trusted: true, label: printable(result.label), keyId: result.browserKeyId, enrolledAt: result.enrolledAt });
    else deps.stdout(`Trusted '${printable(result.label)}' (key ${result.browserKeyId}) for ${printable(app.name)}.\n`);
    return 0;
  } catch (error) {
    await Promise.all(opening);
    if (!json) throw error;
    emit({ event: "outcome", trusted: false, reason: error instanceof EnrollError ? error.reason : "error", message: errorMessage(error) });
    return 1;
  }
}

/** The most stdin `--words -` reads; the four words are a few dozen bytes. */
const WORDS_STDIN_MAX_BYTES = 4096;

/** `bridge enroll approve|deny <app> --words "<w1 w2 w3 w4>" | - [--json]`: answers the pending trust request of an open window. */
export async function runEnrollApprove(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: "boolean" }, words: { type: "string" } });
  const [verb, name] = positionals;
  await assertNoLegacyLayout(deps);
  const usage = "usage: bridge enroll approve|deny <app> (--words \"<w1 w2 w3 w4>\" | --words - to read them from stdin, for scripts) [--json]";
  if ((verb !== "approve" && verb !== "deny") || name === undefined || positionals.length !== 2) throw new UsageError(usage);
  const approving = verb === "approve";
  // `--words -` takes the words from stdin, so they never sit in argv (/proc/<pid>/cmdline, ps, audit logs).
  // The text is never put into an error message: an error may be logged.
  let wordsText = values.words;
  if (wordsText === "-") {
    wordsText = await readStdinOf(deps)(WORDS_STDIN_MAX_BYTES);
    if (Buffer.byteLength(wordsText) > WORDS_STDIN_MAX_BYTES) throw new UsageError(`--words - reads at most ${WORDS_STDIN_MAX_BYTES} bytes from stdin: ${usage}`);
  }
  const given = wordsText === undefined ? undefined : wordsText.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (approving && given?.length !== 4) throw new UsageError(`approve needs the four words the page shows: ${usage}`);
  const app = await resolveApp(deps, name);
  const e2eeApp = e2eeAppOf(app, deps);
  const json = values.json === true;
  const finish = (code: number, accepted: boolean | undefined, message: string, extra: Record<string, unknown> = {}): number => {
    if (json) deps.stdout(`${JSON.stringify({ event: "decision", ...(accepted === undefined ? {} : { accepted }), message, ...extra })}\n`);
    else (code === 0 ? deps.stdout : deps.stderr)(`${message}\n`);
    return code;
  };

  // Everything below is decided on ONE read of the window: the keyId whose words are compared, the attempt
  // and the code the decision is recorded for. If another attempt takes the slot meanwhile, `recordDecision`
  // refuses (it checks the pending attempt under the lock), so these words can never trust another browser.
  const window = await readEnrollWindow(e2eeApp);
  const pending = window?.pending;
  if (!window || !pending) return finish(1, undefined, `no browser is waiting to be trusted for ${printable(app.name)}; run \`bridge enroll ${app.appId}\` and start the pairing in the browser first`);
  if (window.consumed || window.state !== "open") return finish(1, undefined, "the enrollment window is no longer open; start a new `bridge enroll`");
  if (Date.parse(window.expiresAt) <= (deps.now?.() ?? Date.now())) return finish(1, undefined, "the enrollment window has expired; start a new `bridge enroll`");
  if (window.decision) return finish(1, undefined, "this request was already answered");

  const expected = wordsOf(pending.keyId);
  const matches = given !== undefined && given.length === 4 && given.every((word, i) => word === expected[i]);
  const accept = approving && matches;
  const recorded = await recordDecision(e2eeApp, window.codeId, pending.attemptId, accept, new Date(deps.now?.() ?? Date.now()));
  if (!recorded) return finish(1, undefined, "the request changed or was answered meanwhile; nothing was recorded. Check `bridge enroll` and try again");
  if (accept) return finish(0, true, `Approved '${printable(pending.label)}' (key ${pending.keyId}). The running \`bridge enroll\` finishes the pairing.`, { keyId: pending.keyId, words: expected });
  if (approving) return finish(1, false, `The words do not match the browser that is waiting; it was NOT trusted and the request is denied. If it was yours, start a new pairing in the browser.`, { keyId: pending.keyId });
  return finish(0, false, `Denied '${printable(pending.label)}' (key ${pending.keyId}).`, { keyId: pending.keyId });
}
