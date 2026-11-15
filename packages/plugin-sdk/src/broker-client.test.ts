import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { requestSessionBroker } from "./broker-client.js";

const saved = { endpoint: process.env.BRIDGE_SESSION_BROKER_URL, proxy: process.env.HTTP_PROXY };
afterEach(() => {
  if (saved.endpoint === undefined) delete process.env.BRIDGE_SESSION_BROKER_URL; else process.env.BRIDGE_SESSION_BROKER_URL = saved.endpoint;
  if (saved.proxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = saved.proxy;
});
describe("broker-only fixed-route transport", () => {
  it("refuses missing routes, arbitrary hosts and transport-header overrides", async () => {
    delete process.env.BRIDGE_SESSION_BROKER_URL;
    await expect(requestSessionBroker({ body: "{}" })).rejects.toThrow(/route/);
    process.env.BRIDGE_SESSION_BROKER_URL = "http://127.0.0.1:443/";
    process.env.HTTP_PROXY = "http://user:password@localhost:3128";
    await expect(requestSessionBroker({ body: "{}" })).rejects.toThrow(/route/);
    process.env.BRIDGE_SESSION_BROKER_URL = `http://service-${"a".repeat(32)}.invalid:443/`;
    await expect(requestSessionBroker({ body: "{}", headers: { Host: "localhost" } })).rejects.toThrow(/header/);
  });
  it("does not follow redirects, truncate oversized responses or wait beyond the whole-response timeout", async () => {
    let mode = "redirect";
    const server = createServer((req, res) => {
      req.resume();
      if (mode === "redirect") res.writeHead(302, { location: "http://localhost/private" }).end();
      if (mode === "large") res.end("é".repeat(100));
      if (mode === "ok") res.end("complete");
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    process.env.BRIDGE_SESSION_BROKER_URL = `http://service-${"b".repeat(32)}.invalid:443/`;
    process.env.HTTP_PROXY = `http://user:password@127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await expect(requestSessionBroker({ body: "{}" })).rejects.toThrow(/redirect/);
      mode = "large"; await expect(requestSessionBroker({ body: "{}", maxResponseBytes: 150 })).rejects.toThrow(/byte limit/);
      mode = "hang"; await expect(requestSessionBroker({ body: "{}", timeoutMs: 20 })).rejects.toThrow(/timed out/);
      mode = "ok"; expect(Buffer.from((await requestSessionBroker({ body: "{}" })).body).toString()).toBe("complete");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
