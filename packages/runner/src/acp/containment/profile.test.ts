import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptySessionDir } from "./profile.js";

const injected = vi.hoisted(() => ({ denied: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importActual) => {
  const real = await importActual<typeof import("node:fs/promises")>();
  return { ...real, rm: async (...args: Parameters<typeof real.rm>) => {
    if (args[0] === injected.denied) throw Object.assign(new Error("synthetic cleanup denied"), { code: "EACCES" });
    return real.rm(...args);
  } };
});
let root: string | undefined;
afterEach(async () => { injected.denied = undefined; if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

it("propagates session directory removal failure so the adapter retains its cleanup guard", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-profile-remove-"));
  const cwd = path.join(root, "bridge", "sessions", "synthetic-session");
  const session = await createEmptySessionDir(cwd);
  await writeFile(path.join(cwd, "retained"), "synthetic staged state");
  injected.denied = cwd;
  await expect(session.remove()).rejects.toMatchObject({ code: "EACCES" });
  expect(await readFile(path.join(cwd, "retained"), "utf8")).toBe("synthetic staged state");
  injected.denied = undefined;
  await session.remove();
  await expect(stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(session.remove()).resolves.toBeUndefined();
});
