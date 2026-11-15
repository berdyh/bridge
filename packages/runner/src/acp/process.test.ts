import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type RawAgentProcess, spawnAcpProcess } from "./process.js";
import { PID_NAMESPACE_SUPERVISOR } from "./cleanup.js";

let root: string;
const spawned: RawAgentProcess[] = [];
const extraPids = new Set<number>();
const env = () => ({ PATH: process.env.PATH ?? "" });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, timeout = 4_000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error("fixture did not reach expected state");
    await pause(10);
  }
}
const text = (file: string) => readFile(path.join(root, file), "utf8").catch(() => "");

beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "bridge-cleanup-")); });
afterEach(async () => {
  await Promise.all(spawned.splice(0).map((proc) => proc.kill()));
  for (const pid of extraPids) { try { process.kill(pid, "SIGKILL"); } catch { /* own fixture already gone */ } }
  extraPids.clear();
  await rm(root, { recursive: true, force: true });
});

describe("ordinary process cleanup", () => {
  it("reports descendants unverified after normal leader exit", async () => {
    const proc = await spawnAcpProcess({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd: root, env: env(), killGraceMs: 20, platform: "linux" });
    spawned.push(proc);
    await proc.exited;
    await expect(proc.cleanup!()).resolves.toEqual({ status: "incomplete", mechanism: "process-group", reason: "descendants-unverified" });
  });

  it("keeps a detached grandchild explicit rather than claiming success", async () => {
    const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "grandchild"))},String(process.pid));setInterval(()=>{},1000)`;
    const child = `const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'});p.unref();setInterval(()=>{},1000)`;
    const script = `const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "child"))},String(p.pid));setInterval(()=>{},1000)`;
    const proc = await spawnAcpProcess({ command: process.execPath, args: ["-e", script], cwd: root, env: env(), killGraceMs: 20, platform: "linux" });
    spawned.push(proc);
    await until(async () => Boolean(await text("grandchild")));
    const grandchildPid = Number(await text("grandchild"));
    extraPids.add(grandchildPid);
    await expect(proc.cleanup!()).resolves.toMatchObject({ status: "incomplete", reason: "descendants-unverified" });
    expect(() => process.kill(grandchildPid, 0)).not.toThrow();
    const receipt = proc.cleanup!();
    expect(proc.cleanup!()).toBe(receipt);
  });

  it("bounds a termination failure without changing kill's compatibility promise", async () => {
    const proc = await spawnAcpProcess({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root, env: env(), killGraceMs: 5, cleanupTimeoutMs: 20, signalFn: () => undefined, platform: "linux" });
    const receipt = await proc.cleanup!();
    expect(receipt).toEqual({ status: "incomplete", mechanism: "process-group", reason: "timeout" });
    // Only this fixture's direct child is signalled; do not enumerate or sweep host PIDs.
    process.kill(proc.pid!, "SIGKILL");
    await proc.kill();
  });
});

// On macOS an empty process group after the SIGKILL sweep is runner-internal evidence that
// releases a staged login. It is never quiescence; a descendant that leaves the group is an accepted gap.
describe("macOS group-empty evidence (seams)", () => {
  it.each([
    ["ESRCH means the group is empty", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }, { status: "group-empty", mechanism: "process-group" }],
    ["EPERM is a live (possibly reused) group", () => { throw Object.assign(new Error("perm"), { code: "EPERM" }); }, { status: "incomplete", mechanism: "process-group", reason: "timeout" }],
    ["success is a live group", () => undefined, { status: "incomplete", mechanism: "process-group", reason: "timeout" }],
  ])("%s", async (_name, probeFn, expected) => {
    const calls: string[] = [];
    const proc = await spawnAcpProcess({
      command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root, env: env(), killGraceMs: 20, cleanupTimeoutMs: 200, platform: "darwin",
      signalFn: (pid, signal) => { calls.push(`signal ${pid < 0 ? "group" : "pid"} ${signal}`); process.kill(pid, signal); },
      probeFn: () => { calls.push("probe"); probeFn(); },
    });
    expect(await proc.cleanup!()).toEqual(expected);
    // The probe runs only after the leader was reaped and the group SIGKILL sweep was sent, and no
    // real signal follows it (no group signal after groupGone).
    const firstProbe = calls.findIndex((c) => c.startsWith("probe"));
    expect(firstProbe).toBeGreaterThan(calls.lastIndexOf("signal group SIGKILL"));
    expect(calls.slice(firstProbe).every((c) => c.startsWith("probe"))).toBe(true);
  });
  it("Linux and other non-darwin platforms never probe and never report group-empty", async () => {
    let probed = false;
    const proc = await spawnAcpProcess({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd: root, env: env(), killGraceMs: 20, platform: "linux", probeFn: () => { probed = true; } });
    await proc.exited;
    expect(await proc.cleanup!()).toEqual({ status: "incomplete", mechanism: "process-group", reason: "descendants-unverified" });
    expect(probed).toBe(false);
  });
});

describe.runIf(process.platform === "darwin")("macOS group-empty evidence (native)", () => {
  it("an in-group grandchild is killed by the sweep and the group then reads empty", async () => {
    const proc = await spawnAcpProcess({ command: "/bin/sh", args: ["-c", `sleep 30 & echo $! > ${JSON.stringify(path.join(root, "bg"))}; sleep 30`], cwd: root, env: env(), killGraceMs: 50 });
    await until(async () => Boolean((await text("bg")).trim()));
    const bg = Number((await text("bg")).trim());
    expect(await proc.cleanup!()).toEqual({ status: "group-empty", mechanism: "process-group" });
    for (const pid of [proc.pid!, bg]) expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });
  it("documents the accepted gap: a grandchild in its own session survives and the group still reads empty", async () => {
    const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "escaped"))},String(process.pid));setInterval(()=>{},1000)`;
    const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)`;
    const proc = await spawnAcpProcess({ command: process.execPath, args: ["-e", script], cwd: root, env: env(), killGraceMs: 50 });
    await until(async () => Boolean(await text("escaped")));
    const escaped = Number(await text("escaped"));
    extraPids.add(escaped);
    expect(await proc.cleanup!()).toEqual({ status: "group-empty", mechanism: "process-group" });
    expect(() => process.kill(escaped, 0)).not.toThrow();
  });
});

const namespaceProbe = process.platform === "linux" ? spawnSync("/usr/bin/unshare", ["--user", "--map-root-user", "--pid", "--fork", "--kill-child=KILL", "--mount-proc", "--", process.execPath, "-e", "process.exit(process.pid===1?0:1)"], { timeout: 2_000 }) : undefined;
const namespaceAvailable = namespaceProbe?.status === 0;

describe("Linux PID namespace descendant cleanup", () => {
  it("rejects supervisor startup injection and erases the supplied secret", async () => {
    const secret = new Uint8Array([1, 2, 3]);
    await expect(spawnAcpProcess({ command: process.execPath, cwd: root, env: { ...env(), NODE_OPTIONS: "--require=untrusted.cjs" }, processTree: "linux-pid-namespace", secretInput: secret }))
      .rejects.toThrow(/namespace/i);
    expect([...secret]).toEqual([0, 0, 0]);
  });

  it("fails closed when namespace setup is unavailable", async () => {
    if (namespaceAvailable) return;
    const secret = new Uint8Array([1, 2, 3]);
    await expect(spawnAcpProcess({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd: root, env: env(), processTree: "linux-pid-namespace", secretInput: secret }))
      .rejects.toThrow(/namespace/i);
    expect([...secret]).toEqual([0, 0, 0]);
  });

  function treeCommand(mode: "normal" | "running" | "stubborn") {
    const grandchild = `const fs=require('node:fs');const net=require('node:net');const root=${JSON.stringify(root)};const server=net.createServer(s=>s.end('fixture'));server.listen(0,'127.0.0.1',()=>fs.writeFileSync(root+'/port',String(server.address().port)));setInterval(()=>fs.appendFileSync(root+'/grandchild-ticks','x'),10);`;
    const child = `const fs=require('node:fs');const root=${JSON.stringify(root)};const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'});p.unref();setInterval(()=>fs.appendFileSync(root+'/child-ticks','x'),10);`;
    const target = `const fs=require('node:fs');const root=${JSON.stringify(root)};${mode === "stubborn" ? "process.on('SIGTERM',()=>fs.writeFileSync(root+'/term-observed','yes'));" : ""}require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'});setInterval(()=>{if(fs.existsSync(root+'/crash'))process.kill(process.pid,'SIGKILL');fs.appendFileSync(root+'/target-ticks','x')},10);${mode === "normal" ? "const t=setInterval(()=>{if(fs.existsSync(root+'/port')){clearInterval(t);setTimeout(()=>process.exit(0),50)}},10);" : ""}`;
    return target;
  }

  async function tree(mode: "normal" | "running" | "stubborn") {
    const target = treeCommand(mode);
    const stderr: string[] = [];
    const proc = await spawnAcpProcess({ command: process.execPath, args: ["-e", target], cwd: root, env: env(), processTree: "linux-pid-namespace", killGraceMs: 30, onStderr: (line) => stderr.push(line) });
    spawned.push(proc);
    try { await until(async () => Boolean(await text("port")) && Boolean(await text("child-ticks")) && Boolean(await text("grandchild-ticks"))); }
    catch (error) { throw new Error(`${String(error)}; stderr=${stderr.join("\n")}; child=${await text("child-ticks")}; grandchild=${await text("grandchild-ticks")}`); }
    return proc;
  }

  async function stopped() {
    const before = await Promise.all([text("target-ticks"), text("child-ticks"), text("grandchild-ticks")]);
    await pause(100);
    expect(await Promise.all([text("target-ticks"), text("child-ticks"), text("grandchild-ticks")])).toEqual(before);
    const port = Number(await text("port"));
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    expect(connected).toBe(false);
  }

  it.skipIf(!namespaceAvailable)("normal exit tears down setsid child, grandchild and server before a quiescent receipt", async () => {
    const proc = await tree("normal");
    await proc.exited;
    await expect(proc.cleanup!()).resolves.toEqual({ status: "quiescent", mechanism: "linux-pid-namespace" });
    await stopped();
  });

  it.skipIf(!namespaceAvailable)("cancel closes the entire namespace before a quiescent receipt", async () => {
    const proc = await tree("running");
    await expect(proc.cleanup!()).resolves.toEqual({ status: "quiescent", mechanism: "linux-pid-namespace" });
    await stopped();
  });

  it.skipIf(!namespaceAvailable)("trusted grace exit reaps a TERM-ignoring target and its setsid/server descendants", async () => {
    const proc = await tree("stubborn");
    const receipt = await proc.cleanup!();
    expect(await text("term-observed")).toBe("yes");
    expect(await proc.exited).toEqual({ code: 137, signal: null });
    expect(receipt).toEqual({ status: "quiescent", mechanism: "linux-pid-namespace" });
    await stopped();
  });

  it.skipIf(!namespaceAvailable)("target crash tears down escaped descendants and its server", async () => {
    const proc = await tree("running");
    await writeFile(path.join(root, "crash"), "crash");
    await proc.exited;
    await expect(proc.cleanup!()).resolves.toMatchObject({ status: "quiescent" });
    await stopped();
  });

  it.skipIf(!namespaceAvailable)("outer supervisor crash stays incomplete even if parent-death cleanup runs", async () => {
    const proc = await tree("running");
    process.kill(proc.pid!, "SIGKILL");
    await proc.exited;
    await expect(proc.cleanup!()).resolves.toEqual({ status: "incomplete", mechanism: "linux-pid-namespace", reason: "termination-failed" });
    await until(async () => {
      const ticks = await text("grandchild-ticks");
      await pause(30);
      return ticks === await text("grandchild-ticks");
    });
    await stopped();
  });

  it.skipIf(!namespaceAvailable)("runner crash closes the control pipe and kills setsid/server descendants", async () => {
    const args = ["--user", "--map-root-user", "--pid", "--fork", "--kill-child=KILL", "--mount-proc", "--", process.execPath, "-e", PID_NAMESPACE_SUPERVISOR, "--", "30", process.execPath, "-e", treeCommand("running")];
    const owner = spawn(process.execPath, ["-e", `const p=require('node:child_process').spawn('/usr/bin/unshare',${JSON.stringify(args)},{detached:true,stdio:['ignore','ignore','ignore','pipe','pipe']});p.stdio[3].destroy();p.stdio[4].on('data',()=>{});setInterval(()=>{},1000);`], { cwd: root, env: env(), stdio: "ignore" });
    const ownerClosed = new Promise<void>((resolve) => owner.once("close", () => resolve()));
    try {
      await until(async () => Boolean(await text("port")) && Boolean(await text("grandchild-ticks")));
      owner.kill("SIGKILL");
      await ownerClosed;
      await until(async () => {
        const ticks = await text("grandchild-ticks");
        await pause(30);
        return ticks === await text("grandchild-ticks");
      });
      await stopped();
    } finally {
      owner.kill("SIGKILL");
      await ownerClosed;
    }
  });

  it.skipIf(!namespaceAvailable)("namespace cleanup leaves an unrelated synthetic canary running", async () => {
    const canary = await spawnAcpProcess({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root, env: env() });
    spawned.push(canary);
    const proc = await tree("running");
    await expect(proc.cleanup!()).resolves.toMatchObject({ status: "quiescent" });
    expect(() => process.kill(canary.pid!, 0)).not.toThrow();
  });

  it.skipIf(!namespaceAvailable)("a deadline cannot authorize workspace reuse while teardown still runs", async () => {
    const proc = await spawnAcpProcess({ command: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], cwd: root, env: env(), processTree: "linux-pid-namespace", killGraceMs: 200, cleanupTimeoutMs: 1 });
    spawned.push(proc);
    await expect(proc.cleanup!()).resolves.toMatchObject({ status: "incomplete", reason: "timeout" });
    await proc.kill();
    await expect(proc.cleanup!()).resolves.toMatchObject({ status: "incomplete", reason: "timeout" });
  });

  it.skipIf(!namespaceAvailable)("passes secret bytes only over fd3 and zeros caller input", async () => {
    const secret = Buffer.from("synthetic-secret");
    const script = "const fs=require('node:fs');fs.writeFileSync('secret-result',fs.readFileSync(3));setTimeout(()=>process.exit(0),100)";
    const proc = await spawnAcpProcess({ command: process.execPath, args: ["-e", script], cwd: root, env: env(), processTree: "linux-pid-namespace", secretInput: secret });
    spawned.push(proc);
    expect(secret.every((byte) => byte === 0)).toBe(true);
    await proc.exited;
    expect(await text("secret-result")).toBe("synthetic-secret");
  });
});
