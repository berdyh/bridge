#!/usr/bin/env bash
# Release rehearsal. No publish/deploy; all mutable state stays under .ci-local.
# Two sets of packs come out of it:
#   .ci-local/pack/...        the release rehearsal, at the plain version (what install.sh pins);
#   .ci-local/pack-local/<v>/ the packs an app takes from this tree, at <version>-g<sha>, so two
#                             builds never share a version (a lockfile keeps one integrity per version).
# The release step for apps (bump, publish to the local registry, optional release note) is
# `node scripts/release-set.mjs release`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
CI="$ROOT/.ci-local"
export TMPDIR="$CI/tmp"
export npm_config_cache="$CI/npm-cache"
export npm_config_prefer_offline=true
export npm_config_loglevel=http
export npm_config_update_notifier=false
export npm_config_fetch_retries=0
export npm_config_fetch_timeout=15000
# The rehearsal never asks a registry whether a newer bridge exists (doctor and run would).
export BRIDGE_UPDATE_CHECK=0
mkdir -p "$TMPDIR" "$npm_config_cache"
# Stamped packs first: they build at the prerelease version and put the tree back, and the plain
# build below then leaves dist at the tree's own version for the rehearsal.
rm -rf "$CI/pack-local"
node scripts/release-set.mjs local "$CI/pack-local"
pnpm run build
VERSION=$(node -p 'require("./packages/cli/package.json").version')
PACK="$CI/pack/$VERSION"
INVENTORY="$CI/pack/all/$VERSION"
rm -rf "$CI/pack" "$CI/pack-homes"
mkdir -p "$PACK" "$INVENTORY" "$CI/pack-homes"
# Every publishable workspace package, including examples if publishable.
# A read loop, not mapfile: macOS ships bash 3.2.
PACKAGES=()
while IFS= read -r package; do PACKAGES+=("$package"); done < <(node --input-type=module -e "
import { publishablePackages } from './scripts/release-set.mjs';
for (const p of publishablePackages(process.cwd())) console.log(p.dir);
")
[ "${#PACKAGES[@]}" -gt 0 ] || { echo "no publishable packages found" >&2; exit 1; }
for package in "${PACKAGES[@]}"; do
  pnpm --dir "$package" pack --pack-destination "$INVENTORY"
done
node --input-type=module - "$INVENTORY" "$PACK" "$VERSION" <<'JS'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareRunnerSet } from './scripts/release-set.mjs';
const dir = process.argv[2];
const names = fs.readdirSync(dir).filter(n => n.endsWith('.tgz')).sort();
if (!names.length) throw new Error('No release tarballs');
fs.writeFileSync(`${dir}/SHA256SUMS`, names.map(n => `${createHash('sha256').update(fs.readFileSync(`${dir}/${n}`)).digest('hex')}  ${n}\n`).join(''));
prepareRunnerSet(process.cwd(), dir, process.argv[3], process.argv[4]);
JS
# A read-only root makes a successful rehearsal proof of write containment.
# The release gate runs on Linux; bootstrap itself also supports macOS.
command -v bwrap >/dev/null || { echo 'pack requires bubblewrap for write-containment verification' >&2; exit 1; }
contained() {
  bwrap --die-with-parent --ro-bind / / --dev /dev --proc /proc --bind "$CI" "$CI" -- "$@"
}
export BRIDGE_INSTALL_BASE="file://$CI/pack"
for mode in warm offline; do
  export HOME="$CI/pack-homes/$mode"
  export XDG_DATA_HOME="$HOME/.local/share"
  export XDG_CONFIG_HOME="$HOME/.config"
  export XDG_STATE_HOME="$HOME/.local/state"
  export XDG_CACHE_HOME="$HOME/.cache"
  # warm: a bare home (bridge setup creates every folder it needs; uninstall takes back bridge's own
  # entries and leaves the shared folders, empty); offline: the XDG folders exist, with neighbours
  # that must survive uninstall.
  if [ "$mode" = warm ]; then
    DECOY_DIRS=("$HOME")
  else
    DECOY_DIRS=("$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$HOME/.local/bin")
  fi
  mkdir -p "${DECOY_DIRS[@]}"
  for dir in "${DECOY_DIRS[@]}"; do
    printf 'keep\n' > "$dir/decoy"
  done
  # The tree before anything is installed (folders included): uninstall must restore it, but for the
  # shared folders bridge had to create, which stay, and must be empty.
  tree() {
    node --input-type=module - "$HOME" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const home = process.argv[2];
const out = [];
const walk = dir => {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    out.push(`${path.relative(home, p)}${st.isDirectory() ? '/' : ''}`);
    if (st.isDirectory()) walk(p);
  }
};
walk(home);
process.stdout.write(out.join('\n') + '\n');
JS
  }
  tree > "$CI/pack-tree-$mode.before"
  export npm_config_offline=false
  [ "$mode" != offline ] || export npm_config_offline=true
  LOG="$CI/pack-$mode.log"
  export npm_config_logs_dir="$CI/pack-logs-$mode"
  rm -rf "$npm_config_logs_dir"
  mkdir -p "$npm_config_logs_dir"
  install_code=0
  contained sh "$ROOT/scripts/install.sh" --yes > "$LOG" 2>&1 || install_code=$?
  # npm's http log must never request an unpublished workspace edge.
  scan_code=0
  grep -rEi 'http[[:space:]]+fetch.*https?://[^[:space:]]*(@berdyh|%40berdyh)' "$LOG" "$npm_config_logs_dir" || scan_code=$?
  if [ "$scan_code" -eq 0 ]; then
    echo 'Unexpected registry request for @berdyh/*' >&2; exit 1
  elif [ "$scan_code" -ne 1 ]; then
    echo 'Could not verify npm request logs' >&2; exit 1
  fi
  if [ "$install_code" -ne 0 ]; then cat "$LOG"; exit "$install_code"; fi
  BRIDGE="$HOME/.local/bin/bridge"
  test "$(contained "$BRIDGE" --version)" = "$VERSION"
  # setup's own install step after the handoff: no --version, the same file:// base in the
  # environment. The version is present, so it must only report it current, never read the base.
  contained "$BRIDGE" self install --yes > "$CI/pack-self-$mode.log" 2>&1 || { cat "$CI/pack-self-$mode.log"; exit 1; }
  grep -q 'already installed' "$CI/pack-self-$mode.log" || { cat "$CI/pack-self-$mode.log"; echo 'self install after the handoff did not find the installed version' >&2; exit 1; }
  # PATH is cut down so that an adapter the rehearsing machine has on its own PATH cannot hide a missing one.
  NODE_DIR="$(dirname "$(command -v node)")"
  contained env "PATH=$NODE_DIR:/usr/bin:/bin" "$BRIDGE" doctor --json > "$CI/pack-doctor-$mode.json"
  contained env "PATH=$NODE_DIR:/usr/bin:/bin" "$BRIDGE" doctor > "$CI/pack-doctor-$mode.txt"
  grep -q 'claude: no adapter installed; run `bridge agent install claude` (about 300 MB from the npm registry into ' "$CI/pack-doctor-$mode.txt" || { cat "$CI/pack-doctor-$mode.txt"; echo 'doctor did not give the install hint for the missing claude adapter' >&2; exit 1; }
  # Both launcher links are there (bridge and bridge-runner), and uninstall below takes both away.
  test -L "$HOME/.local/bin/bridge-runner" || { echo 'self install did not write the bridge-runner link' >&2; exit 1; }
  node --input-type=module - "$CI/pack-doctor-$mode.json" "$HOME" <<'JS'
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { serverOnlyLeaks } from './scripts/release-set.mjs';
const [report, home] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(report));
if (!d.install.dir?.startsWith(`${home}/`)) throw new Error('Install escaped fake home');
const require = createRequire(`${d.install.dir}/node_modules/@berdyh/bridge/package.json`);
const workspace = fs.readdirSync(`${d.install.dir}/node_modules/@berdyh`).sort();
if (JSON.stringify(workspace) !== JSON.stringify(['bridge', 'bridge-crypto', 'bridge-pairing', 'bridge-protocol', 'bridge-runner'])) throw new Error(`Unexpected runner workspace packages: ${workspace}`);
const leaks = serverOnlyLeaks(JSON.parse(fs.readFileSync(`${d.install.dir}/package-lock.json`)), name => fs.existsSync(`${d.install.dir}/node_modules/${name}`));
if (leaks.length) throw new Error(`Server-only dependency installed in runner: ${leaks.join('; ')}`);
// The install ships no adapter: bridge installs it on request (bridge agent install claude).
let shipped;
try { shipped = require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
if (shipped) throw new Error(`The install ships the claude adapter (${shipped}); it is installed on request`);
// @agentclientprotocol/sdk is the runner's own dependency; only the adapter and the Claude SDK it pulls in must be absent.
for (const name of ['@agentclientprotocol/claude-agent-acp', '@anthropic-ai/claude-agent-sdk']) {
  if (fs.existsSync(`${d.install.dir}/node_modules/${name}`)) throw new Error(`The install holds ${name}`);
}
if (fs.existsSync(`${d.install.dir}/node_modules/.bin/claude-agent-acp`)) throw new Error('The install holds the claude-agent-acp binary');
const claude = d.adapters.find(a => a.id === 'claude');
if (!claude || claude.available || 'command' in claude) throw new Error(`doctor reports a claude adapter in a fresh install: ${JSON.stringify(claude)}`);
JS
  contained "$BRIDGE" uninstall --yes
  # The tree from before the install, folders included (npm's cache is under $CI, not $HOME), plus
  # only shared folders: anything left inside one would be a new entry of its own and fail here.
  tree > "$CI/pack-tree-$mode.after"
  node --input-type=module - "$CI/pack-tree-$mode.before" "$CI/pack-tree-$mode.after" "$mode" <<'JS' || exit 1
import fs from 'node:fs';
const [beforeFile, afterFile, mode] = process.argv.slice(2);
const read = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
const before = read(beforeFile), after = read(afterFile);
const shared = new Set(['.cache/', '.config/', '.local/', '.local/bin/', '.local/share/', '.local/state/']);
const gone = before.filter(e => !after.includes(e));
const left = after.filter(e => !before.includes(e) && !shared.has(e));
if (gone.length || left.length) {
  console.error(`Uninstall did not restore the pre-install tree (${mode}): removed ${JSON.stringify(gone)}, left ${JSON.stringify(left)}`);
  process.exit(1);
}
// The bare home's install made these; they stay, empty.
if (mode === 'warm') for (const d of ['.local/', '.local/share/', '.local/bin/', '.cache/']) {
  if (!after.includes(d)) { console.error(`Uninstall removed the shared folder ${d} (warm)`); process.exit(1); }
}
JS
  for dir in "${DECOY_DIRS[@]}"; do
    [ "$(cat "$dir/decoy")" = keep ] || { echo "Uninstall damaged $dir/decoy" >&2; exit 1; }
  done
done
printf 'pack: PASS (warm and offline installs, doctor, no adapter in the install, uninstall)\n'
