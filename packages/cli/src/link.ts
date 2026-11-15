import {
  PROTOCOL_RANGE,
  RELAY_CLOSE_REPLACED,
  RELAY_CLOSE_REVOKED,
  RELAY_SUBPROTOCOL,
  isRelayEnvelope,
  isServerWelcome,
  relayEndpoint,
  type AgentAvailability,
  type ControlBody,
  type RelayEnvelope,
  type RunnerHello,
} from "@berdyh/bridge-protocol";
import { PairingError } from "@berdyh/bridge-pairing";

import { printable } from "./config.js";
import { createDemux, type Demux, type DemuxOptions } from "./demux.js";
import type { RelaySocket, SocketFactory } from "./deps.js";

/** Where an app's connection stands. Only `online` serves browsers; the others say why not. */
export type LinkStatus =
  | "connecting"
  | "online"
  | "reconnecting"
  /** The server needs a newer runner. This app is parked; the others keep running. */
  | "update_required"
  /** Another process holds this runner credential and took the socket over. Not retried. */
  | "replaced"
  /** The device or credential was revoked on the server. Not retried: connect again. */
  | "revoked"
  /** Pairing is gone or rejected. Not retried: connect again. */
  | "auth_failed"
  | "stopped";

const OPEN = 1;
const CONNECT_TIMEOUT_MS = 15_000;
const WELCOME_TIMEOUT_MS = 15_000;
const MAX_DETAIL = 300;
/**
 * A connection counts as healthy (and resets the backoff) only after this long past the
 * welcome. A server that welcomes and at once closes would otherwise keep the delay at its floor.
 */
export const STABLE_AFTER_WELCOME_MS = 30_000;

/**
 * Heartbeat. After this long with no outbound traffic the link sends `bridge:ping`;
 * a socket that shows no inbound frame within `PONG_TIMEOUT_MS` of it is half-open and is
 * abandoned for a reconnect. The servers answer at the transport layer; neither string ever
 * reaches the demux. The literals stay local to each package.
 */
export const HEARTBEAT_IDLE_MS = 20_000;
export const PONG_TIMEOUT_MS = 10_000;
const PING = "bridge:ping";
const PONG = "bridge:pong";

/** The timers the link uses; tests inject a manual clock. Default: the global timers. */
export interface LinkTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const globalTimers: LinkTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface AppLinkOptions {
  appId: string;
  runnerId: string;
  relayUrl: string;
  runnerVersion: string;
  /** A valid access token (refreshed when needed). */
  getToken(signal?: AbortSignal): Promise<string>;
  agents(): Promise<AgentAvailability[]>;
  socket: SocketFactory;
  hostname?: string;
  os?: string;
  demux: Omit<DemuxOptions, "appId" | "runnerId" | "transmit" | "faultSocket">;
  backoff?: { baseMs: number; maxMs: number };
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random?: () => number;
  /** Timer seam for the connect, welcome and heartbeat timers. Default: the global timers. */
  timers?: LinkTimers;
  /** Called on every status change, with a reason for the terminal ones. */
  onStatus?(status: LinkStatus, detail?: string): void;
}

export interface AppLink {
  readonly appId: string;
  status(): LinkStatus;
  demux: Demux;
  /** Starts the connect loop. Resolves when the loop ends: after `stop`, or on a terminal status. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

type Outcome = { kind: "retry"; online: boolean } | { kind: "terminal"; status: LinkStatus; detail: string } | { kind: "stopped" };

/** The delay before attempt `attempt` (0-based): exponential, capped, with equal jitter. */
export function backoffDelay(attempt: number, bounds: { baseMs: number; maxMs: number }, random: () => number): number {
  const ceiling = Math.min(bounds.maxMs, bounds.baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

function textOf(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return undefined;
}

export function createAppLink(options: AppLinkOptions): AppLink {
  const bounds = options.backoff ?? { baseMs: 1000, maxMs: 30_000 };
  const random = options.random ?? Math.random;
  const log = options.demux.log ?? (() => undefined);
  const timer = options.timers ?? globalTimers;
  let status: LinkStatus = "connecting";
  let stopped = false;
  /** The socket the manager currently owns. A close from any other socket is stale. */
  let current: RelaySocket | undefined;
  let greeted = false;
  let abandon: (() => void) | undefined;
  /** Heartbeat of the greeted socket: outbound traffic defers the next ping. */
  let beat: { sent(): void } | undefined;
  const wake = new AbortController();

  const setStatus = (next: LinkStatus, detail?: string): void => {
    if (status === next && detail === undefined) return;
    status = next;
    // The detail can carry server text (update_required's message): it goes to a terminal.
    options.onStatus?.(next, detail === undefined ? undefined : printable(detail).slice(0, MAX_DETAIL));
  };

  const demux = createDemux({
    ...options.demux,
    appId: options.appId,
    runnerId: options.runnerId,
    transmit(envelope: RelayEnvelope) {
      const sock = current;
      if (!sock || !greeted || sock.readyState !== OPEN) return false;
      try {
        sock.send(JSON.stringify(envelope));
        beat?.sent();
        return true;
      } catch {
        return false;
      }
    },
    faultSocket(reason) {
      log("warn", "closing the relay socket after a transport fault", { appId: options.appId, reason });
      abandon?.();
    },
  });

  async function connectOnce(): Promise<Outcome> {
    let token: string;
    try {
      token = await options.getToken(wake.signal);
    } catch (error) {
      if (error instanceof PairingError && ["no_refresh_token", "invalid_grant", "access_denied", "expired_token"].includes(error.code)) {
        return { kind: "terminal", status: "auth_failed", detail: `${error.message}; run \`bridge connect\` again` };
      }
      if (stopped) return { kind: "stopped" };
      log("warn", "could not get an access token", { appId: options.appId, error: (error as Error).message });
      return { kind: "retry", online: false };
    }
    if (stopped) return { kind: "stopped" };
    const hello: RunnerHello = {
      type: "hello",
      runnerId: options.runnerId,
      runnerVersion: options.runnerVersion,
      protocol: PROTOCOL_RANGE,
      ...(options.hostname ? { hostname: options.hostname } : {}),
      ...(options.os ? { os: options.os } : {}),
      agents: await options.agents().catch(() => []),
    };
    // stop() may have landed during the await above, when there was no socket yet to close.
    if (stopped) return { kind: "stopped" };

    return new Promise<Outcome>((resolve) => {
      let sock: RelaySocket;
      try {
        sock = options.socket(relayEndpoint(options.relayUrl, "runner", options.runnerId), {
          protocols: [RELAY_SUBPROTOCOL],
          headers: { authorization: `Bearer ${token}` },
        });
      } catch (error) {
        log("warn", "could not open the relay socket", { appId: options.appId, error: (error as Error).message });
        return resolve({ kind: "retry", online: false });
      }
      current = sock;
      greeted = false;
      if (stopped) {
        try {
          sock.close(1000, "runner stopping");
        } catch {
          /* closed */
        }
        current = undefined;
        return resolve({ kind: "stopped" });
      }
      let welcomed = false;
      let stable = false;
      let done = false;
      let terminal: Extract<Outcome, { kind: "terminal" }> | undefined;
      const timers: unknown[] = [];
      let heartbeat: { sent(): void; alive(): void; stop(): void } | undefined;

      const finish = (outcome: Outcome): void => {
        if (done) return;
        done = true;
        for (const t of timers) timer.clear(t);
        heartbeat?.stop();
        if (beat === heartbeat) beat = undefined;
        if (current === sock) {
          greeted = false;
          demux.socketLost();
        }
        resolve(outcome);
      };
      const end = (): Outcome => terminal ?? (stopped ? { kind: "stopped" } : { kind: "retry", online: stable });
      /** `abandon` has started: closing a socket that is still connecting makes Node 22 fire `error` from inside `close()`. */
      let abandoning = false;
      abandon = () => {
        if (current !== sock || abandoning) return;
        abandoning = true;
        try {
          sock.close(1000, "transport fault");
        } catch {
          /* already closing */
        }
        // Do not wait for the close handshake: a half-open socket may never finish it. A late
        // close of this socket (for example 4409, once the new one is greeted) is stale.
        finish(end());
      };
      const arm = (ms: number, why: string): void => {
        timers.push(
          timer.set(() => {
            log("warn", why, { appId: options.appId });
            abandon?.();
          }, ms),
        );
      };
      /** Idle ping and pong watchdog for this socket. */
      const startHeartbeat = (): void => {
        let idle: unknown;
        let pong: unknown;
        const armIdle = (): void => {
          if (idle !== undefined) timer.clear(idle);
          idle = timer.set(() => {
            idle = undefined;
            try {
              sock.send(PING);
            } catch {
              abandon?.();
              return;
            }
            pong = timer.set(() => {
              pong = undefined;
              log("warn", "relay socket answered nothing to a ping; reconnecting", { appId: options.appId });
              abandon?.();
            }, PONG_TIMEOUT_MS);
          }, HEARTBEAT_IDLE_MS);
        };
        heartbeat = {
          // Outbound traffic: the next ping is due 20 s from now (unless one is awaiting its pong).
          sent() {
            if (pong === undefined) armIdle();
          },
          // Only `bridge:pong` settles a pending ping; other inbound frames do not. It is not outbound traffic, so
          // it never defers the next ping (receive-only traffic must still be pinged every 20 s).
          alive() {
            if (pong === undefined) return;
            timer.clear(pong);
            pong = undefined;
            armIdle();
          },
          stop() {
            if (idle !== undefined) timer.clear(idle);
            if (pong !== undefined) timer.clear(pong);
            idle = pong = undefined;
          },
        };
        beat = heartbeat;
        armIdle();
      };
      arm(CONNECT_TIMEOUT_MS, "relay socket did not open in time");

      let opened = false;
      sock.addEventListener("open", () => {
        opened = true;
        if (current !== sock) return;
        try {
          sock.send(JSON.stringify(hello));
        } catch {
          return;
        }
        arm(WELCOME_TIMEOUT_MS, "relay did not welcome the runner in time");
      });

      sock.addEventListener("message", (event) => {
        if (current !== sock || done) return;
        const text = textOf(event.data);
        if (text === undefined) return;
        // Heartbeat strings are the transport's: answered or ignored here, never parsed or demuxed.
        if (text === PING) {
          try {
            sock.send(PONG);
            heartbeat?.sent();
          } catch {
            /* the close event follows */
          }
          return;
        }
        if (text === PONG) {
          heartbeat?.alive();
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (!welcomed) {
          if (isServerWelcome(parsed)) {
            welcomed = true;
            // Handshake over: the connect and welcome timers must not close a healthy socket.
            for (const t of timers.splice(0)) timer.clear(t);
            greeted = true;
            timers.push(timer.set(() => { stable = true; }, STABLE_AFTER_WELCOME_MS));
            startHeartbeat();
            setStatus("online");
            demux.socketOpened();
            return;
          }
        }
        if (!isRelayEnvelope(parsed) || parsed.to !== "runner") return;
        if (parsed.kind === "control") {
          const body = parsed.body as ControlBody;
          if (body.type === "update_required") {
            terminal = { kind: "terminal", status: "update_required", detail: typeof body.message === "string" ? body.message : "this server needs a newer bridge runner; update it" };
            abandon?.();
            return;
          }
          if (body.type === "revoked") {
            terminal = { kind: "terminal", status: "revoked", detail: "this device was revoked on the server; run `bridge connect` again" };
            abandon?.();
            return;
          }
          if (body.type === "error") log("warn", "relay error", { appId: options.appId, code: body.code, message: body.message });
        }
        if (welcomed) demux.handle(parsed);
      });

      sock.addEventListener("close", (event) => {
        // A socket this manager already replaced (by its own reconnect) says nothing about the current one.
        if (current !== sock) return;
        if (!terminal) {
          if (event.code === RELAY_CLOSE_REPLACED) {
            terminal = { kind: "terminal", status: "replaced", detail: "another process holds this runner's credential and took the connection over; not retrying" };
          } else if (event.code === RELAY_CLOSE_REVOKED) {
            terminal = { kind: "terminal", status: "revoked", detail: "this device was revoked on the server; run `bridge connect` again" };
          }
        }
        finish(end());
      });
      sock.addEventListener("error", () => {
        // An error before the socket opened is a refused or failed upgrade (HTTP 403, a refused connection). Node 22's
        // global WebSocket fires `error` and never `close` then, so the attempt ends here instead of waiting out the
        // connect timer for a close that may not come; where a `close` does follow (Node 24+) `finish` ignores it.
        // After the socket opened an error is followed by a close, which ends the attempt as before.
        if (!opened && !done) abandon?.();
      });
    });
  }

  async function loop(): Promise<void> {
    let failures = 0;
    while (!stopped) {
      setStatus(failures === 0 && status === "connecting" ? "connecting" : "reconnecting");
      const outcome = await connectOnce();
      if (outcome.kind === "stopped" || stopped) break;
      if (outcome.kind === "terminal") {
        setStatus(outcome.status, outcome.detail);
        // This app's channels and agents end with its connection; other apps keep running.
        demux.close(outcome.status);
        return;
      }
      if (outcome.online) failures = 0;
      setStatus("reconnecting");
      try {
        await options.sleep(backoffDelay(failures, bounds, random), wake.signal);
      } catch {
        break;
      }
      failures++;
    }
  }

  let running: Promise<void> | undefined;
  return {
    appId: options.appId,
    status: () => status,
    demux,
    start() {
      running ??= loop();
      return running;
    },
    async stop() {
      if (stopped) return running;
      stopped = true;
      wake.abort();
      const sock = current;
      abandon?.();
      try {
        sock?.close(1000, "runner stopping");
      } catch {
        /* closed */
      }
      demux.close("runner stopping");
      await running;
      if (status !== "update_required" && status !== "replaced" && status !== "revoked" && status !== "auth_failed") setStatus("stopped");
    },
  };
}

/** The real socket: Node's global `WebSocket`, which takes the headers a runner needs. */
export const nodeSocket: SocketFactory = (url, init) =>
  new (globalThis.WebSocket as unknown as new (url: string, init: object) => RelaySocket)(url, {
    protocols: init.protocols,
    headers: init.headers,
  });
