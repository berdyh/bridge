/** Agent-side stdio transport through SRT's exact, session-specific HTTP proxy route. */
import { request } from "node:http";
import { createInterface } from "node:readline";
const endpoint = new URL(process.argv[2]!);
const proxy = new URL(process.env.HTTP_PROXY ?? process.env.http_proxy ?? "");
const capability = process.argv[3]!;
const headers = {
  authorization: capability,
  host: endpoint.host,
  "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`,
};
const connect = (suffix: string, method: string) => request({ hostname: proxy.hostname, port: proxy.port, method, path: `${endpoint.href}/${suffix}`, headers });
const events = connect("events", "GET");
events.on("response", (res) => {
  if (res.statusCode !== 200) { process.exitCode = 1; process.stdin.destroy(); res.destroy(); return; }
  res.pipe(process.stdout);
  res.on("error", () => process.exit(1));
  res.on("end", () => process.exit());
});
events.on("error", () => process.exit(1));
events.end();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const outgoing = connect("send", "POST");
  outgoing.on("response", (res) => { res.resume(); if (res.statusCode !== 204) process.exit(1); });
  outgoing.on("error", () => process.exit(1));
  outgoing.end(line);
});
lines.on("close", () => events.destroy());
