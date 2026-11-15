import { stat } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DECOY_SECRET, Machine, type BridgeProcess, type Snapshot } from "./machine.js";
import { collectingApp, connectApp, deployApp, headlessClient, promptOnce, startRunner, type AppDeployment } from "./world.js";

describe("plaintext walking skeleton (BRIDGE_E2EE=0)", () => {
  let app: AppDeployment;
  let machine: Machine;
  let runner: BridgeProcess;
  let agentDirsBefore: Snapshot;

  beforeAll(async () => {
    app = await deployApp("m0-app");
    machine = await Machine.create();
    agentDirsBefore = await machine.protectedSnapshot();
  });
  afterAll(async () => {
    await runner?.stop();
    await machine?.dispose();
    await app?.close();
  });

  it("pairs the real bridge CLI against the local server, through the stub OAuth server", async () => {
    await connectApp(machine, app);
    expect(app.oauth.requests.map((r) => r.path)).toContain("/device");
    expect(app.oauth.requests.map((r) => r.path)).toContain("/token");
    // The tokens went to the (fake) keychain, not the real one.
    expect(await machine.keychainEntries()).toBeGreaterThan(0);
    const apps = await machine.exec(["apps", "list"]);
    expect(apps.stdout).toContain("m0-app");
  });

  it("a headless client prompts a stub ACP agent binary through the relay", async () => {
    runner = await startRunner(machine, [app], { e2ee: false });
    const headless = await headlessClient(app, { e2ee: false });
    try {
      const online = await headless.runner();
      const updates: string[] = [];
      const connection = await headless.bridge.acp(collectingApp(updates), online.runnerId);
      const answer = await promptOnce(connection, updates, machine.project, "hello from the browser");
      expect(answer.stopReason).toBe("end_turn");
      // The answer carries the pid of the stub agent process: a real child, not this test process.
      const pid = Number(answer.text.match(/^agent\[(\d+)\] echo: hello from the browser$/)?.[1]);
      expect(pid).toBeGreaterThan(0);
      expect(pid).not.toBe(process.pid);
      // The relay saw the prompt in the clear: plaintext mode really is plaintext (the control for the encrypted test).
      expect(app.traffic.some((t) => t.raw.includes("hello from the browser"))).toBe(true);
      // The session ran from bridge's own login copy; the person's own agent dirs (decoys) are byte for byte as they were.
      expect((await stat(machine.claudeLogin)).isFile()).toBe(true);
      expect(await machine.protectedSnapshot()).toEqual(agentDirsBefore);
      expect(await machine.filesContaining(DECOY_SECRET)).toEqual([]);
    } finally {
      headless.bridge.close();
    }
  });
});
