import os from "node:os";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectBridge, type BridgeClient } from "@berdyh/bridge-client";
import { boundedHostname, parseEnrollFragment, wordsOf } from "@berdyh/bridge-protocol";
import { browserSocket, cliBinary, cliCommand, ObservedSocket, startCli, startWorker, until } from "./harness.js";

describe("enrollPage and hostname under wrangler dev", () => {
  let worker: Awaited<ReturnType<typeof startWorker>>;
  let setup: ReturnType<typeof startCli> | undefined;
  let browser: BridgeClient | undefined;
  let binary: string;

  beforeAll(async () => {
    worker = await startWorker();
    await mkdir(path.join(worker.dir, "home"));
    binary = await cliBinary(worker.dir);
  });
  afterAll(async () => {
    browser?.close();
    await setup?.close();
    for (const socket of ObservedSocket.all) socket.terminate();
    await worker?.close();
    ObservedSocket.all.length = 0;
  });

  it("discovery names the enroll page, and the runner's hello carries the machine's hostname to the page", async () => {
    const discovery = await (await fetch(`${worker.origin}/.well-known/bridge.json`)).json() as { enrollPage?: string };
    expect(discovery.enrollPage).toBe("/bridge/enroll");

    // `bridge setup` with no terminal: consent by flag, the runner in this process, the link from discovery.
    setup = startCli(binary, worker.dir, ["setup", worker.origin, "--json", "--yes", "--foreground", "--no-install", "--no-open"]);
    const event = async (name: string): Promise<Record<string, unknown>> => {
      await until(() => new RegExp(`^\\{"event":"${name}".*\\}$`, "m").test(setup!.output()), `setup event ${name}`, 40_000);
      return JSON.parse(setup!.output().match(new RegExp(`^(\\{"event":"${name}".*\\})$`, "m"))![1]!) as Record<string, unknown>;
    };
    const shown = await event("enroll_code") as { url: string };
    // The link is the app's own origin and the page discovery advertised; the code rides in the fragment only.
    const link = new URL(shown.url);
    expect(link.origin).toBe(worker.origin);
    expect(link.pathname).toBe("/bridge/enroll");
    expect(link.search).toBe("");
    const found = parseEnrollFragment(link.hash);
    expect(found).toBeDefined();

    const keys = new Map<string, unknown>();
    browser = await connectBridge({ discoveryUrl: `${worker.origin}/.well-known/bridge.json`,
      getSessionToken: async () => "test-browser", webSocket: browserSocket(worker.origin),
      keyStore: { load: async (key) => keys.get(key), save: async (key, value) => { keys.set(key, value); }, delete: async (key) => { keys.delete(key); } },
    });
    await until(() => browser!.runners().some((r) => r.online), "runner presence");
    const runner = browser.runners().find((r) => r.online)!;
    expect(runner.runnerId).toBe(found!.runnerId);
    // Display text only, bounded by the relay: the machine's own name.
    expect(runner.hostname).toBe(boundedHostname(os.hostname()));

    // The page enrolls with what the link carried; the words match; a second process answers.
    let words: string[] = [];
    const enrolling = browser.enroll(found!.code, found!.runnerId, { onBrowserKey: (keyId) => { words = wordsOf(keyId); } });
    const trust = await event("trust_request") as { words: string[] };
    expect(trust.words).toEqual(words);
    await cliCommand(binary, worker.dir, ["enroll", "approve", "sample-app", "--words", words.join(" ")]);
    const enrolled = await enrolling;
    await event("ready");
    expect(await browser.isEnrolled(runner.runnerId)).toBe(true);
    expect(enrolled.runnerId).toBe(runner.runnerId);
  });
});
