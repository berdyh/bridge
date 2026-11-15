import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findPlaintextViolations } from "./blindness.js";
import { Machine, type BridgeProcess } from "./machine.js";
import { collectingApp, connectApp, deployApp, headlessClient, memoryKeyStore, promptOnce, startRunner, type AppDeployment } from "./world.js";

const PROMPT = "m1 secret prompt: rotate the launch codes";

describe("end-to-end encryption with SPAKE2 enrollment", () => {
  let app: AppDeployment;
  let machine: Machine;
  let runner: BridgeProcess;
  const keyStore = memoryKeyStore();
  let code = "";
  let browserKeyId = "";

  beforeAll(async () => {
    app = await deployApp("m1-app");
    machine = await Machine.create();
    await connectApp(machine, app);
    runner = await startRunner(machine, [app], { e2ee: true });
  });
  afterAll(async () => {
    await runner?.stop();
    await machine?.dispose();
    await app?.close();
  });

  it("a browser with no enrolled key is refused locally, before anything is sent", async () => {
    const stranger = await headlessClient(app, { e2ee: true });
    try {
      const online = await stranger.runner();
      // The client refuses at once ("not enrolled"): no ACP request can get through it. The runner is not involved.
      const channel = await stranger.bridge.channel(online.runnerId);
      if (!channel.closed) await new Promise<void>((resolve) => channel.onClose(() => resolve()));
      expect(channel.closed).toBe(true);
      const connection = stranger.bridge.acp(collectingApp([]), online.runnerId);
      await expect(connection.then((c) => c.agent.request("initialize", { protocolVersion: 1 }))).rejects.toThrow();
    } finally {
      stranger.bridge.close();
    }
  });

  it("enrolls a browser with the code the runner shows, through the relay", async () => {
    const headless = await headlessClient(app, { e2ee: true, keyStore });
    const enrolling = machine.start(["enroll", "m1-app"]);
    try {
      const online = await headless.runner();
      code = (await enrolling.waitFor(/^\s+([A-Z0-9-]{8,12})\s*$/m))[1]!;
      // No terminal here, so `bridge enroll` shows the browser's four words and waits for `enroll approve`
      // (an agent's path): the test plays the human who compared them with the page.
      const trusted = (async () => {
        const words = (await enrolling.waitFor(/^Its words: (\S+ \S+ \S+ \S+)$/m))[1]!;
        const approved = await machine.exec(["enroll", "approve", "m1-app", "--words", words]);
        expect(approved.code).toBe(0);
      })();
      const enrolled = await headless.bridge.enroll(code, online.runnerId);
      await trusted;
      expect(enrolled.runnerId).toBe(online.runnerId);
      browserKeyId = enrolled.browserKeyId;
      const done = await enrolling.exited;
      expect(done.code).toBe(0);
      expect(done.stdout).toContain(enrolled.browserKeyId);
    } finally {
      headless.bridge.close();
      await enrolling.stop();
    }
    const listed = await machine.exec(["browsers", "list", "m1-app"]);
    expect(listed.stdout).toContain(browserKeyId);
  });

  it("the enrolled client prompts the stub agent over the encrypted channel", async () => {
    const headless = await headlessClient(app, { e2ee: true, keyStore });
    try {
      const online = await headless.runner();
      const updates: string[] = [];
      const connection = await headless.bridge.acp(collectingApp(updates), online.runnerId);
      const answer = await promptOnce(connection, updates, machine.project, PROMPT);
      expect(answer.stopReason).toBe("end_turn");
      expect(answer.text).toMatch(/^agent\[\d+\] echo: m1 secret prompt: rotate the launch codes$/);
    } finally {
      headless.bridge.close();
    }
  });

  it("a revoked browser's session/init reaches the runner, which refuses it", async () => {
    const revoked = await machine.exec(["browsers", "revoke", "m1-app", browserKeyId]);
    expect(revoked.code).toBe(0);
    const headless = await headlessClient(app, { e2ee: true, keyStore });
    const sentBefore = app.traffic.length;
    try {
      const online = await headless.runner();
      // Same keyStore, so the client believes it is enrolled and sends session/init; only the runner's trust check can say no.
      // Reject at once if the runner accepts the revoked key, instead of hanging until the test timeout.
      const accepted = () => app.traffic.slice(sentBefore).some((t) => t.from === "runner" && t.raw.includes('"session/accept"'));
      let watch: NodeJS.Timeout | undefined;
      let closeReason: string | undefined;
      const watcher = new Promise<never>((_, reject) => {
        watch = setInterval(() => { if (accepted()) reject(new Error("the runner accepted a revoked browser (session/accept crossed the relay)")); }, 10);
      });
      watcher.catch(() => undefined);
      try {
        const closed = (async () => {
          const channel = await headless.bridge.channel(online.runnerId);
          if (!channel.closed) await new Promise<void>((resolve) => channel.onClose((reason) => ((closeReason = reason), resolve())));
          expect(channel.closed).toBe(true);
        })();
        await Promise.race([closed, watcher]);
      } finally { clearInterval(watch); }
      expect(accepted(), "the runner must not accept a revoked browser").toBe(false);
      const crossed = app.traffic.slice(sentBefore);
      const types = (from: string) => crossed.filter((t) => t.from === from).map((t) => (JSON.parse(t.raw) as { body?: { t?: string } }).body?.t);
      expect(types("browser")).toContain("session/init");
      expect(types("runner")).toContain("session/close");
      // The runner says WHY (part of the contract): "not_trusted", not the "error" of a crashed agent, on the wire and in the client.
      const closes = crossed.filter((t) => t.from === "runner").map((t) => (JSON.parse(t.raw) as { body?: { t?: string; reason?: string } }).body).filter((b) => b?.t === "session/close");
      expect(closes.map((b) => b?.reason)).toEqual(["not_trusted"]);
      expect(closeReason).toBe("not_trusted");
      // And the page now reads the state it should show: this browser is no longer trusted by the runner that is online.
      expect((await headless.bridge.status(online.runnerId)).state).toBe("online_not_enrolled");
      expect(await headless.bridge.isEnrolled(online.runnerId)).toBe(false);
    } finally {
      headless.bridge.close();
    }
  });

  it("the relay never saw plaintext: its whole traffic dump has no prompt, answer, ACP method or enrollment code", () => {
    // Everything the server received or sent, not only what it forwarded: hello, rejected and dropped messages included.
    const dump = [...app.traffic.map((t) => t.raw), ...app.ingress.map((i) => i.raw), ...app.egress].join("\n");
    expect(app.ingress.some((i) => i.raw.includes('"type":"hello"'))).toBe(true);
    expect(app.ingress.length).toBeGreaterThanOrEqual(app.traffic.length);
    // The dump is real: it holds the encrypted frames and the PAKE messages that crossed the relay.
    expect(app.traffic.some((t) => t.raw.includes('"kind":"frame"'))).toBe(true);
    expect(app.traffic.some((t) => t.raw.includes('"kind":"pake"'))).toBe(true);
    expect(app.traffic.filter((t) => t.from === "browser").length).toBeGreaterThan(3);
    expect(app.traffic.filter((t) => t.from === "runner").length).toBeGreaterThan(3);
    // Structural check over all three captures: only known envelope kinds, only the protocol's ciphertext/pake fields, no JSON-RPC anywhere.
    expect(findPlaintextViolations([...app.traffic.map((t) => t.raw), ...app.ingress.map((i) => i.raw), ...app.egress])).toEqual([]);
    for (const secret of [PROMPT, "launch codes", "echo:", "agent[", "end_turn", "session/prompt", "session/new", "sessionUpdate", "agent_message_chunk", "initialize", code, machine.project]) {
      expect(dump, `relay traffic must not contain ${JSON.stringify(secret)}`).not.toContain(secret);
    }
  });
});
