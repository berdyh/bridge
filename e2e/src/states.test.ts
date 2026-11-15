import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Machine, type BridgeProcess } from "./machine.js";
import { HeadlessPage, enrollBrowser } from "./page.js";
import { collectingApp, connectApp, deployApp, promptOnce, startRunner, type AppDeployment } from "./world.js";

const ENROLL_PAGE = "/enroll";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the page's states follow the runner and the trust list", () => {
  let app: AppDeployment;
  let machine: Machine;
  let page: HeadlessPage;
  let runner: BridgeProcess;
  let runnerId = "";
  let browserKeyId = "";

  beforeAll(async () => {
    app = await deployApp("states-app", { enrollPage: ENROLL_PAGE });
    machine = await Machine.create();
    await connectApp(machine, app);
    page = await HeadlessPage.open(app);
  });
  afterAll(async () => {
    page?.close();
    await runner?.stop();
    await machine?.dispose();
    await app?.close();
  });

  it("no runner is online: the page is told so, and the app's runner is known only once it shows up", async () => {
    expect(page.states).toEqual(["no_runner"]);
  });

  it("a runner comes online: online_not_enrolled; after pairing: ready", async () => {
    runner = await startRunner(machine, [app], { e2ee: true });
    runnerId = (await page.waitForState("online_not_enrolled")).runner!.runnerId;
    const enrolled = await enrollBrowser(machine, page, "states-app");
    browserKeyId = enrolled.browserKeyId;
    await page.waitForState("ready");
    // A session works while it is ready.
    const updates: string[] = [];
    const answer = await promptOnce(await page.bridge.acp(collectingApp(updates), runnerId), updates, machine.project, "ready");
    expect(answer.stopReason).toBe("end_turn");
  });

  it("revoked on the machine: the runner refuses with not_trusted and the page goes back to online_not_enrolled", async () => {
    const revoked = await machine.exec(["browsers", "revoke", "states-app", browserKeyId]);
    expect(revoked.code).toBe(0);
    // The page still believes it is enrolled until it tries: the runner's refusal is what tells it.
    const channel = await page.bridge.channel(runnerId);
    const reason = await new Promise<string>((resolve) => (channel.closed ? resolve("(closed before listening)") : channel.onClose((r) => resolve(String(r)))));
    expect(reason).toBe("not_trusted");
    await page.waitForState("online_not_enrolled");
    expect(await page.bridge.isEnrolled(runnerId)).toBe(false);
  });

  it("the runner is stopped: runner_offline", async () => {
    const finished = await runner.stop();
    expect(finished.code).toBe(0);
    await page.waitForState("runner_offline");
    expect((await page.bridge.status()).runner).toMatchObject({ runnerId, online: false });
    expect(page.states).toEqual(["no_runner", "online_not_enrolled", "ready", "online_not_enrolled", "runner_offline"]);
  });
});

describe("two known runners online at once need a pick", () => {
  let app: AppDeployment;
  let first: Machine;
  let second: Machine;
  let page: HeadlessPage;
  const runners: BridgeProcess[] = [];

  beforeAll(async () => {
    app = await deployApp("pick-app", { enrollPage: ENROLL_PAGE });
    first = await Machine.create();
    second = await Machine.create();
    await connectApp(first, app);
    await connectApp(second, app);
    page = await HeadlessPage.open(app);
  });
  afterAll(async () => {
    page?.close();
    await Promise.all(runners.map((r) => r.stop()));
    await first?.dispose();
    await second?.dispose();
    await app?.close();
  });

  it("one runner: the page uses it; the second one online: runner_selection_required, until a runner is chosen", async () => {
    runners.push(await startRunner(first, [app], { e2ee: true }));
    const only = (await page.waitForState("online_not_enrolled")).runner!;
    runners.push(await startRunner(second, [app], { e2ee: true }));
    await page.waitForState("runner_selection_required");
    expect((await page.bridge.status()).runner).toBeUndefined();
    const online = page.bridge.runners().filter((r) => r.online);
    expect(online).toHaveLength(2);
    expect(online.map((r) => r.hostname).every((h) => typeof h === "string" && h.length > 0)).toBe(true);
    // Choosing a runner explicitly gives that runner's own state.
    const other = online.find((r) => r.runnerId !== only.runnerId)!;
    expect((await page.bridge.status(only.runnerId)).state).toBe("online_not_enrolled");
    expect((await page.bridge.status(other.runnerId)).state).toBe("online_not_enrolled");
  });

  it("one of them goes away: the other is the default again", async () => {
    await runners[1]!.stop();
    await page.waitForState("online_not_enrolled");
    expect(page.states.at(-1)).toBe("online_not_enrolled");
  });
});

describe("the runner stops by itself when no browser is connected", () => {
  let app: AppDeployment;
  let machine: Machine;
  const pages: HeadlessPage[] = [];
  const IDLE_MS = 4_000;
  const env = { E2E_IDLE_MS: String(IDLE_MS), E2E_PEER_GONE_MS: "300" };

  beforeAll(async () => {
    app = await deployApp("idle-app", { enrollPage: ENROLL_PAGE });
    machine = await Machine.create();
    await connectApp(machine, app);
  });
  afterAll(async () => {
    pages.forEach((p) => p.close());
    await machine?.dispose();
    await app?.close();
  });

  it("with no browser it stops after the grace period, exits 0, says so and leaves no status behind", async () => {
    const runner = machine.start(["run"], env, { seams: true });
    await runner.waitFor(/\[idle-app\] online/);
    const running = JSON.parse((await machine.exec(["status", "--json"])).stdout) as { running: boolean; idleSince?: string };
    expect(running.running).toBe(true);
    // Measured from when the runner itself says the idle period began, not from when this test got to look.
    expect(running.idleSince).toBeDefined();
    const idleSince = Date.parse(running.idleSince!);
    const done = await runner.exited;
    const waited = Date.now() - idleSince;
    expect(done.code).toBe(0);
    expect(done.stderr).toMatch(/no browser was connected for .* minutes; stopped/);
    // Not before the injected period is over, and not much later.
    expect(waited).toBeGreaterThanOrEqual(IDLE_MS - 100);
    expect(waited).toBeLessThan(IDLE_MS + 8_000);
    expect(JSON.parse((await machine.exec(["status", "--json"])).stdout)).toMatchObject({ running: false });
  });

  it("a browser that reloads inside the window keeps it running; once the last one leaves it stops", async () => {
    const runner = machine.start(["run"], env, { seams: true });
    await runner.waitFor(/\[idle-app\] online/);
    const first = await HeadlessPage.open(app);
    pages.push(first);
    await first.waitForState("online_not_enrolled");
    await enrollBrowser(machine, first, "idle-app");
    const runnerId = (await first.waitForState("ready")).runner!.runnerId;
    const talk = async (page: HeadlessPage) => {
      const updates: string[] = [];
      await promptOnce(await page.bridge.acp(collectingApp(updates), runnerId), updates, machine.project, "hold");
    };
    await talk(first);
    expect(JSON.parse((await machine.exec(["status", "--json"])).stdout)).toMatchObject({ running: true, browsers: 1 });

    // The tab is closed; the runner has no browser. The new tab (the same stored key) comes back inside the idle window.
    const closedAt = Date.now();
    first.close();
    await sleep(IDLE_MS / 2);
    const reloaded = await HeadlessPage.open(app, { keyStore: first.keyStore });
    pages.push(reloaded);
    await reloaded.waitForState("ready");
    await talk(reloaded);
    // Past the point where the first tab's departure would have stopped it, it is still up and counts the browser.
    await sleep(Math.max(0, closedAt + IDLE_MS + 2_500 - Date.now()));
    expect(JSON.parse((await machine.exec(["status", "--json"])).stdout)).toMatchObject({ running: true, browsers: 1 });

    reloaded.close();
    const done = await runner.exited;
    expect(done.code).toBe(0);
    expect(done.stderr).toMatch(/stopped/);
  });
});
