import { isInt, isNonEmpty, isObj, type ValidationResult } from "./guards.js";
import type { ProtocolRange } from "./handshake.js";

/**
 * The document an app's bridge server serves at `<app-url>/.well-known/bridge.json`.
 * It tells a runner everything it needs to pair and connect.
 */
export type BridgeDiscovery = {
  app: { id: string; name: string };
  /** The app origin, `scheme://host[:port]`, no path. */
  origin: string;
  auth: {
    /** The token issuer (for Clerk, the Frontend API host). Tokens must carry this `iss`. */
    issuer: string;
    /** Public OAuth client id of the runner. */
    clientId: string;
    /** RFC 8628 device authorization endpoint. */
    deviceAuthorizationEndpoint: string;
    tokenEndpoint: string;
    /** Requested enrollment scopes. Absent preserves the OAuth openid/offline_access default. */
    scope?: string;
  };
  /** Base of the relay sockets, on the app origin, e.g. `wss://app.example/relay`. See `relayEndpoint`. */
  relayUrl: string;
  /**
   * Where the app's page enrolls a browser: a path on the app origin (for example
   * `/bridge/enroll`), without `?` or `#`. The runner CLI opens `<origin><enrollPage>#code=...`;
   * the fragment is the CLI's, so the path carries none.
   */
  enrollPage?: string;
  /** Protocol versions the server speaks. */
  protocol: ProtocolRange;
};

export const DISCOVERY_PATH = "/.well-known/bridge.json";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parse(raw: unknown): URL | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const u = new URL(raw);
    return u.username || u.password ? undefined : u;
  } catch {
    return undefined;
  }
}

/** https, or http on loopback for local development. */
function secureHttp(u: URL): boolean {
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
}

/** wss, or ws on loopback. */
function secureWs(u: URL): boolean {
  return u.protocol === "wss:" || (u.protocol === "ws:" && LOOPBACK.has(u.hostname));
}

/** The http(s) origin a ws(s) URL corresponds to. */
function httpOriginOfWs(u: URL): string {
  return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
}

/**
 * Validates a discovery document that came off the network.
 *
 * Same-origin rule (what the runner relies on before it trusts the document):
 *  - `origin` is a bare origin, and when `opts.appUrl` is given it equals that URL's
 *    origin, so a server cannot describe a different app than the one asked about.
 *  - `relayUrl` is on the app origin.
 *  - `auth.deviceAuthorizationEndpoint` and `auth.tokenEndpoint` are on the app
 *    origin OR on the origin of `auth.issuer`. The issuer itself may be off the app
 *    origin: it names the identity provider (the runner rejects tokens whose `iss`
 *    differs from it). Rationale: whoever controls `bridge.json` on the app origin
 *    already chooses the issuer, so endpoints on the issuer's origin add no trust;
 *    and Clerk serves device-authorization and token endpoints from its Frontend API
 *    host, so requiring them on the app origin would force a proxy.
 *  - Every other endpoint (`relayUrl`) must be on the app origin. An endpoint on any
 *    third origin, and a non-auth endpoint on the issuer's origin, is rejected.
 *  - `enrollPage`, when present, is a path: it starts with a single `/`, has no `?`, `#`
 *    or backslash, no control or space characters, and resolved against `origin` it stays on `origin` (a protocol-relative
 *    `//host/x` would not).
 *  - Everything is https/wss (http/ws only on loopback), with no embedded credentials.
 */
export function validateDiscovery(
  doc: unknown,
  opts: { appUrl?: string } = {},
): ValidationResult<BridgeDiscovery> {
  const errors: string[] = [];
  if (!isObj(doc)) return { ok: false, errors: ["discovery document must be an object"] };

  const app = doc.app;
  if (!isObj(app) || !isNonEmpty(app.id) || !isNonEmpty(app.name)) errors.push("app.id and app.name are required");

  const originUrl = parse(doc.origin);
  let origin: string | undefined;
  if (!originUrl || !secureHttp(originUrl) || originUrl.origin !== doc.origin) {
    errors.push("origin must be a bare https origin (http only on loopback)");
  } else {
    origin = originUrl.origin;
  }
  if (opts.appUrl !== undefined) {
    const asked = parse(opts.appUrl);
    if (!asked || !origin || asked.origin !== origin) errors.push("origin does not match the app URL it was fetched from");
  }

  const auth = doc.auth;
  if (!isObj(auth)) {
    errors.push("auth is required");
  } else {
    const issuer = parse(auth.issuer);
    if (!issuer || !secureHttp(issuer)) errors.push("auth.issuer must be an https URL");
    if (!isNonEmpty(auth.clientId)) errors.push("auth.clientId is required");
    // RFC 6749 scope-token: printable ASCII except quote and backslash,
    // separated by exactly one space. Bound untrusted discovery input.
    if (auth.scope !== undefined && (typeof auth.scope !== "string" || auth.scope.length > 512 || !/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(auth.scope))) errors.push("auth.scope must be a bounded space-separated scope list");
    for (const key of ["deviceAuthorizationEndpoint", "tokenEndpoint"] as const) {
      const u = parse(auth[key]);
      if (!u || !secureHttp(u)) {
        errors.push(`auth.${key} must be an https URL`);
      } else if (u.origin !== origin && u.origin !== issuer?.origin) {
        errors.push(`auth.${key} must be on the app origin or the issuer origin`);
      }
    }
  }

  const relay = parse(doc.relayUrl);
  if (!relay || !secureWs(relay)) {
    errors.push("relayUrl must be a wss URL (ws only on loopback)");
  } else if (httpOriginOfWs(relay) !== origin) {
    errors.push("relayUrl must be on the app origin");
  }

  if (doc.enrollPage !== undefined) {
    const page = doc.enrollPage;
    if (typeof page !== "string" || !page.startsWith("/") || page.startsWith("//") || /[?#\\\u0000-\u0020\u007f]/.test(page)) {
      errors.push("enrollPage must be a path on the app origin (starting with a single /, no ?, # or backslash)");
    } else if (origin !== undefined && new URL(page, origin).origin !== origin) {
      errors.push("enrollPage must be on the app origin");
    }
  }

  const pr = doc.protocol;
  if (!isObj(pr) || !isInt(pr.min) || !isInt(pr.max) || pr.min < 1 || pr.min > pr.max) {
    errors.push("protocol must be {min, max} with 1 <= min <= max");
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: doc as BridgeDiscovery };
}

export function isBridgeDiscovery(v: unknown): v is BridgeDiscovery {
  return validateDiscovery(v).ok;
}
