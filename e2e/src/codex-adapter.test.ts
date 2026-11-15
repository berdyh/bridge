// The codex adapter path, end to end with the real CLI and runner as child processes and the
// stub ACP agent standing in for `codex-acp` (never the real adapter or the real codex). A machine whose only login is
// bridge's own codex login: no claude login, no codex adapter installed, none on PATH.
//   1. Without an adapter: `bridge doctor` names `bridge agent install codex`, the runner advertises no usable agent,
//      and the install refuses without a terminal and without --yes (nothing is fetched).
//   2. With `BRIDGE_CODEX_ADAPTER` pointing at the stub: `bridge doctor` finds it, the runner advertises codex (and not
//      claude), and a session reaches the stub through the relay.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Machine, type BridgeProcess } from "./machine.js";
import { collectingApp, connectApp, deployApp, headlessClient, promptOnce, type AppDeployment } from "./world.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const PROMPT = "codex adapter e2e: say hello";

describe("the codex adapter path", () => {
  let app: AppDeployment;
  let machine: Machine;
  let stub: string;
  let runner: BridgeProcess | undefined;

  beforeAll(async () => {
    app = await deployApp("codex-app");
    // `defer`: none of bridge's own files, so no claude login. The policy and bridge's own codex login (the shape
    // `codex login` writes) are staged here.
    machine = await Machine.create({ defer: true });
    await mkdir(path.join(machine.configDir, "bridge"), { recursive: true });
    await writeFile(path.join(machine.configDir, "bridge", "policy.json"), JSON.stringify({ allowedCwds: [machine.project] }));
    const codexLogin = path.join(machine.configDir, "bridge", "agents", "codex", "auth.json");
    await mkdir(path.dirname(codexLogin), { recursive: true, mode: 0o700 });
    await writeFile(codexLogin, JSON.stringify({ tokens: { access_token: "e2e-not-a-real-token" } }), { mode: 0o600 });
    // The stub ACP agent under the adapter's name, but not on PATH: only BRIDGE_CODEX_ADAPTER points at it.
    const stubDir = path.join(machine.root, "codex-stub");
    await mkdir(stubDir, { recursive: true });
    stub = path.join(stubDir, "codex-acp");
    await writeFile(stub, `#!/bin/sh\nexec "${process.execPath}" "${path.join(fixtures, "stub-acp-agent.mjs")}" "$@"\n`);
    await chmod(stub, 0o755);
    await connectApp(machine, app);
  }, 120_000);

  afterAll(async () => {
    await runner?.stop();
    await machine?.dispose();
    await app?.close();
  });

  it("without an adapter: doctor names the install command, the install refuses without --yes, and no agent is advertised", async () => {
    const doctor = await machine.exec(["doctor"]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain("codex: no adapter installed; run `bridge agent install codex` (about 450 MB from the npm registry into ");
    expect(doctor.stdout).toContain("login present");

    // No terminal and no --yes: the usage error comes before any npm run or write.
    const install = await machine.exec(["agent", "install", "codex"]);
    expect(install.code).toBe(2);
    expect(install.stderr).toContain("without a terminal, pass --yes to install the codex adapter");
    expect(await machine.snapshot([path.join(machine.dataDir, "bridge", "adapters")])).toEqual({});

    const bare = machine.start(["run"], { BRIDGE_E2EE: "0" });
    try {
      await bare.waitFor(/\[codex-app\] online/);
      expect(bare.stderr()).toContain("bridge run: warn: the codex adapter is not installed; codex sessions are refused until you run `bridge agent install codex`");
      const headless = await headlessClient(app, { e2ee: false });
      try {
        const online = await headless.runner();
        expect(online.agents?.filter((a) => a.available)).toEqual([]);
      } finally {
        headless.bridge.close();
      }
    } finally {
      await bare.stop();
    }
  });

  it("through BRIDGE_CODEX_ADAPTER: doctor finds the adapter, the runner advertises codex, and a session reaches it", async () => {
    const env = { BRIDGE_CODEX_ADAPTER: stub };
    const doctor = await machine.exec(["doctor"], "", env);
    expect(doctor.stdout).toContain(`codex: adapter found (adapter on PATH: ${stub}), login present`);
    expect(doctor.stdout).not.toContain("bridge agent install codex");

    runner = machine.start(["run"], { BRIDGE_E2EE: "0", ...env });
    await runner.waitFor(/\[codex-app\] online/);
    expect(runner.stderr()).not.toContain("adapter is not installed");
    const headless = await headlessClient(app, { e2ee: false });
    try {
      const online = await headless.runner();
      expect(online.agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: "codex", available: true })]));
      expect(online.agents?.find((a) => a.id === "claude")).toMatchObject({ available: false });
      const updates: string[] = [];
      const connection = await headless.bridge.acp(collectingApp(updates), online.runnerId);
      const answer = await promptOnce(connection, updates, machine.project, PROMPT);
      expect(answer.stopReason).toBe("end_turn");
      expect(answer.text).toMatch(new RegExp(`^agent\\[\\d+\\] echo: ${PROMPT}$`));
    } finally {
      headless.bridge.close();
    }
  });
});
