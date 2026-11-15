import { lstat } from "node:fs/promises";

import { formatEnrollFragment, wordsOf } from "@berdyh/bridge-protocol";
import { loadTokens } from "@berdyh/bridge-pairing";
import { EnrollError, type EnrollPrompt, type LinkStatus } from "@berdyh/bridge-runner";

import { AGENT_NAMES, type AgentName, agentDirOf, agentLoginFileOf, agentLoginIsPresent, agentNameOfAdapter, agentOnPath, loginInBridgeFolder } from "./agent.js";
import { parse } from "./args.js";
import { type HostedAppRecord, appsFilePath, isLocalApp, loadApps, printable, tokenKey } from "./config.js";
import { appUrlOf, connectApp, discoverApp, linkRevoked, staleStateOf, startedBeforeRecord, voiceOf } from "./connect.js";
import { type CliDeps, UsageError, credentialDirOf, credentialStoreWhere, credentialsOf, e2eeOf, errorMessage, isTTYOf, keychainHint, keychainUsability, openUrlOf, platformOf, runnerOf, setupConfigOf } from "./deps.js";
import { ADAPTER_KINDS, adapterInstallPlan, installAdapter } from "./adapters.js";
import { adapterReports, launchdUid, protocolHandlerReport } from "./doctor.js";
import { LegacyLayoutError, assertNoLegacyLayout } from "./legacy.js";
import { WORDS_RULE, confirmFromWindow, e2eeAppOf } from "./enroll.js";
import {
  type ProtocolInstallPlan,
  installProtocolHandler,
  protocolHandlerPaths,
  protocolInstallPlan,
  terminalStartRunner,
} from "./protocol-handler.js";
import { runRun } from "./run.js";
import { installBaseDir, launcherStateOf, launchersCurrentFor, selfInstall, selfInstallPlan } from "./self.js";
import { planPaths, runService, servicePlanOf, servicePromptDefault } from "./service.js";
import { appPathsOf } from "./paths.js";
import { readRunnerStatus, runnerPathsOf } from "./status.js";
import { CLI_VERSION } from "./version.js";

const USAGE = "usage: bridge setup <app-url> [--service | --foreground] [--no-install] [--no-open] [--yes] [--json] [--plan]";

/** Link statuses in which the runner will not come online by waiting. */
const FINAL_BAD: readonly LinkStatus[] = ["auth_failed", "revoked", "update_required", "replaced"];
/** How long `setup` waits for the runner to show the app online: 120 looks, 500 ms apart. */
const ONLINE_LOOKS = 120;
const ONLINE_LOOK_MS = 500;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isWindows(deps: CliDeps): boolean {
  const platform: string = (deps.platform as string | undefined) ?? process.platform;
  return platform === "win32" || platform === "windows";
}

// --- starting the runner through its service ------------------------------------------------

/** Whether the user service file exists. */
export async function serviceInstalled(deps: CliDeps): Promise<boolean> {
  return lstat(runnerPathsOf(deps).serviceFile).then(() => true, () => false);
}

/**
 * Starts (or, with `restart`, restarts) the installed user service through the injected runner:
 * `systemctl --user start|restart <name>` on Linux, `launchctl kickstart [-k] gui/<uid>/<name>` on
 * macOS (falling back to `bootstrap`, which loads and starts a service that was booted out; when
 * both fail the error names both). The arguments are fixed; nothing from a URL or from the user
 * reaches them.
 */
export async function startService(deps: CliDeps, restart = false): Promise<{ ok: true } | { ok: false; error: string }> {
  const paths = runnerPathsOf(deps);
  const run = runnerOf(deps);
  const attempts: string[][] =
    platformOf(deps) === "darwin"
      ? [
          ["launchctl", "kickstart", ...(restart ? ["-k"] : []), `gui/${launchdUid()}/${paths.serviceName}`],
          ["launchctl", "bootstrap", `gui/${launchdUid()}`, paths.serviceFile],
        ]
      : [["systemctl", "--user", restart ? "restart" : "start", paths.serviceName]];
  const failures: string[] = [];
  for (const [command, ...args] of attempts) {
    const step = attempts.length > 1 ? `${args[0]}: ` : "";
    try {
      const result = await run(command!, args);
      if (result.exitCode === 0) return { ok: true };
      failures.push(`${step}\`${[command, ...args].join(" ")}\` failed${result.stderr.trim() ? `: ${result.stderr.trim().split("\n").slice(-3).join(" ")}` : ` (exit ${result.exitCode})`}`);
    } catch (error) {
      failures.push(`${step}\`${[command, ...args].join(" ")}\` could not run: ${errorMessage(error)}`);
    }
  }
  return { ok: false, error: failures.join("; ") };
}

/**
 * What `bridge://run` does: start the installed service; only when there is none, open a terminal
 * running `bridge run`. A service that is installed but fails to start is an error, not a reason
 * to start a second runner in a terminal.
 */
export function startRunnerOf(deps: CliDeps): () => Promise<void> {
  return async () => {
    if (await serviceInstalled(deps)) {
      const result = await startService(deps);
      if (!result.ok) throw new Error(result.error);
      return;
    }
    await terminalStartRunner(deps)();
  };
}

// --- setup ----------------------------------------------------------------------------------

type PlanStep = { id: string; state: string; paths: string[]; note?: string };

/**
 * Waits until `runner.json` shows the app online. `exited` says the in-process runner ended. `connectedAt` is when the
 * app's record was written: a final status from a runner that started before that record was written is the old identity's word
 * (the runner is about to be, or is being, restarted), not a verdict on the current one.
 */
async function waitOnline(deps: CliDeps, appId: string, exited: () => number | undefined, connectedAt: string): Promise<"online" | "timeout" | "exited" | LinkStatus> {
  const sleep = deps.sleep ?? defaultSleep;
  for (let look = 0; look < ONLINE_LOOKS; look++) {
    const status = await readRunnerStatus(deps);
    const link = status?.apps[appId];
    const oldIdentity = status !== undefined && startedBeforeRecord(status, connectedAt);
    if (link === "online") return "online";
    if (link !== undefined && link !== "local" && !oldIdentity && FINAL_BAD.includes(link)) return link;
    if (exited() !== undefined) return "exited";
    await sleep(ONLINE_LOOK_MS);
  }
  return "timeout";
}

/** The enroll page link with the code in its fragment, only if it stays on the app's own origin. */
function enrollLinkOf(app: HostedAppRecord, code: string): string | undefined {
  if (app.enrollPage === undefined || !app.enrollPage.startsWith("/") || app.enrollPage.startsWith("//")) return undefined;
  const link = `${app.origin}${app.enrollPage}${formatEnrollFragment({ code, runnerId: app.runnerId })}`;
  try {
    return new URL(link).origin === new URL(app.origin).origin ? link : undefined;
  } catch {
    return undefined;
  }
}

/** What setup knows of one agent before it asks: its own command on PATH, bridge's adapter for it, bridge's own login. */
interface AgentLook {
  agent: AgentName;
  onPath: boolean;
  adapter: boolean;
  login: boolean;
}

/** One purpose in setup's one consent: what it does and the paths it writes (and deletes). */
interface ConsentGroup {
  id: "install" | "connect" | "agents" | "service";
  what: string;
  paths: string[];
  deletes?: string[];
}

/** What is missing for an agent that cannot run yet, as the commands that add it. */
function agentGap(look: AgentLook): string {
  const steps = [
    ...(look.adapter ? [] : [`\`${ADAPTER_KINDS[look.agent].command}\` (${ADAPTER_KINDS[look.agent].size})`]),
    ...(look.login ? [] : [`\`bridge agent login ${look.agent} --login\``]),
  ];
  return look.onPath ? `${look.agent}: run ${steps.join(" and ")}` : `${look.agent}: not found on PATH; once it is installed, run ${steps.join(" and ")}`;
}

/**
 * `bridge setup <app-url> [--service | --foreground] [--no-install] [--no-open] [--yes] [--json] [--plan]`.
 *
 * One terminal, one question: setup looks first (reads only), prints one path
 * list grouped by purpose (install, connect, agents, background service and `bridge://` handler),
 * asks `Set up bridge for <app> at <origin>?` once, then runs each step as `--yes` would, each step
 * rechecking its own plan before it writes. Steps already done are left out; with nothing left to
 * consent to there is no question. Then it waits for the runner and enrolls the browser.
 *
 * Trust rules, in the order a reviewer would walk them:
 *  - the grouped path list is printed before the question, with or without `--yes`; `--json` emits it
 *    as one `need_approval` event with the groups;
 *  - a "no" writes nothing (`cancelled`); `--from-link` (passed by the `bridge://setup` handler, so a
 *    web page started this run) makes the question default to no;
 *  - without a terminal (or with `--json`) and without `--yes`, nothing is asked and nothing is
 *    written: setup stops before the first write;
 *  - agents: for claude and codex whose own command is on PATH, the consent covers bridge's adapter
 *    and a separate sign-in into bridge's own folder (never a copy of the person's login); the sign-in
 *    needs a terminal, else it is reported as `agent_login_required`;
 *  - the browser: on an interactive run, the first trust request after setup itself opened the enroll
 *    link is trusted without the four words (they are printed with the revoke command), and the code
 *    and link are not printed unless the open fails. Every other case asks the words: `deps.confirm`
 *    on a terminal, `bridge enroll approve --words` from another process otherwise (the agent must
 *    ask the person for the words). `--yes` never answers them;
 *  - the origin printed is the origin connected (one discovery document), and the enroll link is
 *    `<that origin><enrollPage>#code=...` where `enrollPage` is a path checked on the same origin;
 *  - nothing here takes a value from a `bridge://` link beyond the origin `handle-url` passes.
 */
export async function runSetup(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, {
    service: { type: "boolean" },
    foreground: { type: "boolean" },
    "no-install": { type: "boolean" },
    "no-open": { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
    plan: { type: "boolean" },
    // Hidden: what the bridge:// handler passes.
    "from-link": { type: "boolean" },
  });
  if (positionals.length !== 1) throw new UsageError(USAGE);
  if (values.service && values.foreground) throw new UsageError("--service and --foreground exclude each other");
  const json = values.json === true;
  const yes = values.yes === true;
  const { say, emit } = voiceOf(deps, json);
  // Output of the pieces we reuse: in --json mode their text goes to stderr and stdout stays JSON lines.
  const textDeps: CliDeps = json ? { ...deps, stdout: deps.stderr } : deps;
  const stop = (code: string, message: string, exit = 1): number => {
    deps.stderr(`bridge setup: ${message}\n`);
    emit({ event: "error", code, message });
    return exit;
  };

  if (isWindows(deps)) {
    return stop("unsupported_platform", "Windows is not supported. Run bridge in WSL2 (https://learn.microsoft.com/windows/wsl/install) and set up there.");
  }
  const url = appUrlOf(positionals[0]!);
  // Before discovery, any consent or any write, also under --plan: an older layout is refused, never migrated.
  try {
    await assertNoLegacyLayout(deps);
  } catch (error) {
    if (error instanceof LegacyLayoutError) return stop("legacy_layout", error.message);
    throw error;
  }
  const found = await discoverApp(url, deps);
  if (!found.ok) return stop(found.code, found.message);
  const { discovery } = found;
  const appName = printable(discovery.app.name);
  const appId = discovery.app.id;
  say(`bridge ${CLI_VERSION}: setting up ${appName} (${appId}) at ${discovery.origin}\n`);

  const interactive = isTTYOf(deps) && !json;
  const setting = servicePromptDefault(await setupConfigOf(deps, appId));
  const mode = values.service ? "service" : values.foreground ? "foreground" : undefined;

  // --- look: reads only -----------------------------------------------------------------
  const noInstall = values["no-install"] === true;
  const launcherBefore = await launcherStateOf(deps);
  const baseSet = installBaseDir(deps, CLI_VERSION).dir;
  const installPlan = selfInstallPlan(deps, baseSet !== undefined ? { from: baseSet } : {});
  const installState = noInstall ? "skipped" : (await launchersCurrentFor(deps, installPlan.version)) ? "current" : "needed";
  const listed = (await loadApps(deps)).find((a) => a.appId === appId);
  // A local app of this id has no tokens or relay to compare: it is not "the same app", and connecting refuses its id (origin_conflict).
  const existing = listed !== undefined && !isLocalApp(listed) ? listed : undefined;
  // The bounded keychain probe comes before the first keychain read (`loadTokens` below is an unbounded call) and before any
  // question or write: a store that is missing or silent is refused here, and the sign-in is asked only after this.
  const keychain = await keychainUsability(deps);
  if (!keychain.usable) return stop("keychain_unusable", `${keychainHint(keychain)}. Nothing was changed.`);
  const tokens = existing ? await loadTokens(credentialsOf(deps), tokenKey(appId)).catch(() => null) : null;
  // The runner reports the stored runner id as revoked: the server refuses it for good, so the app is connected again
  // (connect picks a new id) instead of setup stopping on "revoked".
  const revokedLink = existing !== undefined && (await linkRevoked(deps, existing));
  const sameApp =
    existing !== undefined &&
    tokens !== null &&
    !revokedLink &&
    existing.origin === discovery.origin &&
    existing.relayUrl === discovery.relayUrl &&
    JSON.stringify(existing.auth) === JSON.stringify(discovery.auth);
  // A connect with a new runner id deletes what an earlier connection of this app left in its folder: part of the consent.
  const staleFiles = !sameApp && (existing === undefined || revokedLink) ? (await staleStateOf(deps, appId)).files : [];
  const serviceExists = await serviceInstalled(deps);
  const servicePaths = planPaths(servicePlanOf(deps));
  const handler = await protocolHandlerReport(deps);
  const handlerRegistered = handler.supported && handler.desktopFile === true && handler.mimeapps === "both";
  const handlerPaths = handler.supported ? protocolHandlerPaths(deps).map((e) => e.path) : [];
  const appPaths = appPathsOf(deps, appId);
  const workDir = appPaths.workDir;

  // Agents: claude and codex whose own command is on PATH get bridge's adapter and a separate sign-in into bridge's
  // folder when they lack them. Never a copy of the person's login: a copy shares the grant and can sign them out.
  const reports = await adapterReports(deps);
  const looks: AgentLook[] = [];
  for (const agent of AGENT_NAMES) {
    const report = reports.find((r) => agentNameOfAdapter(r.id) === agent);
    looks.push({
      agent,
      onPath: agentOnPath(deps, agent),
      adapter: report?.command !== undefined,
      login: report?.login?.present ?? (await agentLoginIsPresent(deps, agent).catch(() => false)),
    });
  }
  const adapterFor = looks.filter((l) => l.onPath && !l.adapter).map((l) => l.agent);
  const loginFor = looks.filter((l) => l.onPath && !l.login).map((l) => l.agent);
  const usableBefore = looks.filter((l) => l.adapter && l.login).map((l) => l.agent);
  const agentNotes = looks.map((l) => (l.adapter && l.login ? `${l.agent}: ready` : agentGap(l)));

  // The service and the handler: offered when the launcher they run will be there; `--foreground` offers neither.
  const launcherWillBeReady = !noInstall || (launcherBefore.kind === "ours" && !launcherBefore.dangling);
  const handlerOfferable = platformOf(deps) === "linux" && launcherWillBeReady && handler.supported && !handlerRegistered;
  const serviceOffered = !serviceExists && mode !== "foreground" && launcherWillBeReady;
  // With the service already there only the handler is left; with setup.service "ask", --yes does not answer that offer.
  const handlerOnly = serviceExists && mode !== "foreground" && handlerOfferable && !(setting === "ask" && yes);
  const handlerOffered = (serviceOffered && handlerOfferable) || handlerOnly;
  const askService = setting === "ask" && mode === undefined && (serviceOffered || handlerOnly);

  const steps: PlanStep[] = [
    { id: "install", state: installState, paths: installState === "needed" ? installPlan.paths : [] },
    {
      id: "connect",
      state: sameApp ? "connected" : "needed",
      paths: sameApp ? [] : [appsFilePath(deps), appPaths.appFile, appPaths.configDir, appPaths.dataDir, appPaths.stateDir, ...(credentialDirOf(deps) !== undefined ? [credentialDirOf(deps)!] : [])],
      note: `${revokedLink ? "the runner reports this machine as revoked: it connects again with a new runner id and its old trust list and identity are deleted; " : ""}the sign-in token goes to ${credentialStoreWhere(deps)}; the three bridge/ dirs are the app's own, their parents are created only when missing`,
    },
    {
      id: "agents",
      state: adapterFor.length + loginFor.length > 0 ? "needed" : usableBefore.length > 0 ? "ready" : "no_agent",
      paths: [...adapterFor.map((a) => adapterInstallPlan(deps, a).dir), ...loginFor.map((a) => agentDirOf(deps, a))],
      note: agentNotes.join("; "),
    },
    {
      id: "service",
      state: serviceExists ? "installed" : mode === "foreground" ? "foreground" : mode === "service" ? "service" : "offered",
      paths: serviceOffered ? servicePaths : [],
    },
    {
      id: "handler",
      state: !handler.supported ? "unsupported" : handlerRegistered ? "registered" : mode === "foreground" ? "foreground" : "offered",
      paths: handlerOffered ? handlerPaths : [],
    },
    { id: "enroll", state: "waits for the browser", paths: [workDir], note: "agent sessions start in this folder" },
  ];
  emit({ event: "plan", app: { appId, name: appName, origin: discovery.origin }, steps });
  if (values.plan) {
    if (!json) {
      for (const s of steps) {
        say(`${s.id}: ${s.state}${s.note ? ` (${s.note})` : ""}\n${s.paths.map((p) => `  ${p}\n`).join("")}`);
      }
      say("Nothing was written (--plan).\n");
    }
    return 0;
  }

  // Nothing can be asked without a terminal: stop before the first write instead of guessing consent.
  if (!yes && !interactive) {
    return stop(
      "consent_required",
      "setup asks before it writes. Run it in a terminal, or pass --yes once the person agreed to the paths listed by `--plan`.",
    );
  }
  // setup.service "ask": --yes does not choose for the person, and nobody can be asked without a terminal.
  if (askService && serviceOffered && (yes || !interactive)) {
    return stop("service_choice_required", "the setting setup.service is \"ask\": choose with --service or --foreground (or run in a terminal without --yes).");
  }
  if (mode === "service" && !launcherWillBeReady) {
    return stop("no_launcher", `--service needs the installed launcher at ${installPlan.launcherLink} (run without --no-install)`);
  }

  // --- the one consent ------------------------------------------------------------------
  const groups: ConsentGroup[] = [];
  if (installState === "needed") groups.push({ id: "install", what: `install bridge ${installPlan.version} for this user`, paths: installPlan.paths });
  if (!sameApp) {
    const connect = steps.find((s) => s.id === "connect")!;
    groups.push({
      id: "connect",
      what: `connect this machine to ${appName} at ${discovery.origin} (you sign in in the browser; the token goes to ${credentialStoreWhere(deps)})`,
      paths: connect.paths,
      ...(staleFiles.length > 0 ? { deletes: staleFiles } : {}),
    });
  }
  if (adapterFor.length + loginFor.length > 0) {
    const parts = [
      ...adapterFor.map((a) => `bridge's ${a} adapter (${ADAPTER_KINDS[a].size} from the npm registry)`),
      ...loginFor.map((a) => `a separate ${a} sign-in for bridge, kept in bridge's folder (your own ~/.${a} is not touched)`),
    ];
    groups.push({ id: "agents", what: `agents: ${parts.join("; ")}`, paths: steps.find((s) => s.id === "agents")!.paths });
  }
  if (serviceOffered || handlerOnly) {
    const what = serviceOffered
      ? handlerOffered
        ? "run the runner as a background service, and register the bridge:// handler the page's Start button uses"
        : "run the runner as a background service"
      : "register the bridge:// handler the page's Start button uses";
    groups.push({ id: "service", what, paths: [...(serviceOffered ? servicePaths : []), ...(handlerOffered ? handlerPaths : [])] });
  }
  const unready = looks.filter((l) => !l.onPath && !(l.adapter && l.login));
  if (groups.length > 0) {
    emit({ event: "need_approval", what: `set up bridge for ${appName} at ${discovery.origin}`, groups, paths: groups.flatMap((g) => g.paths) });
    say(
      `To set up bridge for ${appName}, these paths will be written:\n` +
        groups
          .map((g) => `  ${g.what}:\n${g.paths.map((p) => `    ${p}\n`).join("")}${(g.deletes ?? []).map((p) => `    ${p}  (DELETED: left by an earlier connection of this app)\n`).join("")}`)
          .join(""),
    );
    if (unready.length > 0) say(`Not set up here: ${unready.map(agentGap).join("; ")}.\n`);
    const question = `Set up bridge for ${appName} at ${discovery.origin}?`;
    const answer = yes || (await deps.confirm(question, { default: values["from-link"] ? "no" : askService ? "none" : "yes" }));
    if (!answer) return stop("cancelled", "cancelled; nothing was written");
  }

  // --- install ----------------------------------------------------------------------------
  if (!noInstall) {
    try {
      await selfInstall(textDeps, { consented: true });
    } catch (error) {
      return stop("install_failed", errorMessage(error));
    }
  }
  const launcher = await launcherStateOf(deps);
  const launcherReady = launcher.kind === "ours" && !launcher.dangling;
  if (!launcherReady && mode === "service") {
    return stop("no_launcher", `--service needs the installed launcher at ${installPlan.launcherLink} (run without --no-install)`);
  }
  if (!launcherReady) say(`No installed launcher at ${installPlan.launcherLink}: the background service and the bridge:// handler need one, so the runner stays in this terminal.\n`);

  // --- connect ----------------------------------------------------------------------------
  let app: HostedAppRecord;
  if (sameApp) {
    say(`Already connected to ${appName}.\n`);
    // This run uses the name and enroll page discovery just gave (the stored ones may be stale, or
    // an enroll page off the app's origin); apps.json is not written. `bridge connect` updates it.
    const { enrollPage: _stored, ...rest } = existing!;
    app = { ...rest, name: appName, ...(discovery.enrollPage !== undefined ? { enrollPage: discovery.enrollPage } : {}) };
  } else {
    const connected = await connectApp(url, deps, { yes: true, consented: true, open: !values["no-open"], json, label: "bridge setup", discovered: found });
    if (!connected.ok) return 1;
    app = connected.app;
  }

  // --- agents: bridge's adapter and its own sign-in, never ~/.claude or ~/.codex --------------
  // A failure is reported with the command that does it later; setup goes on (the runner works without an agent).
  const done = { adapter: new Set<AgentName>(), login: new Set<AgentName>() };
  for (const agent of adapterFor) {
    try {
      const installed = await installAdapter(textDeps, agent, { consented: true });
      if (installed.outcome !== "cancelled") done.adapter.add(agent);
    } catch (error) {
      say(`The ${agent} adapter was not installed: ${errorMessage(error)}. Later: \`${ADAPTER_KINDS[agent].command}\`.\n`);
    }
  }
  if (loginFor.length > 0 && interactive) {
    for (const agent of loginFor) {
      say(`${agent}: signing in for bridge (its login goes to ${agentLoginFileOf(deps, agent)}).\n`);
      let outcome: string;
      try {
        outcome = await loginInBridgeFolder(textDeps, agent, { consented: true });
      } catch (error) {
        say(`${errorMessage(error)}\n`);
        outcome = "failed";
      }
      if (outcome === "done") done.login.add(agent);
      else say(`No ${agent} login for bridge yet. Later: \`bridge agent login ${agent} --login\`.\n`);
    }
  } else if (loginFor.length > 0) {
    // The agent's sign-in is the person's, in a terminal: nothing here can run it.
    emit({ event: "agent_login_required", agents: loginFor, command: "bridge agent login <agent> --login" });
    say(`No agent login in bridge's own folder for ${loginFor.join(", ")}. Later, in a terminal: ${loginFor.map((a) => `\`bridge agent login ${a} --login\``).join(", ")}.\n`);
  }
  const usable = looks.filter((l) => (l.adapter || done.adapter.has(l.agent)) && (l.login || done.login.has(l.agent))).map((l) => l.agent);
  const missing = looks
    .filter((l) => !usable.includes(l.agent))
    .map((l) => agentGap({ ...l, adapter: l.adapter || done.adapter.has(l.agent), login: l.login || done.login.has(l.agent) }));
  /** The last line: "Ready" only when an agent can run; otherwise what is missing. */
  const readyLine = (ok: string, paired: string): string =>
    usable.length > 0 ? `Ready: ${ok}\n` : `${paired}, but no coding agent is ready on this machine (${missing.join("; ")}).\n`;

  // --- the service and the bridge:// handler ----------------------------------------------
  const handlerLater = "The page's Start button needs it; register it later with `bridge protocol install`.";
  let useService = serviceExists;
  if (mode === "foreground" && platformOf(deps) === "linux" && launcherReady && handler.supported && !handlerRegistered) {
    say(`Not registering the bridge:// handler (--foreground). ${handlerLater}\n`);
  }
  if (serviceExists) {
    say("The background service is already installed.\n");
    if (mode === "foreground") {
      say("--foreground is ignored while the background service is installed: the service runs the runner. To run it in a terminal instead, remove the service with `bridge service uninstall` and run setup again.\n");
    } else if (handlerOnly && launcherReady) {
      try {
        await installProtocolHandler(textDeps, { consented: true });
      } catch (error) {
        say(`The bridge:// handler was not registered: ${errorMessage(error)}\n`);
      }
    } else if (handlerOfferable) {
      // setup.service is "ask": --yes does not answer the offer.
      say(`The bridge:// handler was not registered: with setup.service "ask", --yes does not answer that offer. ${handlerLater}\n`);
    }
  } else if (serviceOffered && launcherReady) {
    // The handler's plan is bound now and executed only if it is unchanged after the service (installProtocolHandler recomputes it once).
    let handlerPlan: ProtocolInstallPlan | undefined;
    if (handlerOffered) {
      try {
        handlerPlan = await protocolInstallPlan(deps);
      } catch (error) {
        say(`The bridge:// handler cannot be registered: ${errorMessage(error)}\n`);
      }
    }
    // The one consent above covered it: the hook replaces the service's own list and question (its plan is still rechecked).
    const code = await runService(["install", ...(json ? ["--json"] : [])], deps, { ask: async () => true });
    if (code !== 0) return stop("service_failed", "the background service could not be installed (see above)");
    useService = true;
    if (handlerPlan) {
      try {
        await installProtocolHandler(textDeps, { consented: true, installPlan: handlerPlan });
      } catch (error) {
        say(`The bridge:// handler was not registered: ${errorMessage(error)}\n`);
      }
    }
  }
  if (platformOf(deps) === "darwin" && launcherReady) {
    say(`To restart the runner later, paste this in a terminal: ${installPlan.launcherLink} run\n`);
  }

  // --- the runner -------------------------------------------------------------------------
  const controller = new AbortController();
  let runnerExit: number | undefined;
  let runner: Promise<number> | undefined;
  const stopSignals = (): void => controller.abort();
  /** Ctrl-C (or the injected signal, which may already be aborted) stops the runner and the enroll wait. */
  const listenForStop = (): void => {
    if (deps.signal?.aborted) stopSignals();
    else if (deps.signal) deps.signal.addEventListener("abort", stopSignals, { once: true });
    else {
      process.once("SIGINT", stopSignals);
      process.once("SIGTERM", stopSignals);
    }
  };
  const cleanup = async (): Promise<void> => {
    process.off("SIGINT", stopSignals);
    process.off("SIGTERM", stopSignals);
    deps.signal?.removeEventListener("abort", stopSignals);
    if (runner) {
      controller.abort();
      await runner.catch(() => undefined);
    }
  };

  /** The foreground runner keeps going until Ctrl-C (or its idle stop); its exit code is setup's. */
  const finish = async (): Promise<number> => {
    if (!runner) return 0;
    say("The runner stays in this terminal; press Ctrl-C to stop it.\n");
    try {
      return await runner;
    } finally {
      process.off("SIGINT", stopSignals);
      process.off("SIGTERM", stopSignals);
    }
  };

  const running = await readRunnerStatus(deps);
  // A runner that started before the record was last written holds an older runner id, whatever its link reports now.
  const staleIdentity = running !== undefined && startedBeforeRecord(running, app.connectedAt);
  if (useService && !serviceExists) {
    // Installed just now: its activation (enable --now) is starting the runner.
    say("Waiting for the service to start the runner.\n");
  } else if (running && staleIdentity) {
    // It started before the record's current runner id existed (it may be parked on the revoked one, or retrying it): only a new start reads the new record.
    if (!useService) {
      return stop("runner_restart_required", `the running bridge (pid ${running.pid}) started before the current identity of ${appName} was stored; stop it and run \`bridge setup\` again, or run it as a service`);
    }
    say(`The running bridge (pid ${running.pid}) started before the current identity of ${appName} was stored: restarting it.\n`);
    const restarted = await startService(deps, true);
    if (!restarted.ok) return stop("service_failed", restarted.error);
  } else if (running && running.apps[appId] !== undefined) {
    say(`The runner is already running (pid ${running.pid}).\n`);
  } else if (running) {
    // It started before this app was connected: it serves a fixed list of apps.
    if (!useService) {
      return stop("runner_restart_required", `the running bridge (pid ${running.pid}) does not serve ${appName} yet; stop it and run \`bridge setup\` again, or run it as a service`);
    }
    const restarted = await startService(deps, true);
    if (!restarted.ok) return stop("service_failed", restarted.error);
  } else if (serviceExists) {
    // Installed earlier and stopped (idle stop, logout): start it.
    const started = await startService(deps);
    if (!started.ok) return stop("service_failed", started.error);
  } else if (!useService) {
    listenForStop();
    say("Starting the runner in this terminal.\n");
    runner = runRun([], { ...textDeps, signal: controller.signal }).then(
      (code) => (runnerExit = code),
      (error: unknown) => {
        deps.stderr(`bridge setup: the runner stopped: ${errorMessage(error)}\n`);
        return (runnerExit = 1);
      },
    );
  }

  const online = await waitOnline(deps, appId, () => runnerExit, app.connectedAt);
  if (online !== "online") {
    await cleanup();
    return stop(
      online === "exited" ? "runner_exited" : online === "timeout" ? "runner_not_online" : `runner_${online}`,
      online === "timeout"
        ? `the runner did not show ${appName} online in time; check \`bridge status\` and \`bridge doctor\``
        : online === "exited"
          ? "the runner stopped before it was online (see above)"
          : `the runner reports ${appName} as ${online}; run \`bridge status\``,
    );
  }

  // --- enroll the browser -----------------------------------------------------------------
  const e2ee = e2eeOf(deps);
  const e2eeApp = e2eeAppOf(app, deps);
  const trusted = await e2ee.listBrowsers(e2eeApp).then((list) => list.length, () => 0);
  if (trusted > 0) {
    // No question: another browser is paired with `bridge enroll`, which always compares the words.
    say(readyLine(`${trusted} browser(s) already trusted for ${appName}.`, `${trusted} browser(s) already trusted for ${appName}`));
    say(`To pair another browser, run \`bridge enroll ${appId} --open\`.\n`);
    emit({ event: "ready", status: "already_trusted", trustedBrowsers: trusted });
    return finish();
  }

  const opening: Promise<boolean>[] = [];
  /** Whether setup opened the enroll link itself and the opener reported no error; undefined when it did not try. */
  let opened: Promise<boolean> | undefined;
  let requests = 0;
  let autoTrusted: string | undefined;
  const prompt: EnrollPrompt = {
    showCode(code, expiresAt) {
      const link = enrollLinkOf(app, code);
      emit({ event: "enroll_code", ...(link ? { url: link } : {}), code, expiresAt });
      if (link && !values["no-open"]) {
        // On a terminal the code and the link are not printed while the opener works: the page setup opens is the
        // one browser trusted without the words, so nobody should paste them elsewhere. A failed open prints them.
        say(interactive ? `Runner online. Opening ${appName}'s enroll page in your browser.\n` : `Runner online. Opening ${link}  (code: ${code}, expires ${expiresAt})\n`);
        opened = openUrlOf(deps)(link).then(
          () => true,
          () => {
            say(interactive ? `Could not open a browser. Open ${link}  (code: ${code}, expires ${expiresAt})\n` : `Could not open a browser. Open the link above yourself.\n`);
            return false;
          },
        );
        opening.push(opened);
      } else if (link) {
        say(`Runner online. Open ${link}  (code: ${code}, expires ${expiresAt})\n`);
      } else {
        say(`Runner online. ${appName} has no enroll page: enter this code on its page: ${code}  (expires ${expiresAt})\n`);
      }
    },
    async confirm({ label, keyId }, options) {
      const words = wordsOf(keyId);
      const shown = printable(label);
      const first = requests++ === 0;
      // The browser setup opened itself, on a terminal, and only the window's first request: trusted without the words.
      if (first && interactive && opened !== undefined && (await opened)) {
        say(`Trusting the browser '${shown}' that setup opened. Its page shows these four words:\n  ${words.join("  ")}\n`);
        autoTrusted = keyId;
        return true;
      }
      emit({ event: "trust_request", label: shown, words, keyId, instructions: WORDS_RULE });
      say(`Browser '${shown}' asks to be trusted. The page shows four words.\n  ${words.join("  ")}\n`);
      // The one human step. `--yes` is not read here. An agent may be driving the terminal: it gets the rule too.
      say(`${WORDS_RULE}\n`);
      if (interactive) return deps.confirm("Same words?", { default: "no" });
      say(
        `Then run: bridge enroll approve ${appId} --words "<the four words from the page>"\n` +
          `(or \`bridge enroll deny ${appId}\`). Waiting for the decision...\n`,
      );
      return confirmFromWindow(e2eeApp, { keyId }, options?.signal);
    },
  };

  if (!runner) {
    // A service or an already-running runner: setup still ends its own enroll wait on Ctrl-C.
    listenForStop();
  }
  try {
    // Ctrl-C ends the wait itself: the enroll window is closed and enroll rejects with `aborted`, so no
    // poll loop or trust prompt outlives setup.
    const outcome = await e2ee.enroll(e2eeApp, prompt, { signal: controller.signal });
    await Promise.all(opening);
    if (autoTrusted !== undefined && autoTrusted === outcome.browserKeyId) {
      say(`Not your browser? Revoke it: \`bridge browsers revoke ${appId} ${outcome.browserKeyId}\`\n`);
    }
    say(readyLine(`${appName} can use your coding agent on this machine from that browser.`, `Paired: ${appName} trusts that browser`));
    emit({ event: "ready", status: "paired", label: printable(outcome.label), keyId: outcome.browserKeyId });
  } catch (error) {
    await Promise.all(opening);
    await cleanup();
    if (error instanceof EnrollError && error.reason === "aborted") return stop("interrupted", "stopped before the browser was trusted");
    return stop(error instanceof EnrollError ? `enroll_${error.reason}` : "enroll_failed", errorMessage(error));
  }
  if (!runner) {
    process.off("SIGINT", stopSignals);
    process.off("SIGTERM", stopSignals);
    deps.signal?.removeEventListener("abort", stopSignals);
  }
  if (useService) {
    say("The runner starts at login and stops after 15 minutes with no browser connected; the page's Start button (bridge://run) starts it again.\n");
  }
  return finish();
}
