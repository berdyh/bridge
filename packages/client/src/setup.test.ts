import { ENROLL_CODE_TTL_MS } from "@berdyh/bridge-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wordsOf, type EnrollWords } from "./index.js";
import { setupInstructions } from "./setup.js";

const base = { appUrl: "https://app.example.com", appName: "My App", appId: "my-app" };
const storageKey = "__bridge/enrollLink:/connect";
let data: Map<string, string>;
let order: string[];
let location: URL;
let storage: Storage;
let replaceState: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  data = new Map(); order = [];
  location = new URL("https://app.example/connect?view=pair#code=BCDF-GHJK&runner=r1");
  storage = {
    getItem: vi.fn((key: string) => { order.push("get"); return data.get(key) ?? null; }),
    setItem: vi.fn((key: string, value: string) => { order.push("set"); data.set(key, value); }),
    removeItem: vi.fn((key: string) => { order.push("remove"); data.delete(key); }),
    clear: () => data.clear(), key: () => null, get length() { return data.size; },
  };
  replaceState = vi.fn((_state, _title, url: string) => { order.push("strip"); location.href = new URL(url, location).href; });
  vi.stubGlobal("location", location);
  vi.stubGlobal("history", { state: { router: "kept" }, replaceState });
  vi.stubGlobal("sessionStorage", storage);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("consumeEnrollLink", () => {
  it("strips before storage or app callbacks, preserves query/history state, and returns once", async () => {
    const { consumeEnrollLink } = await import("./setup.js");
    const callback = vi.fn((link) => {
      order.push("callback");
      expect(location.hash).toBe("");
      expect(link).toEqual({ code: "BCDFGHJK", runnerId: "r1" });
    });
    callback(consumeEnrollLink());
    expect(order).toEqual(["strip", "remove", "set", "callback"]);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith({ router: "kept" }, "", "/connect?view=pair");
    expect(consumeEnrollLink()).toBeUndefined();
    expect(JSON.parse(data.get(storageKey)!)).toMatchObject({ code: "BCDFGHJK", runnerId: "r1" });
  });

  it("resumes after a sign-in navigation once and deletes the cache without extending expiry", async () => {
    vi.useFakeTimers();
    const first = await import("./setup.js");
    first.consumeEnrollLink();
    const saved = data.get(storageKey);
    vi.resetModules();
    const nextPage = await import("./setup.js");
    expect(nextPage.consumeEnrollLink()).toEqual({ code: "BCDFGHJK", runnerId: "r1" });
    expect(data.has(storageKey)).toBe(false);
    expect(nextPage.consumeEnrollLink()).toBeUndefined();
    expect(JSON.parse(saved!).expiresAt).toBe(Date.now() + ENROLL_CODE_TTL_MS);
  });

  it.each(["expired", "future", "malformed", "invalid code"])("discards %s storage records", async (kind) => {
    location.hash = "";
    data.set(storageKey, kind === "malformed" ? "not json" : JSON.stringify({
      code: kind === "invalid code" ? "bad" : "BCDFGHJK", runnerId: "r1",
      expiresAt: Date.now() + (kind === "expired" ? 0 : kind === "future" ? ENROLL_CODE_TTL_MS * 2 : 5000),
    }));
    const { consumeEnrollLink } = await import("./setup.js");
    expect(consumeEnrollLink()).toBeUndefined();
    expect(data.has(storageKey)).toBe(false);
  });

  it("strips malformed enrollment fragments and rejects stale saved links instead of resuming them", async () => {
    location.hash = "#code=SECRET&runner=r1&tracking=yes";
    data.set(storageKey, JSON.stringify({ code: "BCDFGHJK", runnerId: "old", expiresAt: Date.now() + 5000 }));
    const { consumeEnrollLink } = await import("./setup.js");
    expect(consumeEnrollLink()).toBeUndefined();
    expect(location.hash).toBe("");
    expect(data.size).toBe(0);
  });

  it("keeps unrelated anchors and isolates cached links by enroll page", async () => {
    location.href = "https://app.example/other#section";
    data.set(storageKey, JSON.stringify({ code: "BCDFGHJK", runnerId: "r1", expiresAt: Date.now() + 5000 }));
    const { consumeEnrollLink } = await import("./setup.js");
    expect(consumeEnrollLink()).toBeUndefined();
    expect(replaceState).not.toHaveBeenCalled();
    expect(data.has(storageKey)).toBe(true);
  });

  it("works with storage disabled, but never returns a code when stripping fails", async () => {
    vi.stubGlobal("sessionStorage", { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } });
    const { consumeEnrollLink } = await import("./setup.js");
    replaceState.mockImplementationOnce(() => { throw new Error("cannot strip"); });
    expect(() => consumeEnrollLink()).toThrow("cannot strip");
    expect(consumeEnrollLink()).toEqual({ code: "BCDFGHJK", runnerId: "r1" });
    expect(location.hash).toBe("");
  });

  it("is safe without browser globals", async () => {
    vi.stubGlobal("location", undefined);
    const { consumeEnrollLink } = await import("./setup.js");
    expect(consumeEnrollLink()).toBeUndefined();
  });
});

describe("setupInstructions", () => {
  it("human Linux copy", () => {
    expect(setupInstructions({ ...base, flavor: "human", platform: "linux" })).toMatchInlineSnapshot(`
      {
        "flavor": "human",
        "oneLiner": "npx @berdyh/bridge setup https://app.example.com",
        "steps": [
          "Paste \`npx @berdyh/bridge setup https://app.example.com\` into a terminal to set up My App (https://app.example.com).",
          "Read the exact install and work-folder paths before consenting. Approve the device code on the app's sign-in page.",
          "The runner runs as a background service by default ([Y/n]); choose no for foreground use. Set setup.service to "ask" to always choose explicitly.",
          "On the enroll page, click to pair this browser. Compare its four EFF words with the terminal's words and approve only if all four match.",
          "Wait for ready. Agent sessions start in this app's work folder; add other project folders explicitly to policy.json.",
          "The runner notifies you when it starts and stops after 15 minutes without any app's browser connected.",
          "If the runner is offline, open bridge://run to restart it in a terminal, or paste \`bridge run\`.",
        ],
        "troubleshooting": [
          {
            "fix": "Run \`npx @berdyh/bridge setup https://app.example.com\`. Install Node.js 22 or later and an agent with its login if doctor reports either missing.",
            "problem": "No runner is known",
          },
          {
            "fix": "If the runner is offline, open bridge://run to restart it in a terminal, or paste \`bridge run\`.",
            "problem": "Runner offline",
          },
          {
            "fix": "Run \`bridge enroll my-app --open\`, click to pair, and compare all four words. A revoked browser needs fresh enrollment.",
            "problem": "Online but this browser is not enrolled",
          },
          {
            "fix": "Run \`bridge enroll my-app --open\` again. Codes expire after ten minutes; use the browser profile signed into this app.",
            "problem": "Enrollment expired or sign-in lost the link",
          },
          {
            "fix": "Paste \`bridge run\`, or rerun setup to register the Linux protocol handler after reviewing its paths.",
            "problem": "Restart link does not open a terminal",
          },
          {
            "fix": "Windows is unsupported. Use WSL2 and follow the Linux setup steps.",
            "problem": "Windows",
          },
          {
            "fix": "Run \`bridge doctor --json\` and review its reported prerequisites and paths.",
            "problem": "Setup or agent login failed",
          },
        ],
      }
    `);
  });
  it("human macOS copy", () => {
    expect(setupInstructions({ ...base, flavor: "human", platform: "darwin" })).toMatchInlineSnapshot(`
      {
        "flavor": "human",
        "oneLiner": "npx @berdyh/bridge setup https://app.example.com",
        "steps": [
          "Paste \`npx @berdyh/bridge setup https://app.example.com\` into a terminal to set up My App (https://app.example.com).",
          "Read the exact install and work-folder paths before consenting. Approve the device code on the app's sign-in page.",
          "The runner runs as a background service by default ([Y/n]); choose no for foreground use. Set setup.service to "ask" to always choose explicitly.",
          "On the enroll page, click to pair this browser. Compare its four EFF words with the terminal's words and approve only if all four match.",
          "Wait for ready. Agent sessions start in this app's work folder; add other project folders explicitly to policy.json.",
          "The runner notifies you when it starts and stops after 15 minutes without any app's browser connected.",
          "If the runner is offline, paste \`bridge run\` into a terminal to restart it.",
        ],
        "troubleshooting": [
          {
            "fix": "Run \`npx @berdyh/bridge setup https://app.example.com\`. Install Node.js 22 or later and an agent with its login if doctor reports either missing.",
            "problem": "No runner is known",
          },
          {
            "fix": "If the runner is offline, paste \`bridge run\` into a terminal to restart it.",
            "problem": "Runner offline",
          },
          {
            "fix": "Run \`bridge enroll my-app --open\`, click to pair, and compare all four words. A revoked browser needs fresh enrollment.",
            "problem": "Online but this browser is not enrolled",
          },
          {
            "fix": "Run \`bridge enroll my-app --open\` again. Codes expire after ten minutes; use the browser profile signed into this app.",
            "problem": "Enrollment expired or sign-in lost the link",
          },
          {
            "fix": "macOS uses the paste fallback: \`bridge run\`.",
            "problem": "Restart link does not open a terminal",
          },
          {
            "fix": "Windows is unsupported. Use WSL2 and follow the Linux setup steps.",
            "problem": "Windows",
          },
          {
            "fix": "Run \`bridge doctor --json\` and review its reported prerequisites and paths.",
            "problem": "Setup or agent login failed",
          },
        ],
      }
    `);
  });
  it("agent Linux copy", () => {
    expect(setupInstructions({ ...base, flavor: "agent", platform: "linux" })).toMatchInlineSnapshot(`
      {
        "agentPrompt": "Set up the local bridge runner for My App (https://app.example.com) on this machine.
      Use only the bridge CLI via \`npx @berdyh/bridge\`; never edit ~/.config, ~/.local or service files yourself.
      Show every exact path list and ask me before install or service writes and their --yes flags. The device-grant page confirms the app origin, so connect --yes is allowed. An agent passing --yes is not a human confirmation; the harness's command approval is an additional gate.
      1. Run \`npx @berdyh/bridge doctor --json\` and report Node version, agents and logins. If a prerequisite is missing, stop and tell me what to install or log into. Windows is unsupported; suggest WSL2.
      2. Run \`npx @berdyh/bridge setup https://app.example.com --plan --json\`. Show its paths (including this app's work folder) and ask whether to install and run as a background service. Service is the default ([Y/n]); setup.service: "ask" always asks explicitly.
      3. On my install approval, run \`bridge self install --yes\`. Do not suppress its path list.
      4. Run \`bridge connect https://app.example.com --yes --open --json\`; tell me to approve the device code on https://app.example.com's sign-in page and wait for completion.
      5. On my service approval, run \`bridge service install --yes\` and tell me the runner started (it also shows a desktop notification). Otherwise run \`bridge run\` in the background with my agreement.
      6. Run \`bridge enroll my-app --open --json\`. Wait for trust_request. Ask me to read the four EFF words from the page, then run \`bridge enroll approve my-app --words "<the four words I supplied>"\`. Never infer, invent or copy the terminal's words as my approval. A mismatch must not be approved.
      7. Run \`bridge status --json\` and report whether this browser is ready. Agent sessions use the per-app work folder; other projects need an explicit policy.json addition.
      The runner stops after 15 minutes with no app browser connected. If the runner is offline, open bridge://run to restart it in a terminal, or paste \`bridge run\`.",
        "flavor": "agent",
        "oneLiner": "npx @berdyh/bridge setup https://app.example.com",
        "steps": [
          "Paste \`npx @berdyh/bridge setup https://app.example.com\` into a terminal to set up My App (https://app.example.com).",
          "Read the exact install and work-folder paths before consenting. Approve the device code on the app's sign-in page.",
          "The runner runs as a background service by default ([Y/n]); choose no for foreground use. Set setup.service to "ask" to always choose explicitly.",
          "On the enroll page, click to pair this browser. Compare its four EFF words with the terminal's words and approve only if all four match.",
          "Wait for ready. Agent sessions start in this app's work folder; add other project folders explicitly to policy.json.",
          "The runner notifies you when it starts and stops after 15 minutes without any app's browser connected.",
          "If the runner is offline, open bridge://run to restart it in a terminal, or paste \`bridge run\`.",
        ],
        "troubleshooting": [
          {
            "fix": "Run \`npx @berdyh/bridge setup https://app.example.com\`. Install Node.js 22 or later and an agent with its login if doctor reports either missing.",
            "problem": "No runner is known",
          },
          {
            "fix": "If the runner is offline, open bridge://run to restart it in a terminal, or paste \`bridge run\`.",
            "problem": "Runner offline",
          },
          {
            "fix": "Run \`bridge enroll my-app --open\`, click to pair, and compare all four words. A revoked browser needs fresh enrollment.",
            "problem": "Online but this browser is not enrolled",
          },
          {
            "fix": "Run \`bridge enroll my-app --open\` again. Codes expire after ten minutes; use the browser profile signed into this app.",
            "problem": "Enrollment expired or sign-in lost the link",
          },
          {
            "fix": "Paste \`bridge run\`, or rerun setup to register the Linux protocol handler after reviewing its paths.",
            "problem": "Restart link does not open a terminal",
          },
          {
            "fix": "Windows is unsupported. Use WSL2 and follow the Linux setup steps.",
            "problem": "Windows",
          },
          {
            "fix": "Run \`bridge doctor --json\` and review its reported prerequisites and paths.",
            "problem": "Setup or agent login failed",
          },
        ],
      }
    `);
  });
  it("agent macOS copy", () => {
    expect(setupInstructions({ ...base, flavor: "agent", platform: "darwin" })).toMatchInlineSnapshot(`
      {
        "agentPrompt": "Set up the local bridge runner for My App (https://app.example.com) on this machine.
      Use only the bridge CLI via \`npx @berdyh/bridge\`; never edit ~/.config, ~/.local or service files yourself.
      Show every exact path list and ask me before install or service writes and their --yes flags. The device-grant page confirms the app origin, so connect --yes is allowed. An agent passing --yes is not a human confirmation; the harness's command approval is an additional gate.
      1. Run \`npx @berdyh/bridge doctor --json\` and report Node version, agents and logins. If a prerequisite is missing, stop and tell me what to install or log into. Windows is unsupported; suggest WSL2.
      2. Run \`npx @berdyh/bridge setup https://app.example.com --plan --json\`. Show its paths (including this app's work folder) and ask whether to install and run as a background service. Service is the default ([Y/n]); setup.service: "ask" always asks explicitly.
      3. On my install approval, run \`bridge self install --yes\`. Do not suppress its path list.
      4. Run \`bridge connect https://app.example.com --yes --open --json\`; tell me to approve the device code on https://app.example.com's sign-in page and wait for completion.
      5. On my service approval, run \`bridge service install --yes\` and tell me the runner started (it also shows a desktop notification). Otherwise run \`bridge run\` in the background with my agreement.
      6. Run \`bridge enroll my-app --open --json\`. Wait for trust_request. Ask me to read the four EFF words from the page, then run \`bridge enroll approve my-app --words "<the four words I supplied>"\`. Never infer, invent or copy the terminal's words as my approval. A mismatch must not be approved.
      7. Run \`bridge status --json\` and report whether this browser is ready. Agent sessions use the per-app work folder; other projects need an explicit policy.json addition.
      The runner stops after 15 minutes with no app browser connected. If the runner is offline, paste \`bridge run\` into a terminal to restart it.",
        "flavor": "agent",
        "oneLiner": "npx @berdyh/bridge setup https://app.example.com",
        "steps": [
          "Paste \`npx @berdyh/bridge setup https://app.example.com\` into a terminal to set up My App (https://app.example.com).",
          "Read the exact install and work-folder paths before consenting. Approve the device code on the app's sign-in page.",
          "The runner runs as a background service by default ([Y/n]); choose no for foreground use. Set setup.service to "ask" to always choose explicitly.",
          "On the enroll page, click to pair this browser. Compare its four EFF words with the terminal's words and approve only if all four match.",
          "Wait for ready. Agent sessions start in this app's work folder; add other project folders explicitly to policy.json.",
          "The runner notifies you when it starts and stops after 15 minutes without any app's browser connected.",
          "If the runner is offline, paste \`bridge run\` into a terminal to restart it.",
        ],
        "troubleshooting": [
          {
            "fix": "Run \`npx @berdyh/bridge setup https://app.example.com\`. Install Node.js 22 or later and an agent with its login if doctor reports either missing.",
            "problem": "No runner is known",
          },
          {
            "fix": "If the runner is offline, paste \`bridge run\` into a terminal to restart it.",
            "problem": "Runner offline",
          },
          {
            "fix": "Run \`bridge enroll my-app --open\`, click to pair, and compare all four words. A revoked browser needs fresh enrollment.",
            "problem": "Online but this browser is not enrolled",
          },
          {
            "fix": "Run \`bridge enroll my-app --open\` again. Codes expire after ten minutes; use the browser profile signed into this app.",
            "problem": "Enrollment expired or sign-in lost the link",
          },
          {
            "fix": "macOS uses the paste fallback: \`bridge run\`.",
            "problem": "Restart link does not open a terminal",
          },
          {
            "fix": "Windows is unsupported. Use WSL2 and follow the Linux setup steps.",
            "problem": "Windows",
          },
          {
            "fix": "Run \`bridge doctor --json\` and review its reported prerequisites and paths.",
            "problem": "Setup or agent login failed",
          },
        ],
      }
    `);
  });
  it("is pure with a deterministic platform default and supports callers without appId", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const withoutId = { appUrl: base.appUrl, appName: base.appName, flavor: "agent" as const };
    const result = setupInstructions(withoutId);
    expect(result).toEqual(setupInstructions({ ...withoutId, platform: "linux" }));
    expect(result.agentPrompt).toContain("bridge enroll https://app.example.com --open --json");
  });
  it("quotes shell metacharacters in URL paths", () => {
    const result = setupInstructions({ ...base, appUrl: "https://app.example/it's-$(touch-pwned)", flavor: "human" });
    expect(result.oneLiner).toBe(`npx @berdyh/bridge setup 'https://app.example/it'"'"'s-$(touch-pwned)'`);
  });
  it.each(["javascript:alert(1)", "https://user:password@app.example", "https://app.example/#code=SECRET", "https://app.example/?code=SECRET", "http://app.example"])("rejects unsafe app URL %s", (appUrl) => {
    expect(() => setupInstructions({ ...base, appUrl, flavor: "human" })).toThrow("appUrl");
  });
  describe("pinned CLI", () => {
    const pinned = { ...base, cliVersion: "0.1.1", registry: "http://127.0.0.1:4873" };
    const cli = "npx --registry http://127.0.0.1:4873 @berdyh/bridge@0.1.1";
    it("emits the pinned command in the one-liner, every step and the troubleshooting", () => {
      const result = setupInstructions({ ...pinned, flavor: "human" });
      expect(result.oneLiner).toBe(`${cli} setup https://app.example.com`);
      expect(result.steps[0]).toContain(`\`${cli} setup https://app.example.com\``);
      expect(result.troubleshooting[0]?.fix).toContain(`\`${cli} setup https://app.example.com\``);
      const text = JSON.stringify(result);
      expect(text).not.toMatch(/npx @berdyh\/bridge/);
      expect(text).not.toMatch(/npx (?!--registry http:\/\/127\.0\.0\.1:4873 @berdyh\/bridge@0\.1\.1)/);
    });
    it("emits the pinned command in every agent step", () => {
      const prompt = setupInstructions({ ...pinned, flavor: "agent" }).agentPrompt ?? "";
      expect(prompt).toContain(`Use only the bridge CLI via \`${cli}\``);
      expect(prompt).toContain(`Run \`${cli} doctor --json\``);
      expect(prompt).toContain(`Run \`${cli} setup https://app.example.com --plan --json\``);
      expect(prompt).not.toMatch(/npx (?!--registry http:\/\/127\.0\.0\.1:4873 @berdyh\/bridge@0\.1\.1)/);
    });
    it("pins every bridge command of every flavor and platform, the install step included", () => {
      for (const flavor of ["human", "agent"] as const) {
        for (const platform of ["linux", "darwin"] as const) {
          const result = setupInstructions({ ...pinned, flavor, platform });
          const spans = [...JSON.stringify(result).matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? "");
          // A bare `bridge ...` is not on PATH before the install step runs.
          expect(spans.filter((span) => /^bridge\b/.test(span)), `${flavor}/${platform}`).toEqual([]);
          expect(spans.filter((span) => span.startsWith("npx ") && !span.startsWith(cli))).toEqual([]);
        }
      }
      const prompt = setupInstructions({ ...pinned, flavor: "agent" }).agentPrompt ?? "";
      expect(prompt).toContain(`3. On my install approval, run \`${cli} self install --yes\`.`);
      expect(prompt).toContain(`\`${cli} service install --yes\``);
      expect(prompt).toContain(`\`${cli} status --json\``);
    });
    it("pins the version alone or the registry alone", () => {
      expect(setupInstructions({ ...base, cliVersion: "0.1.1", flavor: "human" }).oneLiner).toBe("npx @berdyh/bridge@0.1.1 setup https://app.example.com");
      expect(setupInstructions({ ...base, registry: "http://127.0.0.1:4873", flavor: "human" }).oneLiner).toBe("npx --registry http://127.0.0.1:4873 @berdyh/bridge setup https://app.example.com");
    });
    it("leaves the output unchanged without options", () => {
      expect(setupInstructions({ ...base, flavor: "human" }).oneLiner).toBe("npx @berdyh/bridge setup https://app.example.com");
    });
    it("quotes the registry and rejects an unsafe version or registry", () => {
      expect(setupInstructions({ ...base, registry: "https://r.example/a b", flavor: "human" }).oneLiner).toContain("--registry 'https://r.example/a b' ");
      expect(() => setupInstructions({ ...base, cliVersion: "1.0.0; rm -rf ~", flavor: "human" })).toThrow("cliVersion");
      expect(() => setupInstructions({ ...base, registry: "file:///etc", flavor: "human" })).toThrow("registry");
    });
  });
});

describe("wordsOf re-export", () => {
  it("is importable from the client package with its type", () => {
    const words: EnrollWords = wordsOf("key-id");
    expect(words).toHaveLength(4);
  });
});
