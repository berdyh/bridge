import { Hono, type Context } from "hono";
import {
  DISCOVERY_PATH,
  RELAY_CLOSE_REVOKED,
  RELAY_PATHS,
  tokenFromSubprotocols,
  type RelayRole,
} from "@berdyh/bridge-protocol";

import type {
  BridgeServerConfig,
  HttpHost,
  Principal,
  RelayGateway,
  RelayPeer,
  UpgradeAuthorization,
} from "./contracts.js";
import { createDeviceService } from "./devices.js";
import { buildDiscovery } from "./discovery.js";

/** Base path of the device API. Browser session auth, same origin as the app. */
export const DEVICES_PATH = "/bridge/devices";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** The longest token that is looked up by fingerprint: a longer one cannot be a credential of any adapter here. */
const MAX_FINGERPRINT_TOKEN_LENGTH = 4096;

/**
 * The fingerprint of a runner token: lowercase hex SHA-256 of its exact text (Web Crypto, so it runs on Workers
 * too). Only this hash is ever stored, never the token. It identifies a credential to a store, it is not a login.
 */
export async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function bearerFrom(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : undefined;
}

/**
 * Builds the Hono app behind `HttpHost`. It builds HTTP only: it uses
 * `config.adapters.relay` as a `RelayGateway` (`accept`, `disconnect`) and never
 * binds the relay core, so the stateless Worker on Cloudflare can call it with its
 * Durable Object forwarder. The relay core is built and bound by whoever owns the
 * relay context (`createRelayCore` and `RelayTransport.bind`). Call it once per
 * deployment (per Worker isolate).
 *
 * Routes (see the package README for the wire shapes):
 *  - `GET /.well-known/bridge.json`
 *  - `GET /bridge/devices`, `GET /bridge/devices/:id`, `GET /bridge/devices/:id/last-seen`,
 *    `DELETE /bridge/devices/:id` (browser session token in `Authorization: Bearer`)
 *  - `GET <relay base>/runner`, `GET <relay base>/browser` (upgrades)
 */
export function createBridgeApp(config: BridgeServerConfig): HttpHost {
  const { relay, store, verifier } = config.adapters;
  const discovery = buildDiscovery(config);
  const allowedOrigins = new Set(config.allowedBrowserOrigins ?? [discovery.origin]);
  const devices = createDeviceService({
    store,
    ...(verifier.revokeRunnerCredentials
      ? { revokeCredentials: (u: string, ids: string[]) => verifier.revokeRunnerCredentials!(u, ids) }
      : {}),
    ...(config.lastSeenIntervalMs !== undefined ? { lastSeenIntervalMs: config.lastSeenIntervalMs } : {}),
    ...(config.now ? { now: config.now } : {}),
  });

  const relayBasePath = new URL(discovery.relayUrl).pathname.replace(/\/+$/, "");
  const runnerPath = relayBasePath + RELAY_PATHS.runner;
  const browserPath = relayBasePath + RELAY_PATHS.browser;

  function originAllowed(origin: string | null): boolean {
    return origin !== null && allowedOrigins.has(origin);
  }

  /** Runs the verifier; infrastructure failures become 503, never access. */
  async function verify<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
    try {
      return { ok: true, value: await fn() };
    } catch {
      return { ok: false, response: text(503, "Authentication unavailable") };
    }
  }

  /**
   * The verifier refused a runner token. If the store knows its fingerprint as a credential of a revoked device and
   * confirms the credential is revoked, the credential is (that user's) revoked one: the holder of the exact token
   * proves possession by presenting it. Any failure, a missing store method or no match answers undefined (the 401
   * stays; an outage of this lookup never becomes a verdict and never turns the usual answer into a 503).
   *
   * No runner-id agreement is required, and none is possible: the user is not known until the store answers. The
   * verdict names only the runner id the caller sent, and nothing about any device is looked up or revealed, so it
   * cannot disclose or act on another user's device. A credential revoked with its device is revoked whichever
   * runner id presents it (the same rule as `isCredentialRevoked`).
   */
  async function revokedByFingerprint(token: string): Promise<{ userId: string; credentialId: string } | undefined> {
    const lookup = store.revokedCredentialByFingerprint?.bind(store);
    if (!lookup || token.length > MAX_FINGERPRINT_TOKEN_LENGTH) return undefined;
    try {
      const match = await lookup(await tokenFingerprint(token));
      if (!match || !(await store.isCredentialRevoked(match.userId, match.credentialId))) return undefined;
      return match;
    } catch {
      return undefined;
    }
  }

  async function authorizeRelayUpgrade(request: Request): Promise<UpgradeAuthorization> {
    const url = new URL(request.url);
    let role: RelayRole;
    if (url.pathname === runnerPath) role = "runner";
    else if (url.pathname === browserPath) role = "browser";
    else return { ok: false, response: text(404, "Not found") };

    const origin = request.headers.get("origin");
    if (role === "browser" && !originAllowed(origin)) return { ok: false, response: text(403, "Origin not allowed") };

    const idParam = url.searchParams.get(role === "runner" ? "runnerId" : "browserKeyId");
    if (!idParam || !ID_PATTERN.test(idParam)) {
      return { ok: false, response: text(400, `Missing or invalid ${role === "runner" ? "runnerId" : "browserKeyId"}`) };
    }

    const token = bearerFrom(request.headers.get("authorization")) ?? tokenFromSubprotocols(request.headers.get("sec-websocket-protocol"));
    if (!token) return { ok: false, response: text(401, "Unauthorized") };

    // Cheap checks first (origin, ids, token present), then this, before the verifier. A plain GET must never reach `relay.accept`: on Workers the gateway hardcodes the
    // upgrade on its internal request, so it would kick the user's live socket.
    if (!/(^|,)\s*websocket\s*(,|$)/i.test(request.headers.get("upgrade") ?? "")) {
      return { ok: false, response: new Response("Upgrade Required", { status: 426, headers: { "content-type": "text/plain; charset=utf-8", upgrade: "websocket" } }) };
    }

    const verified = await verify(() =>
      role === "browser" ? verifier.verifyBrowser(token, { origin }) : verifier.verifyRunner(token),
    );
    if (!verified.ok) return verified;
    const principal: Principal | undefined = verified.value;
    if (!principal) {
      if (role === "runner" && (await revokedByFingerprint(token)) !== undefined) {
        return { ok: false, response: text(403, "Revoked"), verdict: { type: "revoked", runnerId: idParam } };
      }
      return { ok: false, response: text(401, "Unauthorized") };
    }

    if (principal.revoked === true) {
      // Only a runner credential can be revoked. It gets the verdict only when the store confirms
      // that this credential was bound to a revoked device; otherwise it is a plain 401.
      if (role !== "runner" || principal.credentialId === undefined) return { ok: false, response: text(401, "Unauthorized") };
      const credentialId = principal.credentialId;
      const confirmed = await verify(() => store.isCredentialRevoked(principal.userId, credentialId));
      if (!confirmed.ok) return confirmed;
      if (!confirmed.value) return { ok: false, response: text(401, "Unauthorized") };
      return { ok: false, response: text(403, "Revoked"), verdict: { type: "revoked", runnerId: idParam } };
    }

    if (role === "browser") {
      return { ok: true, peer: { role: "browser", userId: principal.userId, browserKeyId: idParam } };
    }

    const revoked = await verify(async () => {
      if (await store.isRevoked(principal.userId, idParam)) return true;
      return principal.credentialId !== undefined && (await store.isCredentialRevoked(principal.userId, principal.credentialId));
    });
    if (!revoked.ok) return revoked;
    // Token verified, id or credential revoked: a verdict, so a host that can deliver it
    // closes with RELAY_CLOSE_REVOKED; the 403 stays for one that cannot.
    if (revoked.value) return { ok: false, response: text(403, "Revoked"), verdict: { type: "revoked", runnerId: idParam } };
    const peer: RelayPeer = {
      role: "runner",
      userId: principal.userId,
      runnerId: idParam,
      ...(principal.credentialId !== undefined ? { credentialId: principal.credentialId } : {}),
      // Only a store that can look fingerprints up gets one; the token itself never leaves this function.
      ...(principal.credentialId !== undefined && store.revokedCredentialByFingerprint ? { credentialFingerprint: await tokenFingerprint(token) } : {}),
    };
    return { ok: true, peer };
  }

  const app = new Hono();

  app.get(DISCOVERY_PATH, (c) => c.json(discovery));

  /** Browser session auth for the device API; returns the principal or a response. */
  async function sessionPrincipal(c: Context): Promise<Principal | Response> {
    const origin = c.req.header("origin") ?? null;
    if (origin !== null && !originAllowed(origin)) return text(403, "Origin not allowed");
    const token = bearerFrom(c.req.header("authorization"));
    if (!token) return text(401, "Unauthorized");
    const verified = await verify(() => verifier.verifyBrowser(token, { origin }));
    if (!verified.ok) return verified.response;
    if (verified.value?.revoked === true) return text(401, "Unauthorized");
    return verified.value ?? text(401, "Unauthorized");
  }

  app.get(DEVICES_PATH, async (c) => {
    const p = await sessionPrincipal(c);
    if (p instanceof Response) return p;
    return c.json({ devices: await devices.list(p.userId) });
  });

  app.get(`${DEVICES_PATH}/:id`, async (c) => {
    const p = await sessionPrincipal(c);
    if (p instanceof Response) return p;
    const device = await store.getDevice(p.userId, c.req.param("id"));
    return device ? c.json({ device }) : text(404, "Not found");
  });

  app.get(`${DEVICES_PATH}/:id/last-seen`, async (c) => {
    const p = await sessionPrincipal(c);
    if (p instanceof Response) return p;
    const deviceId = c.req.param("id");
    const device = await store.getDevice(p.userId, deviceId);
    return device ? c.json({ deviceId, lastSeen: device.lastSeen }) : text(404, "Not found");
  });

  app.delete(`${DEVICES_PATH}/:id`, async (c) => {
    const p = await sessionPrincipal(c);
    if (p instanceof Response) return p;
    const deviceId = c.req.param("id");
    let closed = 0;
    let socketCloseFailed = false;
    const disconnect = async (target: Parameters<RelayGateway["disconnect"]>[1]): Promise<void> => {
      try {
        closed += await relay.disconnect(p.userId, target, RELAY_CLOSE_REVOKED, "revoked");
      } catch {
        // A failed close must not skip the other closes or the identity provider revoke.
        socketCloseFailed = true;
      }
    };
    // Sockets are closed as soon as the store has revoked, before the identity provider
    // is asked: a stalled provider must not leave a revoked runner connected. Idempotent:
    // for an already revoked device the closes and the provider revoke run again, so a
    // retry finishes what a partial failure left undone.
    const result = await devices.revokeAndReport(p.userId, deviceId, async (revoked) => {
      await disconnect({ role: "runner", runnerId: deviceId });
      for (const credentialId of revoked.credentialIds) await disconnect({ role: "runner", credentialId });
    });
    if (!result) return text(404, "Not found");
    return c.json({
      revoked: true,
      closedSockets: closed,
      ...(result.alreadyRevoked ? { alreadyRevoked: true } : {}),
      ...(socketCloseFailed ? { socketCloseFailed: true } : {}),
      ...(result.idpRevokeFailed ? { idpRevokeFailed: true } : {}),
    });
  });

  async function upgrade(c: Context): Promise<Response> {
    const auth = await authorizeRelayUpgrade(c.req.raw);
    if (!auth.ok) {
      if (!auth.verdict || !relay.acceptVerdict) return auth.response;
      // A gateway that fails to deliver the verdict leaves the refusal as it was: never a registered socket.
      return relay.acceptVerdict(c.req.raw, auth.verdict).catch(() => auth.response);
    }
    return relay.accept(c.req.raw, auth.peer);
  }
  app.get(runnerPath, upgrade);
  app.get(browserPath, upgrade);

  return {
    fetch: async (request) => app.fetch(request),
    authorizeRelayUpgrade,
  };
}

