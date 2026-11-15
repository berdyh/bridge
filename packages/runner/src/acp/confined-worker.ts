/** One SRT manager per process/session. Never import this entrypoint into the runner. */
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { confinedSocketDirectoryFits } from "./confined-sockets.js";
import { hostInterfaceDenies } from "./confined-addresses.js";

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  settings: SandboxRuntimeConfig; command: string; args: string[]; secretFd: boolean; socketDir: string;
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
let phase = "dependencies";
try {
  const sandboxTmp = process.env.TMPDIR;
  if (!confinedSocketDirectoryFits(spec.socketDir)) throw new Error("runtime socket path too long");
  process.env.TMPDIR = spec.socketDir;
  const runtimeEntry = createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime");
  const helper = spec.settings.seccomp?.applyPath ?? path.join(path.dirname(path.dirname(runtimeEntry)), "vendor", "seccomp", "x64", "apply-seccomp");
  if (spec.settings.seccomp?.argv0 !== undefined) throw new Error("custom helper mode refused");
  accessSync(helper, constants.X_OK);
  spec.settings.seccomp = { applyPath: helper };
  spec.settings.network.deniedResolvedAddresses = [...new Set([...(spec.settings.network.deniedResolvedAddresses ?? []), ...hostInterfaceDenies(networkInterfaces())])];
  const dependencies = SandboxManager.checkDependencies();
  if (dependencies.errors.length > 0 || dependencies.warnings.some((warning) => /seccomp|namespace|weaker/i.test(warning))) throw new Error("sandbox dependencies unavailable");
  phase = "initialization";
  await SandboxManager.initialize(spec.settings);
  const initializedDependencies = SandboxManager.checkDependencies();
  if (initializedDependencies.errors.length > 0 || initializedDependencies.warnings.some((warning) => /seccomp|namespace|weaker/i.test(warning))) throw new Error("sandbox enforcement helper unavailable");
  const sockets = [SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath()].filter((p): p is string => p !== undefined);
  spec.settings.filesystem.allowRead = [...(spec.settings.filesystem.allowRead ?? []), ...sockets];
  SandboxManager.updateConfig(spec.settings);
  phase = "wrapping";
  const argv = spec.secretFd ? [process.execPath, fileURLToPath(new URL("./confined-secret.js", import.meta.url)), spec.command, ...spec.args] : [spec.command, ...spec.args];
  const wrapped = await SandboxManager.wrapWithSandbox(argv.map(quote).join(" "), "/bin/bash");
  // SRT's command does not inherit a secret in an environment or command line. Only
  // broker workers receive fd3; the agent worker has /dev/null in that position.
  phase = "launch";
  const secret = spec.secretFd ? readFileSync(3) : undefined;
  const child = spawn("/bin/bash", ["-c", wrapped], { env: { ...process.env, TMPDIR: sandboxTmp, CLAUDE_CODE_TMPDIR: sandboxTmp }, stdio: [spec.secretFd ? "pipe" : "inherit", "inherit", "inherit"] });
  if (secret) {
    const pipe = child.stdin!;
    pipe.on("error", () => {});
    const encoded = Buffer.from(secret.toString("base64") + "\n");
    pipe.write(encoded, () => { secret.fill(0); encoded.fill(0); });
    process.stdin.pipe(pipe);
  }
  child.once("error", () => { secret?.fill(0); process.exitCode = 1; });
  await new Promise<void>((resolve) => child.once("close", (code) => { process.exitCode = code ?? 1; resolve(); }));
  await SandboxManager.reset();
} catch {
  // A dependency, config or mount failure is never retried without confinement.
  process.stderr.write(`confined-v1 sandbox failed during ${phase}; run bridge doctor --containment (runtime socket directory must fit Linux Unix socket limits)\n`);
  await SandboxManager.reset().catch(() => undefined);
  process.exitCode = 1;
}
