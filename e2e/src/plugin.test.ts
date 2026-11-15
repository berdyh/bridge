import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Machine, SAMPLE_PLUGIN_DIR, type BridgeProcess } from "./machine.js";
import { collectingApp, connectApp, deployApp, headlessClient, startRunner, type AppDeployment } from "./world.js";

describe("the sample plugin", () => {
  let app: AppDeployment;
  let machine: Machine;
  let runner: BridgeProcess;

  beforeAll(async () => {
    // The sample plugin's manifest names the app "sample-app": only that app's browsers may call it.
    app = await deployApp("sample-app");
    machine = await Machine.create();
    await connectApp(machine, app);
  });
  afterAll(async () => {
    await runner?.stop();
    await machine?.dispose();
    await app?.close();
  });

  it("`bridge plugin add` shows the permissions, asks, and installs", async () => {
    // A person at a terminal answers: the sample's MCP server and headless tool make its grant widened,
    // which a piped answer cannot approve.
    const declined = await machine.exec(["plugin", "add", SAMPLE_PLUGIN_DIR], "n\n", {}, { tty: true });
    expect(declined.code).not.toBe(0);
    expect((await machine.exec(["plugin", "list"])).stdout).toContain("No plugins installed");

    const added = await machine.exec(["plugin", "add", SAMPLE_PLUGIN_DIR], "y\n", {}, { tty: true });
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toMatch(/sample/);
    const listed = await machine.exec(["plugin", "list"]);
    expect(listed.stdout).toMatch(/^sample\t/m);
  });

  it("the client calls _sample/echo and is handed the plugin's local UI URL, which serves", async () => {
    runner = await startRunner(machine, [app], { e2ee: false });
    const headless = await headlessClient(app, { e2ee: false });
    try {
      const online = await headless.runner();
      const localUi = new Promise<{ pluginId: string; url: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no _bridge/localUi within 20s")), 20_000);
        headless.bridge.onLocalUi((params) => {
          clearTimeout(timer);
          resolve(params);
        });
      });
      const connection = await headless.bridge.acp(collectingApp([]), online.runnerId);
      const payload = { message: "hello plugin", nested: [1, null, "🦊"] };
      expect(await connection.agent.request("_sample/echo", payload)).toEqual(payload);

      const ui = await localUi;
      expect(ui.pluginId).toBe("sample");
      expect(new URL(ui.url).hostname).toBe("127.0.0.1");
      const page = await fetch(ui.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Bridge sample plugin");
      // The page lives on the user's machine only: the relay never carried it.
      expect(app.traffic.some((t) => t.raw.includes("Bridge sample plugin"))).toBe(false);
    } finally {
      headless.bridge.close();
    }
  });
});
