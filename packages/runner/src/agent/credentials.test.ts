import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stageAgentCredentials } from "./credentials.js";

let root: string;
let login: string;
let loader: string;
const children: ChildProcess[] = [];
const survivors: number[] = [];
const auth = (token: string) => JSON.stringify({ tokens: { access_token: `access-${token}`, refresh_token: token } });

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "credential-concurrency-"));
  login = path.join(root, "bridge/agents/codex/auth.json");
  await mkdir(path.dirname(login), { recursive: true });
  await writeFile(login, auth("grant-0"), { mode: 0o600 });
  // Exercise the actual TS implementation in independent Node processes, without a build
  // artifact dependency. This loader only maps this module's local .js imports to TS sources.
  loader = path.join(root, "source-loader.mjs");
  await writeFile(loader, `export async function resolve(specifier, context, next) {
    if (specifier.startsWith('./') && specifier.endsWith('.js') && context.parentURL?.endsWith('/credentials.ts')) {
      return next(specifier.slice(0,-3)+'.ts', context);
    }
    return next(specifier, context);
  }`);
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const pid of survivors.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await rm(root, { recursive: true, force: true });
});

type Reply = { kind: string; refresh?: string; code?: string; pid?: number; message?: string };
async function reply(child: ChildProcess): Promise<Reply> {
  return await new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("synthetic child timed out")); }, 5000);
    const message = (value: Reply) => { cleanup(); resolve(value); };
    const exit = () => { cleanup(); reject(new Error("synthetic child exited before reply")); };
    const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); };
    child.once("message", message);
    child.once("exit", exit);
  });
}

function session(app: string, source = login, survivor = false): { child: ChildProcess; ready: Promise<Reply> } {
  const credentials = pathToFileURL(fileURLToPath(new URL("./credentials.ts", import.meta.url))).href;
  const program = `
    import { stageAgentCredentials } from ${JSON.stringify(credentials)};
    import { readFile, writeFile } from 'node:fs/promises';
    import { spawn } from 'node:child_process';
    try {
      const staged = await stageAgentCredentials('codex-cli', ${JSON.stringify(path.join(root, app))}, {
        homedir: ${JSON.stringify(path.join(root, "home"))}, env: {}, authFiles: { 'codex-cli': ${JSON.stringify(source)} }
      });
      const stagedFile = staged.env.CODEX_HOME + '/auth.json';
      let pid;
      if (${survivor}) {
        const kid = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
        kid.unref(); pid = kid.pid;
      }
      process.send({kind:'ready', refresh:JSON.parse(await readFile(stagedFile,'utf8')).tokens.refresh_token, pid});
      process.on('message', async msg => {
        if (msg.kind === 'rotate') {
          await writeFile(stagedFile, JSON.stringify({tokens:{access_token:'fresh',refresh_token:msg.refresh}}));
          await staged.persistRefresh(); process.send({kind:'persisted'});
        }
        if (msg.kind === 'finish') {
          await staged.persistRefresh(); await staged.release(); process.send({kind:'released'}); process.disconnect();
        }
      });
    } catch (error) { process.send({kind:'refused',code:error.code,message:error.message}); process.disconnect(); }
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--loader", loader, "--input-type=module", "-e", program], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.push(child);
  return { child, ready: reply(child) };
}

async function command(child: ChildProcess, value: object): Promise<Reply> {
  const response = reply(child);
  child.send(value);
  return await response;
}

describe("staged login concurrency with synthetic rotating grants", () => {
  it("serializes two separate app processes through persistence, cancellation cleanup and retry", async () => {
    const first = session("app-a");
    expect(await first.ready).toMatchObject({ kind: "ready", refresh: "grant-0" });
    const denied = session("app-b");
    expect(await denied.ready).toMatchObject({ kind: "refused", code: "AGENT_LOGIN_BUSY" });
    await expect(readFile(path.join(root, "app-b/codex-home/auth.json"))).rejects.toThrow();
    // Fake provider rotates its one current grant. No second refresh request can be made with
    // grant-0 because app-b was refused before receiving any staged credential.
    let providerGrant = "grant-0";
    const rotate = (presented: string) => {
      expect(presented).toBe(providerGrant);
      providerGrant = "grant-1";
      return providerGrant;
    };
    expect(await command(first.child, { kind: "rotate", refresh: rotate("grant-0") })).toEqual({ kind: "persisted" });
    const stillDenied = session("app-b-after-persist");
    expect(await stillDenied.ready).toMatchObject({ kind: "refused", code: "AGENT_LOGIN_BUSY" });
    // Synthetic cancellation completion: only after cleanup does the caller explicitly finish.
    expect(await command(first.child, { kind: "finish" })).toEqual({ kind: "released" });
    const retry = session("app-b-retry");
    expect(await retry.ready).toMatchObject({ kind: "ready", refresh: providerGrant });
    expect(JSON.parse(await readFile(login, "utf8")).tokens.refresh_token).toBe(providerGrant);
    await command(retry.child, { kind: "finish" });
  });

  it("keeps different logins independent across two app processes", async () => {
    const other = path.join(path.dirname(login), "other.json");
    await writeFile(other, auth("other-grant"), { mode: 0o600 });
    const a = session("app-a");
    const b = session("app-b", other);
    expect(await a.ready).toMatchObject({ kind: "ready", refresh: "grant-0" });
    expect(await b.ready).toMatchObject({ kind: "ready", refresh: "other-grant" });
    await command(a.child, { kind: "rotate", refresh: "next-a" });
    expect(JSON.parse(await readFile(other, "utf8")).tokens.refresh_token).toBe("other-grant");
    await command(b.child, { kind: "finish" });
    await command(a.child, { kind: "finish" });
  });

  it("never steals a dead runner's lease while its detached descendant survives", async () => {
    const first = session("crashing-app", login, true);
    const ready = await first.ready;
    expect(ready.kind).toBe("ready");
    survivors.push(ready.pid!);
    const exited = once(first.child, "exit");
    first.child.kill("SIGKILL");
    await exited;
    expect(() => process.kill(ready.pid!, 0)).not.toThrow();
    const denied = session("retry-after-crash");
    expect(await denied.ready).toMatchObject({ kind: "refused", message: expect.stringContaining("descendants may remain") });
    expect(await readFile(login, "utf8")).toBe(auth("grant-0"));
  });

  it("releases failed staging and refuses persistence after explicit release", async () => {
    const blocked = path.join(root, "cannot-stage");
    await writeFile(blocked, "not a directory");
    const src = { homedir: path.join(root, "home"), env: {}, authFiles: { "codex-cli": login } };
    await expect(stageAgentCredentials("codex-cli", blocked, src)).rejects.toThrow();
    const retry = await stageAgentCredentials("codex-cli", path.join(root, "retry"), src);
    expect(retry.staged).toBe(true);
    await retry.release!();
    await expect(retry.persistRefresh!()).rejects.toMatchObject({ code: "AGENT_LOGIN_BUSY" });
  });

  it("uses one lease across allowed config ancestor aliases", async () => {
    await symlink(path.join(root, "bridge"), path.join(root, "config-alias"));
    const src = { homedir: path.join(root, "home"), env: {}, authFiles: { "codex-cli": login } };
    const staged = await stageAgentCredentials("codex-cli", path.join(root, "first"), src);
    const alias = path.join(root, "config-alias/agents/codex/auth.json");
    await expect(stageAgentCredentials("codex-cli", path.join(root, "second"), { ...src, authFiles: { "codex-cli": alias } })).rejects.toMatchObject({ code: "AGENT_LOGIN_BUSY" });
    await staged.release!();
    const retry = await stageAgentCredentials("codex-cli", path.join(root, "retry"), { ...src, authFiles: { "codex-cli": alias } });
    await retry.release!();
  });

  it("retains Claude stale-base rejection and unrelated MCP credential isolation", async () => {
    const claude = path.join(path.dirname(login), ".credentials.json");
    const original = { claudeAiOauth: { accessToken: "synthetic-a", refreshToken: "grant-a" }, mcpOAuth: { private: "never-staged" } };
    await writeFile(claude, JSON.stringify(original), { mode: 0o600 });
    const staged = await stageAgentCredentials("claude-code", path.join(root, "claude"), { homedir: path.join(root, "home"), env: {}, authFiles: { "claude-code": claude } });
    const stagedFile = path.join(staged.env.CLAUDE_CONFIG_DIR!, ".credentials.json");
    expect(await readFile(stagedFile, "utf8")).not.toContain("never-staged");
    await writeFile(stagedFile, JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-b" } }));
    const replaced = { ...original, claudeAiOauth: { accessToken: "new-login", refreshToken: "new-grant" } };
    await writeFile(claude, JSON.stringify(replaced));
    await expect(staged.persistRefresh!()).rejects.toMatchObject({ code: "AGENT_LOGIN_PERSISTENCE_UNVERIFIED" });
    expect(JSON.parse(await readFile(claude, "utf8"))).toEqual(replaced);
    expect(await readFile(stagedFile, "utf8")).toContain("synthetic-b");
    expect((await stat(`${claude}.bridge-login-lease`)).isDirectory()).toBe(true);
  });

  it("treats unchanged latest staged credentials as a verified no-op", async () => {
    const staged = await stageAgentCredentials("codex-cli", path.join(root, "unchanged"), { homedir: path.join(root, "home"), env: {}, authFiles: { "codex-cli": login } });
    await expect(staged.persistRefresh!()).resolves.toBeUndefined();
    expect(await readFile(login, "utf8")).toBe(auth("grant-0"));
    await staged.release!();
  });

  it("reports an unreadable canonical source and retains its latest staged copy", async () => {
    const staged = await stageAgentCredentials("codex-cli", path.join(root, "unreadable"), { homedir: path.join(root, "home"), env: {}, authFiles: { "codex-cli": login } });
    const copy = path.join(staged.env.CODEX_HOME!, "auth.json");
    await writeFile(copy, auth("latest-grant"));
    await chmod(login, 0o000);
    try {
      await expect(staged.persistRefresh!()).rejects.toMatchObject({ code: "AGENT_LOGIN_PERSISTENCE_UNVERIFIED" });
      expect(await readFile(copy, "utf8")).toBe(auth("latest-grant"));
      expect((await stat(`${login}.bridge-login-lease`)).isDirectory()).toBe(true);
    } finally { await chmod(login, 0o600); }
  });
});
