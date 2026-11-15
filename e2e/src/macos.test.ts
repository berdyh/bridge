import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DECOY_SECRET, Machine, type BridgeProcess, type Snapshot } from "./machine.js";
import { collectingApp, connectApp, deployApp, headlessClient, promptOnce, startRunner, type AppDeployment } from "./world.js";

const gone = async (file: string) => stat(file).then(() => false, () => true);
async function until(check: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

// macOS has no PID namespace. A staged-login session runs in an ordinary process group; once the agent
// ends and its group reads empty, the runner persists the login and releases the lease and staged copy.
describe.runIf(process.platform === "darwin")("a staged-login session on macOS releases its login", () => {
  let app: AppDeployment;
  let machine: Machine;
  let runner: BridgeProcess;
  let agentDirsBefore: Snapshot;

  beforeAll(async () => {
    app = await deployApp("macos-app");
    machine = await Machine.create();
    agentDirsBefore = await machine.protectedSnapshot();
    await connectApp(machine, app);
  });
  afterAll(async () => {
    await runner?.stop();
    await machine?.dispose();
    await app?.close();
  });

  it("runs from bridge's login copy, then leaves no lease, staged copy or sandbox behind", async () => {
    runner = await startRunner(machine, [app], { e2ee: false });
    const lease = `${machine.claudeLogin}.bridge-login-lease`;
    const tmp = path.join(machine.home, ".local", "state", "macos-app", "bridge", "tmp");
    const headless = await headlessClient(app, { e2ee: false });
    try {
      const online = await headless.runner();
      const updates: string[] = [];
      const connection = await headless.bridge.acp(collectingApp(updates), online.runnerId);
      const answer = await promptOnce(connection, updates, machine.project, "hello from macOS");
      expect(answer.stopReason).toBe("end_turn");
      expect(answer.text).toMatch(/echo: hello from macOS$/);
      expect(await gone(lease)).toBe(false);
    } finally {
      headless.bridge.close();
    }
    await until(() => gone(lease));
    await until(async () => (await readdir(tmp).catch(() => [] as string[])).every((name) => !name.startsWith("bridge-acp-")));
    expect(await machine.protectedSnapshot()).toEqual(agentDirsBefore);
    expect(await machine.filesContaining(DECOY_SECRET)).toEqual([]);
  });
});
