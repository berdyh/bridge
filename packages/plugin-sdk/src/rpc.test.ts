import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES, RpcPeer } from "./rpc.js";

describe("NDJSON framing", () => {
  it("handles fragmented and concurrent responses, preserving unicode", async () => {
    const input = new PassThrough(); const output = new PassThrough(); const peer = new RpcPeer(input, output);
    const a = peer.request("one", {}); const b = peer.request("two", {});
    const response = Buffer.from('{"jsonrpc":"2.0","id":2,"result":"🦊"}\n{"jsonrpc":"2.0","id":1,"result":42}\n');
    for (const byte of response) input.write(Buffer.from([byte]));
    expect(await a).toBe(42); expect(await b).toBe("🦊"); peer.close(); input.destroy(); output.destroy();
  });
  it.each(["bad json\n", '{"jsonrpc":"1.0"}\n', "x".repeat(MAX_FRAME_BYTES + 1)])("closes malformed/oversized input (%#)", async (data) => {
    const input = new PassThrough(); const output = new PassThrough(); const peer = new RpcPeer(input, output);
    const pending = peer.request("wait", {});
    input.write(data);
    await expect(pending).rejects.toThrow(); peer.close(); input.destroy(); output.destroy();
  });
  it("times out requests and rejects pending calls on EOF", async () => {
    const input = new PassThrough(); const output = new PassThrough(); const peer = new RpcPeer(input, output, 10);
    await expect(peer.request("wait", {})).rejects.toThrow("timed out");
    const pending = peer.request("wait", {}); input.end();
    await expect(pending).rejects.toThrow("closed"); peer.close(); input.destroy(); output.destroy();
  });
  it("keeps the data of a JSON-RPC error (the reason code of a refused contained session), and has none when the error has none", async () => {
    const input = new PassThrough(); const output = new PassThrough(); const peer = new RpcPeer(input, output);
    const a = peer.request("one", {}); const b = peer.request("two", {});
    input.write('{"jsonrpc":"2.0","id":1,"error":{"code":-32016,"message":"Contained session unavailable","data":{"reason":"adapter_missing","hint":"bridge agent install claude"}}}\n');
    input.write('{"jsonrpc":"2.0","id":2,"error":{"code":-32016,"message":"Contained session unavailable"}}\n');
    await expect(a).rejects.toMatchObject({ code: -32016, message: "Contained session unavailable", data: { reason: "adapter_missing", hint: "bridge agent install claude" } });
    const other = await b.then(() => undefined, (error: unknown) => error as Error);
    expect(other).toMatchObject({ code: -32016 });
    expect(other).not.toHaveProperty("data");
    peer.close(); input.destroy(); output.destroy();
  });
  it("answers a request with the data of a thrown error only when it is the fixed reason and hint on -32016", async () => {
    const valid = { reason: "adapter_missing", hint: "bridge agent install claude" };
    const cases: Array<[string, number, unknown]> = [
      ["valid", -32016, valid],
      ["a string", -32016, "/home/secret-user"],
      ["an array", -32016, [valid]],
      ["a missing hint", -32016, { reason: "adapter_missing" }],
      ["an unknown reason", -32016, { reason: "other", hint: valid.hint }],
      ["another hint", -32016, { reason: "adapter_missing", hint: "rm -rf /" }],
      ["an extra key", -32016, { ...valid, detail: "/home/secret-user" }],
      ["the valid payload on another code", -32012, valid],
      ["free data on another code", -32603, { detail: "/home/secret-user" }],
    ];
    const input = new PassThrough(); const output = new PassThrough(); const peer = new RpcPeer(input, output);
    let next = 0;
    peer.onRequest = async () => { const [, code, data] = cases[next++]!; throw Object.assign(new Error("refused"), { code, data }); };
    const answers: { id: number; error: { code: number; message: string; data?: unknown } }[] = [];
    output.on("data", (chunk: Buffer) => { for (const l of chunk.toString("utf8").split("\n").filter(Boolean)) answers.push(JSON.parse(l)); });
    cases.forEach((_, i) => input.write(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "x", params: {} }) + "\n"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answers).toHaveLength(cases.length);
    const byId = new Map(answers.map((a) => [a.id, a.error]));
    expect(byId.get(1)).toEqual({ code: -32016, message: "refused", data: valid });
    cases.slice(1).forEach(([name], i) => expect(byId.get(i + 2), name).not.toHaveProperty("data"));
    peer.close(); input.destroy(); output.destroy();
  });
});
