/**
 * A runner revoked while it was offline learns it from the relay itself. The device is revoked while
 * `bridge run` is stopped; on its next start the upgrade completes only to say `revoked` and close, `bridge run` writes
 * `revoked.json` naming the old runner id and stays up (a parked link, no restart loop), and `bridge connect` mints a
 * fresh runner id that comes online. Without the verdict the relay answers that upgrade with a bare 403, which the runner could
 * not tell from a refusal.
 *
 * The real revoke path: `DELETE /bridge/devices/:id` revokes the runner's credential at the (stub) identity provider
 * as well as the device, as Clerk revokes the API key. The stub verifier then reports the offline runner's old token as
 * a revoked credential, and the relay, whose store confirms the revoke, answers with the verdict instead of a 401.
 * Because the identity provider hands out a new credential at the next pairing (as Clerk does), the stub OAuth server
 * here issues the second token after the revoke; `startOAuthStub` issues one fixed token, which would be revoked too.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createNodeBridgeServer, createStubAuthVerifier, type NodeBridgeServer } from "@berdyh/bridge-server-node";
import { afterAll, describe, expect, it } from "vitest";

import { Machine } from "./machine.js";

const APP = "revoke-app";
const FIRST_TOKEN = "runner-token-1-revoke-app";
const SECOND_TOKEN = "runner-token-2-revoke-app";
const BROWSER_TOKEN = "browser-token-revoke-app";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stub RFC 8628 server that approves at once and issues `current()` as the access token. */
async function rotatingOAuth(clientId: string, current: () => string): Promise<{ http: Server; url: string; close(): Promise<void> }> {
  const form = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
  };
  const http = createServer((req, res) => {
    void (async () => {
      const params = await form(req);
      const reply = (status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.method !== "POST" || params.client_id !== clientId) return reply(400, { error: "invalid_client" });
      const route = new URL(req.url ?? "/", "http://stub").pathname;
      if (route === "/device") return reply(200, { device_code: "e2e-device-code", user_code: "ABCD-EFGH", verification_uri: "http://127.0.0.1/verify", expires_in: 600, interval: 0.1 });
      if (route === "/token") return reply(200, { access_token: current(), refresh_token: "e2e-refresh", token_type: "Bearer", expires_in: 3600 });
      reply(404, { error: "not_found" });
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { http, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections(); }) };
}

describe("a runner revoked while offline gets the relay's revoked verdict ", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  // `providerForgets`: the identity provider no longer knows the revoked key at all (Clerk answers 404 about a minute
  // after a revoke), so the verifier says undefined and only the relay's token fingerprint can tell it was revoked here.
  it.each([
    ["the verifier still reports the revoked credential as revoked", false],
    ["a long-offline runner: the verifier refuses the revoked token outright", true],
  ])("writes revoked.json naming the old id, stays up, and bridge connect mints a fresh id that comes online: %s", async (_name, providerForgets) => {
    let issued = FIRST_TOKEN;
    let forgotten = false;
    const oauth = await rotatingOAuth(`runner-${APP}`, () => issued);
    cleanups.push(() => oauth.close());
    const stub = createStubAuthVerifier({ browser: { [BROWSER_TOKEN]: "alice" }, runner: { [FIRST_TOKEN]: "alice", [SECOND_TOKEN]: "alice" } });
    const server: NodeBridgeServer = await createNodeBridgeServer({
      app: { id: APP, name: `App ${APP}` },
      auth: { issuer: oauth.url, clientId: `runner-${APP}`, deviceAuthorizationEndpoint: `${oauth.url}/device`, tokenEndpoint: `${oauth.url}/token` },
      adapters: { verifier: { ...stub, verifyRunner: async (token) => (forgotten && token === FIRST_TOKEN ? undefined : stub.verifyRunner(token)) } },
    });
    cleanups.push(() => server.close());
    const auth = { authorization: `Bearer ${BROWSER_TOKEN}` };
    const devices = async () => ((await (await fetch(`${server.url}/bridge/devices`, { headers: auth })).json()) as { devices: { deviceId: string }[] }).devices.map((d) => d.deviceId);

    const machine = await Machine.create();
    cleanups.push(() => machine.dispose());
    const paired = await machine.exec(["connect", server.url, "--yes"]);
    expect(paired.code, paired.stderr).toBe(0);
    const appFile = path.join(machine.configDir, APP, "bridge", "app.json");
    const revokedFile = path.join(machine.configDir, APP, "bridge", "revoked.json");
    const runnerIdOf = async () => (JSON.parse(await readFile(appFile, "utf8")) as { runnerId: string }).runnerId;
    const oldId = await runnerIdOf();

    // Online once, then stopped: the device is known to the server.
    const first = machine.start(["run"], { BRIDGE_E2EE: "0" });
    await first.waitFor(new RegExp(`\\[${APP}\\] online`));
    expect((await first.stop()).code).toBe(0);
    expect(await devices()).toEqual([oldId]);

    // Revoked while the runner is offline: the device and its credential. The next pairing gets a new credential.
    issued = SECOND_TOKEN;
    const revoke = await fetch(`${server.url}/bridge/devices/${oldId}`, { method: "DELETE", headers: auth });
    expect(revoke.status).toBe(200);
    forgotten = providerForgets;

    // Its next start: the relay says revoked (not a bare 403), the runner records it and stays up.
    const second = machine.start(["run"], { BRIDGE_E2EE: "0" });
    await second.waitFor(new RegExp(`\\[${APP}\\] revoked`));
    for (let i = 0; i < 100; i++) {
      if (await readFile(revokedFile, "utf8").then(() => true, () => false)) break;
      await sleep(50);
    }
    const mark = JSON.parse(await readFile(revokedFile, "utf8")) as { version: number; runnerId: string };
    expect(mark).toMatchObject({ version: 1, runnerId: oldId });
    await sleep(1_500);
    expect(second.stderr()).not.toContain("relay connection failed"); // a verdict, not a refusal the link retries
    const early = await Promise.race([second.exited, sleep(0).then(() => undefined)]);
    expect(early, "bridge run must stay up after the verdict").toBeUndefined();

    // bridge connect replaces the revoked id; a restarted runner comes online under the new one.
    const reconnect = await machine.exec(["connect", server.url, "--yes"]);
    expect(reconnect.code, reconnect.stderr).toBe(0);
    expect(reconnect.stdout).toContain("new machine");
    const newId = await runnerIdOf();
    expect(newId).not.toBe(oldId);
    // Parked, it waits for a stop signal ("will not be retried"); stopping it is the person's restart.
    expect(second.stderr()).toContain(`${APP} is revoked and will not be retried; waiting for a stop signal`);
    await second.stop();

    const third = machine.start(["run"], { BRIDGE_E2EE: "0" });
    await third.waitFor(new RegExp(`\\[${APP}\\] online`));
    expect(await devices()).toEqual([newId]); // the revoked id is gone from the list, the fresh one is registered
    expect((await third.stop()).code).toBe(0);
  }, 120_000);
});
