import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep the npm publication inventory separate from what a user's runner needs.
export function runnerClosure(packages, name = '@berdyh/bridge', seen = new Set()) {
  if (seen.has(name)) return seen;
  const pkg = packages.get(name);
  if (!pkg || pkg.private) throw new Error(`Missing publishable runtime package: ${name}`);
  seen.add(name);
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if (dep.startsWith('@berdyh/')) runnerClosure(packages, dep, seen);
  }
  return seen;
}

export function prepareRunnerSet(root, inventory, dest, version) {
  const packages = new Map();
  for (const name of fs.readdirSync(path.join(root, 'packages'))) {
    const file = path.join(root, 'packages', name, 'package.json');
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      packages.set(pkg.name, pkg);
    }
  }
  fs.mkdirSync(dest, { recursive: true });
  const names = [...runnerClosure(packages)].sort().map(name => {
    if (packages.get(name).version !== version) throw new Error(`Runtime version mismatch: ${name}`);
    return `${name.slice(1).replace('/', '-')}-${version}.tgz`;
  });
  const sums = names.map(name => {
    const bytes = fs.readFileSync(path.join(inventory, name));
    fs.writeFileSync(path.join(dest, name), bytes);
    return `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`;
  });
  fs.writeFileSync(path.join(dest, 'SHA256SUMS'), sums.join(''));
}

const SERVER_ONLY = ['@clerk/backend', '@neondatabase/serverless', 'hono', '@hono/node-server', 'ws'];
const ADAPTER = '@agentclientprotocol/claude-agent-acp';

/**
 * Server-only packages a bridge package (or the install root) reaches in an npm lockfile, as
 * requirer chains. The bundled adapter's own tree may hold some of them (hono comes with
 * @modelcontextprotocol/sdk, a peer of the Claude agent SDK); a path through the adapter is
 * allowed, any other is a leak. Every location counts, nested ones too (install-strategy=nested
 * puts them under their requirer), and requirers are matched by name, so the walk over-reports
 * rather than misses. A location is identified by the lockfile's `name` when it has one, so an
 * npm alias (`"x": "npm:hono@4"` installs at node_modules/x) still counts. `presentAtRoot` also
 * reports a root node_modules copy the lockfile omits.
 */
export function serverOnlyLeaks(lock, presentAtRoot = () => false) {
  const nameOf = key => key.replace(/^.*node_modules\//, '');
  const requirers = name => Object.entries(lock.packages)
    .filter(([, e]) => Object.hasOwn({ ...e.dependencies, ...e.optionalDependencies, ...e.peerDependencies }, name))
    .map(([key]) => key);
  const leaks = [];
  for (const name of SERVER_ONLY) {
    const locations = Object.keys(lock.packages).filter(key => key !== '' && (lock.packages[key].name ?? nameOf(key)) === name);
    if (presentAtRoot(name) && !locations.includes(`node_modules/${name}`)) locations.push(`node_modules/${name}`);
    for (const location of locations) {
      // Requirers name the folder (the alias, if any), not the package.
      const seen = new Set([nameOf(location)]);
      const queue = [[nameOf(location), location]];
      while (queue.length) {
        const [current, chain] = queue.shift();
        for (const key of requirers(current)) {
          if (key === '' || nameOf(key).startsWith('@berdyh/')) {
            leaks.push(`${key || '<root>'} -> ${chain}`);
            continue;
          }
          const next = nameOf(key);
          // The exemption goes by the lockfile's name too: an alias named like the adapter is not it.
          if ((lock.packages[key].name ?? next) === ADAPTER || seen.has(next)) continue;
          seen.add(next);
          queue.push([next, `${next} -> ${chain}`]);
        }
      }
    }
  }
  return [...new Set(leaks)];
}

// ---- Release hygiene: which version a pack carries -------------------------------------------
//
// One version means one set of bytes. A local pack (the default) is stamped `<base>-g<sha>` so
// two builds never share a version, and a lockfile that pinned the first build's integrity cannot
// go stale. A release run (`release`) keeps a plain `x.y.z`, which must be new: never one the tree
// or the registry already holds.

/** Every publishable `@berdyh/*` workspace package: its folder, manifest path and manifest. */
export function publishablePackages(root) {
  const out = [];
  for (const top of ['packages', 'examples']) {
    if (!fs.existsSync(path.join(root, top))) continue;
    for (const name of fs.readdirSync(path.join(root, top)).sort()) {
      const file = path.join(root, top, name, 'package.json');
      if (!fs.existsSync(file)) continue;
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pkg.name?.startsWith('@berdyh/') && !pkg.private) out.push({ dir: path.dirname(file), file, pkg });
    }
  }
  return out;
}

/** Dependencies before dependents (runtime, optional and peer edges between the packages). */
export function publishOrder(list) {
  const byName = new Map(list.map(p => [p.pkg.name, p]));
  const out = [];
  const seen = new Set();
  const visit = p => {
    if (seen.has(p.pkg.name)) return;
    seen.add(p.pkg.name);
    const edges = { ...p.pkg.dependencies, ...p.pkg.optionalDependencies, ...p.pkg.peerDependencies };
    for (const dep of Object.keys(edges).sort()) if (byName.has(dep)) visit(byName.get(dep));
    out.push(p);
  };
  for (const p of [...list].sort((a, b) => a.pkg.name.localeCompare(b.pkg.name))) visit(p);
  return out;
}

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  return r;
};
const must = (cmd, args, opts) => {
  const r = run(cmd, args, opts);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').toString().trim()}`);
  return (r.stdout ?? '').trim();
};

/** Hash of one untracked path: file bytes, a symlink's target, or a directory's entries (a nested repo). */
const hashPath = (hash, file) => {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) hash.update(`link ${fs.readlinkSync(file)}\0`);
  else if (st.isDirectory()) for (const name of fs.readdirSync(file).sort()) { hash.update(`dir ${name}\0`); hashPath(hash, path.join(file, name)); }
  else hash.update(fs.readFileSync(file));
};

/**
 * The commit a pack is cut from, and whether the tree differs from it, with a hash of how. Tracked
 * edits and untracked files (ignored ones excepted) both count: either can enter the build, so
 * either must change the version fingerprint, and `untracked` lists the latter for a release to refuse.
 */
export function gitInfo(root) {
  const git = (...args) => must('git', ['-C', root, ...args]);
  const sha = git('rev-parse', '--short=7', 'HEAD');
  const tracked = git('status', '--porcelain', '--untracked-files=no') !== '';
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort();
  const dirty = tracked || untracked.length > 0;
  let diffHash = null;
  if (dirty) {
    const hash = createHash('sha1').update(must('git', ['-C', root, 'diff', 'HEAD', '--binary']));
    for (const file of untracked) { hash.update(`\0untracked ${file}\0`); hashPath(hash, path.join(root, file)); }
    diffHash = hash.digest('hex').slice(0, 8);
  }
  return { sha, subject: git('log', '-1', '--format=%s'), full: git('rev-parse', 'HEAD'), dirty, tracked, untracked, diffHash };
}

/**
 * The version a pack carries. A release keeps the plain version. Anything else is a prerelease of
 * it: `g<sha>` (the `g` keeps an all-digit sha a valid semver identifier), and for a tree that
 * differs from its commit (edited, or with untracked files) also `dirty-<hash of the difference>`,
 * so edited trees do not share a version.
 */
export function packVersion(base, { sha, dirty = false, diffHash = null, release = false }) {
  if (release) return base;
  if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error(`Base version must be plain x.y.z: ${base}`);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`Not a commit sha: ${sha}`);
  return `${base}-g${sha}${dirty ? `.dirty-${diffHash}` : ''}`;
}

const cmpVersion = (a, b) => {
  const [x, y] = [a, b].map(v => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** A release version is plain x.y.z, above every version the tree holds, and unused in the registry. */
export function checkReleaseVersion(version, current, taken = []) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Release version must be plain x.y.z, not ${version}`);
  const held = [...new Set(current)];
  if (held.some(v => cmpVersion(version, v) <= 0)) throw new Error(`Release version ${version} must be above the tree's ${held.join(', ')}: a version is never reused`);
  if (taken.length) throw new Error(`Release version ${version} already exists in the registry for ${taken.join(', ')}`);
}

/**
 * The places a version lives. Each pattern must match exactly once, so a rename in the source is a
 * failure here and not a pack that quietly keeps the old version.
 */
const VERSION_SITES = [
  { file: 'packages/cli/src/version.ts', re: /(CLI_VERSION\s*=\s*)"[^"]*"/, to: v => `$1"${v}"` },
  { file: 'packages/runner/src/acp/proxy.ts', re: /(RUNNER_INFO\s*=\s*\{[^}]*version:\s*)"[^"]*"/, to: v => `$1"${v}"` },
  { file: 'scripts/install.sh', re: /^VERSION=\S+$/m, to: v => `VERSION=${v}`, plainOnly: true },
];

/**
 * Write `version` into every publishable manifest and the sources that repeat it. Returns
 * `restore()`, which puts the original bytes back. install.sh pins plain versions only (its
 * tarball-name check refuses a prerelease), so a prerelease stamp leaves it alone.
 */
export function stampVersion(root, version) {
  const plain = /^\d+\.\d+\.\d+$/.test(version);
  const saved = new Map();
  const rewrite = (file, re, to) => {
    const before = fs.readFileSync(file, 'utf8');
    const hits = before.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`));
    if (hits?.length !== 1) throw new Error(`Expected exactly one version in ${path.relative(root, file)}, found ${hits?.length ?? 0}`);
    if (!saved.has(file)) saved.set(file, before);
    fs.writeFileSync(file, before.replace(re, to));
  };
  const restore = () => { for (const [file, bytes] of saved) fs.writeFileSync(file, bytes); saved.clear(); };
  try {
    for (const p of publishablePackages(root)) rewrite(p.file, /^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
    for (const site of VERSION_SITES) if (plain || !site.plainOnly) rewrite(path.join(root, site.file), site.re, site.to(version));
  } catch (e) { restore(); throw e; }
  return restore;
}

export const integrityOf = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** The regular files of a gzipped npm tarball, as `{ path, mode, bytes }`, with the `package/` prefix removed. */
export function tarFiles(tgz) {
  const tar = gunzipSync(tgz);
  const field = (h, at, len) => h.subarray(at, at + len).toString('utf8').replace(/\0.*$/s, '');
  const files = [];
  let longName;
  for (let at = 0; at + 512 <= tar.length;) {
    const h = tar.subarray(at, at + 512);
    if (h.every(b => b === 0)) break;
    const size = parseInt(field(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? longName; continue; }
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    const prefix = field(h, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    longName = undefined;
    if (type !== '0') continue;
    files.push({ path: name.replace(/^package\//, ''), mode: parseInt(field(h, 100, 8).trim() || '0', 8) & 0o777, bytes: Buffer.from(body) });
  }
  return files;
}

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'];

/**
 * A package's content identity, which ignores the version the release step stamped: sha256 over
 * each file's path, mode and sha256, with the version written back to a placeholder. In
 * `package.json` that is `version` and every `@berdyh/*` dependency; in any other file, the quoted
 * version literal (`CLI_VERSION`, the runner's ACP info). Two packs with the same content id differ
 * only in their version, so an app can move its pin without re-reviewing the package.
 */
export function contentIdOf(tgz, version) {
  const PLACEHOLDER = '0.0.0-content';
  const lines = tarFiles(tgz).map(({ path: name, mode, bytes }) => {
    let normalized = bytes;
    if (name === 'package.json') {
      const pkg = JSON.parse(bytes.toString('utf8'));
      if (pkg.version === version) pkg.version = PLACEHOLDER;
      for (const key of DEPENDENCY_FIELDS) for (const dep of Object.keys(pkg[key] ?? {})) {
        if (dep.startsWith('@berdyh/') && pkg[key][dep] === version) pkg[key][dep] = PLACEHOLDER;
      }
      normalized = Buffer.from(JSON.stringify(pkg));
    } else {
      const text = bytes.toString('utf8');
      for (const q of ['"', "'"]) {
        if (text.includes(`${q}${version}${q}`)) normalized = Buffer.from(normalized.toString('utf8').split(`${q}${version}${q}`).join(`${q}${PLACEHOLDER}${q}`));
      }
    }
    return `${createHash('sha256').update(normalized).digest('hex')} ${mode.toString(8)} ${name}\n`;
  }).sort((a, b) => (a.slice(69) < b.slice(69) ? -1 : a.slice(69) > b.slice(69) ? 1 : 0));
  return `sha256-${createHash('sha256').update(lines.join('')).digest('hex')}`;
}

/** The note an app pins from: kit commit, version, and each package's integrity and content id. */
export function releaseNote({ version, date, commit, subject, registry, packs }) {
  const rows = packs.map(p => `| \`${p.name}\` | \`${p.integrity}\` | \`${p.contentId}\` |`);
  return [
    `### ${version} (${date}), kit commit \`${commit}\``,
    '',
    `Cut from \`${commit}\` (${subject}) and published to the local registry ${registry}. All ${packs.length} packages carry ${version} and nothing else. Pin by version and integrity. A package whose content id matches an earlier release differs from it only in the version:`,
    '',
    '| Package | Integrity | Content id |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

export const RELEASE_MARKER = '<!-- release notes, newest first -->';

export function addReleaseNote(doc, note) {
  if (!doc.includes(RELEASE_MARKER)) throw new Error('the release-notes file has no release-notes marker');
  return doc.replace(RELEASE_MARKER, `${RELEASE_MARKER}\n\n${note.trimEnd()}`);
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The release step publishes to a local registry only; npm's registry is a separate step that needs explicit confirmation. */
export function checkLocalRegistry(registry) {
  const url = new URL(registry);
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) throw new Error(`Refusing registry ${registry}: the release step publishes to a loopback registry only`);
  return url.origin;
}

const NPM_SCOPE = '@berdyh';

/**
 * Every npm call of the release step goes through here. Besides `--registry`, the `@berdyh` scope is
 * pinned to the same validated origin on the command line, which outranks the environment, a project
 * or user `.npmrc` and `--userconfig`: a scope mapping there cannot send a publish, lookup, download
 * or install to another registry.
 */
export function npmArgs(origin, args, { cache, npmrc } = {}) {
  return [...args, '--registry', origin, `--${NPM_SCOPE}:registry=${origin}`, ...(cache ? ['--cache', cache] : []), '--update-notifier=false', ...(npmrc ? ['--userconfig', npmrc] : [])];
}

/**
 * Whether the registry holds name@version. Only an explicit not-found (npm's E404) means it does
 * not; a failure of any other kind (unreachable, 5xx, auth, a crash) is an error, never "available".
 */
export function versionInRegistry(origin, name, version, npmOpts) {
  const r = run('npm', npmArgs(origin, ['view', `${name}@${version}`, 'version', '--json'], npmOpts));
  if (r.status === 0) return r.stdout.trim() !== '';
  let code;
  try { code = JSON.parse(r.stdout).error?.code; } catch { /* not npm's JSON error */ }
  if (code === 'E404') return false;
  throw new Error(`Could not look up ${name}@${version} in ${origin} (npm ${r.status === null ? `killed by ${r.signal}` : `exit ${r.status}`}${code ? `, ${code}` : ''}): ${(r.stderr || r.stdout || '').trim()}`);
}

function buildAll(root) {
  must('pnpm', ['run', 'build'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
}

/** Stamp, build and pack every publishable package at `version` into `dest`; restore the tree unless `keep`. */
export function packAll(root, version, dest, { keep = false, rebuild = false } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  const restore = stampVersion(root, version);
  const onSignal = () => { restore(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    buildAll(root);
    const list = publishOrder(publishablePackages(root));
    const packs = list.map(p => {
      must('pnpm', ['--dir', p.dir, 'pack', '--pack-destination', dest], { stdio: ['ignore', 'ignore', 'inherit'] });
      const file = `${p.pkg.name.slice(1).replace('/', '-')}-${version}.tgz`;
      const bytes = fs.readFileSync(path.join(dest, file));
      return { name: p.pkg.name, version, file, integrity: integrityOf(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), contentId: contentIdOf(bytes, version) };
    });
    fs.writeFileSync(path.join(dest, 'SHA256SUMS'), packs.map(p => `${p.sha256}  ${p.file}\n`).join(''));
    fs.writeFileSync(path.join(dest, 'packs.json'), JSON.stringify(packs, null, 2) + '\n');
    return packs;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (!keep) {
      restore();
      if (rebuild) buildAll(root);
    }
  }
}

/** Local packs of the tree as it is: a prerelease version naming the commit. */
export function localPacks(root, dest, opts) {
  const base = publishablePackages(root).find(p => p.pkg.name === '@berdyh/bridge').pkg.version;
  const info = gitInfo(root);
  const version = packVersion(base, info);
  return { version, info, packs: packAll(root, version, path.join(dest, version), opts) };
}

/**
 * The release step for apps: bump every package to one new version, build and pack, publish to the
 * local registry, check each tarball comes back with the same integrity, and, only when `notes` names
 * a release-notes file, add the release note naming the kit commit to it. Without `notes` no notes
 * file is read or written. Needs a clean head. Without `keep` the bump is reverted afterwards
 * (the note says which commit the version was cut from); with it the bump stays for the caller to commit.
 */
export function release(root, { version, registry, dest, npmrc, keep = false, notes }) {
  const origin = checkLocalRegistry(registry);
  const notesFile = notes ? path.resolve(root, notes) : undefined;
  // The notes file is checked before anything is packed or published, not after.
  if (notesFile) addReleaseNote(fs.readFileSync(notesFile, 'utf8'), '');
  const info = gitInfo(root);
  if (info.dirty) {
    const why = [info.tracked && 'tracked files differ from HEAD', info.untracked.length && `untracked files: ${info.untracked.slice(0, 5).join(', ')}${info.untracked.length > 5 ? ', ...' : ''}`].filter(Boolean);
    throw new Error(`A release needs a clean head: ${why.join('; ')}`);
  }
  const list = publishOrder(publishablePackages(root));
  const npmOpts = { cache: path.join(dest, '.npm-cache'), npmrc };
  const npm = (args, opts) => must('npm', npmArgs(origin, args, npmOpts), opts);
  const taken = list.filter(p => versionInRegistry(origin, p.pkg.name, version, npmOpts)).map(p => p.pkg.name);
  checkReleaseVersion(version, list.map(p => p.pkg.version), taken);
  const packs = packAll(root, version, path.join(dest, version), { keep, rebuild: true });
  for (const p of list) {
    const pack = packs.find(x => x.name === p.pkg.name);
    npm(['publish', path.join(dest, version, pack.file), '--access', 'public', '--tag', 'latest']);
  }
  // Each version comes back from the registry with the integrity of the pack it was cut from.
  const verify = path.join(dest, version, 'verify');
  fs.mkdirSync(verify, { recursive: true });
  for (const pack of packs) {
    npm(['pack', `${pack.name}@${version}`, '--pack-destination', verify]);
    const got = integrityOf(fs.readFileSync(path.join(verify, pack.file)));
    if (got !== pack.integrity) throw new Error(`Integrity mismatch for ${pack.name}@${version}: registry ${got}, pack ${pack.integrity}`);
  }
  // And the 13 install together: npm resolves them from the registry to the same integrity.
  const deps = Object.fromEntries(packs.map(p => [p.name, version]));
  fs.writeFileSync(path.join(verify, 'package.json'), JSON.stringify({ private: true, dependencies: deps }, null, 2) + '\n');
  npm(['install', '--prefix', verify, '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
  const lock = JSON.parse(fs.readFileSync(path.join(verify, 'package-lock.json'), 'utf8'));
  for (const pack of packs) {
    const entry = lock.packages[`node_modules/${pack.name}`];
    if (entry?.version !== version || entry.integrity !== pack.integrity) throw new Error(`Registry install of ${pack.name}@${version} resolved ${entry?.version} ${entry?.integrity}, expected ${pack.integrity}`);
  }
  const note = releaseNote({ version, date: new Date().toISOString().slice(0, 10), commit: info.full, subject: info.subject, registry: origin, packs });
  if (notesFile) fs.writeFileSync(notesFile, addReleaseNote(fs.readFileSync(notesFile, 'utf8'), note));
  fs.writeFileSync(path.join(dest, version, 'release.json'), JSON.stringify({ version, commit: info.full, registry: origin, packs }, null, 2) + '\n');
  return { version, info, packs };
}

/** The content id of a tarball, at the version its own package.json carries. */
export function contentIdOfFile(file) {
  const bytes = fs.readFileSync(file);
  const manifest = tarFiles(bytes).find(f => f.path === 'package.json');
  if (!manifest) throw new Error(`${file} has no package/package.json`);
  return contentIdOf(bytes, JSON.parse(manifest.bytes.toString('utf8')).version);
}

// node scripts/release-set.mjs local <dest> [--rebuild]
// node scripts/release-set.mjs content-id <tarball>...
// node scripts/release-set.mjs release <x.y.z> <dest> --registry <loopback url> [--npmrc <file>] [--keep] [--notes <file>]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [cmd, ...args] = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
  const has = name => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
  try {
    if (cmd === 'local') {
      const rebuild = has('--rebuild');
      if (args.length !== 1) throw new Error('usage: local <dest> [--rebuild]');
      const dest = path.resolve(args[0]);
      const r = localPacks(root, dest, { rebuild });
      console.log(`local packs ${r.version} (${r.packs.length}) in ${path.join(dest, r.version)}`);
    } else if (cmd === 'content-id') {
      if (!args.length) throw new Error('usage: content-id <tarball>...');
      for (const file of args) console.log(`${contentIdOfFile(path.resolve(file))}  ${path.basename(file)}`);
    } else if (cmd === 'release') {
      const registry = opt('--registry');
      const npmrc = opt('--npmrc');
      const keep = has('--keep');
      const notes = opt('--notes');
      const [version, dest] = args;
      if (!registry || !version || !dest) throw new Error('usage: release <x.y.z> <dest> --registry <url> [--npmrc <file>] [--keep] [--notes <file>]');
      const r = release(root, { version, registry, dest: path.resolve(dest), npmrc: npmrc && path.resolve(npmrc), keep, notes: notes && path.resolve(notes) });
      console.log(`released ${r.version} (${r.packs.length} packages) from ${r.info.full}; ${notes ? `note added to ${notes}` : 'no release note written (no --notes)'}`);
    } else {
      throw new Error('usage: release-set.mjs local <dest> | content-id <tarball>... | release <x.y.z> <dest> --registry <url>');
    }
  } catch (e) {
    console.error(`release-set: ${e.message}`);
    process.exitCode = 1;
  }
}
