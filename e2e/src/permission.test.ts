import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { permissionPrompt, type PermissionView } from "@berdyh/bridge-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Machine, type BridgeProcess } from "./machine.js";
import { HeadlessPage, enrollBrowser } from "./page.js";
import { connectApp, deployApp, startRunner, type AppDeployment } from "./world.js";

const COMMAND = "echo permission-e2e";

describe("permissionPrompt answers the agent's permission requests forwarded by the runner", () => {
  let app: AppDeployment;
  let machine: Machine;
  let runner: BridgeProcess;
  let page: HeadlessPage;
  let runnerId = "";

  beforeAll(async () => {
    app = await deployApp("perm-app", { enrollPage: "/enroll" });
    machine = await Machine.create();
    await connectApp(machine, app);
    runner = await startRunner(machine, [app], { e2ee: true });
    page = await HeadlessPage.open(app);
    runnerId = (await page.waitForState("online_not_enrolled")).runner!.runnerId;
    await enrollBrowser(machine, page, "perm-app");
  });
  afterAll(async () => {
    page?.close();
    await runner?.stop();
    await machine?.dispose();
    await app?.close();
  });

  /** One prompt "ask: <command>" with `handler` as the page's permission handler; the agent's reply and the requests seen. */
  async function ask(handler: ReturnType<typeof permissionPrompt>): Promise<{ text: string; asked: number }> {
    const updates: string[] = [];
    let asked = 0;
    const app = client({ name: "e2e-permission" })
      .onNotification("session/update", ({ params }) => {
        const update = params.update as { sessionUpdate: string; content?: { type: string; text?: string } };
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") updates.push(update.content.text ?? "");
      })
      .onRequest("session/request_permission", (args) => {
        asked += 1;
        return handler(args as Parameters<typeof handler>[0]);
      });
    const connection = await page.bridge.acp(app, runnerId);
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await connection.agent.request("session/new", { cwd: machine.project, mcpServers: [] });
    const result = await connection.agent.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: `ask: ${COMMAND}` }] });
    expect(result.stopReason).toBe("end_turn");
    return { text: updates.join(""), asked };
  }

  it("with no mount it denies: the tool does not run", async () => {
    const answer = await ask(permissionPrompt());
    expect(answer.asked).toBe(1);
    expect(answer.text).toBe("tool not run (selected reject)");
  });

  it("a scripted mount that allows the exact request runs the tool, and sees only once-only choices", async () => {
    let seen: PermissionView | undefined;
    const answer = await ask(
      permissionPrompt({
        mount(view, choose) {
          seen = view;
          // The person reads the title and picks "allow once" on that exact request only.
          const allow = view.title === COMMAND ? view.options.find((o) => o.kind === "allow_once") : undefined;
          queueMicrotask(() => choose(allow?.optionId ?? null));
          return () => undefined;
        },
      }),
    );
    expect(answer.text).toBe(`tool ran: ${COMMAND}`);
    expect(seen?.title).toBe(COMMAND);
    expect(seen?.toolKind).toBe("execute");
    expect(seen?.options.map((o) => o.kind).sort()).toEqual(["allow_once", "reject_once"]);
  });

  it("a mount that dismisses denies", async () => {
    const answer = await ask(permissionPrompt({ mount: (_view, choose) => (queueMicrotask(() => choose(null)), () => undefined) }));
    expect(answer.text).toBe("tool not run (selected reject)");
  });

  it("a choice that was never offered denies too", async () => {
    const answer = await ask(permissionPrompt({ mount: (_view, choose) => (queueMicrotask(() => choose("allow-always")), () => undefined) }));
    expect(answer.text).toBe("tool not run (selected reject)");
  });
});
