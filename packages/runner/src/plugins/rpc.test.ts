import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PROXY_ERROR, containmentRefusalDataOf } from "../acp/contracts.js";
import { RpcPeer } from "./rpc.js";

const VALID = containmentRefusalDataOf("adapter_missing");
const DETAIL = "/home/secret-user/.local/share/bridge: exit 127";
const line = (message: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n";

/** Data that must never pass: malformed, with extra keys, with a bad hint or reason, or on another code. */
const REJECTED: Array<[string, number, unknown]> = [
  ["a string", PROXY_ERROR.containmentUnavailable, DETAIL],
  ["an array", PROXY_ERROR.containmentUnavailable, [VALID]],
  ["a missing hint", PROXY_ERROR.containmentUnavailable, { reason: "adapter_missing" }],
  ["an unknown reason", PROXY_ERROR.containmentUnavailable, { reason: "other", hint: VALID.hint }],
  ["another hint", PROXY_ERROR.containmentUnavailable, { reason: "adapter_missing", hint: DETAIL }],
  ["an extra key", PROXY_ERROR.containmentUnavailable, { ...VALID, detail: DETAIL }],
  ["the valid payload on another code", PROXY_ERROR.sessionNotAllowed, VALID],
  ["free data on another code", -32603, { detail: DETAIL }],
];

describe("the runner's plugin RPC error data", () => {
  it("keeps the data of an error the plugin answers with, only when it is the fixed reason and hint on -32016", async () => {
    const input = new PassThrough(); const output = new PassThrough(); const peer = new RpcPeer(input, output);
    const kept = peer.request("m", {}); // id 1
    input.write(line({ id: 1, error: { code: PROXY_ERROR.containmentUnavailable, message: "Contained session unavailable", data: VALID } }));
    await expect(kept).rejects.toMatchObject({ code: -32016, message: "Contained session unavailable", data: { reason: "adapter_missing", hint: "bridge agent install claude" } });
    let id = 1;
    for (const [name, code, data] of REJECTED) {
      const pending = peer.request("m", {}); id += 1;
      input.write(line({ id, error: { code, message: "refused", data } }));
      const error = await pending.then(() => undefined, (e: unknown) => e as Error);
      expect(error, name).toMatchObject({ code, message: "refused" });
      expect(error, name).not.toHaveProperty("data");
    }
    peer.close(); input.destroy(); output.destroy();
  });

  it("answers a request with the data of a thrown error only when it is the fixed reason and hint on -32016", async () => {
    const input = new PassThrough(); const output = new PassThrough(); const peer = new RpcPeer(input, output);
    const cases: Array<[number, unknown]> = [[PROXY_ERROR.containmentUnavailable, VALID], ...REJECTED.map(([, code, data]) => [code, data] as [number, unknown])];
    let next = 0;
    peer.onRequest = async () => { const [code, data] = cases[next++]!; throw Object.assign(new Error("refused"), { code, data }); };
    const answers: Array<{ id: number; error: { code: number; message: string; data?: unknown } }> = [];
    output.on("data", (chunk: Buffer) => { for (const l of chunk.toString("utf8").split("\n").filter(Boolean)) answers.push(JSON.parse(l)); });
    for (let id = 1; id <= cases.length; id++) input.write(line({ id, method: "x", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answers).toHaveLength(cases.length);
    const byId = new Map(answers.map((a) => [a.id, a.error]));
    expect(byId.get(1)).toEqual({ code: -32016, message: "refused", data: VALID });
    for (let id = 2; id <= cases.length; id++) expect(byId.get(id), `case ${id}`).not.toHaveProperty("data");
    peer.close(); input.destroy(); output.destroy();
  });
});
