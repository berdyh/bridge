import path from "node:path";

import { assertAppFolderName } from "@berdyh/bridge-runner";

import {
  type LocalAppRecord,
  LOCAL_ORIGIN,
  appsFilePath,
  isLocalApp,
  printable,
  readAppFile,
  readAppList,
  upsertApp,
} from "./config.js";
import { ChangedWhileWaiting, assertUnchanged, describePath, pathStates } from "./consent-plan.js";
import { type CliDeps, errorMessage, isTTYOf } from "./deps.js";
import { assertAppDirsReal, assertLayout, layoutSnapshot } from "./layout-rule.js";
import { appPathsOf } from "./paths.js";

const LABEL = "bridge apps add-local";

/** The files an earlier app of this id leaves in its config `bridge/` dir; a local app has none of them, so one there is not ours to reuse. */
const LEFTOVER_FILES = ["app.json", "trust.json", "identity.json", "identity.key", "enroll.json"] as const;

/**
 * `bridge apps add-local <app-id> [--name <name>] [--yes]`: records an app that has no hosted server (no relay,
 * pairing, E2EE identity or browsers). It gets the same folders as any app (`<config|data|state>/<id>/bridge`),
 * its `app.json` carries `kind: "local"`, and `apps.json` lists it under the origin `local`. Plugins install into it
 * with `bridge plugin add` (the manifest's `app` is the id) and `bridge run` serves them. No keychain item is made.
 *
 * Consent as every writing command: the paths are printed, then the question (`--yes` answers it; with no terminal
 * and no `--yes` it fails before anything is written). Rule A (consent-plan.ts) before the question, Rule B after it.
 * An id that is already a local app is a no-op success, so an installer can run it again.
 */
export async function runAddLocal(appId: string, name: string | undefined, yes: boolean, deps: CliDeps): Promise<number> {
  const refuse = (message: string): number => {
    deps.stderr(`${LABEL}: ${message}\n`);
    return 1;
  };
  try {
    assertAppFolderName(appId);
  } catch (error) {
    return refuse(errorMessage(error));
  }
  const shownName = printable(name ?? "").trim() || appId;

  const { listed, error } = await readAppList(deps);
  if (error !== undefined) throw new Error(error);
  const entry = listed.find((a) => a.appId === appId);
  if (entry !== undefined) {
    if (entry.origin !== LOCAL_ORIGIN) return refuse(`${appId} is connected to ${printable(entry.origin)}; run \`bridge apps remove ${appId}\` first. Nothing was changed.`);
    const record = await readAppFile(deps, entry);
    if (!isLocalApp(record)) throw new Error(`${appPathsOf(deps, appId).appFile} is not a local app record; fix or restore it`);
    deps.stdout(`Nothing changed: local app ${appId} exists.\n`);
    return 0;
  }

  const paths = appPathsOf(deps, appId);
  const leftoverFiles = LEFTOVER_FILES.map((f) => path.join(paths.configDir, f));
  const planNow = async () => ({
    layout: await layoutSnapshot(deps, [appId]),
    files: await pathStates([appsFilePath(deps), paths.appFile], { hash: true }),
    leftovers: await pathStates(leftoverFiles),
    dirs: await pathStates([paths.configDir, paths.dataDir, paths.stateDir]),
  });

  // Rule A before the question: the app's three bridge/ dirs may not alias one another, another app's or a machine-wide dir, nor be links.
  try {
    await assertLayout(deps, "add-local", [appId]);
    await assertAppDirsReal(deps, appId);
  } catch (e) {
    return refuse(errorMessage(e));
  }

  // Without a terminal there is nobody to ask: fail fast before anything is written, never read stdin.
  if (!yes && !isTTYOf(deps)) return refuse("no terminal to ask on; pass --yes to create without asking (nothing was created)");

  const plan = await planNow();
  const present = plan.leftovers.filter((s) => s.kind !== "missing");
  if (present.length > 0) {
    return refuse(
      `${paths.configDir} already holds ${present.map((s) => path.basename(s.path)).join(", ")}, left by an earlier app; remove ${present.length === 1 ? "it" : "them"} by hand and run the command again. Nothing was changed.`,
    );
  }

  const parentNote = "its parent is created only when missing and never changed";
  deps.stdout(
    `Local app: ${shownName} (${appId}); it has no hosted server, relay, sign-in or browsers.\n` +
      `These paths will be written:\n` +
      `  ${describePath(plan.files[0]!)}  (the machine-wide list of apps: id and origin)\n` +
      `  ${describePath(plan.files[1]!)}  (the app record)\n` +
      `  ${describePath(plan.dirs[0]!)}  (dir: the app record and the plugins' consent; ${parentNote})\n` +
      `  ${describePath(plan.dirs[1]!)}  (dir: plugins and their data, created when a plugin is installed; ${parentNote})\n` +
      `  ${describePath(plan.dirs[2]!)}  (dir: the work folder and session sandboxes, created when the runner first needs it; ${parentNote})\n`,
  );
  if (!yes && !(await deps.confirm(`Create local app ${shownName} (${appId})?`))) return refuse("cancelled");

  // Rule B: the one recompute after the question; anything that moved means nothing is written.
  try {
    assertUnchanged(plan, await planNow(), LABEL);
  } catch (e) {
    if (e instanceof ChangedWhileWaiting) return refuse(e.message);
    throw e;
  }

  const record: LocalAppRecord = {
    kind: "local",
    appId,
    name: shownName,
    origin: LOCAL_ORIGIN,
    createdAt: (deps.now ? new Date(deps.now()) : new Date()).toISOString(),
  };
  // At the bound canonical destinations of the plan the recompute above confirmed.
  await upsertApp(deps, record, { appsFile: plan.files[0]!.canonical, appFile: plan.files[1]!.canonical });
  deps.stdout(`Created local app ${shownName} (${appId}). Install its plugins with \`bridge plugin add\`, then \`bridge run\`.\n`);
  return 0;
}
