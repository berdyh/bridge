import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/** A stub OAuth server for RFC 8628 that approves every device code at once. */
export interface OAuthStub {
  /** `http://127.0.0.1:<port>`; the issuer, and the origin of both endpoints. */
  url: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  /** Every request received, in order. */
  requests: { path: string; params: Record<string, string> }[];
  close(): Promise<void>;
}

async function formBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

/**
 * Issues `runnerToken` for the device grant and for refreshes. The token is fixed because the
 * server under test checks it against a static table (`createStubAuthVerifier`).
 */
export async function startOAuthStub(options: { clientId: string; runnerToken: string }): Promise<OAuthStub> {
  const requests: OAuthStub["requests"] = [];
  const http = createServer((req, res) => {
    void (async () => {
      const params = await formBody(req);
      const path = new URL(req.url ?? "/", "http://stub").pathname;
      requests.push({ path, params });
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST" || params.client_id !== options.clientId) return reply(400, { error: "invalid_client" });
      if (path === "/device") {
        return reply(200, {
          device_code: "e2e-device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "http://127.0.0.1/verify",
          expires_in: 600,
          // Fractional on purpose: the pairing client waits this long before each poll.
          interval: 0.1,
        });
      }
      if (path === "/token") {
        const grant = params.grant_type;
        const ok =
          (grant === "urn:ietf:params:oauth:grant-type:device_code" && params.device_code === "e2e-device-code") ||
          grant === "refresh_token";
        if (!ok) return reply(400, { error: "invalid_grant" });
        return reply(200, { access_token: options.runnerToken, refresh_token: "e2e-refresh", token_type: "Bearer", expires_in: 3600 });
      }
      reply(404, { error: "not_found" });
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    url,
    deviceAuthorizationEndpoint: `${url}/device`,
    tokenEndpoint: `${url}/token`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}
