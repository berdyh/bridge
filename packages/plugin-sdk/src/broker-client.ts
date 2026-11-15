import { request } from "node:http";

export interface SessionBrokerRequest {
  /** App-specific headers, such as Authorization built from the private fd3 capability. */
  headers?: Record<string, string>;
  body: string | Uint8Array;
  /** 1..30000 ms, default 10000; bounds the whole response. */
  timeoutMs?: number;
  /** 1..4 MiB, default 1 MiB. An oversized response is refused, never truncated. */
  maxResponseBytes?: number;
}
export interface SessionBrokerResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
}

/**
 * Broker-only HTTP RPC through the runner's fixed host-service route. The app supplies
 * its protocol and private capability; the kit owns proxy routing and byte/time limits.
 * Works on supported Node versions without relying on opt-in environment proxy support.
 */
export async function requestSessionBroker(options: SessionBrokerRequest): Promise<SessionBrokerResponse> {
  let endpoint: URL;
  let proxy: URL;
  try {
    endpoint = new URL(process.env.BRIDGE_SESSION_BROKER_URL ?? "");
    proxy = new URL(process.env.HTTP_PROXY ?? "");
  } catch { throw new Error("No runner-provided session broker route"); }
  if (!/^http:\/\/service-[a-f0-9]{32}\.invalid:443\/$/.test(endpoint.href) || proxy.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(proxy.hostname) || !proxy.port || !proxy.username || !proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash) throw new Error("Invalid runner-provided session broker route");
  const timeoutMs = options.timeoutMs ?? 10000;
  const maximum = options.maxResponseBytes ?? 1024 * 1024;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isInteger(maximum) || maximum < 1 || maximum > 4 * 1024 * 1024) throw new Error("Invalid session broker request limits");
  const body = Buffer.from(options.body);
  if (body.length > 1024 * 1024) throw new Error("Session broker request exceeds 1 MiB");
  const headers: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value) || /^(?:host|proxy-authorization|proxy-connection|connection|content-length|transfer-encoding|upgrade)$/i.test(name)) throw new Error("Invalid session broker request header");
    headers[name] = value;
  }
  headers.host = endpoint.host;
  headers["content-length"] = body.length;
  headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
  return new Promise<SessionBrokerResponse>((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const fail = (message: string) => { if (done) return; done = true; clearTimeout(timer); req.destroy(); reject(new Error(message)); };
    const req = request({ hostname: proxy.hostname, port: proxy.port, method: "POST", path: endpoint.href, headers, agent: false }, (res) => {
      if (!res.statusCode || (res.statusCode >= 300 && res.statusCode < 400)) { res.destroy(); fail("Session broker redirects are refused"); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maximum) { res.destroy(); fail("Session broker response exceeds its byte limit"); } else chunks.push(chunk); });
      res.on("error", () => fail("Session broker response failed"));
      res.on("end", () => { if (done) return; done = true; clearTimeout(timer); resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks, bytes) }); });
    });
    req.on("error", () => fail("Session broker request failed"));
    timer = setTimeout(() => fail("Session broker request timed out"), timeoutMs);
    req.end(body);
  });
}
