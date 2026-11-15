import { afterAll, beforeAll, describe, expect, it } from "vitest";


import WebSocket from "ws";
import { RELAY_SUBPROTOCOL, bearerSubprotocol } from "@berdyh/bridge-protocol";

import { Machine, SAMPLE_PLUGIN_DIR, type BridgeProcess } from "./machine.js";
import { collectingApp, connectApp, deployApp, headlessClient, promptOnce, startRunner, type AppDeployment } from "./world.js";

/** `extensionNotFound` of the runner's ACP proxy: what an unknown or foreign `_<plugin>/...` method gets. */
const EXTENSION_NOT_FOUND = -32013;

/** The HTTP status of a socket upgrade to `app`'s relay with `token` (101 when accepted). */
function upgradeStatus(app: AppDeployment, token: string, role: "browser" | "runner" = "browser", runnerId = ""): Promise<number> {
  return new Promise((resolve) => {
    const query = role === "browser" ? `browserKeyId=probe-${"x".repeat(24)}` : `runnerId=${runnerId}`;
    const ws = new WebSocket(`${app.server.url.replace("http", "ws")}/relay/${role}?${query}`, [RELAY_SUBPROTOCOL, bearerSubprotocol(token)], {
      headers: { origin: app.server.url },
    });
    ws.once("open", () => {
      resolve(101);
      ws.terminate();
    });
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", () => undefined);
  });
}

/**
 * Opens a browser socket authenticated to `app`, sends `envelopes` addressed to `runnerId`, and
 * returns every message the relay answered with (after `settleMs` of quiet).
 */
function sendAsBrowser(app: AppDeployment, token: string, runnerId: string, kind: "frame" | "pake"): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const browserKeyId = `probe-${"y".repeat(24)}`;
    const replies: string[] = [];
    const ws = new WebSocket(`${app.server.url.replace("http", "ws")}/relay/browser?browserKeyId=${browserKeyId}`, [RELAY_SUBPROTOCOL, bearerSubprotocol(token)], {
      headers: { origin: app.server.url },
    });
    ws.on("message", (data) => replies.push(data.toString()));
    ws.once("error", reject);
    ws.once("open", () => {
      ws.send(JSON.stringify({ to: "runner", runnerId, browserKeyId, kind, body: "cross-app-probe" }));
      setTimeout(() => {
        ws.terminate();
        resolve(replies);
      }, 500);
    });
  });
}

/** One runner, two servers. The sample plugin belongs to B ("sample-app") only. */
describe("two apps on one runner stay apart", () => {
  let a: AppDeployment;
  let b: AppDeployment;
  let machine: Machine;
  let runner: BridgeProcess;
  const runnerIds: Record<string, string> = {};

  beforeAll(async () => {
    a = await deployApp("app-a");
    b = await deployApp("sample-app");
    machine = await Machine.create();
    await connectApp(machine, a);
    await connectApp(machine, b);
    // At a terminal: the sample's grant is widened (an MCP server and a headless tool).
    const added = await machine.exec(["plugin", "add", SAMPLE_PLUGIN_DIR], "y\n", {}, { tty: true });
    expect(added.code, added.stderr).toBe(0);
    runner = await startRunner(machine, [a, b], { e2ee: false });
  });
  afterAll(async () => {
    await runner?.stop();
    await machine?.dispose();
    await Promise.all([a?.close(), b?.close()]);
  });

  it("each server sees one runner id, and the two ids differ", async () => {
    for (const app of [a, b]) {
      const client = await headlessClient(app, { e2ee: false });
      try {
        runnerIds[app.appId] = (await client.runner()).runnerId;
        expect(client.bridge.runners()).toHaveLength(1);
      } finally {
        client.bridge.close();
      }
    }
    expect(runnerIds["app-a"]).not.toBe(runnerIds["sample-app"]);
  });

  it("keeps a separate credential per app in the keychain", async () => {
    // Two apps, two token entries (plus nothing shared), each under its own attributes and holding its own token.
    expect(await machine.keychainEntries()).toBe(2);
    const entries = await machine.keychainContents();
    const serviceOf = (e: { attributes: Record<string, string> }) => JSON.stringify(e.attributes);
    expect(new Set(entries.map(serviceOf)).size).toBe(2);
    for (const app of [a, b]) {
      const mine = entries.filter((e) => e.secret.includes(app.runnerToken));
      expect(mine, `entries holding ${app.appId}'s runner token`).toHaveLength(1);
      const foreign = app === a ? b : a;
      expect(mine[0]?.secret.includes(foreign.runnerToken)).toBe(false);
    }
  });

  it("both apps' clients reach their own agent", async () => {
    for (const app of [a, b]) {
      const client = await headlessClient(app, { e2ee: false });
      try {
        const updates: string[] = [];
        const connection = await client.bridge.acp(collectingApp(updates), runnerIds[app.appId]);
        const answer = await promptOnce(connection, updates, machine.project, `hi from ${app.appId}`);
        expect(answer.text).toContain(`echo: hi from ${app.appId}`);
      } finally {
        client.bridge.close();
      }
    }
  });

  it("A's server refuses B's tokens, on the browser and the runner socket", async () => {
    // B's session token means nothing to A's server; A's own is accepted.
    expect(await upgradeStatus(a, b.browserToken)).toBe(401);
    expect(await upgradeStatus(a, a.browserToken)).toBe(101);
    // Nor can B's runner token open a runner socket on A's relay.
    expect(await upgradeStatus(a, b.runnerToken, "runner", runnerIds["app-a"]!)).toBe(401);
    // And no frame meant for B's runner was ever forwarded by A's relay.
    expect(a.traffic.some((t) => t.raw.includes(runnerIds["sample-app"]!) && t.to === "runner")).toBe(false);
  });

  it("a client authenticated to A cannot address B's runner: A refuses it and nothing reaches B", async () => {
    const bRunner = runnerIds["sample-app"]!;
    const bIngressBefore = b.ingress.length;
    const bTrafficBefore = b.traffic.length;
    for (const kind of ["frame", "pake"] as const) {
      const replies = (await sendAsBrowser(a, a.browserToken, bRunner, kind)).filter((r) => !r.includes('"kind":"presence"'));
      // A's relay has no such runner: it answers with an error and forwards nothing.
      expect(replies.some((r) => r.includes("unknown_runner")), `replies: ${replies.join(" | ")}`).toBe(true);
    }
    // The same through the SDK: a bridge-client signed in to A, asked to talk to B's runner id.
    const clientA = await headlessClient(a, { e2ee: false });
    try {
      const attempt = clientA.bridge.acp(collectingApp([]), bRunner).then((c) => c.agent.request("initialize", { protocolVersion: 1 }));
      const outcome = await Promise.race([attempt.then(() => "delivered", () => "rejected"), new Promise((r) => setTimeout(() => r("pending"), 3000))]);
      expect(outcome).not.toBe("delivered");
    } finally {
      clientA.bridge.close();
    }
    // Nothing was delivered: A's relay forwarded no frame to a runner on this id, and B saw no new traffic at all.
    expect(a.traffic.some((t) => t.to === "runner" && t.raw.includes(bRunner))).toBe(false);
    expect(a.traffic.some((t) => t.raw.includes("cross-app-probe"))).toBe(false);
    expect(b.ingress.length).toBe(bIngressBefore);
    expect(b.traffic.length).toBe(bTrafficBefore);
    expect(b.ingress.some((i) => i.raw.includes("cross-app-probe"))).toBe(false);
  });

  it("A's client cannot call B's plugin; B's client can", async () => {
    const clientA = await headlessClient(a, { e2ee: false });
    const clientB = await headlessClient(b, { e2ee: false });
    try {
      const viaA = await clientA.bridge.acp(collectingApp([]), runnerIds["app-a"]);
      await expect(viaA.agent.request("_sample/echo", { x: 1 })).rejects.toMatchObject({ code: EXTENSION_NOT_FOUND });
      const viaB = await clientB.bridge.acp(collectingApp([]), runnerIds["sample-app"]);
      expect(await viaB.agent.request("_sample/echo", { x: 1 })).toEqual({ x: 1 });
    } finally {
      clientA.bridge.close();
      clientB.bridge.close();
    }
  });
});
