import { type HandshakeIO, type JsonRpcMessage, type PakeMessage, type PakeStart, type SequencedFrame, createPlainLayer } from "@berdyh/bridge-protocol";
import { describe, expect, expectTypeOf, it } from "vitest";

import { type EnrollmentWire, type RunnerWire, acceptEnrollment, channelFromLayer, wrapRunnerChannel } from "./index.js";
import { appPathsOf } from "../paths.js";

/** Two wires joined back to back, like the relay and links would. */
function wirePair(): [RunnerWire, RunnerWire] {
  const make = (): RunnerWire & { peer?: RunnerWire; deliver(f: SequencedFrame): void } => {
    const frameHandlers = new Set<(f: SequencedFrame) => void>();
    const closeHandlers = new Set<(r?: string) => void>();
    const handshake: HandshakeIO = { send: () => {}, onMessage: () => () => {} };
    const w: RunnerWire & { peer?: RunnerWire; deliver(f: SequencedFrame): void } = {
      appId: "app",
      browserKeyId: "k1",
      kid: "browser_kid",
      bindSession(kid) {
        (w as { kid?: string }).kid = kid;
      },
      closed: false,
      handshake,
      sendFrame(f) {
        queueMicrotask(() => (w.peer as typeof w | undefined)?.deliver(f));
      },
      deliver(f) {
        for (const h of frameHandlers) h(f);
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
        if (w.closed) return;
        (w as { closed: boolean }).closed = true;
        for (const h of closeHandlers) h(reason);
        (w.peer as typeof w | undefined)?.close(reason);
      },
    };
    return w;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

const msg = (id: number): JsonRpcMessage => ({ jsonrpc: "2.0", id, method: "ping" });
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("channelFromLayer", () => {
  it("carries messages both ways in order through plain layers", async () => {
    const [wa, wb] = wirePair();
    const layerA = createPlainLayer();
    const a = channelFromLayer(wa, layerA);
    const b = channelFromLayer(wb, createPlainLayer({ kid: layerA.kid }));
    const got: unknown[] = [];
    b.onMessage((m) => got.push(m.id));
    a.send(msg(1));
    a.send(msg(2));
    a.send(msg(3));
    await tick();
    expect(got).toEqual([1, 2, 3]);
    expect(a.appId).toBe("app");
    expect(a.browserKeyId).toBe("k1");
  });

  it("binds the wire's kid to the layer's negotiated kid once start resolves, before any data", async () => {
    const [wa] = wirePair();
    (wa as { kid?: string }).kid = undefined;
    channelFromLayer(wa, createPlainLayer({ kid: "negotiated" }));
    await tick();
    expect(wa.kid).toBe("negotiated");
  });

  it("closes the channel and the wire when a frame is replayed", async () => {
    const [wa, wb] = wirePair();
    const layer = createPlainLayer();
    const a = channelFromLayer(wa, layer);
    const b = channelFromLayer(wb, createPlainLayer({ kid: layer.kid }));
    let closedReason: string | undefined;
    b.onClose((r) => (closedReason = r));
    const frame = await createPlainLayer({ kid: layer.kid }).seal(msg(1));
    (wb as unknown as { deliver(f: SequencedFrame): void }).deliver(frame);
    (wb as unknown as { deliver(f: SequencedFrame): void }).deliver(frame);
    await tick();
    expect(b.closed).toBe(true);
    expect(closedReason).toBe("channel error");
    expect(a.closed).toBe(true);
  });

  it("reports closing once and ignores sends afterwards", async () => {
    const [wa] = wirePair();
    const a = channelFromLayer(wa, createPlainLayer());
    let n = 0;
    a.onClose(() => n++);
    a.close("bye");
    a.close("again");
    a.send(msg(1));
    expect([n, a.closed]).toEqual([1, true]);
  });
});

describe("plaintext mode (BRIDGE_E2EE=0)", () => {
  it("wrapRunnerChannel with e2ee off is the plaintext layer", async () => {
    const [wa, wb] = wirePair();
    const ctx = { app: { appId: "app", runnerId: "r1", paths: appPathsOf({ config: "/nonexistent", data: "/nonexistent", state: "/nonexistent" }, "app") }, e2ee: false };
    const a = wrapRunnerChannel(wa, ctx);
    const b = wrapRunnerChannel(wb, ctx);
    const sent: SequencedFrame[] = [];
    const send = wa.sendFrame.bind(wa);
    wa.sendFrame = (f) => (sent.push(f), send(f));
    const got: unknown[] = [];
    b.onMessage((m) => got.push(m.method));
    a.send(msg(7));
    await tick();
    expect(got).toEqual(["ping"]);
    expect(sent.map((f) => f.kid)).toEqual(["browser_kid"]);
  });
});

describe("enrollment seam (the first message of an unenrolled browser is pake/start, not a session)", () => {
  const ctx = { app: { appId: "app", runnerId: "r1", paths: appPathsOf({ config: "/nonexistent", data: "/nonexistent", state: "/nonexistent" }, "app") }, e2ee: true };
  const start: PakeStart = { t: "pake/start", v: 1, enrollId: "pre_enroll_id", msg: "AAAA" };

  function enrollmentWire() {
    const sent: PakeMessage[] = [];
    const closes: (string | undefined)[] = [];
    const wire: EnrollmentWire = {
      appId: "app",
      enrollId: start.enrollId,
      closed: false,
      handshake: { send: (m) => void sent.push(m), onMessage: () => () => {} },
      onClose: () => () => {},
      close: (reason) => void closes.push(reason),
    };
    return { wire, sent, closes };
  }

  it("is its own wire type: an enrollment can never be wrapped into a BrowserChannel", () => {
    expectTypeOf<EnrollmentWire>().not.toExtend<RunnerWire>();
    expectTypeOf(wrapRunnerChannel).parameter(0).toEqualTypeOf<RunnerWire>();
    expectTypeOf(acceptEnrollment).parameter(0).toEqualTypeOf<EnrollmentWire>();
  });

  it("answers no_enrollment_open on the wire's enrollId while no window is open (no window)", async () => {
    const { wire, sent, closes } = enrollmentWire();
    await acceptEnrollment(wire, start, ctx);
    expect(sent).toEqual([{ t: "pake/done", v: 1, enrollId: "pre_enroll_id", ok: false, reason: "no_enrollment_open" }]);
    expect(closes).toEqual(["no_enrollment_open"]);
  });
});
