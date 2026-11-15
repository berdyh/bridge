import { ENROLL_CODE_TTL_MS, parseEnrollFragment } from "@berdyh/bridge-protocol";
import type { EnrollLink, SetupInstructions, SetupInstructionsOptions } from "./contracts.js";

// A return consumes the link for this document. The first document leaves its saved copy
// for a sign-in navigation; a new document consumes and deletes that copy without extending it.
let returned = false;

/** Call before analytics, auth redirects or other application callbacks. Never enrolls by itself. */
export function consumeEnrollLink(): EnrollLink | undefined {
  const location = globalThis.location;
  if (!location) return undefined;
  const hash = location.hash;
  const hasEnrollFields = /(?:^#?|&)(?:code|runner)=/.test(hash);
  if (hasEnrollFields) {
    // First observable side effect: scrub even malformed enrollment fragments. If this
    // fails, throw rather than hand a code to application code while it is still in the URL.
    globalThis.history.replaceState(globalThis.history.state, "", location.pathname + location.search);
  }
  const storageKey = `__bridge/enrollLink:${location.pathname}`;
  let storage: Storage | undefined;
  try { storage = globalThis.sessionStorage; } catch { /* Storage may be disabled. */ }
  if (hasEnrollFields) {
    const link = parseEnrollFragment(hash);
    try { storage?.removeItem(storageKey); } catch { /* Best effort, like the save below. */ }
    if (!link) return undefined;
    if (returned) return undefined;
    returned = true;
    try { storage?.setItem(storageKey, JSON.stringify({ ...link, expiresAt: Date.now() + ENROLL_CODE_TTL_MS })); }
    catch { /* A valid URL link still works with storage disabled. */ }
    return link;
  }
  if (returned) return undefined;
  returned = true;
  try {
    const saved = storage?.getItem(storageKey);
    storage?.removeItem(storageKey);
    if (!saved) return undefined;
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== "object") return undefined;
    const { code, runnerId, expiresAt } = value as Record<string, unknown>;
    const now = Date.now();
    if (typeof code !== "string" || typeof runnerId !== "string" || typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + ENROLL_CODE_TTL_MS) return undefined;
    return parseEnrollFragment(`#code=${code}&runner=${runnerId}`);
  } catch { return undefined; }
}

/** Shell-quote untrusted URL arguments, including single quotes and shell substitutions. */
function argument(value: string): string {
  return /^[A-Za-z0-9:/._-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Pure setup copy. Without an explicit platform, use Linux (also the WSL2 path). */
export function setupInstructions(options: SetupInstructionsOptions & { appId?: string }): SetupInstructions {
  const url = new URL(options.appUrl);
  if (url.username || url.password || url.hash || url.search || !(url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("appUrl requires HTTPS (HTTP only on loopback), without credentials, query or fragment");
  }
  if (options.appId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.appId)) throw new Error("invalid appId");
  const target = argument(options.appUrl);
  // Existing CLI app selection accepts the origin as well as the discovery app id.
  const app = argument(options.appId ?? url.origin);
  if (options.cliVersion !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(options.cliVersion)) throw new Error("invalid cliVersion");
  if (options.registry !== undefined && !/^https?:\/\//.test(options.registry)) throw new Error("registry must be an http(s) URL");
  // Every emitted `npx` command shares this prefix, so a pin or registry reaches each step.
  const cli = ["npx", ...(options.registry === undefined ? [] : ["--registry", argument(options.registry)]),
    `@berdyh/bridge${options.cliVersion === undefined ? "" : `@${options.cliVersion}`}`].join(" ");
  // Unpinned copy keeps the bare launcher; a pin or registry also covers every later command, install step included.
  const bridge = options.cliVersion === undefined && options.registry === undefined ? "bridge" : cli;
  const oneLiner = `${cli} setup ${target}`;
  const restart = options.platform === "darwin"
    ? `If the runner is offline, paste \`${bridge} run\` into a terminal to restart it.`
    : `If the runner is offline, open bridge://run to restart it in a terminal, or paste \`${bridge} run\`.`;
  const steps = [
    `Paste \`${oneLiner}\` into a terminal to set up ${options.appName} (${url.origin}).`,
    "Setup lists every path it will write and asks one question. Then approve the device code on the app's sign-in page.",
    "It also installs bridge's adapter and runs a separate sign-in for bridge for claude or codex on your PATH; it never copies your own login.",
    'The runner runs as a background service unless you pass --foreground. With setup.service set to "ask", the question has no default.',
    "Setup opens the enroll page and trusts that browser without a question; the terminal shows its four words and how to revoke it. If no browser opens, compare the page's four words with the terminal's.",
    "Wait for ready. Agent sessions start in this app's work folder; add other project folders explicitly to policy.json.",
    "The runner notifies you when it starts and stops after 15 minutes without any app's browser connected.",
    restart,
  ];
  const troubleshooting = [
    { problem: "No runner is known", fix: `Run \`${oneLiner}\`. Install Node.js 22 or later and an agent with its login if doctor reports either missing.` },
    { problem: "Runner offline", fix: restart },
    { problem: "Online but this browser is not enrolled", fix: `Run \`${bridge} enroll ${app} --open\`, click to pair, and compare all four words. A revoked browser needs fresh enrollment.` },
    { problem: "Enrollment expired or sign-in lost the link", fix: `Run \`${bridge} enroll ${app} --open\` again. Codes expire after ten minutes; use the browser profile signed into this app.` },
    { problem: "Restart link does not open a terminal", fix: options.platform === "darwin" ? `macOS uses the paste fallback: \`${bridge} run\`.` : `Paste \`${bridge} run\`, or rerun setup to register the Linux protocol handler after reviewing its paths.` },
    { problem: "Windows", fix: "Windows is unsupported. Use WSL2 and follow the Linux setup steps." },
    { problem: "Setup or agent login failed", fix: `Run \`${bridge} doctor --json\` and review its reported prerequisites and paths.` },
  ];
  if (options.flavor === "human") return { flavor: "human", oneLiner, steps, troubleshooting };
  const agentPrompt = [
    `Set up the local bridge runner for ${options.appName} (${options.appUrl}) on this machine.`,
    `Use only the bridge CLI via \`${cli}\`; never edit ~/.config, ~/.local or service files yourself.`,
    "Show every exact path list and ask me before install or service writes and their --yes flags. The device-grant page confirms the app origin, so connect --yes is allowed. An agent passing --yes is not a human confirmation; the harness's command approval is an additional gate.",
    `1. Run \`${cli} doctor --json\` and report Node version, agents and logins. If a prerequisite is missing, stop and tell me what to install or log into. Windows is unsupported; suggest WSL2.`,
    `2. Run \`${oneLiner} --plan --json\`. Show its paths (including this app's work folder) and ask whether to install and run as a background service. Service is the default; setup.service: "ask" always asks explicitly.`,
    `3. On my install approval, run \`${bridge} self install --yes\`. Do not suppress its path list.`,
    `4. Run \`${bridge} connect ${target} --yes --open --json\`; tell me to approve the device code on ${url.origin}'s sign-in page and wait for completion.`,
    `5. On my service approval, run \`${bridge} service install --yes\` and tell me the runner started (it also shows a desktop notification). Otherwise run \`${bridge} run\` in the background with my agreement.`,
    `6. Run \`${bridge} enroll ${app} --open --json\`. Wait for trust_request. Ask me to read the four EFF words from the page, then run \`${bridge} enroll approve ${app} --words "<the four words I supplied>"\`. Never infer, invent or copy the terminal's words as my approval. A mismatch must not be approved.`,
    `7. Run \`${bridge} status --json\` and report whether this browser is ready. Agent sessions use the per-app work folder; other projects need an explicit policy.json addition.`,
    "The runner stops after 15 minutes with no app browser connected. " + restart,
  ].join("\n");
  return { flavor: "agent", oneLiner, steps, agentPrompt, troubleshooting };
}
