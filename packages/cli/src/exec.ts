import { spawn } from "node:child_process";

import type { CommandRunner } from "@berdyh/bridge-runner";

/** The real `CommandRunner`: rejects only when the command cannot be started. */
export const nodeRun: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const timer =
      options?.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGKILL");
            reject(Object.assign(new Error(`${command} did not finish within ${options.timeoutMs} ms`), { code: "ETIMEDOUT" }));
          }, options.timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options?.stdin ?? "");
  });
