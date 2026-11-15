import { clearTokens } from "@berdyh/bridge-pairing";
import { RemoveRefused, wrapKeyNameOf } from "@berdyh/bridge-runner";

import { parse } from "./args.js";
import { removeAppFolders } from "./app-removal.js";
import { type AppListEntry, type AppsRead, appsFilePath, LOCAL_ORIGIN, isLocalApp, loadApps, printable, readAppFile, readApps, removeApp, tokenKey } from "./config.js";
import { type PathState, assertUnchanged, describePath, pathState, pathStates } from "./consent-plan.js";
import { type CliDeps, UsageError, credentialStoreWhere, credentialsOf, errorMessage, isTTYOf } from "./deps.js";
import { type LayoutSnapshot, aliasedLayoutMessage, appDirsOf, assertNotABase, layoutOf, layoutSnapshot } from "./layout-rule.js";
import { assertNoLegacyLayout } from "./legacy.js";
import { runAddLocal } from "./local-app.js";
import { appPathsOf } from "./paths.js";

/**
 * The listed app a name resolves to. Resolves against what `apps.json` lists, not `loadApps`: removing an app
 * is how one whose `app.json` is broken is recovered, so a broken record must not stop it. An id wins, then a
 * unique name or origin. Only the name is resolved here; the record itself is read into the plan (`planOf`).
 */
function targetOf(read: AppsRead, name: string): AppListEntry {
  const byId = read.listed.find((a) => a.appId === name);
  if (byId) return byId;
  const matches = read.apps.filter((a) => a.name === name || (!isLocalApp(a) && a.origin === name));
  if (matches.length > 1) throw new Error(`'${printable(name)}' matches more than one app (${matches.map((a) => a.appId).join(", ")}); use the app id`);
  if (matches.length === 1) return { appId: matches[0]!.appId, origin: matches[0]!.origin };
  throw new Error(`no connected app '${printable(name)}' (see \`bridge apps list\`)`);
}

/** What one `apps remove` consents to (consent-plan.ts, Rule B): computed before the question, recomputed once after it. */
interface RemovePlan {
  layout: LayoutSnapshot;
  /**
   * The app's record as this snapshot finds it: `ok` (its runner id names the wrapping key), `local` (a local app: no
   * credentials exist, so no keychain step), `absent` (nothing at `app.json`: a half removal) or `broken` (something
   * there that is not a valid record). The consent text and the keychain step read it from here, so a record that
   * changes during the question fails the recompute.
   */
  record: { kind: "ok"; name: string; runnerId: string } | { kind: "local"; name: string } | { kind: "absent" } | { kind: "broken"; error: string };
  /** `apps.json` and the app's `app.json`, with their contents. */
  files: PathState[];
  /** The app's three `bridge/` dirs, then its three parents. */
  dirs: PathState[];
  parents: PathState[];
}

async function recordOf(deps: CliDeps, entry: AppListEntry): Promise<RemovePlan["record"]> {
  if ((await pathState(appPathsOf(deps, entry.appId).appFile)).kind === "missing") return { kind: "absent" };
  try {
    const record = await readAppFile(deps, entry);
    return isLocalApp(record) ? { kind: "local", name: record.name } : { kind: "ok", name: record.name, runnerId: record.runnerId };
  } catch (error) {
    return { kind: "broken", error: errorMessage(error) };
  }
}

async function planOf(deps: CliDeps, entry: AppListEntry): Promise<RemovePlan> {
  const appId = entry.appId;
  const paths = appPathsOf(deps, appId);
  return {
    layout: await layoutSnapshot(deps),
    record: await recordOf(deps, entry),
    files: await pathStates([appsFilePath(deps), paths.appFile], { hash: true }),
    dirs: await pathStates(appDirsOf(deps, appId)),
    parents: await pathStates([paths.parents.config, paths.parents.data, paths.parents.state]),
  };
}

const DIR_NOTES = ["bridge config folder: trust list, identity, enrollment window, connection record", "bridge data folder: plugins and their data", "bridge state folder: work folder and session sandboxes"];

/**
 * `bridge apps remove <app> [--yes]`: lists every path (the three `bridge/` dirs, the app's parents
 * "removed only if empty", `apps.json`) and the keychain items, asks, recomputes once, then forgets
 * the credentials, removes the three dirs, each parent only when empty (an existing parent that
 * holds anything else, or is a symlink, stays) and last the `apps.json` entry. Every removal goes
 * through `removeBound`; one it refuses stops the command and names what was left, and `apps.json`
 * keeps the app so the command can run again.
 */
async function runRemove(name: string, yes: boolean, deps: CliDeps): Promise<number> {
  const read = await readApps(deps);
  if (read.error !== undefined) throw new Error(read.error);
  // The name is resolved against this read; everything the consent says and does comes from the plan below.
  const entry = targetOf(read, name);
  const appId = entry.appId;

  // Rule A: an aliased layout (an app's dir resolving into another app's or a machine-wide dir) is refused before the question.
  const layout = await layoutOf(deps);
  if (layout.overlap !== undefined) {
    deps.stderr(`bridge apps remove: ${aliasedLayoutMessage(layout.overlap, "remove")}\n`);
    return 1;
  }

  // Without a terminal there is nobody to ask: fail fast before the plan is printed, never read stdin.
  if (!yes && !isTTYOf(deps)) {
    deps.stderr("bridge apps remove: no terminal to ask on; pass --yes to remove without asking (nothing was removed)\n");
    return 1;
  }

  // Where the credentials live, said in the consent text; a bad BRIDGE_CREDENTIAL_STORE stops here, before the question.
  const where = credentialStoreWhere(deps);

  const plan = await planOf(deps, entry);
  const record = plan.record;
  // A local app has no credentials, whatever state its app.json is in: the list entry says so, not the record.
  const isLocal = entry.origin === LOCAL_ORIGIN;
  const shown = record.kind === "ok" || record.kind === "local" ? `${printable(record.name)} (${entry.origin})` : `${appId} (${printable(entry.origin)})`;
  const dirLines = plan.dirs.map((s, i) => `  ${describePath(s)}  (dir: ${appId}: ${DIR_NOTES[i]})`);
  const parentLines = plan.parents.map((s) => `  ${describePath(s)}`);
  deps.stdout(`These paths will be removed:\n${dirLines.join("\n")}\n`);
  deps.stdout(`Removed only if empty (they are ${appId}'s own folders; bridge never removes anything else in them):\n${parentLines.join("\n")}\n`);
  deps.stdout(`These paths will be edited:\n  ${appsFilePath(deps)}  (file: ${appId} is taken off the list)\n`);
  if (!isLocal && record.kind !== "local") deps.stdout(
    record.kind === "ok"
      ? `Also deleted from ${where}: the sign-in token and the identity's key wrapping key of ${appId}.\n`
      : record.kind === "absent"
        ? `Also deleted from ${where}: the sign-in token of ${appId}. Its app.json is gone (a half removal), so the identity's key wrapping key cannot be named (its runner id is unknown); a half removal by bridge already deleted it (credential items go first).\n`
        : `Also deleted from ${where}: the sign-in token of ${appId}. Its record is unreadable (${record.error}), so its runner id is unknown and the identity's key wrapping key (the item named ${wrapKeyNameOf({ appId, runnerId: "x" }).replace(/x$/, "<runner id>")}) stays; delete it by hand.\n`,
  );
  const question = isLocal ? `Remove local app ${shown} and delete its bridge folders?` : `Disconnect ${shown} and delete its bridge folders and credentials?`;
  if (!yes && !(await deps.confirm(question))) {
    deps.stderr("bridge apps remove: cancelled\n");
    return 1;
  }

  // Rule B: the one recompute after the question; anything that moved means nothing runs.
  try {
    assertUnchanged(plan, await planOf(deps, entry), "bridge apps remove");
  } catch (error) {
    deps.stderr(`bridge apps remove: ${errorMessage(error)}\n`);
    return 1;
  }

  // Never a base dir or above one, lexically or resolved, before anything (credentials included) is touched.
  try {
    await assertNotABase(deps, ...[...plan.dirs, ...plan.parents].flatMap((s) => [s.path, s.canonical]));
  } catch (error) {
    deps.stderr(`bridge apps remove: ${errorMessage(error)}; nothing was changed\n`);
    return 1;
  }

  const left: string[] = [];
  try {
    // Credentials first, while the record that names them is intact: a failure here leaves every file for a second run.
    // A local app has no credentials: nothing was ever put in the keychain for it.
    if (!isLocal) {
      const store = credentialsOf(deps);
      await clearTokens(store, tokenKey(appId));
      if (record.kind === "ok") await store.delete(wrapKeyNameOf({ appId, runnerId: record.runnerId }));
    }
    // Its folders with app.json last, then its apps.json entry: an index entry goes only after everything it lists,
    // so a failure anywhere leaves the app recorded and the command can run again.
    const [config, data, state] = plan.dirs as [PathState, PathState, PathState];
    const [pConfig, pData, pState] = plan.parents as [PathState, PathState, PathState];
    left.push(...(await removeAppFolders(deps, { appId, config, data, state, parents: { config: pConfig, data: pData, state: pState } }, () => {})));
    await removeApp(deps, appId, { appsFile: plan.files[0]!.canonical });
  } catch (error) {
    if (error instanceof RemoveRefused) {
      deps.stderr(`bridge apps remove: ${error.message}; stopped here, nothing more was changed (${appsFilePath(deps)} still lists ${appId}; run the command again once it is fixed)\n`);
    } else {
      deps.stderr(`bridge apps remove: ${errorMessage(error)}; nothing after this step was changed (${appsFilePath(deps)} still lists ${appId}; run the command again)\n`);
    }
    return 1;
  }
  if (left.length > 0) deps.stdout(`Left in place: ${left.join(", ")}.\n`);
  if (isLocal) deps.stdout(`Removed local app ${record.kind === "local" ? printable(record.name) : appId}. A running \`bridge run\` drops it on its next start.\n`);
  else deps.stdout(`Disconnected ${record.kind === "ok" ? printable(record.name) : appId}. A running \`bridge run\` drops it on its next start.\n`);
  return 0;
}

/** `bridge apps list [--json] | add-local <app-id> [--name <name>] [--yes] | remove <app> [--yes]`. `--json` prints the app records (they hold no secrets) as one JSON array. */
export async function runApps(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, { yes: { type: "boolean" }, json: { type: "boolean" }, name: { type: "string" } });
  const [sub, name] = positionals;
  await assertNoLegacyLayout(deps);
  if (values.json && sub !== "list") throw new UsageError("--json applies to `bridge apps list` only");
  if (values.name !== undefined && sub !== "add-local") throw new UsageError("--name applies to `bridge apps add-local` only");
  if (sub === "list" && positionals.length === 1) {
    const apps = await loadApps(deps);
    if (values.json) {
      deps.stdout(`${JSON.stringify(apps)}\n`);
      return 0;
    }
    if (apps.length === 0) {
      deps.stdout("No apps connected. Run `bridge connect <app-url>` or `bridge apps add-local <app-id>`.\n");
      return 0;
    }
    for (const a of apps) deps.stdout(`${a.appId}\t${a.name}\t${a.origin}\t${isLocalApp(a) ? "-" : `runner ${a.runnerId}`}\n`);
    return 0;
  }
  if (sub === "add-local" && name !== undefined && positionals.length === 2) return runAddLocal(name, values.name, values.yes === true, deps);
  if (sub === "remove" && name !== undefined && positionals.length === 2) return runRemove(name, values.yes === true, deps);
  throw new UsageError("usage: bridge apps list [--json] | add-local <app-id> [--name <name>] [--yes] | remove <app> [--yes]");
}
