/**
 * A real process: `bridge run` (the built CLI through `fixtures/bridge-cli.mjs`, production backoff and
 * timers) against a relay that refuses every upgrade with HTTP 403, and one that takes the upgrade and never finishes
 * the handshake. Neither child may exit while its link retries: `bridge run` once exited 13
 * ("unsettled top-level await") with no line in both cases, and a service manager restarted it in a loop. The in-process
 * tests cannot see that exit (Vitest and their fake relay hold the loop), so this one runs the child for 60 real
 * seconds. Both cases run at once, so the suite pays the minute once. No service manager is used.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { SEAMS_CLI } from "./containment-world.js";
import { Machine, type BridgeProcess, type Finished } from "./machine.js";
import { connectApp, deployApp, type AppDeployment } from "./world.js";

const APP = "park-app";
const HOLD_MS = 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface BrokenRelay {
  relayUrl: string;
  attempts: () => number;
  close(): Promise<void>;
}

/** A relay that answers every runner upgrade with 403 (`refuse`), or takes it and never answers (`hang`). */
async function brokenRelay(mode: "refuse" | "hang"): Promise<BrokenRelay> {
  let attempts = 0;
  const sockets = new Set<Duplex>();
  const server: Server = createServer((_req, res) => void res.writeHead(404).end());
  server.on("upgrade", (_req, socket: Duplex) => {
    attempts += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (mode === "refuse") socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    relayUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/relay`,
    attempts: () => attempts,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A machine connected to the app for real (`bridge connect`), whose record then points its runner at `relay`. */
async function machineAgainst(app: AppDeployment, relay: BrokenRelay): Promise<Machine> {
  const machine = await Machine.create();
  await connectApp(machine, app);
  const appFile = path.join(machine.configDir, APP, "bridge", "app.json");
  const record = JSON.parse(await readFile(appFile, "utf8")) as Record<string, unknown>;
  await writeFile(appFile, JSON.stringify({ ...record, relayUrl: relay.relayUrl }, null, 2) + "\n", { mode: 0o600 });
  return machine;
}

const refusalLines = (proc: BridgeProcess): string[] => proc.stderr().split("\n").filter((l) => l.startsWith(`[${APP}] warn: relay connection failed`));

describe("bridge run, a real child process, against a relay that refuses it or never answers", () => {
  let app: AppDeployment | undefined;
  const relays: BrokenRelay[] = [];
  const machines: Machine[] = [];
  afterAll(async () => {
    await Promise.all(machines.map((m) => m.dispose()));
    await Promise.all(relays.map((r) => r.close()));
    await app?.close();
  });

  it("stays up for 60 real seconds in both cases, logging each refusal, never exits 13, and stops cleanly on SIGTERM", async () => {
    app = await deployApp(APP);
    const refuseRelay = await brokenRelay("refuse");
    const hangRelay = await brokenRelay("hang");
    relays.push(refuseRelay, hangRelay);
    const refuseMachine = await machineAgainst(app, refuseRelay);
    const hangMachine = await machineAgainst(app, hangRelay);
    machines.push(refuseMachine, hangMachine);

    // No E2E_IDLE_MS: the seams entry runs `runCli`, the production path with its own timers and backoff.
    const started = Date.now();
    const refuse = refuseMachine.start(["run"], { BRIDGE_E2EE: "0" }, { entry: SEAMS_CLI });
    const hang = hangMachine.start(["run"], { BRIDGE_E2EE: "0" }, { entry: SEAMS_CLI });
    const early: Partial<Record<"refuse" | "hang", Finished>> = {};
    void refuse.exited.then((f) => (early.refuse = f));
    void hang.exited.then((f) => (early.hang = f));
    const report = () =>
      Object.entries(early)
        .map(([k, f]) => `${k} exited ${f!.code}:\n--- stdout\n${f!.stdout}\n--- stderr\n${f!.stderr}`)
        .join("\n");

    // Either child exiting ends the wait at once (an exit 13 shows up seconds in, not at the minute).
    await Promise.race([sleep(HOLD_MS), refuse.exited, hang.exited]);
    expect(report()).toBe("");
    // The wait ended by the timer, not a child exit; Date.now() and timer rounding can differ by a millisecond (seen as 59999 on macOS).
    expect(Date.now() - started).toBeGreaterThanOrEqual(HOLD_MS - 2);

    // 403 at the upgrade, backoff 1, 2, 4, 8, 16 s at most: six attempts by the minute, each step logged with its reason.
    expect(refuseRelay.attempts()).toBeGreaterThanOrEqual(4);
    const refused = refusalLines(refuse);
    expect(refused.length).toBeGreaterThanOrEqual(4);
    expect(refused.every((l) => l.includes("the relay refused the connection"))).toBe(true);

    // A handshake that never finishes: each attempt waits out the link's 15 s connect timer, so the fourth
    // refusal line lands by about 67 s. The child is still up when it does.
    await hang.waitFor(/(?:\[park-app\] warn: relay connection failed[^]*?){4}/, { stream: "stderr", timeoutMs: 20_000 });
    expect(report()).toBe("");
    expect(hangRelay.attempts()).toBeGreaterThanOrEqual(4);
    const unanswered = refusalLines(hang);
    expect(unanswered.length).toBeGreaterThanOrEqual(4);
    expect(unanswered.every((l) => l.includes("the relay did not answer in time"))).toBe(true);

    // Told to stop, each runner stops by itself and exits 0 (never 13).
    const [r, h] = await Promise.all([refuse.stop(), hang.stop()]);
    expect(r.code).toBe(0);
    expect(h.code).toBe(0);
  }, 120_000);
});
