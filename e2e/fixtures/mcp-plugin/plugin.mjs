// The e2e plugin: one MCP server (`stub`, two tools), a headless set, and two methods the test calls
// from its page to drive sessions the way a plugin's own code would:
//
//   _mcpplug/run     {request, prompts?, hold?, onBehalf?, secretFrom?}
//                                                            start a session, send each prompt, then close it (or
//                    keep it open with `hold`); returns what the plugin got back: the start error, each prompt's
//                    result or error, every event, and the end reason.
//   _mcpplug/finish  {sessionId}                             close a held session; returns its events and end.
//   _mcpplug/start   {request}                               start a session, close it at once; a refused start is NOT caught: the
//                    method fails with the start's own error (code, message, and data when the error has it).
//
// `request` is an `AgentSessionRequest` without `onBehalfOf`; `onBehalf: true` adds the calling page as
// `onBehalfOf` (the session's trigger is then that browser, not headless). `secretFrom: "<name>"` makes the
// session's secret the content of `<data dir>/<name>`, so a secret can be used that never crossed the page.
//
// Autorun (the local-app suite, where no browser or page exists to call `_mcpplug/run`): when `<data dir>/autorun.json`
// holds `{request, prompts?}` at start, the plugin runs it once through the same code path as `_mcpplug/run` and notes
// the outcome in `plugin.log`. Without that file nothing changes.
//
// The plugin's own log, `<data dir>/plugin.log`, holds every line it logs and everything the runner handed it
// (results, errors, events, end reasons), one JSON object per line; never the secret it sends.
//
// `./sdk/runtime.js` is not in this folder: the test copies the built SDK and protocol next to it before the
// install (as the sample plugin's build does), so the installed package has no node_modules.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { definePlugin } from "./sdk/runtime.js";

const held = new Map();

definePlugin(({ registerMethod, startAgentSession, dataDir, log }) => {
  const logFile = path.join(dataDir, "plugin.log");
  const note = (entry) => {
    try {
      appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    } catch {
      // the test reads the file; a missing line shows there
    }
  };
  // `data` is the error's own, when it has one (the reason code and hint of a refused contained session).
  const errorOf = (error) => ({ code: typeof error?.code === "number" ? error.code : null, message: String(error?.message ?? error), ...(error?.data !== undefined ? { data: error.data } : {}) });
  const waitEnd = (state, ms) =>
    Promise.race([state.ended, new Promise((resolve) => setTimeout(() => resolve(undefined), ms))]);

  async function finish(state) {
    try {
      await state.session.close();
    } catch (error) {
      state.closeError = errorOf(error);
    }
    const end = await waitEnd(state, 10_000);
    held.delete(state.session.sessionId);
    const out = { sessionId: state.session.sessionId, events: state.events, ended: end?.reason ?? null, ...(state.closeError ? { closeError: state.closeError } : {}) };
    note({ kind: "finish", out });
    return out;
  }

  async function run(params, caller) {
    const { request = {}, prompts = [], hold = false, onBehalf = false, secretFrom } = params ?? {};
    const { secret: _secret, ...shown } = request;
    note({ kind: "start", request: shown, hasSecret: _secret !== undefined || secretFrom !== undefined, onBehalf });
    let session;
    try {
      const secret = typeof secretFrom === "string" ? { secret: readFileSync(path.join(dataDir, path.basename(secretFrom)), "utf8") } : {};
      session = await startAgentSession({ ...request, ...secret, ...(onBehalf ? { onBehalfOf: caller } : {}) });
    } catch (error) {
      const out = { started: false, error: errorOf(error) };
      note({ kind: "start-failed", out });
      return out;
    }
    const state = { session, events: [], ended: session.ended ?? new Promise(() => {}) };
    session.onUpdate?.((event) => {
      state.events.push(event);
      note({ kind: "event", sessionId: session.sessionId, event });
    });
    void state.ended.then((end) => note({ kind: "ended", sessionId: session.sessionId, reason: end?.reason }));
    const results = [];
    for (const text of prompts) {
      try {
        const result = await session.prompt(text);
        results.push({ ok: true, stopReason: result.stopReason, text: result.text });
      } catch (error) {
        results.push({ ok: false, error: errorOf(error) });
      }
    }
    note({ kind: "prompts", sessionId: session.sessionId, results });
    log.info("e2e plugin ran a session", { prompts: prompts.length });
    if (hold) {
      held.set(session.sessionId, state);
      return { started: true, sessionId: session.sessionId, prompts: results, events: state.events };
    }
    const done = await finish(state);
    return { started: true, sessionId: session.sessionId, prompts: results, events: done.events, ended: done.ended };
  }

  registerMethod("_mcpplug/run", run);

  // Starts a session and lets a refusal propagate as the method's own error (no report): what a plugin that does not catch sees.
  registerMethod("_mcpplug/start", async (params) => {
    const session = await startAgentSession(params?.request ?? {});
    await session.close();
    return { sessionId: session.sessionId };
  });

  registerMethod("_mcpplug/finish", async (params) => {
    const state = held.get(params?.sessionId);
    if (!state) throw Object.assign(new Error("no held session"), { code: -32602 });
    return finish(state);
  });

  const autorunFile = path.join(dataDir, "autorun.json");
  if (existsSync(autorunFile)) {
    // After `plugin/ready` has gone out (the timer fires once the setup has returned), on the plugin's own turn.
    setTimeout(() => {
      let params;
      try {
        params = JSON.parse(readFileSync(autorunFile, "utf8"));
      } catch (error) {
        note({ kind: "autorun-failed", error: errorOf(error) });
        return;
      }
      note({ kind: "autorun" });
      run(params, undefined).then(
        (out) => note({ kind: "autorun-done", out }),
        (error) => note({ kind: "autorun-failed", error: errorOf(error) }),
      );
    }, 0);
  }
});
