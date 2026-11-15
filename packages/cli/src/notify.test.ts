import { afterEach, describe, expect, it } from "vitest";

import { notifyOf } from "./notify.js";
import { type Harness, harness } from "./testkit.js";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("notifyOf", () => {
  it("uses the injected notify", async () => {
    h = await harness();
    await notifyOf(h.deps)({ title: "T", body: "B" });
    expect(h.notifications).toEqual([{ title: "T", body: "B" }]);
    expect(h.commands).toEqual([]);
  });

  it("defaults to notify-send on Linux, with the text after `--` so it cannot be read as an option", async () => {
    h = await harness();
    const { notify: _notify, ...rest } = h.deps;
    await notifyOf(rest)({ title: "--hidden", body: "line\nbreak \u001b[31m" });
    expect(h.commands).toEqual([["notify-send", "--app-name=bridge", "--", "--hidden", "line break  [31m"]]);
  });

  it("defaults to osascript on macOS, escaping quotes and backslashes", async () => {
    h = await harness({ platform: "darwin" });
    const { notify: _notify, ...rest } = h.deps;
    await notifyOf(rest)({ title: 'Bridge "runner"', body: "a\\b" });
    expect(h.commands).toEqual([["osascript", "-e", 'display notification "a\\\\b" with title "Bridge \\"runner\\""']]);
  });

  it("ignores a missing tool and a failing one", async () => {
    h = await harness({ run: async () => { throw new Error("spawn notify-send ENOENT"); } });
    const { notify: _notify, ...rest } = h.deps;
    await expect(notifyOf(rest)({ title: "T", body: "B" })).resolves.toBeUndefined();
    h = await harness({ run: async () => ({ exitCode: 1, stdout: "", stderr: "no bus" }) });
    const { notify: _n2, ...rest2 } = h.deps;
    await expect(notifyOf(rest2)({ title: "T", body: "B" })).resolves.toBeUndefined();
  });
});
