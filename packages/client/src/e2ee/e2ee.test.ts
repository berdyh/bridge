import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { base64UrlEncode, generateKeyPair } from "@berdyh/bridge-crypto";
import {
  ENROLL_CODE_TTL_MS,
  HANDSHAKE_TIMEOUT_MS,
  type HandshakeIO,
  type JsonRpcMessage,
  type PakeMessage,
  type SequencedFrame,
  createPlainLayer,
} from "@berdyh/bridge-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientE2eeContext, KeyStore } from "../contracts.js";
// The real runner side. This test pairs the two implementations through an in-memory relay, so it
// reaches into the runner and server sources by relative path, which a package boundary would
// normally forbid. It stays that way on purpose: bridge-client does not (and must not) depend on
// bridge-runner or bridge-server, so a package import cannot resolve, and adding them as
// workspace devDependencies means editing package.json files of other packages. This is
// the only place the real client, the real runner and the relay's traffic tap meet.
import {
  type E2eeApp,
  type EnrollmentWire,
  type RunnerWire,
  acceptEnrollment,
  enroll as runnerEnroll,
  revokeBrowser,
  wrapRunnerChannel,
} from "../../../runner/src/e2ee/index.js";
import { appPathsOf } from "../../../runner/src/paths.js";
// The relay core, with its traffic tap.
import { createRelayCoreWithHooks } from "../../../server/src/relay.js";
import type { BridgeServerConfig, RelayPeer, RelayTransport, SendResult } from "../../../server/src/contracts.js";
import { EnrollError, enroll, wrapClientLayer } from "./index.js";
import { KEY_NAME, runnerKeyName } from "./wire.js";

// --- harness --------------------------------------------------------------------

let dir: string;
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 2000): Promise<void> {
  const limit = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > limit) throw new Error("condition not reached in time");
    await tick();
  }
}
const randomId = () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
const appFor = (runnerId: string): E2eeApp => ({ appId: "app", runnerId, paths: appPathsOf({ config: path.join(dir, runnerId), data: path.join(dir, runnerId), state: path.join(dir, runnerId) }, "app") });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-client-e2ee-"));
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/**
 * How a message crosses the relay. The default is a direct in-memory hop; the "relay core"
 * tests route every hop through the real relay core (`createRelayCoreWithHooks`).
 */
type Hop = (direction: "toRunner" | "toBrowser", kind: "pake" | "frame", browserKeyId: string, body: unknown, deliver: () => void) => void;
const direct: Hop = (_direction, _kind, _id, _body, deliver) => queueMicrotask(deliver);

/** What a relay sees: every `pake` and `frame` body, serialized. */
const relayTap: string[] = [];
beforeEach(() => {
  relayTap.length = 0;
});
const tap = (body: unknown) => void relayTap.push(JSON.stringify(body));

function memoryStore(): KeyStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return { data, load: async (name) => data.get(name), save: async (name, value) => void data.set(name, value), delete: async (name) => void data.delete(name) };
}

/** A browser: one key store and a transport id that `rebind` changes, like the real transport. */
function browser(label = "Test laptop", keyStore: ReturnType<typeof memoryStore> = memoryStore()) {
  const state = { id: randomId(), rebinds: [] as string[] };
  const links = new Map<string, HandshakeIO>();
  const ctxFor = (runnerId: string): ClientE2eeContext => ({
    runnerId,
    label,
    keyStore,
    get browserKeyId() {
      return state.id;
    },
    rebind: async (id) => {
      state.rebinds.push(id);
      state.id = id;
    },
    handshakeFor: (target) => links.get(target)!,
  });
  return { keyStore, state, links, ctxFor };
}

/** The link between a browser and one runner's enrollment path (the app's enroll page does this in production). */
function enrollmentLink(runner: E2eeApp, enrollId: string, tamper?: (m: PakeMessage) => PakeMessage, hop: Hop = direct) {
  const runnerHandlers = new Set<(m: PakeMessage) => void>();
  const browserHandlers = new Set<(m: PakeMessage) => void>();
  const closeHandlers = new Set<(r?: string) => void>();
  let started = false;
  const wire: EnrollmentWire = {
    appId: runner.appId,
    enrollId,
    closed: false,
    handshake: {
      send(m) {
        const out = tamper ? tamper(m) : m;
        tap(out);
        hop("toBrowser", "pake", enrollId, out, () => browserHandlers.forEach((h) => h(out)));
      },
      onMessage(h) {
        runnerHandlers.add(h);
        return () => void runnerHandlers.delete(h);
      },
    },
    onClose(h) {
      closeHandlers.add(h);
      return () => void closeHandlers.delete(h);
    },
    close(reason) {
      if (wire.closed) return;
      (wire as { closed: boolean }).closed = true;
      closeHandlers.forEach((h) => h(reason));
    },
  };
  const io: HandshakeIO = {
    send(m) {
      tap(m);
      hop("toRunner", "pake", enrollId, m, () => {
        if (m.t === "pake/start" && !started) {
          started = true;
          void acceptEnrollment(wire, m, { app: runner, e2ee: true });
        } else runnerHandlers.forEach((h) => h(m));
      });
    },
    onMessage(h) {
      browserHandlers.add(h);
      return () => void browserHandlers.delete(h);
    },
  };
  return io;
}

/** Opens the runner's enrollment window and returns the code it shows. */
async function openWindow(runner: E2eeApp, answer = true) {
  let resolveCode!: (code: string) => void;
  const code = new Promise<string>((resolve) => (resolveCode = resolve));
  const result = runnerEnroll(runner, { showCode: (c) => resolveCode(c), confirm: async () => answer }, { pollMs: 20 });
  result.catch(() => undefined);
  return { code: await code, result };
}

/** Enrolls `b` with `runner` through the real runner code. */
async function enrollWith(b: ReturnType<typeof browser>, runner: E2eeApp, code?: string, tamper?: (m: PakeMessage) => PakeMessage, hop: Hop = direct) {
  const win = code === undefined ? await openWindow(runner) : undefined;
  b.links.set(runner.runnerId, enrollmentLink(runner, b.state.id, tamper, hop));
  return { outcome: enroll(code ?? win!.code, b.ctxFor(runner.runnerId)), win };
}

/** A runner wire and the browser's end, for a session. */
function sessionLink(runner: E2eeApp, browserKeyId: string, hop: Hop = direct) {
  const frameHandlers = new Set<(f: SequencedFrame) => void>();
  const closeHandlers = new Set<(r?: string) => void>();
  const handshakeHandlers = new Set<(m: PakeMessage) => void>();
  const browserHandshake = new Set<(m: PakeMessage) => void>();
  const toBrowser = new Set<(f: SequencedFrame) => void>();
  const closes: (string | undefined)[] = [];
  let sid: string | undefined;
  const wire: RunnerWire = {
    appId: runner.appId,
    browserKeyId,
    get sid() {
      return sid;
    },
    bindSession(kid) {
      (wire as { kid?: string }).kid = kid;
    },
    closed: false,
    handshake: {
      send(m) {
        tap(m);
        hop("toBrowser", "pake", browserKeyId, m, () => browserHandshake.forEach((h) => h(m)));
      },
      onMessage(h) {
        handshakeHandlers.add(h);
        return () => void handshakeHandlers.delete(h);
      },
    },
    sendFrame(f) {
      tap(f);
      hop("toBrowser", "frame", browserKeyId, f, () => toBrowser.forEach((h) => h(f)));
    },
    onFrame(h) {
      frameHandlers.add(h);
      return () => void frameHandlers.delete(h);
    },
    onClose(h) {
      closeHandlers.add(h);
      return () => void closeHandlers.delete(h);
    },
    close(reason) {
      if (wire.closed) return;
      (wire as { closed: boolean }).closed = true;
      closes.push(reason);
      closeHandlers.forEach((h) => h(reason));
    },
  };
  const io: HandshakeIO = {
    send(m) {
      tap(m);
      if (m.t === "session/init") sid = m.sid;
      hop("toRunner", "pake", browserKeyId, m, () => handshakeHandlers.forEach((h) => h(m)));
    },
    onMessage(h) {
      browserHandshake.add(h);
      return () => void browserHandshake.delete(h);
    },
  };
  return {
    wire,
    io,
    closes,
    deliver(frame: SequencedFrame) {
      tap(frame);
      hop("toRunner", "frame", browserKeyId, frame, () => frameHandlers.forEach((h) => h(frame)));
    },
    onBrowserFrame: (h: (f: SequencedFrame) => void) => void toBrowser.add(h),
  };
}

const call = (id: number): JsonRpcMessage => ({ jsonrpc: "2.0", id, method: "session/prompt", params: { text: "tell-nobody-42" } });

/** Starts a session between the real client layer and the real runner channel. */
async function talk(b: ReturnType<typeof browser>, runner: E2eeApp, hop: Hop = direct) {
  const link = sessionLink(runner, b.state.id, hop);
  const channel = wrapRunnerChannel(link.wire, { app: runner, e2ee: true });
  const fromBrowser: JsonRpcMessage[] = [];
  channel.onMessage((m) => fromBrowser.push(m));
  const layer = wrapClientLayer(createPlainLayer(), b.ctxFor(runner.runnerId));
  await layer.start(link.io);
  const fromRunner: JsonRpcMessage[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  link.onBrowserFrame((f) => {
    chain = chain.then(async () => void fromRunner.push(await layer.open(f))).catch(() => undefined);
  });
  return { link, channel, layer, fromBrowser, fromRunner };
}

// --- enrollment -----------------------------------------------------------------

describe("enroll", () => {
  it("reports the generated or reused browser key before pake/start reaches the runner", async () => {
    const b = browser();
    const ids: string[] = [];
    for (const runnerId of ["r1", "r2"]) {
      const runner = appFor(runnerId);
      const win = await openWindow(runner);
      const original = enrollmentLink(runner, b.state.id);
      const order: string[] = [];
      const ctx = b.ctxFor(runnerId);
      ctx.handshakeFor = () => ({ ...original, send(message) {
        order.push(message.t);
        expect(order[0]).toBe("browser-key");
        original.send(message);
      } });
      ctx.onBrowserKey = (id) => {
        expect(b.keyStore.data.has(KEY_NAME)).toBe(true);
        order.push("browser-key");
        ids.push(id);
      };
      const enrolled = await enroll(win.code, ctx);
      await win.result;
      expect(order.slice(0, 2)).toEqual(["browser-key", "pake/start"]);
      expect(ids.at(-1)).toBe(enrolled.browserKeyId);
    }
    expect(ids[0]).toBe(ids[1]);
  });

  it("enrolls with the runner's code, stores the keys, rebinds, and the two can talk", async () => {
    const runner = appFor("r1");
    const b = browser();
    const { outcome, win } = await enrollWith(b, runner);
    const enrolled = await outcome;
    await win!.result;
    expect(enrolled.runnerId).toBe("r1");
    expect(b.state.rebinds).toEqual([enrolled.browserKeyId]);
    expect(b.state.id).toBe(enrolled.browserKeyId);
    expect(b.keyStore.data.has(KEY_NAME)).toBe(true);
    expect(typeof b.keyStore.data.get(runnerKeyName("r1"))).toBe("string");

    const session = await talk(b, runner);
    expect(session.link.wire.kid).toBe(session.layer.kid);
    session.link.deliver(await session.layer.seal(call(1)));
    await until(() => session.fromBrowser.length === 1);
    expect(session.fromBrowser[0]).toEqual(call(1));
    session.channel.send({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
    await until(() => session.fromRunner.length === 1);
    expect(session.fromRunner[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
    expect(session.layer.kind).toBe("e2ee");
    session.channel.close();
  });

  it("answers the open question: one key per app, so a second runner reuses it and nothing is orphaned", async () => {
    const r1 = appFor("r1");
    const r2 = appFor("r2");
    const b = browser();
    const first = await (await enrollWith(b, r1)).outcome;
    const second = await (await enrollWith(b, r2)).outcome;
    // same long-term key, same socket identity, no second rebind
    expect(second.browserKeyId).toBe(first.browserKeyId);
    expect(b.state.rebinds).toEqual([first.browserKeyId]);
    // the enrollId of the second run was the enrolled id, and both runners trust that one key
    const { listBrowsers } = await import("../../../runner/src/e2ee/index.js");
    expect((await listBrowsers(r1)).map((x) => x.browserKeyId)).toEqual([first.browserKeyId]);
    expect((await listBrowsers(r2)).map((x) => x.browserKeyId)).toEqual([first.browserKeyId]);
    // and the first runner still works
    const s1 = await talk(b, r1);
    const s2 = await talk(b, r2);
    expect(s1.layer.kid).not.toBe(s2.layer.kid);
    s1.channel.close();
    s2.channel.close();
  });

  it("two first enrollments at once (two tabs, one key store) end up with the same key at both runners", async () => {
    const r1 = appFor("r1");
    const r2 = appFor("r2");
    const shared = memoryStore();
    const tabA = browser("Tab A", shared);
    const tabB = browser("Tab B", shared);
    const a = await enrollWith(tabA, r1);
    const b = await enrollWith(tabB, r2);
    const [first, second] = await Promise.all([a.outcome, b.outcome]);
    await Promise.all([a.win!.result, b.win!.result]);
    expect(second.browserKeyId).toBe(first.browserKeyId);
    const { listBrowsers } = await import("../../../runner/src/e2ee/index.js");
    // both runners trust the one key that the store holds; nothing is orphaned
    expect((await listBrowsers(r1)).map((x) => x.browserKeyId)).toEqual([first.browserKeyId]);
    expect((await listBrowsers(r2)).map((x) => x.browserKeyId)).toEqual([first.browserKeyId]);
    expect(((shared.data.get(KEY_NAME) as { publicKey: Uint8Array | string }) ?? {}).publicKey).toBeDefined();
    const s1 = await talk(tabB, r1);
    s1.channel.close();
  });

  it("fails instead of replacing a key that another context stored while this enrollment waited", async () => {
    const runner = appFor("r1");
    const b = browser();
    const intruder = await generateKeyPair();
    let resolveCode!: (code: string) => void;
    const code = new Promise<string>((resolve) => (resolveCode = resolve));
    const result = runnerEnroll(
      runner,
      {
        showCode: (c) => resolveCode(c),
        confirm: async () => {
          b.keyStore.data.set(KEY_NAME, await intruder.toStored());
          return true;
        },
      },
      { pollMs: 20 },
    );
    result.catch(() => undefined);
    b.links.set(runner.runnerId, enrollmentLink(runner, b.state.id));
    await expect(enroll(await code, b.ctxFor(runner.runnerId))).rejects.toMatchObject({ reason: "key_changed" });
    // the stored key is the other context's, untouched, and no runner key was stored
    expect(b.keyStore.data.get(KEY_NAME)).toEqual(await intruder.toStored());
    expect(b.keyStore.data.has(runnerKeyName("r1"))).toBe(false);
    expect(b.state.rebinds).toEqual([]);
  });

  it("a wrong code fails locally, reports the attempts left, and stores nothing", async () => {
    const runner = appFor("r1");
    const b = browser();
    const win = await openWindow(runner);
    const wrong = win.code[0] === "B" ? `C${win.code.slice(1)}` : `B${win.code.slice(1)}`;
    const { outcome } = await enrollWith(b, runner, wrong);
    const error = await outcome.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnrollError);
    expect(error).toMatchObject({ reason: "bad_code", attemptsLeft: 4 });
    expect([...b.keyStore.data.keys()]).toEqual([KEY_NAME]); // the candidate key only, no runner key
    expect(b.state.rebinds).toEqual([]);
  });

  it("fails when the runner reports a key id that is not the key we generated", async () => {
    const runner = appFor("r1");
    const b = browser();
    const forged = (m: PakeMessage): PakeMessage => (m.t === "pake/done" && m.ok ? { ...m, browserKeyId: randomId() } : m);
    const { outcome } = await enrollWith(b, runner, undefined, forged);
    await expect(outcome).rejects.toMatchObject({ reason: "identity_mismatch" });
    expect([...b.keyStore.data.keys()]).toEqual([KEY_NAME]); // the candidate key only, no runner key
    expect(b.state.rebinds).toEqual([]);
  });

  it("does not believe a relay that turns the user's refusal into ok:true", async () => {
    const runner = appFor("r1");
    const b = browser();
    // the browser already has its app key (a first enrollment elsewhere), so a forger knows its id
    await (await enrollWith(b, appFor("r2"))).outcome;
    b.keyStore.data.delete(runnerKeyName("r2"));
    const forged = (m: PakeMessage): PakeMessage =>
      m.t === "pake/done" && !m.ok ? { t: "pake/done", v: 1, enrollId: m.enrollId, ok: true, browserKeyId: b.state.id } : m;
    const win = await openWindow(runner, false);
    const { outcome } = await enrollWith(b, runner, win.code, forged);
    await expect(outcome).rejects.toMatchObject({ reason: "unauthenticated_done" });
    expect(b.keyStore.data.has(runnerKeyName("r1"))).toBe(false);
    expect(b.state.rebinds).toHaveLength(1); // only the first enrollment's
  });

  it("does not believe an ok:true whose proof was stripped", async () => {
    const runner = appFor("r1");
    const b = browser();
    const stripped = (m: PakeMessage): PakeMessage => {
      if (m.t !== "pake/done" || !m.ok) return m;
      const { proof: _proof, ...rest } = m as PakeMessage & { proof?: unknown };
      return rest as PakeMessage;
    };
    const first = await enrollWith(b, runner, undefined, stripped);
    await expect(first.outcome).rejects.toMatchObject({ reason: "unauthenticated_done" });
    expect([...b.keyStore.data.keys()]).toEqual([KEY_NAME]); // the candidate key only, no runner key
    expect(b.state.rebinds).toEqual([]);
  });

  it("keeps one trust entry when the proof is stripped and the browser retries: the same key is presented", async () => {
    const runner = appFor("r1");
    const b = browser();
    const stripped = (m: PakeMessage): PakeMessage => {
      if (m.t !== "pake/done" || !m.ok) return m;
      const { proof: _proof, ...rest } = m as PakeMessage & { proof?: unknown };
      return rest as PakeMessage;
    };
    const first = await enrollWith(b, runner, undefined, stripped);
    await expect(first.outcome).rejects.toMatchObject({ reason: "unauthenticated_done" });
    const kept = b.keyStore.data.get(KEY_NAME);
    expect(kept).toBeDefined();
    const second = await enrollWith(b, runner);
    await second.outcome;
    expect(b.keyStore.data.get(KEY_NAME)).toBe(kept);
    const { listBrowsers } = await import("../../../runner/src/e2ee/index.js");
    const trusted = await listBrowsers(runner);
    expect(trusted).toHaveLength(1);
  });

  it("fails before sending anything when the candidate key cannot be saved", async () => {
    const b = browser();
    const send = vi.fn();
    b.links.set("r1", { send, onMessage: () => () => {} });
    b.keyStore.save = async () => {
      throw new Error("EIO");
    };
    await expect(enroll("BCDFGHJK", b.ctxFor("r1"))).rejects.toMatchObject({ reason: "unreadable_key" });
    expect(send).not.toHaveBeenCalled();
  });

  it("carries the runner proof on a genuine success", async () => {
    const runner = appFor("r1");
    const b = browser();
    let seen: PakeMessage | undefined;
    const { outcome } = await enrollWith(b, runner, undefined, (m) => ((m.t === "pake/done" && m.ok && (seen = m)), m));
    await outcome;
    expect(seen).toHaveProperty("proof");
  });

  it("surfaces the runner's refusal when the user says no", async () => {
    const runner = appFor("r1");
    const b = browser();
    const win = await (async () => {
      const w = await openWindow(runner, false);
      return w;
    })();
    const { outcome } = await enrollWith(b, runner, win.code);
    await expect(outcome).rejects.toMatchObject({ reason: "rejected_by_user" });
    expect([...b.keyStore.data.keys()]).toEqual([KEY_NAME]); // the candidate key only, no runner key
  });

  it("surfaces no_enrollment_open when the runner has no window", async () => {
    const b = browser();
    b.links.set("r1", enrollmentLink(appFor("r1"), b.state.id));
    await expect(enroll("BCDFGHJK", b.ctxFor("r1"))).rejects.toMatchObject({ reason: "no_enrollment_open" });
  });

  it("rejects a malformed code before sending anything", async () => {
    const b = browser();
    const send = vi.fn();
    b.links.set("r1", { send, onMessage: () => () => {} });
    await expect(enroll("AEIOU123", b.ctxFor("r1"))).rejects.toMatchObject({ reason: "invalid_code_format" });
    expect(send).not.toHaveBeenCalled();
  });

  it("times out when nobody answers", async () => {
    vi.useFakeTimers();
    const b = browser();
    const sent: PakeMessage[] = [];
    b.links.set("r1", { send: (m) => void sent.push(m), onMessage: () => () => {} });
    const outcome = enroll("BCDFGHJK", b.ctxFor("r1")).catch((e: unknown) => e);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await outcome).toMatchObject({ reason: "timeout" });
    expect(sent.map((m) => m.t)).toEqual(["pake/start"]);
    expect([...b.keyStore.data.keys()]).toEqual([KEY_NAME]); // the candidate key only, no runner key
  });

  it("waits for the person at the runner's terminal far longer than the handshake timeout", async () => {
    // Only timers are faked: the runner's files stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const runner = appFor("r1");
    const b = browser();
    let answer!: (yes: boolean) => void;
    let asked = false;
    let shown!: (code: string) => void;
    const code = new Promise<string>((resolve) => (shown = resolve));
    const runnerSide = runnerEnroll(
      runner,
      { showCode: (c) => shown(c), confirm: () => ((asked = true), new Promise<boolean>((resolve) => (answer = resolve))) },
      { pollMs: 20 },
    );
    runnerSide.catch(() => undefined);
    b.links.set("r1", enrollmentLink(runner, b.state.id));
    let settled = false;
    const outcome = enroll(await code, b.ctxFor("r1"));
    outcome.then(() => (settled = true), () => (settled = true));
    while (!asked) await new Promise((resolve) => setImmediate(resolve));

    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS * 4);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    answer(true);
    await expect(outcome).resolves.toMatchObject({ runnerId: "r1" });
    await runnerSide;
  });

  it("gives up on a runner that never answers its user once the code's life is over", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const runner = appFor("r1");
    const b = browser();
    const stop = new AbortController();
    let asked = false;
    let shown!: (code: string) => void;
    const code = new Promise<string>((resolve) => (shown = resolve));
    const runnerSide = runnerEnroll(
      runner,
      { showCode: (c) => shown(c), confirm: () => ((asked = true), new Promise<boolean>(() => {})) },
      { pollMs: 20, signal: stop.signal },
    );
    runnerSide.catch(() => undefined);
    b.links.set("r1", enrollmentLink(runner, b.state.id));
    let settled = false;
    const outcome = enroll(await code, b.ctxFor("r1"));
    const failure = outcome.then(() => undefined, (error: unknown) => ((settled = true), error));
    while (!asked) await new Promise((resolve) => setImmediate(resolve));

    await vi.advanceTimersByTimeAsync(ENROLL_CODE_TTL_MS - 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(await failure).toBeInstanceOf(EnrollError);
    expect([...b.keyStore.data.keys()]).toEqual([KEY_NAME]); // the candidate key only, no runner key
    stop.abort();
    await runnerSide.catch(() => undefined);
  });

  it("refuses an unreadable stored key instead of silently replacing it", async () => {
    const b = browser();
    await b.keyStore.save(KEY_NAME, { kind: "webcrypto", garbage: true });
    b.links.set("r1", { send: () => {}, onMessage: () => () => {} });
    await expect(enroll("BCDFGHJK", b.ctxFor("r1"))).rejects.toMatchObject({ reason: "unreadable_key" });
  });
});

// --- sessions -------------------------------------------------------------------

describe("encrypted layer", () => {
  async function enrolledSession() {
    const runner = appFor("r1");
    const b = browser();
    const { outcome } = await enrollWith(b, runner);
    await outcome;
    return { runner, b, ...(await talk(b, runner)) };
  }

  it("rejects a replayed frame and a plaintext frame, and dies after the first fault", async () => {
    const { link, layer, channel } = await enrolledSession();
    const seen: SequencedFrame[] = [];
    link.onBrowserFrame((f) => void seen.push(f));
    channel.send({ jsonrpc: "2.0", id: 1, result: {} });
    await until(() => seen.length === 1);
    // the first copy was opened by the harness; opening it again is a replay
    await expect(layer.open(seen[0]!)).rejects.toThrow();
    // the fault destroyed the codec: even a fresh frame cannot be opened now
    channel.send({ jsonrpc: "2.0", id: 2, result: {} });
    await until(() => seen.length === 2);
    await expect(layer.open(seen[1]!)).rejects.toThrow();
    channel.close();
  });

  it("refuses plaintext frames and frames of another session without touching the codec", async () => {
    const { link, layer, channel, fromRunner } = await enrolledSession();
    await expect(layer.open({ v: 1, kid: layer.kid, seq: 1, msg: call(1) })).rejects.toThrow();
    const other = await enrolledSession();
    other.channel.send({ jsonrpc: "2.0", id: 9, result: {} });
    await until(() => other.fromRunner.length === 1);
    channel.send({ jsonrpc: "2.0", id: 1, result: {} });
    await until(() => fromRunner.length === 1);
    expect(link.wire.closed).toBe(false);
    channel.close();
    other.channel.close();
  });

  it("start fails for a browser the runner does not know, and close() aborts a pending start", async () => {
    const runner = appFor("r1");
    const b = browser();
    const { outcome } = await enrollWith(b, runner);
    await outcome;
    // a session with no answering runner: close() must settle start promptly
    const silent = { send: () => {}, onMessage: () => () => {} } satisfies HandshakeIO;
    const layer = wrapClientLayer(createPlainLayer(), b.ctxFor("r1"));
    const started = layer.start(silent).catch((e: unknown) => e);
    await tick(20);
    layer.close();
    expect(await started).toBeInstanceOf(Error);
  });

  it("is not enrolled with a different runner", async () => {
    const runner = appFor("r1");
    const b = browser();
    const { outcome } = await enrollWith(b, runner);
    await outcome;
    const layer = wrapClientLayer(createPlainLayer(), b.ctxFor("r2"));
    await expect(layer.start({ send: () => {}, onMessage: () => () => {} })).rejects.toThrow("not enrolled");
  });

  it("a revoked browser gets no session", async () => {
    const runner = appFor("r1");
    const b = browser();
    const { outcome } = await enrollWith(b, runner);
    const enrolled = await outcome;
    expect(await revokeBrowser(runner, enrolled.browserKeyId)).toBe(true);
    const link = sessionLink(runner, b.state.id);
    const channel = wrapRunnerChannel(link.wire, { app: runner, e2ee: true });
    const accepted = vi.fn();
    link.io.onMessage((m) => m.t === "session/accept" && accepted());
    const layer = wrapClientLayer(createPlainLayer(), b.ctxFor("r1"));
    const started = layer.start(link.io).catch((e: unknown) => e);
    await until(() => channel.closed);
    layer.close();
    expect(await started).toBeInstanceOf(Error);
    expect(accepted).not.toHaveBeenCalled();
  });
});

// --- relay blindness ------------------------------------------------------------

describe("relay blindness", () => {
  it("everything the relay forwards, from enrollment to a prompt, is opaque", async () => {
    const runner = appFor("r1");
    const b = browser("Very Private Laptop");
    const win = await openWindow(runner);
    b.links.set("r1", enrollmentLink(runner, b.state.id));
    await enroll(win.code, b.ctxFor("r1"));
    await win.result;
    const session = await talk(b, runner);
    session.link.deliver(await session.layer.seal(call(1)));
    await until(() => session.fromBrowser.length === 1);
    session.channel.send({ jsonrpc: "2.0", id: 1, result: { text: "agent says secret-output" } });
    await until(() => session.fromRunner.length === 1);

    const seen = relayTap.join("\n");
    const runnerKey = b.keyStore.data.get(runnerKeyName("r1")) as string;
    const stored = b.keyStore.data.get(KEY_NAME) as { publicKey: Uint8Array };
    for (const needle of [win.code, "Very Private Laptop", "tell-nobody-42", "secret-output", "jsonrpc", "session/prompt", runnerKey, base64UrlEncode(stored.publicKey)]) {
      expect(seen).not.toContain(needle);
    }
    const kinds = new Set(relayTap.map((body) => (JSON.parse(body) as { t?: string }).t ?? "frame"));
    expect([...kinds].sort()).toEqual(["frame", "pake/confirm", "pake/done", "pake/reply", "pake/start", "session/accept", "session/init"]);
    session.channel.close();
  });
});

// --- through the relay core -----------------------------------------------

/** The real relay core on an in-memory transport: every hop is routed, and tapped, by the core. */
async function coreRelay(runnerId: string) {
  type Conn = { conn: { id: string; peer: RelayPeer; state: { connectedAt: string } }; queue: { deliver: () => void }[] };
  const conns = new Map<string, Conn>();
  let n = 0;
  const transport: RelayTransport = {
    bind() {},
    async accept() {
      return new Response(null, { status: 426 });
    },
    async disconnect() {
      return 0;
    },
    send(id, data): SendResult {
      const entry = conns.get(id);
      if (!entry) return "closed";
      const envelope = JSON.parse(data) as { kind: string };
      if (envelope.kind === "pake" || envelope.kind === "frame") entry.queue.shift()?.deliver();
      return "sent";
    },
    close() {},
    connections(userId, filter = {}) {
      return [...conns.values()]
        .filter((e) => e.conn.peer.userId === userId)
        .filter((e) => filter.role === undefined || e.conn.peer.role === filter.role)
        .filter((e) => filter.runnerId === undefined || (e.conn.peer.role === "runner" && e.conn.peer.runnerId === filter.runnerId))
        .filter((e) => filter.browserKeyId === undefined || (e.conn.peer.role === "browser" && e.conn.peer.browserKeyId === filter.browserKeyId))
        .map((e) => e.conn) as never;
    },
    setState(id, state) {
      const entry = conns.get(id);
      if (entry) entry.conn.state = state as never;
    },
  };
  const devices = new Map<string, unknown>();
  const config = {
    app: { id: "app", name: "App" },
    origin: "https://app.example",
    auth: { issuer: "https://idp.example", clientId: "c", deviceAuthorizationEndpoint: "https://idp.example/d", tokenEndpoint: "https://idp.example/t" },
    adapters: {
      relay: {} as never,
      verifier: {} as never,
      store: {
        getDevice: async (userId: string, id: string) => (devices.has(`${userId}:${id}`) ? ({ deviceId: id, runnerVersion: "1.0.0", lastSeen: "2026-01-01T00:00:00.000Z" } as never) : undefined),
        listDevices: async () => [],
        upsertDevice: async (record: { userId: string; deviceId: string }) => {
          devices.set(`${record.userId}:${record.deviceId}`, record);
          return "ok" as const;
        },
        touchLastSeen: async () => false,
        revokeDevice: async () => undefined,
        isRevoked: async () => false,
        isCredentialRevoked: async () => false,
      },
    },
  } as unknown as BridgeServerConfig;
  const forwarded: string[] = [];
  const core = createRelayCoreWithHooks(config, transport, { onForward: (raw) => forwarded.push(raw) });
  const open = (peer: RelayPeer): Conn => {
    const conn: Conn = { conn: { id: `c${++n}`, peer, state: { connectedAt: new Date(1000 + n).toISOString() } }, queue: [] };
    conns.set(conn.conn.id, conn);
    return conn;
  };
  const runner = open({ role: "runner", userId: "u", runnerId });
  await core.onMessage(runner.conn as never, JSON.stringify({ type: "hello", runnerId, runnerVersion: "1.0.0", protocol: { min: 1, max: 1 } }));
  const browsers = new Map<string, Conn>();
  const browserConn = async (id: string): Promise<Conn> => {
    let entry = browsers.get(id);
    if (!entry) {
      entry = open({ role: "browser", userId: "u", browserKeyId: id });
      browsers.set(id, entry);
      await core.onOpen(entry.conn as never);
    }
    return entry;
  };
  const hop: Hop = (direction, kind, browserKeyId, body, deliver) => {
    void (async () => {
      const browser = await browserConn(browserKeyId);
      const [from, to] = direction === "toRunner" ? [browser, runner] : [runner, browser];
      to.queue.push({ deliver });
      await core.onMessage(from.conn as never, JSON.stringify({ to: direction === "toRunner" ? "runner" : "browser", runnerId, browserKeyId, kind, body }));
    })();
  };
  return { hop, forwarded };
}

describe("through the relay core", () => {
  it("the core forwards only ciphertext and handshake messages it cannot read", async () => {
    const runner = appFor("r1");
    const net = await coreRelay("r1");
    const b = browser("Very Private Laptop");
    const win = await openWindow(runner);
    b.links.set("r1", enrollmentLink(runner, b.state.id, undefined, net.hop));
    await enroll(win.code, b.ctxFor("r1"));
    await win.result;
    const session = await talk(b, runner, net.hop);
    session.link.deliver(await session.layer.seal(call(1)));
    await until(() => session.fromBrowser.length === 1);
    session.channel.send({ jsonrpc: "2.0", id: 1, result: { text: "agent says secret-output" } });
    await until(() => session.fromRunner.length === 1);
    expect(session.fromBrowser[0]).toEqual(call(1));

    // what the core tapped is exactly what travelled, and none of it is readable
    expect(net.forwarded.length).toBeGreaterThanOrEqual(8);
    const seen = net.forwarded.join("\n");
    for (const needle of [win.code, "Very Private Laptop", "tell-nobody-42", "secret-output", "jsonrpc", "session/prompt"]) {
      expect(seen).not.toContain(needle);
    }
    const kinds = new Map<string, number>();
    for (const raw of net.forwarded) {
      const envelope = JSON.parse(raw) as { kind: string; body: { t?: string } };
      const label = envelope.kind === "frame" ? "frame" : envelope.body.t!;
      kinds.set(label, (kinds.get(label) ?? 0) + 1);
    }
    expect([...kinds.keys()].sort()).toEqual(["frame", "pake/confirm", "pake/done", "pake/reply", "pake/start", "session/accept", "session/init"]);
    for (const raw of net.forwarded) {
      const envelope = JSON.parse(raw) as { kind: string; body: Record<string, unknown> };
      if (envelope.kind === "frame") expect(Object.keys(envelope.body).sort()).toEqual(["ct", "kid", "nonce", "seq", "v"]);
    }
    session.channel.close();
  });
});
