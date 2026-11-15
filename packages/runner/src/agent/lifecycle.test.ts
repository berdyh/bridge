import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stageAgentCredentials } from "./credentials.js";
import { execCollect } from "./exec.js";
import { nodeSpawn } from "./lifecycle.js";
import { createAgentRunner } from "./runner.js";

let root: string;
const owned: ChildProcess[] = [];
const env = () => ({ PATH: path.dirname(process.execPath) });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "agent-lifecycle-")); });
afterEach(async () => {
  for (const child of owned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "close");
      child.kill("SIGKILL");
      await done;
    }
  }
  await rm(root, { recursive: true, force: true });
});
const probe = process.platform === "linux" ? spawnSync("/usr/bin/unshare", ["--user", "--map-root-user", "--pid", "--fork", "--kill-child=KILL", "--mount-proc", "--", process.execPath, "-e", "process.exit(process.pid===1?0:1)"], { timeout: 2_000 }) : undefined;
const namespaces = probe?.status === 0;

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 250; i++) { if (await check()) return; await pause(10); }
  throw new Error("synthetic lifecycle condition timed out");
}
const text = (name: string) => readFile(path.join(root, name), "utf8").catch(() => "");
function workload(mode: "normal" | "cancel" | "crash") {
  const kid = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(path.join(root, "ticks"))},'x'),10);`;
  return `const fs=require('node:fs');const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(kid)}],{detached:true,stdio:'ignore'});p.unref();` +
    `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(root, "ticks"))})){` +
    (mode === "normal" ? "clearInterval(t);process.exit(0);" : mode === "crash" ? "clearInterval(t);process.kill(process.pid,'SIGKILL');" : "") + "}},10);";
}

describe("ordinary CLI staged-login lifecycle", () => {
  it("preserves unstaged ordinary spawning and labels its cleanup incomplete", async () => {
    const result = await execCollect(nodeSpawn, { command: process.execPath, args: ["-e", "console.log('ordinary')"], cwd: root, env: env(), timeoutMs: 1_000 });
    expect(result.stdout.trim()).toBe("ordinary");
    expect(result.cleanup).toMatchObject({ status: "incomplete", reason: "descendants-unverified" });
  });

  it("refuses supervisor startup injection", () => {
    expect(() => nodeSpawn(process.execPath, [], { cwd: root, env: { NODE_OPTIONS: "--require=untrusted" }, requireCleanup: true })).toThrow(/lifecycle|startup/);
  });

  it("returns explicit incomplete evidence when lifecycle namespaces are unavailable", async () => {
    if (namespaces) return;
    const result = await execCollect(nodeSpawn, { command: process.execPath, args: ["-e", "console.log('must-not-run')"], cwd: root, env: env(), requireCleanup: true, timeoutMs: 5_000 });
    expect(result.cleanup?.status).toBe("incomplete");
    expect(result.stdout).not.toContain("must-not-run");
  });

  for (const mode of ["normal", "cancel", "crash"] as const) {
    it.skipIf(!namespaces)(`default real spawn ${mode} kills a detached descendant before returning cleanup evidence`, async () => {
      const canary = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      owned.push(canary);
      const controller = new AbortController();
      const result = execCollect(nodeSpawn, { command: process.execPath, args: ["-e", workload(mode)], cwd: root, env: env(), requireCleanup: true, signal: controller.signal, timeoutMs: 5_000 });
      if (mode === "cancel") { await until(async () => Boolean(await text("ticks"))); controller.abort(); }
      const outcome = await result;
      expect(outcome.cleanup).toEqual({ status: "quiescent", mechanism: "linux-pid-namespace" });
      if (mode === "cancel") expect(outcome.aborted).toBe(true);
      const ticks = await text("ticks");
      expect(ticks.length).toBeGreaterThan(0);
      await pause(100);
      expect(await text("ticks")).toBe(ticks);
      expect(() => process.kill(canary.pid!, 0)).not.toThrow();
    });
  }

  it.skipIf(!namespaces)("cancel of a TERM-resistant workload still produces verified namespace teardown", async () => {
    const controller = new AbortController();
    const program = `process.on('SIGTERM',()=>{});${workload("cancel")}`;
    const result = execCollect(nodeSpawn, { command: process.execPath, args: ["-e", program], cwd: root, env: env(), requireCleanup: true, signal: controller.signal, timeoutMs: 5_000 });
    await until(async () => Boolean(await text("ticks")));
    controller.abort();
    expect((await result).cleanup).toEqual({ status: "quiescent", mechanism: "linux-pid-namespace" });
    const before = await text("ticks");
    await pause(100);
    expect(await text("ticks")).toBe(before);
  });

  it.skipIf(!namespaces)("default runner releases the login only after detached descendants are gone", async () => {
    const login = path.join(root, "bridge/agents/codex/auth.json");
    await mkdir(path.dirname(login), { recursive: true, mode: 0o700 });
    await writeFile(login, JSON.stringify({ tokens: { access_token: "synthetic" } }), { mode: 0o600 });
    const command = path.join(root, "fake-codex.cjs");
    await writeFile(command, `#!${process.execPath}\n${workload("normal")}`);
    await chmod(command, 0o700);
    const tmp = path.join(root, "tmp");
    await mkdir(tmp);
    const runner = createAgentRunner({ environment: { spawn: nodeSpawn, env: env(), homedir: path.join(root, "home"), tmpBase: tmp }, commands: { "codex-cli": command }, authFiles: { "codex-cli": login }, order: ["codex-cli"] });
    expect(await runner.runTask({ prompt: "synthetic" }).result).toMatchObject({ ok: true });
    const before = await text("ticks");
    await pause(100);
    expect(await text("ticks")).toBe(before);
    expect(await readdir(tmp)).toEqual([]);
    const retry = await stageAgentCredentials("codex-cli", path.join(root, "retry"), { homedir: path.join(root, "home"), env: {}, authFiles: { "codex-cli": login } });
    expect(retry.staged).toBe(true);
    await retry.release!();
  });

  it.skipIf(!namespaces)("runner crash closes the trusted supervisor pipe and stops detached descendants", async () => {
    const loader = path.join(root, "source-loader.mjs");
    await writeFile(loader, `import {existsSync} from 'node:fs';import {fileURLToPath} from 'node:url';export async function resolve(s,c,n){if(s.startsWith('.')&&s.endsWith('.js')&&c.parentURL){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return n(u.href,c);}return n(s,c);}`);
    const lifecycle = pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), "lifecycle.ts")).href;
    const program = `import {nodeSpawn} from ${JSON.stringify(lifecycle)};nodeSpawn(process.execPath,['-e',${JSON.stringify(workload("cancel"))}],{cwd:${JSON.stringify(root)},env:${JSON.stringify(env())},requireCleanup:true});setInterval(()=>{},1000);`;
    const runner = spawn(process.execPath, ["--experimental-strip-types", "--loader", loader, "--input-type=module", "-e", program], { stdio: "ignore" });
    owned.push(runner);
    await until(async () => Boolean(await text("ticks")));
    const done = once(runner, "close");
    runner.kill("SIGKILL");
    await done;
    // The supervisor gives cooperative shutdown one second before killing namespace PID1.
    await pause(1_200);
    const before = await text("ticks");
    await pause(100);
    expect(await text("ticks")).toBe(before);
  });
});
