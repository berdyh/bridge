import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createKeychainAccess } from "./keychain-access.js";
import type { CommandRunner } from "./contracts.js";

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    const timer = setTimeout(() => { lines.close(); reject(new Error("Private fixture did not start")); }, 3000);
    const fail = () => { clearTimeout(timer); lines.close(); reject(new Error("Private fixture exited before ready")); };
    child.once("error", fail); child.once("exit", fail);
    lines.once("line", (line) => { clearTimeout(timer); lines.close(); resolve(line); });
  });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGKILL"); await closed;
}

// The fixture has no activation directories, never inherits the real service
// address, and implements no credential/item/session/unlock operations at all.
async function privateBus(test: (address: string, root: string) => Promise<void>): Promise<void> {
  const scratch = fileURLToPath(new URL("../../../.ci-local/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "kc-"));
  const name = `bridge-keychain-${randomUUID()}`;
  const config = path.join(root, "bus.conf");
  await writeFile(config, `<busconfig><type>session</type><listen>unix:abstract=${name}</listen><auth>EXTERNAL</auth><policy context="default"><allow user="*"/><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>`);
  const daemon = spawn("dbus-daemon", ["--nofork", `--config-file=${config}`, "--print-address=1"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: root, XDG_RUNTIME_DIR: root, DBUS_SESSION_BUS_ADDRESS: "" } });
  try {
    const address = await firstLine(daemon);
    expect(address).toContain(`unix:abstract=${name}`);
    await test(address, root);
  } finally { await stop(daemon); await rm(root, { recursive: true, force: true }); }
}

function portOn(address: string) {
  const seen: string[][] = [];
  const run: CommandRunner = (command, args, options) => new Promise((resolve, reject) => {
    seen.push([command, ...args]);
    execFile(command, [...args], { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address }, timeout: options?.timeoutMs ?? 1000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ exitCode: error && typeof error.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
  return { seen, port: createKeychainAccess({ platform: "linux", service: "synthetic", run, findExecutable: async () => true, inspectionTimeoutMs: 2000 }) };
}

it.skipIf(process.platform !== "linux")("reads actual busctl JSON on an isolated bus without activating a keychain", async () => {
  await privateBus(async (address) => {
    const { port, seen } = portOn(address);
    expect(await port.inspect()).toEqual({ status: "absent", reason: "service_missing" });
    expect(seen).toHaveLength(2);
    expect(seen.every((args) => args[0] === "busctl" && args.includes("--auto-start=no"))).toBe(true);
  });
}, 8000);

// Optional native test bindings only, never a production library dependency.
const nativeProvider = process.platform === "linux" && spawnSync("/usr/bin/python3", ["-I", "-B", "-c", "import dbus, dbus.service, dbus.mainloop.glib; from gi.repository import GLib"], { stdio: "ignore", timeout: 2000 }).status === 0;
const provider = `
import sys, dbus, dbus.service, dbus.mainloop.glib
from gi.repository import GLib
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.bus.BusConnection(sys.argv[1])
name = dbus.service.BusName("org.freedesktop.secrets", bus)
class Root(dbus.service.Object):
 @dbus.service.method("org.freedesktop.Secret.Service", in_signature="s", out_signature="o")
 def ReadAlias(self, alias): return "/org/freedesktop/secrets/collection/test"
class Collection(dbus.service.Object):
 @dbus.service.method("org.freedesktop.DBus.Properties", in_signature="ss", out_signature="v")
 def Get(self, interface, prop):
  if interface != "org.freedesktop.Secret.Collection" or prop != "Locked": raise dbus.DBusException("Unsupported metadata")
  return dbus.Boolean(sys.argv[2] == "true", variant_level=1)
objects = [Root(bus, "/org/freedesktop/secrets"), Collection(bus, "/org/freedesktop/secrets/collection/test")]
print("READY", flush=True)
GLib.MainLoop().run()
`;

it.skipIf(!nativeProvider).each([false, true])("observes actual native property JSON on a private fake collection (locked=%s)", async (locked) => {
  await privateBus(async (address, root) => {
    const service = spawn("/usr/bin/python3", ["-I", "-B", "-c", provider, address, String(locked)], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: root, XDG_RUNTIME_DIR: root, DBUS_SESSION_BUS_ADDRESS: address } });
    try {
      expect(await firstLine(service)).toBe("READY");
      const { port, seen } = portOn(address);
      expect(await port.inspect()).toEqual(locked ? { status: "locked", reason: "collection_locked" } : { status: "available", reason: "ready" });
      expect(seen).toHaveLength(4);
      expect(seen.at(-1)).toContain("get-property");
      expect(seen.every((args) => args[0] === "busctl" && args.includes("--auto-start=no"))).toBe(true);
    } finally { await stop(service); }
  });
}, 8000);
