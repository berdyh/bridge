import { lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appPathsOf } from "../paths.js";

import { type PermissionRequestInfo, SESSION_BUDGET_CEILING } from "./contracts.js";
import { createLocalPolicy } from "./policy.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-policy-"));
  await mkdir(path.join(root, "home/project"), { recursive: true });
  await mkdir(path.join(root, "outside"), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const OPTIONS = [
  { optionId: "always", name: "Always", kind: "allow_always" },
  { optionId: "once", name: "Once", kind: "allow_once" },
  { optionId: "no", name: "No", kind: "reject_once" },
];

function request(over: Partial<PermissionRequestInfo> = {}): PermissionRequestInfo {
  return {
    appId: "app",
    agentId: "claude",
    sessionId: "s",
    cwd: path.join(root, "home/project"),
    origin: { kind: "browser", channelId: "c", browserKeyId: "k" },
    toolCallId: "t",
    options: OPTIONS,
    ...over,
  };
}

describe("allowSession", () => {
  it("allows only configured agents and directories under the allowed roots", async () => {
    const home = path.join(root, "home");
    const policy = createLocalPolicy({ homedir: home, agents: ["claude"] });
    const ok = { appId: "a", agentId: "claude", cwd: path.join(home, "project") };
    expect(await policy.allowSession(ok)).toBe(true);
    expect(await policy.allowSession({ ...ok, agentId: "codex" })).toBe(false);
    expect(await policy.allowSession({ ...ok, cwd: path.join(root, "outside") })).toBe(false);
    expect(await policy.allowSession({ ...ok, cwd: "relative/dir" })).toBe(false);
    expect(await policy.allowSession({ ...ok, cwd: `${home}/../outside` })).toBe(false);
  });

  it("does not let a symlink inside an allowed root lead out of it", async () => {
    const home = path.join(root, "home");
    await symlink(path.join(root, "outside"), path.join(home, "link"));
    const policy = createLocalPolicy({ homedir: home });
    expect(await policy.allowSession({ appId: "a", agentId: "claude", cwd: path.join(home, "link") })).toBe(false);
  });

  it("does not let a not-yet-existing path under a symlinked directory lead out of the root", async () => {
    const home = path.join(root, "home");
    await symlink(path.join(root, "outside"), path.join(home, "link"));
    const policy = createLocalPolicy({ homedir: home });
    expect(await policy.allowSession({ appId: "a", agentId: "claude", cwd: path.join(home, "link/new/dir") })).toBe(false);
  });

  it("honours allowedCwds in place of the home default; an empty agent list means all", async () => {
    const policy = createLocalPolicy({ homedir: path.join(root, "home"), allowedCwds: [path.join(root, "outside")], agents: [] });
    expect(await policy.allowSession({ appId: "a", agentId: "codex", cwd: path.join(root, "outside") })).toBe(true);
    expect(await policy.allowSession({ appId: "a", agentId: "codex", cwd: path.join(root, "home/project") })).toBe(false);
  });
});

describe("allowedTools", () => {
  const policy = createLocalPolicy({ allowedTools: ["Bash", "mcp__srv__read"] });

  it("matches the tool name exactly and selects allow_once, never allow_always", async () => {
    expect(await policy.decidePermission(request({ toolName: "Bash" }))).toEqual({ action: "select", optionId: "once" });
    expect(await policy.decidePermission(request({ toolName: "mcp__srv__read" }))).toEqual({ action: "select", optionId: "once" });
  });

  it("is case sensitive and has no prefix or title matching", async () => {
    expect(await policy.decidePermission(request({ toolName: "bash" }))).toEqual({ action: "ask" });
    expect(await policy.decidePermission(request({ toolName: "Bash2" }))).toEqual({ action: "ask" });
    expect(await policy.decidePermission(request({ toolName: "mcp__srv__write" }))).toEqual({ action: "ask" });
    expect(await policy.decidePermission(request({ title: "Bash" }))).toEqual({ action: "ask" });
  });

  it("never matches a request without a toolName", async () => {
    expect(await policy.decidePermission(request())).toEqual({ action: "ask" });
    expect(await policy.decidePermission(request({ toolName: undefined, toolKind: "execute" }))).toEqual({ action: "ask" });
  });

  it("asks when the agent offered no allow_once option", async () => {
    const decision = await policy.decidePermission(
      request({ toolName: "Bash", options: [{ optionId: "always", name: "A", kind: "allow_always" }] }),
    );
    expect(decision).toEqual({ action: "ask" });
  });
});

describe("modes", () => {
  const cwd = () => path.join(root, "home/project");

  it("defaults to ask and has no bypass", async () => {
    const policy = createLocalPolicy({});
    expect(policy.mode).toBe("ask");
    expect(await policy.decidePermission(request({ toolKind: "read" }))).toEqual({ action: "ask" });
  });

  it("read-only allows reads in the session directory, rejects writes and execution, asks otherwise", async () => {
    const policy = createLocalPolicy({ mode: "read-only" });
    const inside = [{ path: path.join(cwd(), "a.txt") }];
    expect(await policy.decidePermission(request({ toolKind: "read", locations: inside }))).toEqual({ action: "select", optionId: "once" });
    expect(await policy.decidePermission(request({ toolKind: "read", locations: [{ path: "/etc/passwd" }] }))).toEqual({ action: "ask" });
    expect(await policy.decidePermission(request({ toolKind: "read", locations: [{ path: `${cwd()}/../outside/x` }] }))).toEqual({ action: "ask" });
    expect(await policy.decidePermission(request({ toolKind: "read" }))).toEqual({ action: "ask" });
    expect(await policy.decidePermission(request({ toolKind: "search", locations: [] }))).toEqual({ action: "ask" });
    expect(await policy.decidePermission(request({ toolKind: "think" }))).toEqual({ action: "select", optionId: "once" });
    expect(await policy.decidePermission(request({ toolKind: "edit", locations: inside }))).toEqual({ action: "select", optionId: "no" });
    expect(await policy.decidePermission(request({ toolKind: "execute" }))).toEqual({ action: "select", optionId: "no" });
    expect(await policy.decidePermission(request({ toolKind: "execute", options: [OPTIONS[1]!] }))).toEqual({ action: "cancel" });
    expect(await policy.decidePermission(request({ toolKind: "fetch" }))).toEqual({ action: "ask" });
  });

  it("accept-edits adds edits inside the session directory and still asks for execution", async () => {
    const policy = createLocalPolicy({ mode: "accept-edits" });
    const inside = [{ path: path.join(cwd(), "a.txt") }];
    expect(await policy.decidePermission(request({ toolKind: "edit", locations: inside }))).toEqual({ action: "select", optionId: "once" });
    expect(await policy.decidePermission(request({ toolKind: "edit" }))).toEqual({ action: "ask" });
    expect(await policy.decidePermission(request({ toolKind: "edit", locations: [{ path: "/etc/hosts" }] }))).toEqual({ action: "ask" });
    expect(await policy.decidePermission(request({ toolKind: "execute" }))).toEqual({ action: "ask" });
  });

  it("does not treat a new path under a symlink that leads out of the session directory as inside it", async () => {
    await symlink(path.join(root, "outside"), path.join(cwd(), "link"));
    await symlink(path.join(root, "nowhere"), path.join(cwd(), "dangling"));
    const edit = createLocalPolicy({ mode: "accept-edits" });
    const read = createLocalPolicy({ mode: "read-only" });
    for (const p of ["link/new.txt", "link/missing/x", "link", "dangling/new.txt", "dangling"]) {
      const locations = [{ path: path.join(cwd(), p) }];
      expect(await edit.decidePermission(request({ toolKind: "edit", locations }))).toEqual({ action: "ask" });
      expect(await read.decidePermission(request({ toolKind: "read", locations }))).toEqual({ action: "ask" });
    }
    // A new file in a real directory of the session is still fine.
    const fresh = [{ path: path.join(cwd(), "new/deeper/x.txt") }];
    expect(await edit.decidePermission(request({ toolKind: "edit", locations: fresh }))).toEqual({ action: "select", optionId: "once" });
  });

  it("bypass, set only in local config, allows once", async () => {
    const policy = createLocalPolicy({ mode: "bypass" });
    expect(await policy.decidePermission(request({ toolKind: "execute" }))).toEqual({ action: "select", optionId: "once" });
  });
});

describe("protected locations", () => {
  const home = () => path.join(root, "home");
  const protectedPaths = [
    ".config/bridge/policy.json",
    ".config/bridge/apps.json",
    ".local/share/bridge/plugins/x/manifest.json",
    ".local/state/bridge/runner.log",
    ".config/systemd/user/bridge-runner.service",
    ".ssh/id_ed25519",
    ".gnupg/private-keys-v1.d/k",
    ".aws/credentials",
    ".config/gh/hosts.yml",
    ".claude/.credentials.json",
    ".codex/auth.json",
    ".netrc",
    ".bashrc",
    ".zshrc",
    ".profile",
  ];
  // A session directory that contains the whole home but is not the home itself.
  const wide = () => root;

  it("never auto-approves reads or edits of the runner's dirs, credential dirs or rc files", async () => {
    for (const mode of ["read-only", "accept-edits"] as const) {
      const policy = createLocalPolicy({ mode, homedir: home() });
      for (const rel of protectedPaths) {
        const locations = [{ path: path.join(home(), rel) }];
        expect(await policy.decidePermission(request({ cwd: wide(), toolKind: "read", locations })), `${mode} read ${rel}`).toEqual({ action: "ask" });
      }
    }
    const edit = createLocalPolicy({ mode: "accept-edits", homedir: home() });
    for (const rel of protectedPaths) {
      const locations = [{ path: path.join(home(), rel) }];
      expect(await edit.decidePermission(request({ cwd: wide(), toolKind: "edit", locations })), `edit ${rel}`).toEqual({ action: "ask" });
    }
    // Control: an unprotected file under the same session directory is still approved.
    const ok = [{ path: path.join(home(), "project/a.txt") }];
    expect(await edit.decidePermission(request({ cwd: wide(), toolKind: "edit", locations: ok }))).toEqual({ action: "select", optionId: "once" });
  });

  it("asks when the session directory is itself inside a protected location", async () => {
    const cwd = path.join(home(), ".claude/proj");
    await mkdir(cwd, { recursive: true });
    const policy = createLocalPolicy({ mode: "accept-edits", homedir: home() });
    const locations = [{ path: path.join(cwd, "f") }];
    expect(await policy.decidePermission(request({ cwd, toolKind: "read", locations }))).toEqual({ action: "ask" });
    expect(await policy.decidePermission(request({ cwd, toolKind: "edit", locations }))).toEqual({ action: "ask" });
  });

  it("protects extra configured paths (non-default XDG dirs)", async () => {
    const custom = path.join(root, "xdg/bridge");
    await mkdir(custom, { recursive: true });
    const policy = createLocalPolicy({ mode: "accept-edits", homedir: home(), protectedPaths: [custom] });
    const locations = [{ path: path.join(custom, "policy.json") }];
    expect(await policy.decidePermission(request({ cwd: wide(), toolKind: "edit", locations }))).toEqual({ action: "ask" });
  });

  it("protects through a symlink that points into a protected directory", async () => {
    await mkdir(path.join(home(), ".ssh"), { recursive: true });
    await symlink(path.join(home(), ".ssh"), path.join(home(), "keys"));
    const policy = createLocalPolicy({ mode: "read-only", homedir: home() });
    const locations = [{ path: path.join(home(), "keys/id_ed25519") }];
    expect(await policy.decidePermission(request({ cwd: wide(), toolKind: "read", locations }))).toEqual({ action: "ask" });
  });

  it("gives no shortcut when the session directory is the home directory itself", async () => {
    await mkdir(home(), { recursive: true });
    const locations = [{ path: path.join(home(), "notes.txt") }];
    for (const mode of ["read-only", "accept-edits"] as const) {
      const policy = createLocalPolicy({ mode, homedir: home() });
      expect(await policy.decidePermission(request({ cwd: home(), toolKind: "read", locations }))).toEqual({ action: "ask" });
      expect(await policy.decidePermission(request({ cwd: home(), toolKind: "think" }))).toEqual({ action: "ask" });
    }
    const edit = createLocalPolicy({ mode: "accept-edits", homedir: home() });
    expect(await edit.decidePermission(request({ cwd: home(), toolKind: "edit", locations }))).toEqual({ action: "ask" });
    // A subdirectory of home still gets the shortcut.
    const sub = [{ path: path.join(home(), "project/a.txt") }];
    expect(await edit.decidePermission(request({ toolKind: "edit", locations: sub }))).toEqual({ action: "select", optionId: "once" });
  });

  it("resolves `..` after a symlink with filesystem semantics", async () => {
    // project/keys -> ~/.ssh/sub, so project/keys/../config is ~/.ssh/config.
    await mkdir(path.join(home(), ".ssh/sub"), { recursive: true });
    await mkdir(path.join(home(), "project"), { recursive: true });
    await symlink(path.join(home(), ".ssh/sub"), path.join(home(), "project/keys"));
    const cwd = path.join(home(), "project");
    const locations = [{ path: `${cwd}/keys/../config` }];
    for (const mode of ["read-only", "accept-edits"] as const) {
      const policy = createLocalPolicy({ mode, homedir: home() });
      expect(await policy.decidePermission(request({ cwd, toolKind: "read", locations }))).toEqual({ action: "ask" });
    }
    const edit = createLocalPolicy({ mode: "accept-edits", homedir: home() });
    expect(await edit.decidePermission(request({ cwd, toolKind: "edit", locations }))).toEqual({ action: "ask" });
    // `..` after a component that does not exist is ambiguous: ask.
    const missing = [{ path: `${cwd}/nope/../a.txt` }];
    expect(await edit.decidePermission(request({ cwd, toolKind: "edit", locations: missing }))).toEqual({ action: "ask" });
  });

  it("asks when a protected root lies inside the target (a recursive search of an ancestor)", async () => {
    await mkdir(path.join(home(), ".config/gh"), { recursive: true });
    const cwd = path.join(home(), ".config");
    for (const mode of ["read-only", "accept-edits"] as const) {
      const policy = createLocalPolicy({ mode, homedir: home() });
      expect(await policy.decidePermission(request({ cwd, toolKind: "search", locations: [{ path: cwd }] }))).toEqual({ action: "ask" });
      expect(await policy.decidePermission(request({ cwd, toolKind: "read", locations: [{ path: path.join(cwd, "other.txt") }] }))).toEqual({ action: "select", optionId: "once" });
    }
  });

  it("checks paths in rawInput as well as locations", async () => {
    const cwd = path.join(home(), "project");
    await mkdir(cwd, { recursive: true });
    const edit = createLocalPolicy({ mode: "accept-edits", homedir: home() });
    const locations = [{ path: path.join(cwd, "a.txt") }];
    const decide = (rawInput: unknown, toolKind = "edit") => edit.decidePermission(request({ cwd, toolKind, locations, rawInput }));
    expect(await decide({ file_path: path.join(cwd, "a.txt"), content: "x" })).toEqual({ action: "select", optionId: "once" });
    expect(await decide({ file_path: path.join(home(), ".ssh/config") })).toEqual({ action: "ask" });
    expect(await decide({ edits: [{ path: "~/.ssh/config" }] })).toEqual({ action: "ask" });
    expect(await decide({ uri: `file://${path.join(home(), ".bashrc")}` })).toEqual({ action: "ask" });
    expect(await decide({ file_path: "../.zshrc" })).toEqual({ action: "ask" });
    expect(await decide({ paths: [path.join(cwd, "a.txt"), path.join(root, "outside/x")] })).toEqual({ action: "ask" });
    expect(await decide({ file_path: "file:///%zz" })).toEqual({ action: "ask" });
    expect(await decide({ path: "" , note: "plain text"})).toEqual({ action: "select", optionId: "once" });
    // No locations at all: ask.
    expect(await edit.decidePermission(request({ cwd, toolKind: "edit", rawInput: { file_path: path.join(cwd, "a.txt") } }))).toEqual({ action: "ask" });
  });

  describe("fail-closed resolution", () => {
    const decide = async (mode: "read-only" | "accept-edits", cwd: string, toolKind: string, locations: { path: string }[], rawInput?: unknown) =>
      createLocalPolicy({ mode, homedir: home() }).decidePermission(request({ cwd, toolKind, locations, rawInput }));
    const ASK = { action: "ask" };

    it("rawInput `keys/../config` through the symlink, relative, absolute and tilde", async () => {
      await mkdir(path.join(home(), ".ssh/sub"), { recursive: true });
      await mkdir(path.join(home(), "project"), { recursive: true });
      await symlink(path.join(home(), ".ssh/sub"), path.join(home(), "project/keys"));
      const cwd = path.join(home(), "project");
      const loc = [{ path: path.join(cwd, "a.txt") }];
      for (const file_path of ["keys/../config", `${cwd}/keys/../config`, "~/project/keys/../config"]) {
        expect(await decide("accept-edits", cwd, "edit", loc, { file_path }), file_path).toEqual(ASK);
        expect(await decide("read-only", cwd, "read", loc, { nested: [[file_path]] }), file_path).toEqual(ASK);
      }
    });

    it("a backslash anywhere in a candidate asks, including a symlink named `literal\\alias`", async () => {
      await mkdir(path.join(home(), ".ssh"), { recursive: true });
      await mkdir(path.join(home(), "project"), { recursive: true });
      const cwd = path.join(home(), "project");
      await symlink(path.join(home(), ".ssh"), path.join(cwd, "literal\\alias"));
      const loc = [{ path: path.join(cwd, "a.txt") }];
      expect(await decide("accept-edits", cwd, "edit", loc, { file_path: "literal\\alias/config" })).toEqual(ASK);
      expect(await decide("accept-edits", cwd, "edit", loc, { file_path: "..\\x" })).toEqual(ASK);
      expect(await decide("accept-edits", cwd, "edit", [{ path: path.join(cwd, "literal\\alias/config") }])).toEqual(ASK);
    });

    it("compares protected roots and home case-insensitively", async () => {
      await mkdir(path.join(home(), "project"), { recursive: true });
      const loc = [{ path: path.join(home(), "project/a.txt") }];
      expect(await decide("accept-edits", root, "edit", loc)).toEqual({ action: "select", optionId: "once" });
      expect(await decide("accept-edits", root, "edit", loc, { file_path: "~/.SSH/config" })).toEqual(ASK);
      expect(await decide("accept-edits", root, "edit", loc, { file_path: `${root}/HOME/.ssh/config` })).toEqual(ASK);
      expect(await decide("accept-edits", root, "edit", loc, { file_path: `${root}/home/.Bashrc` })).toEqual(ASK);
      // The session in a differently-cased home is the home itself.
      expect(await decide("accept-edits", home().toUpperCase(), "edit", [{ path: path.join(home().toUpperCase(), "x") }])).toEqual(ASK);
      expect(await decide("accept-edits", home(), "edit", loc)).toEqual(ASK);
    });

    it("decodes file: URIs (any case, percent escapes, single slash) and asks when decoding throws", async () => {
      const loc = [{ path: path.join(home(), "project/a.txt") }];
      for (const uri of [`FILE://${home()}/.ssh/%63onfig`, `file:${home()}/.ssh/config`, `File://${home()}/.%73sh/config`, "file:///a%2Fb"]) {
        expect(await decide("accept-edits", root, "edit", loc, { uri }), uri).toEqual(ASK);
      }
      // Other schemes are not paths.
      expect(await decide("accept-edits", root, "edit", loc, { url: "https://example.com/.ssh/config" })).toEqual({ action: "select", optionId: "once" });
    });

    it("finds candidates in arrays at any position", async () => {
      await mkdir(path.join(home(), ".config/gh"), { recursive: true });
      const cwd = path.join(home(), ".config");
      const loc = [{ path: path.join(cwd, "other.txt") }];
      expect(await decide("read-only", cwd, "read", loc, [["gh/hosts.yml"]])).toEqual(ASK);
      expect(await decide("read-only", cwd, "read", loc, { a: [{ b: [["gh/hosts.yml"]] }] })).toEqual(ASK);
    });

    it("asks quickly for absurd paths and for too many candidates", async () => {
      const cwd = path.join(home(), "project");
      await mkdir(cwd, { recursive: true });
      const huge = "/" + "a/".repeat(20_000);
      const started = performance.now();
      expect(await decide("read-only", cwd, "read", [{ path: huge }])).toEqual(ASK);
      expect(await decide("read-only", cwd, "read", [{ path: path.join(cwd, "a.txt") }], { file_path: huge.slice(1) })).toEqual(ASK);
      expect(await decide("read-only", cwd, "read", [{ path: `${cwd}/${"x".repeat(5000)}` }])).toEqual(ASK);
      expect(performance.now() - started).toBeLessThan(100);
      const many = Array.from({ length: 65 }, (_, n) => `${cwd}/f${n}`);
      expect(await decide("read-only", cwd, "read", [{ path: path.join(cwd, "a.txt") }], many)).toEqual(ASK);
      expect(await decide("read-only", cwd, "read", [{ path: path.join(cwd, "a.txt") }], many.slice(0, 10))).toEqual({ action: "select", optionId: "once" });
    });

    it("asks for a `..` after a missing component and for ~user", async () => {
      const cwd = path.join(home(), "project");
      await mkdir(cwd, { recursive: true });
      const loc = [{ path: path.join(cwd, "a.txt") }];
      expect(await decide("accept-edits", cwd, "edit", loc, { file_path: "missing/../a.txt" })).toEqual(ASK);
      expect(await decide("accept-edits", cwd, "edit", loc, { file_path: "~root/x" })).toEqual(ASK);
    });

    it("a protected file symlinked into the project is protected by its pathname (and every path seen in the walk)", async () => {
      const cwd = path.join(home(), "project");
      await mkdir(cwd, { recursive: true });
      await mkdir(path.join(home(), ".config/bridge"), { recursive: true });
      await mkdir(path.join(home(), ".ssh"), { recursive: true });
      await mkdir(path.join(home(), ".claude"), { recursive: true });
      await symlink(path.join(cwd, "policy.json"), path.join(home(), ".config/bridge/policy.json"));
      await symlink(path.join(cwd, "ssh-config"), path.join(home(), ".ssh/config"));
      await symlink(path.join(cwd, "creds.json"), path.join(home(), ".claude/.credentials.json"));
      for (const name of [".config/bridge/policy.json", ".ssh/config", ".claude/.credentials.json"]) {
        const abs = path.join(home(), name);
        for (const mode of ["read-only", "accept-edits"] as const) {
          // As a location, as an absolute path and as a tilde path in rawInput.
          expect(await decide(mode, cwd, mode === "read-only" ? "read" : "edit", [{ path: abs }]), name).toEqual(ASK);
          const loc = [{ path: path.join(cwd, "a.txt") }];
          expect(await decide(mode, cwd, mode === "read-only" ? "read" : "edit", loc, { file_path: abs }), name).toEqual(ASK);
          expect(await decide(mode, cwd, mode === "read-only" ? "read" : "edit", loc, { file_path: `~/${name}` }), name).toEqual(ASK);
        }
      }
      // A symlink in the project that leads through a protected pathname is caught by the walk.
      await symlink(path.join(home(), ".ssh"), path.join(cwd, "viaDir"));
      expect(await decide("read-only", cwd, "read", [{ path: path.join(cwd, "a.txt") }], { file_path: "viaDir/config" })).toEqual(ASK);
    });

    it("checks a non-file scheme as a relative path and skips only http(s) and ws(s)", async () => {
      const cwd = path.join(home(), "project");
      await mkdir(path.join(cwd, "vault:ssh"), { recursive: true });
      await mkdir(path.join(home(), ".ssh"), { recursive: true });
      await symlink(path.join(home(), ".ssh"), path.join(cwd, "vault:ssh/key"));
      const loc = [{ path: path.join(cwd, "a.txt") }];
      expect(await decide("accept-edits", cwd, "edit", loc, { file_path: "vault:ssh/key" })).toEqual(ASK);
      for (const url of ["https://x.test/.ssh/config", "HTTP://x.test/a", "wss://x.test/b", "ws://x.test/c"]) {
        expect(await decide("accept-edits", cwd, "edit", loc, { url }), url).toEqual({ action: "select", optionId: "once" });
      }
    });

    it("considers bare strings and object keys at any position, but not content strings", async () => {
      const cwd = path.join(home(), "project");
      await mkdir(cwd, { recursive: true });
      await symlink(path.join(home(), ".bashrc"), path.join(cwd, "rc"));
      const loc = [{ path: path.join(cwd, "a.txt") }];
      expect(await decide("accept-edits", cwd, "edit", loc, ["rc"])).toEqual(ASK);
      expect(await decide("accept-edits", cwd, "edit", loc, { edits: { [path.join(home(), ".bashrc")]: "new text" } })).toEqual(ASK);
      // Multi-line and long content, and many content strings, are not candidates and not counted.
      const content = Array.from({ length: 100 }, (_, n) => `line ${n} of ~/.bashrc`);
      expect(await decide("accept-edits", cwd, "edit", loc, { content: content.join("\n"), old_string: "a b", lines: content })).toEqual({ action: "select", optionId: "once" });
    });

    it("a session whose cwd is protected (or reaches a protected dir through a symlink) gets no shortcut", async () => {
      await mkdir(path.join(home(), ".ssh"), { recursive: true });
      await mkdir(path.join(home(), "project"), { recursive: true });
      await symlink(path.join(home(), "project"), path.join(home(), ".ssh/session"));
      for (const mode of ["read-only", "accept-edits"] as const) {
        // Empty think request in ~/.ssh, and project locations under a cwd that is a symlink in ~/.ssh.
        expect(await decide(mode, path.join(home(), ".ssh"), "think", [])).toEqual(ASK);
        const cwd = path.join(home(), ".ssh/session");
        const kind = mode === "read-only" ? "read" : "edit";
        expect(await decide(mode, cwd, kind, [{ path: path.join(home(), "project/a.txt") }])).toEqual(ASK);
        expect(await decide(mode, cwd, kind, [{ path: path.join(cwd, "a.txt") }])).toEqual(ASK);
      }
      // Control: an ordinary project cwd still gets the shortcut.
      expect(await decide("read-only", path.join(home(), "project"), "think", [])).toEqual({ action: "select", optionId: "once" });
    });

    it("protects the other standard user unit and environment dirs", async () => {
      for (const name of [".local/share/systemd/user/x.service", ".config/environment.d/10-x.conf", ".config/systemd/user/x.service"]) {
        expect(await decide("accept-edits", root, "edit", [{ path: path.join(home(), name) }]), name).toEqual(ASK);
      }
    });

    it("skips content keys: content that mentions protected paths, and many identifiers, do not ask or count", async () => {
      const cwd = path.join(home(), "project");
      await mkdir(cwd, { recursive: true });
      const loc = [{ path: path.join(cwd, "a.txt") }];
      const once = { action: "select", optionId: "once" };
      expect(await decide("accept-edits", cwd, "edit", loc, { file_path: path.join(cwd, "a.txt"), content: "~/.ssh/config" })).toEqual(once);
      expect(await decide("accept-edits", cwd, "edit", loc, { old_string: "~/.bashrc", new_string: "~/.bashrc" })).toEqual(once);
      const ids = Array.from({ length: 65 }, (_, n) => `ident${n}`);
      expect(await decide("accept-edits", cwd, "edit", loc, { lines: ids })).toEqual(once);
      expect(await decide("accept-edits", cwd, "edit", loc, { edits: [{ old_string: "/x/.ssh/config", new_string: "y" }] })).toEqual(once);
    });

    it("allows spaces in the value of a path-like key, but not control characters", async () => {
      const cwd = path.join(home(), "project");
      await mkdir(cwd, { recursive: true });
      const loc = [{ path: path.join(cwd, "a.txt") }];
      expect(await decide("accept-edits", cwd, "edit", loc, { file_path: path.join(cwd, "my notes.txt") })).toEqual({ action: "select", optionId: "once" });
      expect(await decide("accept-edits", cwd, "edit", loc, { file_path: `${cwd}/my\nnotes.txt` })).toEqual(ASK);
      expect(await decide("accept-edits", cwd, "edit", loc, { file_path: path.join(home(), ".ssh/my notes") })).toEqual(ASK);
    });

    it("scans a huge raw input lazily and asks at the node budget", async () => {
      const cwd = path.join(home(), "project");
      await mkdir(cwd, { recursive: true });
      const loc = [{ path: path.join(cwd, "a.txt") }];
      const big: Record<string, string> = {};
      for (let n = 0; n < 50_000; n++) big[`key${n}`] = "v";
      const policy = createLocalPolicy({ mode: "read-only", homedir: home() });
      const ask = (rawInput: unknown) => policy.decidePermission(request({ cwd, toolKind: "read", locations: loc, rawInput }));
      await ask({}); // resolves the protected roots once
      const started = performance.now();
      expect(await ask(big)).toEqual(ASK);
      expect(performance.now() - started).toBeLessThan(50);
      const huge = Array.from({ length: 300_000 }, () => "v");
      const t2 = performance.now();
      expect(await ask({ items: huge })).toEqual(ASK);
      expect(performance.now() - t2).toBeLessThan(50);
    });
  });
});

describe("per-app work and state folders (workDirOf and appStateDirOf)", () => {
  const home = () => path.join(root, "home");
  const base = () => ({ config: path.join(home(), ".config"), data: path.join(home(), ".local/share"), state: path.join(home(), ".local/state") });
  const paths = (id: string) => appPathsOf(base(), id);
  const SHORTCUT = { action: "select", optionId: "once" };
  const ASK = { action: "ask" };
  const all = ["app-a", "app-b"];
  /** What the CLI passes: every connected app's three bridge dirs. */
  const protectedDirs = () => all.flatMap((id) => [paths(id).configDir, paths(id).dataDir, paths(id).stateDir]);
  const make = (over: Partial<Parameters<typeof createLocalPolicy>[0]> = {}) =>
    createLocalPolicy({
      homedir: home(),
      workDirOf: (id) => paths(id).workDir,
      appStateDirOf: (id) => paths(id).stateDir,
      protectedPaths: protectedDirs(),
      ...over,
    });
  const ok = { appId: "app-a", agentId: "claude" };
  const ask = (policy: ReturnType<typeof make>, over: Partial<PermissionRequestInfo>) => policy.decidePermission(request({ appId: "app-a", ...over }));

  describe("allowSession", () => {
    it("admits the own work folder (created 0700 with its missing parents) and below, nothing else", async () => {
      const policy = make();
      const work = paths("app-a").workDir;
      expect(await policy.allowSession({ ...ok, cwd: work })).toBe(true);
      expect((await stat(work)).mode & 0o777).toBe(0o700);
      expect((await stat(paths("app-a").stateDir)).mode & 0o777).toBe(0o700);
      await mkdir(path.join(work, "proj/sub"), { recursive: true });
      expect(await policy.allowSession({ ...ok, cwd: path.join(work, "proj/sub") })).toBe(true);
      for (const cwd of [home(), path.join(home(), "project"), paths("app-a").stateDir, paths("app-a").tmpDir, paths("app-a").parents.state, paths("app-b").workDir, paths("app-a").configDir]) {
        expect(await policy.allowSession({ ...ok, cwd }), cwd).toBe(false);
      }
    });

    it("keeps each app in its own folder", async () => {
      const policy = make();
      expect(await policy.allowSession({ appId: "app-b", agentId: "claude", cwd: paths("app-a").workDir })).toBe(false);
      expect(await policy.allowSession({ appId: "app-b", agentId: "claude", cwd: paths("app-b").workDir })).toBe(true);
    });

    it("allows a symlinked <state>/<app> parent, and still confines to the work folder", async () => {
      const real = path.join(root, "real-state-a");
      await mkdir(real);
      await mkdir(base().state, { recursive: true });
      await symlink(real, paths("app-a").parents.state);
      const policy = make();
      expect(await policy.allowSession({ ...ok, cwd: paths("app-a").workDir })).toBe(true);
      expect(await policy.allowSession({ ...ok, cwd: path.join(real, "bridge/work") })).toBe(true);
      for (const cwd of [paths("app-a").stateDir, path.join(real, "bridge"), path.join(real, "bridge/tmp"), real]) {
        expect(await policy.allowSession({ ...ok, cwd }), cwd).toBe(false);
      }
    });

    it("admits nothing when bridge or work is a symlink", async () => {
      const policy = make();
      const a = paths("app-a");
      await mkdir(a.parents.state, { recursive: true });
      await mkdir(path.join(root, "outside/work"), { recursive: true });
      // bridge -> outside
      await symlink(path.join(root, "outside"), a.stateDir);
      for (const cwd of [a.workDir, a.stateDir, path.join(root, "outside/work")]) expect(await policy.allowSession({ ...ok, cwd }), cwd).toBe(false);
      await rm(a.stateDir);
      // work -> outside
      await mkdir(a.stateDir);
      await symlink(path.join(root, "outside/work"), a.workDir);
      for (const cwd of [a.workDir, a.stateDir, path.join(root, "outside/work")]) expect(await policy.allowSession({ ...ok, cwd }), cwd).toBe(false);
    });

    it("refuses a work folder that is not <stateDir>/work", async () => {
      const policy = make({ workDirOf: (id) => path.join(paths(id).stateDir, "elsewhere") });
      expect(await policy.allowSession({ ...ok, cwd: path.join(paths("app-a").stateDir, "elsewhere") })).toBe(false);
      const outside = make({ workDirOf: () => path.join(root, "outside/work") });
      expect(await outside.allowSession({ ...ok, cwd: path.join(root, "outside/work") })).toBe(false);
    });

    it("drops a configured root that touches the app's state folder, keeping its own work folder", async () => {
      const warnings: string[] = [];
      const work = paths("app-a").workDir;
      await mkdir(path.join(work, "proj"), { recursive: true });
      const policy = make({ allowedCwds: [paths("app-a").stateDir, work, path.join(home(), "project")], warn: (m) => warnings.push(m) });
      expect(await policy.allowSession({ ...ok, cwd: path.join(work, "proj") })).toBe(true);
      expect(await policy.allowSession({ ...ok, cwd: paths("app-a").tmpDir })).toBe(false);
      expect(await policy.allowSession({ ...ok, cwd: path.join(home(), "project") })).toBe(true);
      // one warning per admission that evaluated the dropped root; only the app's own work folder is silent
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.every((w) => w.includes("bridge state folder") && w.includes(paths("app-a").stateDir))).toBe(true);
    });

    it("with a broad allowedCwds, still keeps each app out of the other apps' folders and its own config dir", async () => {
      const warnings: string[] = [];
      const policy = make({ allowedCwds: [home()], warn: (m) => warnings.push(m) });
      const a = paths("app-a");
      const b = paths("app-b");
      await mkdir(b.workDir, { recursive: true });
      await mkdir(b.configDir, { recursive: true });
      await mkdir(a.configDir, { recursive: true });
      await mkdir(path.join(home(), "project"), { recursive: true });
      for (const cwd of [b.workDir, path.join(b.workDir, "proj"), b.stateDir, b.tmpDir, b.configDir, b.dataDir, a.configDir, a.stateDir, a.tmpDir, a.dataDir]) {
        expect(await policy.allowSession({ ...ok, cwd }), cwd).toBe(false);
      }
      await mkdir(path.join(a.workDir, "proj"), { recursive: true });
      for (const cwd of [a.workDir, path.join(a.workDir, "proj"), path.join(home(), "project")]) expect(await policy.allowSession({ ...ok, cwd }), cwd).toBe(true);
      // the other app is symmetric
      expect(await policy.allowSession({ appId: "app-b", agentId: "claude", cwd: b.workDir })).toBe(true);
      expect(await policy.allowSession({ appId: "app-b", agentId: "claude", cwd: a.workDir })).toBe(false);
      expect(warnings).toEqual([]);
    });

    it("drops a configured root inside another app's folders, and refuses a cwd reaching them through a link", async () => {
      const warnings: string[] = [];
      const b = paths("app-b");
      await mkdir(b.workDir, { recursive: true });
      await mkdir(path.join(home(), "project"), { recursive: true });
      await symlink(b.workDir, path.join(home(), "project/to-b"));
      const policy = make({ allowedCwds: [b.workDir, path.join(home(), "project")], warn: (m) => warnings.push(m) });
      expect(await policy.allowSession({ ...ok, cwd: b.workDir })).toBe(false);
      expect(await policy.allowSession({ ...ok, cwd: path.join(home(), "project/to-b") })).toBe(false);
      expect(await policy.allowSession({ ...ok, cwd: path.join(home(), "project") })).toBe(true);
      expect(warnings.some((w) => w.includes(JSON.stringify(b.workDir)))).toBe(true);
    });

    it("workDirOf without appStateDirOf is refused at creation: the state folder is its trust anchor", () => {
      expect(() => createLocalPolicy({ homedir: home(), workDirOf: (id) => paths(id).workDir })).toThrow(/workDirOf needs appStateDirOf/);
      expect(() => createLocalPolicy({ homedir: home(), appStateDirOf: (id) => paths(id).stateDir })).not.toThrow();
      expect(() => createLocalPolicy({ homedir: home() })).not.toThrow();
    });
  });

  describe("shortcuts", () => {
    beforeEach(async () => {
      for (const id of all) {
        await mkdir(path.join(paths(id).workDir, "proj"), { recursive: true });
        await mkdir(paths(id).tmpDir, { recursive: true });
        await mkdir(paths(id).configDir, { recursive: true });
        await writeFile(paths(id).trustFile, "{}");
      }
    });

    it("work inside the own work folder, for reads and, in accept-edits, edits", async () => {
      const work = paths("app-a").workDir;
      for (const mode of ["read-only", "accept-edits"] as const) {
        const policy = make({ mode });
        for (const cwd of [work, path.join(work, "proj")]) {
          expect(await ask(policy, { cwd, toolKind: "read", locations: [{ path: path.join(cwd, "a.txt") }] }), `${mode} ${cwd}`).toEqual(SHORTCUT);
          expect(await ask(policy, { cwd, toolKind: "think" })).toEqual(SHORTCUT);
        }
      }
      const edit = make({ mode: "accept-edits" });
      expect(await ask(edit, { cwd: work, toolKind: "edit", locations: [{ path: path.join(work, "proj/a.txt") }] })).toEqual(SHORTCUT);
      expect(await ask(edit, { cwd: work, toolKind: "execute" })).toEqual(ASK);
    });

    it("do not reach the rest of the app's state folder, nor another app's folders", async () => {
      const work = paths("app-a").workDir;
      const elsewhere = [
        path.join(paths("app-a").tmpDir, "x"),
        path.join(paths("app-a").stateDir, "runner-note"),
        path.join(paths("app-b").workDir, "proj/a.txt"),
        path.join(paths("app-b").tmpDir, "x"),
        paths("app-b").trustFile,
        paths("app-a").trustFile,
        path.join(paths("app-a").dataDir, "plugins/x"),
        path.join(paths("app-a").parents.state, "other-thing"),
      ];
      for (const mode of ["read-only", "accept-edits"] as const) {
        const policy = make({ mode });
        for (const target of elsewhere.slice(0, 7)) {
          expect(await ask(policy, { cwd: work, toolKind: "read", locations: [{ path: target }] }), `${mode} read ${target}`).toEqual(ASK);
          expect(await ask(policy, { cwd: work, toolKind: "read", locations: [{ path: path.join(work, "a") }], rawInput: { path: target } }), `${mode} raw ${target}`).toEqual(ASK);
        }
        expect(await ask(policy, { cwd: work, toolKind: "read", locations: [{ path: path.join(work, "..", "tmp", "x") }] })).toEqual(ASK);
      }
      const edit = make({ mode: "accept-edits" });
      for (const target of elsewhere.slice(0, 7)) expect(await ask(edit, { cwd: work, toolKind: "edit", locations: [{ path: target }] }), `edit ${target}`).toEqual(ASK);
    });

    it("keeps the app's own state folder protected without protectedPaths, and another app's folder only with it", async () => {
      const work = paths("app-a").workDir;
      const own = createLocalPolicy({ mode: "read-only", homedir: home(), workDirOf: (id) => paths(id).workDir, appStateDirOf: (id) => paths(id).stateDir });
      expect(await ask(own, { cwd: work, toolKind: "read", locations: [{ path: path.join(paths("app-a").tmpDir, "x") }] })).toEqual(ASK);
      expect(await ask(own, { cwd: work, toolKind: "read", locations: [{ path: path.join(work, "a") }] })).toEqual(SHORTCUT);
    });

    it("give a session started anywhere else in the app's folders nothing", async () => {
      for (const mode of ["read-only", "accept-edits"] as const) {
        const policy = make({ mode });
        for (const cwd of [paths("app-a").stateDir, paths("app-a").tmpDir, paths("app-a").configDir, paths("app-a").dataDir, paths("app-b").workDir]) {
          expect(await ask(policy, { cwd, toolKind: "read", locations: [{ path: path.join(cwd, "a") }] }), `${mode} ${cwd}`).toEqual(ASK);
          expect(await ask(policy, { cwd, toolKind: "think" }), `${mode} think ${cwd}`).toEqual(ASK);
        }
      }
    });

    it("never shortcut the machine-wide agent logins, even with no protectedPaths", async () => {
      const policy = createLocalPolicy({ mode: "read-only", homedir: home(), workDirOf: (id) => paths(id).workDir, appStateDirOf: (id) => paths(id).stateDir });
      const login = path.join(home(), ".config/bridge/agents/claude/credentials.json");
      expect(await ask(policy, { cwd: paths("app-a").workDir, toolKind: "read", locations: [{ path: login }] })).toEqual(ASK);
    });
  });
});

describe("contained plugin sessions", () => {
  const SET = ["mcp__srv__read", "mcp__srv__list"];
  const SELECT_ONCE = { action: "select", optionId: "once" };
  const SELECT_NO = { action: "select", optionId: "no" };
  const ASK = { action: "ask" };
  const CANCEL = { action: "cancel" };
  type Origin = PermissionRequestInfo["origin"];
  const contained = (over: Partial<Extract<Origin, { kind: "plugin" }>> = {}): Origin => ({ kind: "plugin", pluginId: "p", contained: true, headless: true, callsLeft: 3, allow: SET, ...over });
  const browser: Origin = { kind: "browser", channelId: "c", browserKeyId: "k" };
  /** A policy with a healthy audit log wired: with none wired a contained session is never approved. */
  const healthy = (config: Parameters<typeof createLocalPolicy>[0] = {}) => createLocalPolicy({ warn: () => {}, auditFailed: () => false, ...config });

  type Row = { name: string; config?: Parameters<typeof createLocalPolicy>[0]; origin: Origin; toolName?: string; options?: PermissionRequestInfo["options"]; expected: unknown };
  const rows: Row[] = [
    // The approval set, and nothing else, approves a contained session.
    { name: "in the set, machine ask", origin: contained(), toolName: "mcp__srv__read", expected: SELECT_ONCE },
    { name: "in the set, pluginApprovals true", config: { pluginApprovals: true }, origin: contained(), toolName: "mcp__srv__list", expected: SELECT_ONCE },
    { name: "in the set, machine bypass", config: { mode: "bypass" }, origin: contained(), toolName: "mcp__srv__read", expected: SELECT_ONCE },
    { name: "in the set, kill switch off", config: { pluginApprovals: false }, origin: contained(), toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "in the set, kill switch off, bypass", config: { pluginApprovals: false, mode: "bypass" }, origin: contained(), toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "in the set, no calls left", origin: contained({ callsLeft: 0 }), toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "in the set, a negative count", origin: contained({ callsLeft: -1 }), toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "in the set, callsLeft unknown", origin: contained({ callsLeft: undefined }), toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "in the set, callsLeft NaN", origin: contained({ callsLeft: Number.NaN }), toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "in the set, a fractional budget under 1", origin: contained({ callsLeft: 0.5 }), toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "in the set, a fractional budget over 1", origin: contained({ callsLeft: 1.5 }), toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "in the set, an infinite budget", origin: contained({ callsLeft: Number.POSITIVE_INFINITY }), toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "in the set, one call left", origin: contained({ callsLeft: 1 }), toolName: "mcp__srv__read", expected: SELECT_ONCE },
    { name: "in the set but the proxy gave no set", origin: contained({ allow: undefined }), toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "an empty set", origin: contained({ allow: [] }), toolName: "mcp__srv__read", expected: SELECT_NO },
    // Outside the set: rejected whatever the machine says.
    { name: "outside the set, machine ask", origin: contained(), toolName: "mcp__srv__write", expected: SELECT_NO },
    { name: "outside the set, machine bypass", config: { mode: "bypass" }, origin: contained(), toolName: "mcp__srv__write", expected: SELECT_NO },
    { name: "outside the set, machine allowedTools has it", config: { allowedTools: ["mcp__srv__write"] }, origin: contained(), toolName: "mcp__srv__write", expected: SELECT_NO },
    { name: "outside the set, allowedTools and bypass", config: { allowedTools: ["Bash"], mode: "bypass" }, origin: contained(), toolName: "Bash", expected: SELECT_NO },
    { name: "outside the set, read-only mode", config: { mode: "read-only" }, origin: contained(), toolName: "Read", expected: SELECT_NO },
    { name: "another server's tool", origin: contained(), toolName: "mcp__other__read", expected: SELECT_NO },
    { name: "a case variant of a tool in the set", origin: contained(), toolName: "mcp__srv__Read", expected: SELECT_NO },
    { name: "no tool name, bypass", config: { mode: "bypass" }, origin: contained(), expected: SELECT_NO },
    { name: "a built-in in a (corrupt) set is not an mcp name, so it is not approved", origin: contained({ allow: ["Bash"] }), toolName: "Bash", expected: SELECT_NO },
    // The options offered.
    { name: "in the set, no allow_once offered", origin: contained(), toolName: "mcp__srv__read", options: [{ optionId: "no", name: "No", kind: "reject_once" }], expected: SELECT_NO },
    { name: "in the set, only allow_always offered", origin: contained(), toolName: "mcp__srv__read", options: [{ optionId: "always", name: "Always", kind: "allow_always" }], expected: CANCEL },
    { name: "outside the set, no reject option", origin: contained(), toolName: "Bash", options: [{ optionId: "once", name: "Once", kind: "allow_once" }], expected: CANCEL },
    // Not contained: today's rules, and the set is not an approval.
    { name: "plugin, not contained, machine ask", origin: { kind: "plugin", pluginId: "p" }, toolName: "mcp__srv__read", expected: ASK },
    { name: "plugin, contained false, machine ask", origin: { kind: "plugin", pluginId: "p", contained: false }, toolName: "mcp__srv__read", expected: ASK },
    // Signs of a contained session without the flag: rejected, never the machine's rules.
    { name: "plugin, flag missing but an approval set, machine ask", origin: { kind: "plugin", pluginId: "p", allow: SET }, toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "plugin, flag missing but a call budget, machine ask", origin: { kind: "plugin", pluginId: "p", callsLeft: 3 }, toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "plugin, flag missing but a budget of 0", origin: { kind: "plugin", pluginId: "p", callsLeft: 0 }, toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "plugin, contained false but a set and a budget, machine ask", origin: { kind: "plugin", pluginId: "p", contained: false, allow: SET, callsLeft: 3 }, toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "plugin, flag missing, set, allowedTools has the tool", config: { allowedTools: ["mcp__srv__read"] }, origin: { kind: "plugin", pluginId: "p", allow: SET, callsLeft: 3 }, toolName: "mcp__srv__read", expected: SELECT_NO },
    { name: "plugin, flag missing, set, machine bypass", config: { mode: "bypass" }, origin: { kind: "plugin", pluginId: "p", allow: SET, callsLeft: 3 }, toolName: "Bash", expected: SELECT_NO },
    { name: "plugin, flag missing, set, no reject option", config: { mode: "bypass" }, origin: { kind: "plugin", pluginId: "p", allow: SET }, toolName: "Bash", options: [{ optionId: "once", name: "Once", kind: "allow_once" }], expected: CANCEL },
    { name: "plugin, flag missing, an empty set and no budget is a plain plugin session", config: { mode: "bypass" }, origin: { kind: "plugin", pluginId: "p", allow: [] }, toolName: "Bash", expected: SELECT_ONCE },
    { name: "plugin, not contained, machine bypass", config: { mode: "bypass" }, origin: { kind: "plugin", pluginId: "p" }, toolName: "Bash", expected: SELECT_ONCE },
    { name: "plugin, not contained, allowedTools", config: { allowedTools: ["Bash"] }, origin: { kind: "plugin", pluginId: "p", onBehalfOf: { browserKeyId: "k" } }, toolName: "Bash", expected: SELECT_ONCE },
    // A browser session never gets the headless set.
    { name: "browser, mcp tool of some plugin's set, machine ask", origin: browser, toolName: "mcp__srv__read", expected: ASK },
    { name: "browser, mcp tool, allowedTools has it", config: { allowedTools: ["mcp__srv__read"] }, origin: browser, toolName: "mcp__srv__read", expected: SELECT_ONCE },
    { name: "browser, mcp tool, machine bypass (as today)", config: { mode: "bypass" }, origin: browser, toolName: "mcp__srv__read", expected: SELECT_ONCE },
    { name: "browser, mcp tool, pluginApprovals off changes nothing", config: { pluginApprovals: false }, origin: browser, toolName: "mcp__srv__read", expected: ASK },
  ];

  it.each(rows)("$name", async ({ config, origin, toolName, options, expected }) => {
    const policy = healthy(config);
    const info = request({ origin, ...(toolName !== undefined ? { toolName } : {}), ...(options ? { options } : {}) });
    expect(await policy.decidePermission(info)).toEqual(expected);
  });

  it("never asks a contained session's request of a browser, over the whole product of the machine settings", async () => {
    for (const mode of ["ask", "read-only", "accept-edits", "bypass"] as const) {
      for (const pluginApprovals of [undefined, true, false]) {
        for (const toolName of [undefined, "Bash", "Read", "mcp__srv__read", "mcp__srv__write"]) {
          for (const callsLeft of [undefined, 0, 5]) {
            const policy = healthy({ mode, pluginApprovals, allowedTools: ["Bash", "Read", "mcp__srv__write"] });
            const decision = await policy.decidePermission(request({ origin: contained({ callsLeft }), ...(toolName ? { toolName } : {}), toolKind: "read" }));
            const approved = toolName === "mcp__srv__read" && pluginApprovals !== false && (callsLeft ?? 0) > 0;
            expect(decision, `${mode} ${String(pluginApprovals)} ${String(toolName)} ${String(callsLeft)}`).toEqual(approved ? SELECT_ONCE : SELECT_NO);
          }
        }
      }
    }
  });

  it("reads a kill switch that is not a boolean as off, with a warning", async () => {
    const warnings: string[] = [];
    const policy = createLocalPolicy({ pluginApprovals: "no" as unknown as boolean, auditFailed: () => false, warn: (m) => void warnings.push(m) });
    expect(await policy.decidePermission(request({ origin: contained(), toolName: "mcp__srv__read" }))).toEqual(SELECT_NO);
    expect(warnings.join("\n")).toContain("pluginApprovals");
  });

  describe("a failed audit log cancels every decision of that plugin's contained sessions", () => {
    const failing = (failed: (id: string) => boolean) => createLocalPolicy({ auditFailed: failed, warn: () => {} });
    it("in the set or not, and a healthy log changes nothing", async () => {
      const policy = failing((id) => id === "p");
      expect(await policy.decidePermission(request({ origin: contained(), toolName: "mcp__srv__read" }))).toEqual(CANCEL);
      expect(await policy.decidePermission(request({ origin: contained(), toolName: "Bash" }))).toEqual(CANCEL);
      // Another plugin's log is its own.
      expect(await policy.decidePermission(request({ origin: contained({ pluginId: "q" }), toolName: "mcp__srv__read" }))).toEqual(SELECT_ONCE);
      expect(await failing(() => false).decidePermission(request({ origin: contained(), toolName: "mcp__srv__read" }))).toEqual(SELECT_ONCE);
    });
    it("reads a throwing or non-boolean answer as a failure", async () => {
      const thrower = failing(() => { throw new Error("boom"); });
      expect(await thrower.decidePermission(request({ origin: contained(), toolName: "mcp__srv__read" }))).toEqual(CANCEL);
      const odd = failing(() => undefined as unknown as boolean);
      expect(await odd.decidePermission(request({ origin: contained(), toolName: "mcp__srv__read" }))).toEqual(CANCEL);
    });
    it("no audit check wired is not a healthy log: a contained session is cancelled, in the set or not", async () => {
      const policy = createLocalPolicy({ warn: () => {} });
      for (const toolName of ["mcp__srv__read", "Bash", undefined]) {
        expect(await policy.decidePermission(request({ origin: contained(), ...(toolName ? { toolName } : {}) }))).toEqual(CANCEL);
      }
      expect(await createLocalPolicy({ warn: () => {}, mode: "bypass", allowedTools: ["mcp__srv__read"] }).decidePermission(request({ origin: contained(), toolName: "mcp__srv__read" }))).toEqual(CANCEL);
      // Other requests do not depend on the audit log.
      expect(await policy.decidePermission(request({ toolName: "mcp__srv__read" }))).toEqual(ASK);
    });
    it("does not touch browser or non-contained requests", async () => {
      const policy = failing(() => true);
      expect(await policy.decidePermission(request({ toolName: "mcp__srv__read" }))).toEqual(ASK);
      expect(await policy.decidePermission(request({ origin: { kind: "plugin", pluginId: "p" }, toolName: "Bash" }))).toEqual(ASK);
    });
  });

  describe("allowContainedSession", () => {
    const ok = { appId: "app", agentId: "claude" };
    const make = (config: Parameters<typeof createLocalPolicy>[0] = {}) => createLocalPolicy({ warn: () => {}, ...config });
    const allowed = async (policy: ReturnType<typeof make>, request: Parameters<NonNullable<ReturnType<typeof make>["allowContainedSession"]>>[0]) => (await policy.allowContainedSession!(request)).allowed;

    it("admits whatever allowedCwds says: the cwd is the runner's choice", async () => {
      const policy = make({ allowedCwds: ["/somewhere/else"], homedir: path.join(root, "home") });
      expect(await policy.allowSession({ ...ok, cwd: path.join(root, "sessions/x") })).toBe(false); // allowSession would refuse that folder
      expect(await policy.allowContainedSession!(ok)).toMatchObject({ allowed: true });
    });

    it("does not consult the machine mode or allowedTools", async () => {
      for (const mode of ["ask", "bypass"] as const) expect(await allowed(make({ mode, allowedTools: ["Bash"] }), ok)).toBe(true);
    });

    it("refuses an agent outside the (narrowed) agents list, and admits an empty list's every agent", async () => {
      const policy = make({ agents: ["codex"] });
      expect(await policy.allowContainedSession!(ok)).toMatchObject({ allowed: false, reason: expect.stringContaining("claude") });
      expect(await allowed(policy, { ...ok, agentId: "codex" })).toBe(true);
      expect(await allowed(make({ agents: [] }), ok)).toBe(true);
      expect(await allowed(make({ agents: ["(no agent is allowed)"] }), ok)).toBe(false);
    });

    it("refuses a model outside models, admits one on the list, and any model when no list is set", async () => {
      const policy = make({ models: ["sonnet", "haiku"] });
      expect(await policy.allowContainedSession!({ ...ok, model: "opus" })).toMatchObject({ allowed: false, reason: expect.stringContaining("opus") });
      expect(await allowed(policy, { ...ok, model: "sonnet" })).toBe(true);
      expect(await allowed(policy, { ...ok, model: "Sonnet" })).toBe(false);
      expect(await allowed(make(), { ...ok, model: "opus" })).toBe(true);
      expect(await allowed(make({ models: [] }), { ...ok, model: "opus" })).toBe(true);
    });

    it("with a models list, a session that names no model is refused unless the app's agent.model is on the list", async () => {
      expect(await allowed(make({ models: ["sonnet"] }), ok)).toBe(false);
      expect(await allowed(make({ models: ["sonnet"], agentModel: "sonnet" }), ok)).toBe(true);
      expect(await allowed(make({ models: ["sonnet"], agentModel: "opus" }), ok)).toBe(false);
      // A named model is the one checked; the app's agent.model is not consulted then.
      expect(await allowed(make({ models: ["sonnet"], agentModel: "opus" }), { ...ok, model: "sonnet" })).toBe(true);
      expect(await allowed(make({ agentModel: "opus" }), ok)).toBe(true);
    });

    it("reads a models value that is not a list of strings as a list nobody is on", async () => {
      const warnings: string[] = [];
      const policy = createLocalPolicy({ models: "sonnet" as unknown as string[], warn: (m) => void warnings.push(m) });
      expect(await allowed(policy, { ...ok, model: "sonnet" })).toBe(false);
      expect(warnings.join("\n")).toContain("models");
    });

    it("refuses another app's id instead of throwing, for a policy bound to one app", async () => {
      const base = { config: path.join(root, "c"), data: path.join(root, "d"), state: path.join(root, "s") };
      const own = appPathsOf(base, "app-a");
      const policy = createLocalPolicy({
        warn: () => {},
        workDirOf: (id) => { if (id !== "app-a") throw new Error("not mine"); return own.workDir; },
        appStateDirOf: () => own.stateDir,
      });
      expect(await allowed(policy, { appId: "app-a", agentId: "claude" })).toBe(true);
      expect(await policy.allowContainedSession!({ appId: "app-b", agentId: "claude" })).toMatchObject({ allowed: false });
    });

    it("the same agent and model rules apply to a non-contained plugin session's model (allowSession)", async () => {
      const policy = make({ models: ["sonnet"], homedir: path.join(root, "home") });
      const cwd = path.join(root, "home/project");
      expect(await policy.allowSession({ ...ok, cwd, model: "sonnet" })).toBe(true);
      expect(await policy.allowSession({ ...ok, cwd, model: "opus" })).toBe(false);
      expect(await policy.allowSession({ ...ok, cwd })).toBe(true); // a browser session names none
    });
  });

  describe("the budget ceiling of the verdict", () => {
    const ok = { appId: "app", agentId: "claude" };
    const budgetOf = async (config: Parameters<typeof createLocalPolicy>[0], warnings: string[] = []) => {
      const policy = createLocalPolicy({ warn: (m) => void warnings.push(m), ...config });
      return await policy.allowContainedSession!(ok);
    };
    const RUNNER = { wallClockMs: SESSION_BUDGET_CEILING.wallClockMs, maxToolCalls: SESSION_BUDGET_CEILING.maxToolCalls };

    it("no policy key: the runner's ceiling, whole", async () => {
      expect(await budgetOf({})).toEqual({ allowed: true, budget: RUNNER });
    });
    it("a policy ceiling lowers the budget, per field", async () => {
      expect(await budgetOf({ sessionBudget: { wallClockMs: 60_000, maxToolCalls: 7 } })).toEqual({ allowed: true, budget: { wallClockMs: 60_000, maxToolCalls: 7 } });
      expect(await budgetOf({ sessionBudget: { maxToolCalls: 7 } })).toEqual({ allowed: true, budget: { wallClockMs: RUNNER.wallClockMs, maxToolCalls: 7 } });
      expect(await budgetOf({ sessionBudget: {} })).toEqual({ allowed: true, budget: RUNNER });
    });
    it("a policy ceiling above the runner's is clamped to it, with a warning", async () => {
      const warnings: string[] = [];
      expect(await budgetOf({ sessionBudget: { wallClockMs: RUNNER.wallClockMs * 2, maxToolCalls: RUNNER.maxToolCalls + 1 } }, warnings)).toEqual({ allowed: true, budget: RUNNER });
      expect(warnings.join("\n")).toContain("sessionBudget.wallClockMs");
      expect(warnings.join("\n")).toContain("sessionBudget.maxToolCalls");
    });
    it("a value that is not a positive integer is ignored, never widening", async () => {
      for (const bad of [0, -5, 1.5, "10", null, Number.NaN]) {
        expect(await budgetOf({ sessionBudget: { maxToolCalls: bad as unknown as number, wallClockMs: 60_000 } }), String(bad)).toEqual({ allowed: true, budget: { wallClockMs: 60_000, maxToolCalls: RUNNER.maxToolCalls } });
      }
      expect(await budgetOf({ sessionBudget: "5" as unknown as object })).toEqual({ allowed: true, budget: RUNNER });
    });
    it("the effective budget is min(request, ceiling, default): the verdict is the ceiling side of it", async () => {
      const effective = (request: number | undefined, ceiling: number, fallback: number): number => Math.min(request ?? fallback, ceiling);
      const v = await budgetOf({ sessionBudget: { maxToolCalls: 50 } });
      expect(v.allowed && effective(500, v.budget.maxToolCalls, 200)).toBe(50);
      expect(v.allowed && effective(10, v.budget.maxToolCalls, 200)).toBe(10);
      expect(v.allowed && effective(undefined, v.budget.maxToolCalls, 200)).toBe(50);
    });
  });
});
