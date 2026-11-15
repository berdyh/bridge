import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AckFrame,
  PENDING_FRAMES_MAX,
  RETIRED_KIDS_MIN,
  type ReceiveVerdict,
  type ReliableReceiver,
  type ReliableSender,
  createReliableReceiver,
  createReliableSender,
  type SequencedFrame,
  type PlainFrame,
} from "./index.js";

describe("reliable link contract", () => {
  it("types the sender and receiver", () => {
    expectTypeOf<ReliableSender["send"]>().toEqualTypeOf<(frame: SequencedFrame) => SequencedFrame>();
    expectTypeOf<ReliableSender["ack"]>().toEqualTypeOf<(ack: AckFrame) => void>();
    expectTypeOf<ReliableSender["pending"]>().returns.toEqualTypeOf<readonly SequencedFrame[]>();
    expectTypeOf<ReliableReceiver["accept"]>().toEqualTypeOf<(frame: SequencedFrame) => ReceiveVerdict>();
    expectTypeOf<ReceiveVerdict>().toEqualTypeOf<"deliver" | "duplicate" | "gap" | "bind" | "new_session" | "buffer" | "unknown_session" | "retired">();
    expectTypeOf(createReliableSender).returns.toEqualTypeOf<ReliableSender>();
    expectTypeOf(createReliableReceiver).returns.toEqualTypeOf<ReliableReceiver>();
    expectTypeOf<ReliableReceiver["expectBind"]>().toEqualTypeOf<() => void>();
    expectTypeOf<ReliableReceiver["beginSession"]>().toEqualTypeOf<() => void>();
    expect([RETIRED_KIDS_MIN, PENDING_FRAMES_MAX]).toEqual([8, 64]);
  });
});

const frame = (kid = "one", seq = 1): PlainFrame => ({ v: 1, kid, seq, msg: { jsonrpc: "2.0", method: "ping" } });
const invalidSequences = [Number.MAX_SAFE_INTEGER + 1, 1.5, 0, -1, NaN, Infinity, -Infinity];

describe("shared reliable sender", () => {
  it.each(invalidSequences)("rejects invalid seq %s without retaining it or advancing state", (seq) => {
    const sender = createReliableSender();
    expect(() => sender.send(frame("one", seq))).toThrow("non-contiguous frame or wrong session");
    expect(sender.kid).toBeUndefined();
    expect(sender.acked).toBe(0);
    expect(sender.pending()).toEqual([]);

    const first = frame();
    expect(sender.send(first)).toBe(first);
    expect(() => sender.send(frame("one", seq))).toThrow("non-contiguous frame or wrong session");
    expect(sender.kid).toBe("one");
    expect(sender.acked).toBe(0);
    expect(sender.pending()).toEqual([first]);
    expect(sender.pending()[0]).toBe(first);
    const second = frame("one", 2);
    expect(sender.send(second)).toBe(second);
    expect(sender.pending()).toEqual([first, second]);
  });

  it("retains identical objects in order and applies cumulative acknowledgements", () => {
    const sender = createReliableSender();
    const first = frame();
    expect(sender.send(first)).toBe(first);
    sender.send(frame("one", 2));
    sender.send(frame("one", 3));
    expect(sender.pending()[0]).toBe(first);
    sender.ack({ v: 1, kid: "other", ack: 999 });
    expect(sender.acked).toBe(0);
    sender.ack({ v: 1, kid: "one", ack: 2 });
    sender.ack({ v: 1, kid: "one", ack: 1 });
    expect(sender.acked).toBe(2);
    expect(sender.pending().map((f) => f.seq)).toEqual([3]);
    const snapshot = sender.pending() as PlainFrame[];
    snapshot.length = 0;
    expect(sender.pending()).toHaveLength(1);
    sender.reset();
    expect(sender.kid).toBeUndefined();
    expect(sender.acked).toBe(0);
    expect(sender.pending()).toEqual([]);
    sender.send(frame("two"));
  });

  it("rejects invalid sends and impossible acknowledgements without changing state", () => {
    const sender = createReliableSender();
    expect(() => sender.send(frame("one", 2))).toThrow();
    sender.send(frame());
    for (const bad of [frame(), frame("two", 2), frame("one", 3), frame("one", NaN)]) {
      expect(() => sender.send(bad)).toThrow();
    }
    expect(() => sender.ack({ v: 1, kid: "one", ack: 2 })).toThrow();
    expect(sender.acked).toBe(0);
    expect(sender.pending()).toHaveLength(1);
    sender.send(frame("one", 2));
  });
});

describe("shared reliable receiver", () => {
  describe.each(["browser", "runner"] as const)("%s sequence validation", (role) => {
    it.each(invalidSequences)("rejects invalid seq %s before session classification without changing state", (seq) => {
      const receiver = createReliableReceiver({ role });
      expect(() => receiver.accept(frame("unseen", seq))).toThrow("invalid sequence");
      expect(receiver.kid).toBeUndefined();
      expect(receiver.delivered).toBe(0);
      expect(receiver.ackFrame()).toBeUndefined();
      expect(receiver.isRetired("unseen")).toBe(false);

      if (role === "browser") receiver.bind("one");
      expect(receiver.accept(frame())).toBe(role === "browser" ? "deliver" : "new_session");
      if (role === "browser") receiver.bind("two");
      expect(receiver.accept(frame("two"))).toBe(role === "browser" ? "deliver" : "new_session");
      expect(receiver.isRetired("one")).toBe(true);

      for (const kid of ["two", "unseen", "one"]) {
        expect(() => receiver.accept(frame(kid, seq))).toThrow("invalid sequence");
        expect(receiver.kid).toBe("two");
        expect(receiver.delivered).toBe(1);
        expect(receiver.ackFrame()).toEqual({ v: 1, kid: "two", ack: 1 });
        expect(receiver.isRetired("one")).toBe(true);
        expect(receiver.isRetired("two")).toBe(false);
        expect(receiver.isRetired("unseen")).toBe(false);
      }
      expect(receiver.accept(frame("one"))).toBe("retired");
      expect(receiver.accept(frame("two", 2))).toBe("deliver");

      if (role === "runner") receiver.expectBind();
      else receiver.beginSession();
      expect(() => receiver.accept(frame("three", seq))).toThrow("invalid sequence");
      expect(receiver.kid).toBeUndefined();
      expect(receiver.delivered).toBe(0);
      expect(receiver.ackFrame()).toBeUndefined();
      expect(receiver.accept(frame("three"))).toBe(role === "runner" ? "bind" : "buffer");
    });
  });

  it("the browser buffers before binding, dedupes, and only gaps on its current kid", () => {
    const receiver = createReliableReceiver({ role: "browser" });
    expect(receiver.accept(frame("stale", 5))).toBe("buffer");
    expect(receiver.ackFrame()).toBeUndefined();
    receiver.bind("one");
    expect(receiver.accept(frame("stale", 5))).toBe("unknown_session");
    expect(receiver.accept(frame())).toBe("deliver");
    expect(receiver.accept(frame())).toBe("duplicate");
    expect(receiver.accept(frame("one", 3))).toBe("gap");
    expect(receiver.delivered).toBe(1);
    expect(receiver.ackFrame()).toEqual({ v: 1, kid: "one", ack: 1 });
    receiver.bind("one");
    expect(receiver.delivered).toBe(1);
    receiver.beginSession();
    expect(receiver.isRetired("one")).toBe(true);
    expect(receiver.accept(frame())).toBe("retired");
    expect(receiver.accept(frame("two"))).toBe("buffer");
    receiver.bind("two");
    expect(receiver.accept(frame("two"))).toBe("deliver");
    expect(() => receiver.bind("one")).toThrow();
  });

  it("the runner distinguishes pending binding from session supersession", () => {
    const receiver = createReliableReceiver({ role: "runner", kid: "ignored" });
    expect(receiver.kid).toBeUndefined();
    expect(receiver.accept(frame("one", 3))).toBe("unknown_session");
    expect(receiver.accept(frame())).toBe("new_session");
    expect(receiver.accept(frame())).toBe("duplicate");
    receiver.expectBind();
    expect(receiver.accept(frame())).toBe("retired");
    expect(receiver.accept(frame("two", 2))).toBe("unknown_session");
    expect(receiver.accept(frame("two"))).toBe("bind");
    expect(receiver.delivered).toBe(1);
    expect(receiver.accept(frame("three"))).toBe("new_session");
    expect(receiver.accept(frame("two", 2))).toBe("retired");
    receiver.reset();
    expect(receiver.ackFrame()).toBeUndefined();
    expect(receiver.accept(frame("four"))).toBe("new_session");
  });

  it("once the pending wire's kid is known, only that kid binds; a junk kid is dropped and not adopted", () => {
    const receiver = createReliableReceiver({ role: "runner" });
    receiver.expectBind();
    // Before the kid is known any unseen kid binds (the handshake has not finished).
    receiver.expectKid("real");
    expect(receiver.accept(frame("junk"))).toBe("unknown_session");
    expect(receiver.kid).toBeUndefined();
    expect(receiver.isRetired("junk")).toBe(false);
    expect(receiver.ackFrame()).toBeUndefined();
    expect(receiver.accept(frame("real"))).toBe("bind");
    expect(receiver.kid).toBe("real");
    expect(receiver.delivered).toBe(1);
    expect(receiver.accept(frame("real", 2))).toBe("deliver");
  });

  it("expectKid is cleared by reset and is a no-op when not pending", () => {
    const receiver = createReliableReceiver({ role: "runner" });
    receiver.expectKid("real");
    expect(receiver.accept(frame("other"))).toBe("new_session");
    receiver.expectBind();
    receiver.expectKid("real");
    receiver.reset();
    receiver.expectBind();
    expect(receiver.accept(frame("anything"))).toBe("bind");
  });

  it("with bufferUntilKid, a pending runner holds an unseen kid until expectKid and adopts nothing", () => {
    const receiver = createReliableReceiver({ role: "runner", bufferUntilKid: true });
    receiver.expectBind();
    expect(receiver.accept(frame("early"))).toBe("buffer");
    expect(receiver.accept(frame("junk"))).toBe("buffer");
    expect(receiver.accept(frame("early", 2))).toBe("unknown_session");
    expect(receiver.kid).toBeUndefined();
    expect(receiver.delivered).toBe(0);
    expect(receiver.isRetired("early")).toBe(false);
    expect(receiver.ackFrame()).toBeUndefined();
    receiver.expectKid("real");
    expect(receiver.accept(frame("junk"))).toBe("unknown_session");
    expect(receiver.accept(frame("real"))).toBe("bind");
    expect(receiver.kid).toBe("real");
    expect(receiver.delivered).toBe(1);
    expect(receiver.accept(frame("real", 2))).toBe("deliver");
  });

  it("with bufferUntilKid, a retired kid is still retired and a receiver that is not pending still starts a new session", () => {
    const receiver = createReliableReceiver({ role: "runner", bufferUntilKid: true });
    expect(receiver.accept(frame("one"))).toBe("new_session");
    receiver.expectBind();
    expect(receiver.accept(frame("one"))).toBe("retired");
    receiver.reset();
    expect(receiver.accept(frame("two"))).toBe("new_session");
  });

  it("bufferUntilKid is off by default and ignored by the browser", () => {
    const off = createReliableReceiver({ role: "runner" });
    off.expectBind();
    expect(off.accept(frame("any"))).toBe("bind");
    const browser = createReliableReceiver({ role: "browser", bufferUntilKid: true });
    expect(browser.accept(frame("x"))).toBe("buffer");
    browser.bind("x");
    expect(browser.accept(frame("y"))).toBe("unknown_session");
  });

  it("retains at least eight retired kids with bounded eviction", () => {
    const receiver = createReliableReceiver({ role: "runner", retiredCapacity: 1 });
    for (let i = 0; i <= RETIRED_KIDS_MIN + 1; i++) receiver.accept(frame(`k${i}`));
    expect(receiver.isRetired("k0")).toBe(false);
    for (let i = 1; i <= RETIRED_KIDS_MIN; i++) expect(receiver.isRetired(`k${i}`)).toBe(true);
    expect(receiver.accept(frame("new", 8))).toBe("unknown_session");
  });
});
