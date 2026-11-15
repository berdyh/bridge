import { resolveApp } from "./config.js";
import { type CliDeps, UsageError, e2eeOf } from "./deps.js";
import { e2eeAppOf } from "./enroll.js";
import { assertNoLegacyLayout } from "./legacy.js";

/** A browser key id is 16 bytes of unpadded base64url, so 1 in 64 start with `-` and look like a flag. */
const KEY_ID_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/** This command takes no options: a dash-leading token is a positional if it is key-id shaped or follows `--`, else a usage error. */
function positionalsOf(args: string[]): string[] {
  const out: string[] = [];
  let literal = false;
  for (const arg of args) {
    if (!literal && arg === "--") literal = true;
    else if (!literal && arg.startsWith("-") && !KEY_ID_SHAPE.test(arg)) throw new UsageError(`unknown option '${arg}'`);
    else out.push(arg);
  }
  return out;
}

/** `bridge browsers list [<app>]` and `bridge browsers revoke [<app>] <browser-key-id>` (put `--` before an id that starts with `-`; it is also accepted without). */
export async function runBrowsers(args: string[], deps: CliDeps): Promise<number> {
  const [sub, ...rest] = positionalsOf(args);
  await assertNoLegacyLayout(deps);
  if (sub === "list" && rest.length <= 1) {
    const app = await resolveApp(deps, rest[0]);
    const browsers = await e2eeOf(deps).listBrowsers(e2eeAppOf(app, deps));
    if (browsers.length === 0) deps.stdout(`No trusted browsers for ${app.name}. Run \`bridge enroll\`.\n`);
    for (const b of browsers) deps.stdout(`${b.browserKeyId}\t${b.label}\tenrolled ${b.enrolledAt}\tlast seen ${b.lastSeen}\n`);
    return 0;
  }
  if (sub === "revoke" && (rest.length === 1 || rest.length === 2)) {
    const keyId = rest[rest.length - 1]!;
    const app = await resolveApp(deps, rest.length === 2 ? rest[0] : undefined);
    const revoked = await e2eeOf(deps).revokeBrowser(e2eeAppOf(app, deps), keyId);
    if (!revoked) {
      deps.stderr(`bridge browsers revoke: ${keyId} is not trusted for ${app.name}\n`);
      return 1;
    }
    deps.stdout(`Revoked ${keyId} for ${app.name}.\n`);
    return 0;
  }
  throw new UsageError("usage: bridge browsers list [<app>] | bridge browsers revoke [<app>] [--] <browser-key-id>");
}
