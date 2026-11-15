import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { wordsOf } from "@berdyh/bridge-protocol";
import { type EnrollWindow, readEnrollWindow } from "@berdyh/bridge-runner";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { upsertApp } from "./config.js";
import type { CliDeps } from "./deps.js";
import { WORDS_RULE, confirmFromWindow, e2eeAppOf } from "./enroll.js";
import { writeRunnerStatus } from "./status.js";
import { type Harness, harness, record } from "./testkit.js";
import { appPathsOf } from "./paths.js";

/** A live `runner.json` (this process is the "runner") that serves `appIds`. */
async function runnerUp(deps: CliDeps, appIds: string[] = ["demo"]): Promise<void> {
  await writeRunnerStatus(deps, {
    version: 1,
    pid: process.pid,
    startedAt: "2026-10-21T00:00:00.000Z",
    apps: Object.fromEntries(appIds.map((id) => [id, "online" as const])),
    browsers: 0,
  });
}

const FAR = "2999-01-01T00:00:00.000Z";
const windowFile = (deps: CliDeps, app = record()): string => appPathsOf(deps, app.appId).enrollFile;

/** Writes an enroll window as the runner's store would, with a browser waiting. */
async function putWindow(deps: CliDeps, over: Partial<EnrollWindow> = {}): Promise<EnrollWindow> {
  const window: EnrollWindow = {
    v: 1,
    codeId: "code-1",
    code: "BCDFGHJK",
    expiresAt: FAR,
    attemptsLeft: 5,
    state: "open",
    ownerPid: process.pid,
    pending: { attemptId: "attempt-1", enrollId: "enroll-1", label: "Laptop", publicKey: "pk", keyId: "kid-1" },
    ...over,
  };
  await mkdir(path.dirname(windowFile(deps)), { recursive: true });
  await writeFile(windowFile(deps), `${JSON.stringify(window)}\n`);
  return window;
}
const readWindow = async (deps: CliDeps) => JSON.parse(await readFile(windowFile(deps), "utf8")) as EnrollWindow;
const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("enroll and browsers", () => {
  const trusted = [{ browserKeyId: "k1", publicKey: "pk", label: "Laptop", enrolledAt: "2026-10-14T00:00:00Z", lastSeen: "2026-10-14T01:00:00Z" }];

  it("passes the app's E2EE identity and its own bridge/ folder to the runner functions", async () => {
    const calls: unknown[] = [];
    h = await harness({
      isTTY: true,
      e2ee: {
        enroll: async (app, prompt) => {
          calls.push(["enroll", app]);
          prompt.showCode("ABCD2345", "2026-10-14T00:10:00Z");
          expect(await prompt.confirm({ label: "Laptop", keyId: "k1" })).toBe(true);
          return { browserKeyId: "k1", label: "Laptop", enrolledAt: "2026-10-14T00:00:00Z" };
        },
        listBrowsers: async (app) => (calls.push(["list", app]), trusted),
        revokeBrowser: async (app, id) => (calls.push(["revoke", app, id]), id === "k1"),
      },
    });
    await upsertApp(h.deps, record());
    await runnerUp(h.deps);
    expect(await runCli(["enroll", "demo"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("ABCD2345");
    expect(h.questions.join("")).toContain(`words ${wordsOf("k1").join(" ")}`);
    expect(await runCli(["browsers", "list"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("k1\tLaptop");
    expect(await runCli(["browsers", "revoke", "k1"], h.deps)).toBe(0);
    expect(await runCli(["browsers", "revoke", "demo", "missing"], h.deps)).toBe(1);
    const app = { appId: "demo", runnerId: "runner-1", paths: appPathsOf(h.deps, "demo"), secrets: h.deps.credentials };
    expect(calls).toEqual([["enroll", app], ["list", app], ["revoke", app, "k1"], ["revoke", app, "missing"]]);
  });

  it("revokes a browser key id that starts with a dash, with or without `--`, and still rejects real flags", async () => {
    const dashed = "-AbCdEfGhIjKlMnOpQrStU";
    const revoked: string[] = [];
    h = await harness({
      e2ee: {
        enroll: () => { throw new Error("unused"); },
        listBrowsers: async () => [],
        revokeBrowser: async (_app, id) => (revoked.push(id), true),
      },
    });
    await upsertApp(h.deps, record());
    expect(await runCli(["browsers", "revoke", dashed], h.deps)).toBe(0);
    expect(await runCli(["browsers", "revoke", "demo", dashed], h.deps)).toBe(0);
    expect(await runCli(["browsers", "revoke", "--", dashed], h.deps)).toBe(0);
    expect(await runCli(["browsers", "revoke", "demo", "--", "-x"], h.deps)).toBe(0);
    expect(revoked).toEqual([dashed, dashed, dashed, "-x"]);
    expect(await runCli(["browsers", "revoke", "--bogus", "k1"], h.deps)).toBe(2);
    expect(await runCli(["browsers", "revoke", "-x"], h.deps)).toBe(2);
  });

  it("hands the keychain to the runner as the identity key store, so no wrapping-key file is written", async () => {
    h = await harness({
      e2ee: {
        enroll: async (app) => {
          await app.secrets!.set("bridge/e2ee-identity-key/demo/runner-1", "wrapping-key");
          return { browserKeyId: "k1", label: "Laptop", enrolledAt: "2026-10-14T00:00:00Z" };
        },
        listBrowsers: async () => [],
        revokeBrowser: async () => false,
      },
    });
    await upsertApp(h.deps, record());
    await runnerUp(h.deps);
    expect(await runCli(["enroll", "demo"], h.deps)).toBe(0);
    expect((h.deps.credentials as unknown as { data: Map<string, string> }).data.get("bridge/e2ee-identity-key/demo/runner-1")).toBe("wrapping-key");
    await expect(access(appPathsOf(h.deps, "demo").identityKeyFile)).rejects.toThrow();
  });

  it("reports a failing runner function as an error, not a crash", async () => {
    h = await harness({ e2ee: { enroll: () => { throw new Error("not implemented"); }, listBrowsers: async () => [], revokeBrowser: async () => false } });
    await upsertApp(h.deps, record());
    await runnerUp(h.deps);
    expect(await runCli(["enroll"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("not implemented");
  });

  it("needs a connected app, and a name when there are several", async () => {
    h = await harness();
    expect(await runCli(["enroll"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("no app is connected");
    await upsertApp(h.deps, record());
    await upsertApp(h.deps, record({ appId: "other", name: "Other", origin: "https://other.example" }));
    h.err.length = 0;
    expect(await runCli(["browsers", "list"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("more than one app");
  });
});

describe("bridge enroll with no runner", () => {
  it("refuses with 'start `bridge run` first' when runner.json says no runner (missing, or its pid is dead)", async () => {
    let enrolled = false;
    h = await harness({ e2ee: { enroll: async () => ((enrolled = true), { browserKeyId: "k", label: "L", enrolledAt: "x" }), listBrowsers: async () => [], revokeBrowser: async () => false } });
    await upsertApp(h.deps, record());
    expect(await runCli(["enroll", "demo"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("start `bridge run` first");
    // A leftover file of a dead process is "not running" too.
    await writeRunnerStatus(h.deps, { version: 1, pid: 2 ** 22 + 12345, startedAt: "2026-10-21T00:00:00.000Z", apps: { demo: "online" }, browsers: 0 });
    h.err.length = 0;
    expect(await runCli(["enroll", "demo"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("start `bridge run` first");
    // A runner that started before the app was connected does not serve it.
    await runnerUp(h.deps, ["other"]);
    h.err.length = 0;
    expect(await runCli(["enroll", "demo"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("does not serve");
    expect(enrolled).toBe(false);
    // A runner whose entry for the app says `local` (the app was recreated as a hosted one) does not serve it either.
    await writeRunnerStatus(h.deps, { version: 1, pid: process.pid, startedAt: "2026-10-21T00:00:00.000Z", apps: { demo: "local" }, browsers: 0 });
    h.err.length = 0;
    expect(await runCli(["enroll", "demo"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("does not serve");
    expect(enrolled).toBe(false);
  });
});

describe("bridge enroll --open and --json", () => {
  const fakeEnroll = (events: string[]) => ({
    enroll: async (_app: unknown, prompt: import("@berdyh/bridge-runner").EnrollPrompt) => {
      prompt.showCode("BCDFGHJK", "2026-10-21T00:10:00.000Z");
      events.push(String(await prompt.confirm({ label: "Laptop", keyId: "kid-1" })));
      return { browserKeyId: "kid-1", label: "Laptop", enrolledAt: "2026-10-21T00:01:00.000Z" };
    },
    listBrowsers: async () => [],
    revokeBrowser: async () => false,
  });

  it("--open opens <origin><enrollPage>#code=...&runner=... and does not print the code", async () => {
    const events: string[] = [];
    h = await harness({ isTTY: true, e2ee: fakeEnroll(events) });
    h.answers.yes = true;
    await upsertApp(h.deps, record({ enrollPage: "/bridge/enroll" }));
    await runnerUp(h.deps);
    expect(await runCli(["enroll", "demo", "--open"], h.deps)).toBe(0);
    expect(h.opened).toEqual(["https://demo.example/bridge/enroll#code=BCDFGHJK&runner=runner-1"]);
    expect(h.out.join("")).not.toContain("    BCDFGHJK");
    expect(h.out.join("")).toContain("nothing to type");
    expect(events).toEqual(["true"]);
  });

  it("--open prints the code when the app has no enroll page, and the link when the browser cannot be opened", async () => {
    h = await harness({ isTTY: true, e2ee: fakeEnroll([]) });
    await upsertApp(h.deps, record());
    await runnerUp(h.deps);
    expect(await runCli(["enroll", "demo", "--open"], h.deps)).toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.out.join("")).toContain("    BCDFGHJK");
    expect(h.out.join("")).toContain("no enroll page");

    await h.cleanup();
    h = await harness({ isTTY: true, openUrl: async () => { throw new Error("no browser"); }, e2ee: fakeEnroll([]) });
    await upsertApp(h.deps, record({ enrollPage: "/bridge/enroll" }));
    await runnerUp(h.deps);
    expect(await runCli(["enroll", "demo", "--open"], h.deps)).toBe(0);
    expect(h.out.join("")).toContain("https://demo.example/bridge/enroll#code=BCDFGHJK&runner=runner-1");
  });

  it("--json prints the code, the trust request with its four words and the outcome as JSON lines; an agent approves with the words", async () => {
    const events: string[] = [];
    h = await harness({ e2ee: fakeEnroll(events) });
    await upsertApp(h.deps, record({ enrollPage: "/bridge/enroll" }));
    await runnerUp(h.deps);
    await putWindow(h.deps);
    const done = runCli(["enroll", "demo", "--json"], h.deps);
    await until(() => h!.out.length >= 2);
    const words = wordsOf("kid-1");
    expect(await runCli(["enroll", "approve", "demo", "--words", words.join(" ")], h.deps)).toBe(0);
    expect(await done).toBe(0);
    const lines = h.out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ event: "code", code: "BCDFGHJK", enrollUrl: "https://demo.example/bridge/enroll#code=BCDFGHJK&runner=runner-1" });
    expect(lines[1]).toMatchObject({ event: "trust_request", trust_request: { label: "Laptop", words, keyId: "kid-1" } });
    expect(lines.at(-1)).toMatchObject({ event: "outcome", trusted: true, keyId: "kid-1" });
    expect(events).toEqual(["true"]);
  });

  it("--json reports a refusal as a failed outcome and exits 1", async () => {
    h = await harness({ e2ee: { ...fakeEnroll([]), enroll: async () => { throw new Error("an enrollment for this app is already open"); } } });
    await upsertApp(h.deps, record());
    await runnerUp(h.deps);
    expect(await runCli(["enroll", "demo", "--json"], h.deps)).toBe(1);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ event: "outcome", trusted: false, message: "an enrollment for this app is already open" });
  });

  it("without a TTY and without --json it prints the words, the ask-the-person rule and the approve command with a placeholder, then waits", async () => {
    const events: string[] = [];
    h = await harness({ e2ee: fakeEnroll(events) });
    await upsertApp(h.deps, record());
    await runnerUp(h.deps);
    await putWindow(h.deps);
    const done = runCli(["enroll", "demo"], h.deps);
    await until(() => h!.out.join("").includes("bridge enroll approve"));
    const words = wordsOf("kid-1").join(" ");
    const out = h.out.join("");
    // The words are the person's confirmation only because the agent asks the person: no copy-ready
    // approve command carries the words the runner computed.
    expect(out).toContain(`Its words: ${words}`);
    expect(out).toContain(WORDS_RULE);
    expect(out).toContain('bridge enroll approve demo --words "<the four words from the page>"');
    expect(out).not.toContain(`--words "${words}"`);
    expect(out).not.toMatch(new RegExp(`approve demo --words\\s+"?${words.split(" ")[0]}`));
    expect(await runCli(["enroll", "deny", "demo"], h.deps)).toBe(0);
    expect(await done).toBe(0);
    expect(events).toEqual(["false"]);
    expect(h.questions).toEqual([]);
  });
});

describe("the non-TTY confirm (confirmFromWindow)", () => {
  const appOf = (deps: CliDeps) => e2eeAppOf(record(), deps);

  it("returns the decision recorded for the asked attempt by another caller", async () => {
    h = await harness();
    await putWindow(h.deps);
    const answer = confirmFromWindow(appOf(h.deps), { keyId: "kid-1" });
    await new Promise((r) => setTimeout(r, 150));
    await putWindow(h.deps, { decision: { attemptId: "attempt-1", accepted: true } });
    expect(await answer).toBe(true);
  });

  it("returns false at once when the pending request is withdrawn (a deny), not at expiry", async () => {
    h = await harness();
    await putWindow(h.deps);
    const started = Date.now();
    const answer = confirmFromWindow(appOf(h.deps), { keyId: "kid-1" });
    await new Promise((r) => setTimeout(r, 150));
    await putWindow(h.deps, { pending: undefined });
    expect(await answer).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("is bound to the attempt it first saw: another attempt taking the slot, another key, or no window is false", async () => {
    h = await harness();
    expect(await confirmFromWindow(appOf(h.deps), { keyId: "kid-1" })).toBe(false);
    await putWindow(h.deps);
    expect(await confirmFromWindow(appOf(h.deps), { keyId: "some-other-key" })).toBe(false);
    const answer = confirmFromWindow(appOf(h.deps), { keyId: "kid-1" });
    await new Promise((r) => setTimeout(r, 150));
    // A second attempt with the same key and an accept recorded for IT must not be taken for this one.
    await putWindow(h.deps, { pending: { attemptId: "attempt-2", enrollId: "e2", label: "Other", publicKey: "pk", keyId: "kid-1" }, decision: { attemptId: "attempt-2", accepted: true } });
    expect(await answer).toBe(false);
  });

  it("stops when its signal aborts", async () => {
    h = await harness();
    await putWindow(h.deps);
    const controller = new AbortController();
    const answer = confirmFromWindow(appOf(h.deps), { keyId: "kid-1" }, controller.signal);
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    expect(await answer).toBe(false);
  });
});

describe("bridge enroll approve and deny", () => {
  const words = () => wordsOf("kid-1").join(" ");
  const decisionOf = async (deps: CliDeps) => (await readEnrollWindow(e2eeAppOf(record(), deps)))?.decision;

  it("records an accept for the pending attempt only when the four words match", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await putWindow(h.deps);
    expect(await runCli(["enroll", "approve", "demo", "--words", words().toUpperCase()], h.deps)).toBe(0);
    expect(await decisionOf(h.deps)).toEqual({ attemptId: "attempt-1", accepted: true });
    expect(h.out.join("")).toContain("Approved 'Laptop'");
  });

  it("wrong words record a deny and exit non-zero; a malformed list is a usage error that records nothing", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await putWindow(h.deps);
    expect(await runCli(["enroll", "approve", "demo", "--words", "one two three"], h.deps)).toBe(2);
    expect(await runCli(["enroll", "approve", "demo"], h.deps)).toBe(2);
    expect(await decisionOf(h.deps)).toBeUndefined();
    expect(await runCli(["enroll", "approve", "demo", "--words", "acid acorn acre acts"], h.deps)).toBe(1);
    expect(await decisionOf(h.deps)).toEqual({ attemptId: "attempt-1", accepted: false });
    expect(h.err.join("")).toContain("do not match");
  });

  it("exactly one decision per attempt: a second answer, even a different one, changes nothing", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await putWindow(h.deps);
    expect(await runCli(["enroll", "approve", "demo", "--words", words()], h.deps)).toBe(0);
    h.err.length = 0;
    expect(await runCli(["enroll", "deny", "demo"], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("already answered");
    expect(await runCli(["enroll", "approve", "demo", "--words", "acid acorn acre acts"], h.deps)).toBe(1);
    expect(await decisionOf(h.deps)).toEqual({ attemptId: "attempt-1", accepted: true });
  });

  it("exits non-zero with no pending browser, no window, an expired, consumed or locked window", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    expect(await runCli(["enroll", "approve", "demo", "--words", words()], h.deps)).toBe(1);
    expect(h.err.join("")).toContain("no browser is waiting");
    for (const over of [{ pending: undefined }, { expiresAt: "2020-01-01T00:00:00.000Z" }, { consumed: true }, { state: "locked" as const }]) {
      await putWindow(h.deps, over);
      expect(await runCli(["enroll", "approve", "demo", "--words", words()], h.deps)).toBe(1);
      expect((await readWindow(h.deps)).decision).toBeUndefined();
    }
  });

  it("never consults --yes or the prompt, and --json prints one decision line", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    await putWindow(h.deps);
    expect(await runCli(["enroll", "approve", "demo", "--words", "acid acorn acre acts", "--yes"], h.deps)).toBe(2);
    expect(await decisionOf(h.deps)).toBeUndefined();
    expect(h.questions).toEqual([]);
    expect(await runCli(["enroll", "approve", "demo", "--words", words(), "--json"], h.deps)).toBe(0);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ event: "decision", accepted: true, keyId: "kid-1" });
  });

  it("--words - reads the words from stdin: the right words approve, wrong words deny, and argv never carries them", async () => {
    let stdin = `${words().toUpperCase()}\n`;
    h = await harness({ readStdin: async () => stdin });
    await upsertApp(h.deps, record());
    await putWindow(h.deps);
    expect(await runCli(["enroll", "approve", "demo", "--words", "-"], h.deps)).toBe(0);
    expect(await decisionOf(h.deps)).toEqual({ attemptId: "attempt-1", accepted: true });
    expect(h.out.join("")).toContain("Approved 'Laptop'");

    await putWindow(h.deps);
    stdin = "acid acorn acre acts\n";
    expect(await runCli(["enroll", "approve", "demo", "--words", "-"], h.deps)).toBe(1);
    expect(await decisionOf(h.deps)).toEqual({ attemptId: "attempt-1", accepted: false });
    expect(h.err.join("")).toContain("do not match");
    expect(h.err.join("")).not.toContain("acorn");
  });

  it("--words - with empty, short or oversized stdin is a usage error that records nothing and never echoes the input", async () => {
    const secret = "zebra";
    let stdin = "";
    h = await harness({ readStdin: async () => stdin });
    await upsertApp(h.deps, record());
    await putWindow(h.deps);
    for (const text of ["", " \n", `${secret} two three\n`, `${words()} ${secret}\n`, `${words()}\n${secret.repeat(1000)}`]) {
      stdin = text;
      expect(await runCli(["enroll", "approve", "demo", "--words", "-"], h.deps)).toBe(2);
    }
    expect(await decisionOf(h.deps)).toBeUndefined();
    expect(h.err.join("")).not.toContain(secret);
    expect(h.err.join("")).not.toContain(words().split(" ")[0]);
    expect(h.out.join("")).not.toContain(secret);
  });

  it("--words - refuses more than 4 KiB without reading further, even when the first words are right", async () => {
    const asked: number[] = [];
    h = await harness({ readStdin: async (max) => (asked.push(max), `${words()} ${"x".repeat(5000)}`) });
    await upsertApp(h.deps, record());
    await putWindow(h.deps);
    expect(await runCli(["enroll", "approve", "demo", "--words", "-"], h.deps)).toBe(2);
    expect(asked).toEqual([4096]);
    expect(await decisionOf(h.deps)).toBeUndefined();
    expect(h.err.join("")).toContain("at most 4096 bytes");
    expect(h.err.join("")).not.toContain(words().split(" ")[0]);
  });

  it("deny accepts --words - (stdin is drained) and still accepts no words at all", async () => {
    let reads = 0;
    h = await harness({ readStdin: async () => (reads++, "") });
    await upsertApp(h.deps, record());
    await putWindow(h.deps);
    expect(await runCli(["enroll", "deny", "demo", "--words", "-"], h.deps)).toBe(0);
    expect(reads).toBe(1);
    expect(await decisionOf(h.deps)).toEqual({ attemptId: "attempt-1", accepted: false });
    expect(h.out.join("")).toContain("Denied 'Laptop'");

    await putWindow(h.deps);
    expect(await runCli(["enroll", "deny", "demo"], h.deps)).toBe(0);
    expect(reads).toBe(1);
  });

  it("the argv form never reads stdin", async () => {
    h = await harness({ readStdin: async () => { throw new Error("stdin must not be read"); } });
    await upsertApp(h.deps, record());
    await putWindow(h.deps);
    expect(await runCli(["enroll", "approve", "demo", "--words", words()], h.deps)).toBe(0);
    expect(await decisionOf(h.deps)).toEqual({ attemptId: "attempt-1", accepted: true });
  });

  it("a request that was replaced after the read is refused by the store (the words were for another attempt)", async () => {
    h = await harness();
    await upsertApp(h.deps, record());
    const { recordDecision } = await import("@berdyh/bridge-runner");
    await putWindow(h.deps, { pending: { attemptId: "attempt-2", enrollId: "e2", label: "Other", publicKey: "pk", keyId: "kid-2" } });
    // A decision for attempt-1 (what an approve that read the old window would write) is refused.
    expect(await recordDecision(e2eeAppOf(record(), h.deps), "code-1", "attempt-1", true, new Date())).toBe(false);
    expect(await decisionOf(h.deps)).toBeUndefined();
  });
});
