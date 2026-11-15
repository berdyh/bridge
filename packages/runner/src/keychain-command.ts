import { spawn } from "node:child_process";
import type { CommandRunner } from "./contracts.js";

/** Internal, bounded transport. Never include command output or stdin in errors. */
export const keychainCommand: CommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  if (options?.signal?.aborted) { reject(Object.assign(new Error("Keychain command cancelled"), { code: "ETIMEDOUT" })); return; }
  const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
  let done = false;
  let bytes = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const finish = (error?: Error, code?: number) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", abort);
    if (error) {
      child.kill("SIGKILL");
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      reject(error);
    } else resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
  };
  const abort = () => finish(Object.assign(new Error("Keychain command cancelled"), { code: "ETIMEDOUT" }));
  const timer = setTimeout(() => finish(Object.assign(new Error("Keychain command timed out"), { code: "ETIMEDOUT" })), options?.timeoutMs ?? 5000);
  const collect = (target: Buffer[], chunk: Buffer) => {
    if (done) return;
    bytes += chunk.length;
    if (bytes > 1024 * 1024) finish(Object.assign(new Error("Keychain output limit exceeded"), { code: "EOUTPUTLIMIT" }));
    else target.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
  child.on("error", (error) => finish(error));
  child.on("close", (code) => finish(undefined, code ?? 1));
  child.stdin.on("error", () => {});
  options?.signal?.addEventListener("abort", abort, { once: true });
  if (options?.signal?.aborted) { abort(); return; }
  child.stdin.end(options?.stdin ?? "");
});
