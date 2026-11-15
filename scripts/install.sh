#!/bin/sh
# Pinned release bootstrap. Release URLs are <base>/<version>/<artifact>.
set -eu
# Node writes compile-cache, coverage and warning files wherever these point, before consent too
# and never in the listed paths. NODE_OPTIONS (--cpu-prof, --prof, --report-*, ...) is cleared
# for the node runs before consent. npm after consent keeps it: install.sh answers for its own
# writes, and a person's own Node flags (proxy, CA, profiling) are theirs.
unset NODE_COMPILE_CACHE NODE_V8_COVERAGE NODE_REDIRECT_WARNINGS
VERSION=0.2.1
BASE=${BRIDGE_INSTALL_BASE:?set BRIDGE_INSTALL_BASE to the release base URL (https:// or file://)}
fail() { printf '%s\n' "bridge install: $*" >&2; exit 1; }
case $(uname -s) in
  Linux|Darwin) ;;
  *) fail 'Windows is unsupported; use WSL2. Only Linux and macOS are supported.' ;;
esac
command -v node >/dev/null 2>&1 || fail 'Node >= 22 is required. Install Node, then retry.'
NODE_OPTIONS= node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail 'Node >= 22 is required. Upgrade Node, then retry.'
command -v npm >/dev/null 2>&1 || fail 'npm is required.'
[ -n "${HOME:-}" ] && [ -d "$HOME" ] || fail 'HOME must name an existing directory.'
# Use the same XDG defaults as the CLI, rather than silently installing elsewhere.
DATA=${XDG_DATA_HOME:-$HOME/.local/share}
VERSIONS=$DATA/bridge/versions
DEST=$VERSIONS/$VERSION
CACHE=$HOME/.cache/bridge-install
LAUNCHER=$HOME/.local/bin/bridge
ALIAS=$(dirname "$LAUNCHER")/bridge-runner
# npm also reads cache and logs-dir from .npmrc files; the install passes both explicitly, so
# the paths printed below are the ones npm writes.
NPM_CACHE=${npm_config_cache:-$HOME/.npm}
NPM_LOGS=${npm_config_logs_dir:-$NPM_CACHE/_logs}
# Redirected bases are fine unless they alias another base
# or manifest directory. Only bridge-owned install directories must be real dirs.
NODE_OPTIONS= node --input-type=module - "$HOME" "$VERSIONS" "$DEST" "$(dirname "$LAUNCHER")" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const [home, versions, dest, bin] = process.argv.slice(2);
function resolved(p) {
  try { return fs.realpathSync(p); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const parent = path.dirname(p);
    if (parent === p) throw e;
    return path.join(resolved(parent), path.basename(p));
  }
}
function relation(a, b) {
  if (a === b) return 'same';
  const inside = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  if (inside(a, b)) return 'inside';
  if (inside(b, a)) return 'contains';
  return 'apart';
}
const data = path.dirname(path.dirname(versions));
const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
const state = process.env.XDG_STATE_HOME || path.join(home, '.local/state');
const service = process.platform === 'darwin' ? path.join(home, 'Library/LaunchAgents') : path.join(config, 'systemd/user');
const named = [data, config, state, bin, service, ...[data, config, state].map(p => path.join(p, 'bridge'))].map(p => path.resolve(p));
const real = named.map(resolved);
for (let i = 0; i < named.length; i++) for (let j = i + 1; j < named.length; j++) {
  if (relation(real[i], real[j]) !== 'apart' && relation(real[i], real[j]) !== relation(named[i], named[j])) {
    throw new Error(`Aliased layout: ${named[i]} (really ${real[i]}) and ${named[j]} (really ${real[j]}) overlap; refusing to install`);
  }
}
for (const p of [path.dirname(versions), versions, dest]) {
  try { if (!fs.lstatSync(p).isDirectory()) throw new Error(`Not a directory (symlink or other): ${p}`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
JS
# An older bridge layout (one shared config dir for every app, state under bridge/apps, an apps.json of
# full records) is refused before anything is listed or written: there is no migration. The same
# check the CLI makes (packages/cli/src/legacy.ts), here in sh because no CLI has run yet.
LEGACY=
CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}
STATE=${XDG_STATE_HOME:-$HOME/.local/state}
for marker in "$CONFIG/bridge/trust" "$CONFIG/bridge/identity" "$CONFIG/bridge/identity-key" "$CONFIG/bridge/enroll" "$STATE/bridge/apps" "$DATA/bridge/plugins" "$DATA/bridge/plugin-data"; do
  if [ -e "$marker" ] || [ -L "$marker" ]; then LEGACY="${LEGACY:+$LEGACY, }$marker"; fi
done
if [ -f "$CONFIG/bridge/apps.json" ] && NODE_OPTIONS= node -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(v !== null && typeof v === "object" && v.version !== 2 ? 0 : 1); } catch { process.exit(1); }' "$CONFIG/bridge/apps.json"; then
  LEGACY="${LEGACY:+$LEGACY, }$CONFIG/bridge/apps.json"
fi
[ -z "$LEGACY" ] || fail "an older bridge layout is present ($LEGACY); run the old \`bridge uninstall\`, then \`bridge setup <url>\`. There is no migrate command. Nothing was written."
printf 'bridge %s will write:\n  %s/\n  %s/.staging-%s-<random>/\n  %s\n  %s (the same program under another name)\n  %s/<temporary>/ (removed at exit)\n  npm cache: %s\n  npm logs: %s\n' "$VERSION" "$DEST" "$VERSIONS" "$VERSION" "$LAUNCHER" "$ALIAS" "$CACHE" "$NPM_CACHE" "$NPM_LOGS"
# No file or directory has been created yet. A pipe's stdin is script text, not consent.
if [ "${1:-}" = --yes ]; then
  shift
else
  printf 'Install these paths? [y/N] '
  if ! { read -r answer < /dev/tty; } 2>/dev/null; then fail 'No controlling terminal; rerun in a terminal or explicitly pass --yes.'; fi
  case $answer in y|Y|yes|YES) ;; *) fail 'Cancelled; nothing written.' ;; esac
fi
# Keep the terminal open for child commands too: under curl | sh, fd 0 is
# still the script pipe. Bootstrap consent does not imply setup consent.
TTY=0
if ( : < /dev/tty ) 2>/dev/null; then
  exec 3< /dev/tty
  TTY=1
fi
if [ "$#" -gt 0 ] && [ "$TTY" -eq 0 ]; then
  SETUP_YES=0
  for arg do
    case $arg in --) break ;; --yes) SETUP_YES=1 ;; esac
  done
  [ "$SETUP_YES" -eq 1 ] || fail 'No controlling terminal for setup; pass a separate setup --yes or run bridge setup in a terminal.'
fi
with_input() {
  if [ "$TTY" -eq 1 ]; then "$@" <&3; else "$@" < /dev/null; fi
}
umask 077
mkdir -p "$CACHE"
WORK=$(mktemp -d "$CACHE/download.XXXXXXXX")
STAGING=
cleanup() {
  [ -z "$STAGING" ] || rm -rf "$STAGING"
  rm -rf "$WORK"
}
trap cleanup 0
trap 'exit 1' HUP INT TERM
fetch() {
  case $BASE in
    file://*) cp "${BASE#file://}/$VERSION/$1" "$WORK/$1" ;;
    https://*) curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$BASE/$VERSION/$1" -o "$WORK/$1" ;;
    *) fail 'BRIDGE_INSTALL_BASE must be https:// or file://' ;;
  esac
}
fetch SHA256SUMS
# Validate all names before using them as URLs, paths or npm arguments.
node --input-type=module - "$WORK" "$VERSION" <<'JS'
import fs from 'node:fs';
const [dir, version] = process.argv.slice(2);
const lines = fs.readFileSync(`${dir}/SHA256SUMS`, 'utf8').trim().split('\n');
const seen = new Set();
for (const line of lines) {
  const m = /^([a-fA-F0-9]{64}) {2}(berdyh-[a-z0-9-]+-[0-9]+\.[0-9]+\.[0-9]+\.tgz)$/.exec(line);
  if (!m || !m[2].endsWith(`-${version}.tgz`) || seen.has(m[2])) throw new Error('Invalid SHA256SUMS');
  seen.add(m[2]);
}
// The hosted runner set is the CLI's production workspace closure, not the
// server/client/plugin SDK publication inventory.
const runtime = ['bridge', 'bridge-crypto', 'bridge-pairing', 'bridge-protocol', 'bridge-runner'];
if (seen.size !== runtime.length || runtime.some(n => !seen.has(`berdyh-${n}-${version}.tgz`))) throw new Error('Expected exactly the five runner tarballs');
fs.writeFileSync(`${dir}/names`, [...seen].join('\n') + '\n');
JS
while IFS= read -r name; do fetch "$name"; done < "$WORK/names"
node --input-type=module - "$WORK" <<'JS'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const dir = process.argv[2];
for (const line of fs.readFileSync(`${dir}/SHA256SUMS`, 'utf8').trim().split('\n')) {
  const [expected, name] = line.split('  ');
  if (createHash('sha256').update(fs.readFileSync(`${dir}/${name}`)).digest('hex') !== expected.toLowerCase()) throw new Error(`Checksum mismatch: ${name}`);
}
JS
if [ ! -e "$DEST" ]; then
  mkdir -p "$VERSIONS"
  STAGING=$(mktemp -d "$VERSIONS/.staging-$VERSION-XXXXXXXX")
  # The verified tarballs go in as a staging package.json, dependencies and overrides alike:
  # npm then resolves the @berdyh/* edges between them locally. Tarballs named on the command
  # line would still make npm ask the registry for those (unpublished) packages.
  node --input-type=module - "$WORK" "$VERSION" "$STAGING" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const [dir, version, staging] = process.argv.slice(2);
const deps = {};
for (const n of ['bridge', 'bridge-crypto', 'bridge-pairing', 'bridge-protocol', 'bridge-runner']) {
  deps[`@berdyh/${n}`] = `file:${path.resolve(dir, `berdyh-${n}-${version}.tgz`)}`;
}
fs.writeFileSync(`${staging}/package.json`, JSON.stringify({ private: true, dependencies: deps, overrides: deps }, null, 2) + '\n', { flag: 'wx' });
JS
  npm install --prefix "$STAGING" --cache "$NPM_CACHE" --logs-dir "$NPM_LOGS" --ignore-scripts --no-audit --no-fund
  [ -f "$STAGING/node_modules/@berdyh/bridge/bin/run.js" ] || fail 'Installed release has no CLI entry.'
  [ ! -e "$DEST" ] || fail 'Version appeared during install; retry.'
  # rename (unlike mv) never nests staging in a concurrently promoted release.
  node --input-type=module - "$STAGING" "$DEST" <<'JS'
import fs from 'node:fs';
const [staging, dest] = process.argv.slice(2);
try { fs.lstatSync(dest); throw new Error('Version appeared during install; retry.'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
fs.renameSync(staging, dest);
JS
  STAGING=
fi
with_input "$DEST/node_modules/.bin/bridge" self install --version "$VERSION" --yes
if [ "$#" -gt 0 ]; then with_input "$LAUNCHER" setup "$@"; fi
