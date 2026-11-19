import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import {
  runnerClosure, prepareRunnerSet, serverOnlyLeaks, publishablePackages, publishOrder, gitInfo, packVersion,
  checkReleaseVersion, stampVersion, integrityOf, tarFiles, contentIdOf, releaseNote, addReleaseNote, RELEASE_MARKER, checkLocalRegistry, npmArgs, release, versionInRegistry,
} from './release-set.mjs';

// A gzipped ustar archive of `files` ({ path, body, mode? }) under `package/`, like `pnpm pack`.
// Its source is also embedded in the fake pnpm below, so it uses only `require`d modules.
function tgzOf(files, gzip) {
  const blocks = [];
  for (const f of files) {
    const body = Buffer.from(f.body);
    const h = Buffer.alloc(512);
    const name = 'package/' + f.path;
    const put = (at, len, text) => h.write(text.slice(0, len), at, 'ascii');
    if (name.length > 100) { put(345, 155, name.slice(0, name.lastIndexOf('/', name.length - 1))); put(0, 100, name.slice(name.lastIndexOf('/') + 1)); }
    else put(0, 100, name);
    put(100, 8, (f.mode ?? 0o644).toString(8).padStart(7, '0'));
    put(108, 8, '0000000'); put(116, 8, '0000000');
    put(124, 12, body.length.toString(8).padStart(11, '0'));
    put(136, 12, '00000000000');
    h[156] = 48; put(257, 6, 'ustar'); put(263, 2, '00');
    h.fill(32, 148, 156);
    let sum = 0; for (const b of h) sum += b;
    put(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzip(Buffer.concat(blocks));
}

function fixture(t) {
  const scratch = path.resolve(import.meta.dirname, '../.ci-local/tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'release-set-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const release = `${dir}/release`;
  fs.mkdirSync(release);
  for (const name of ['bridge', 'bridge-runner', 'bridge-protocol', 'bridge-crypto']) {
    fs.writeFileSync(`${release}/berdyh-${name}-0.1.0.tgz`, name);
  }
  return { dir, release };
}
test('runner release contains only the production closure; full publication set stays separate', t => {
  const f = fixture(t);
  const repo = `${f.dir}/repo`;
  const pkgs = [
    { name: '@berdyh/bridge', dependencies: { '@berdyh/bridge-runner': 'workspace:*' }, devDependencies: { '@berdyh/bridge-server': 'workspace:*' } },
    { name: '@berdyh/bridge-runner', optionalDependencies: { '@berdyh/bridge-protocol': 'workspace:*' } },
    { name: '@berdyh/bridge-protocol', dependencies: { '@berdyh/bridge-runner': 'workspace:*', external: '1.0.0' } },
    { name: '@berdyh/bridge-server', dependencies: { hono: '1.0.0' } },
  ].map(pkg => ({ version: '0.1.0', ...pkg }));
  for (const pkg of pkgs) {
    const dir = `${repo}/packages/${pkg.name.split('/')[1]}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/package.json`, JSON.stringify(pkg));
  }
  const packages = new Map(pkgs.map(p => [p.name, p]));
  assert.deepEqual([...runnerClosure(packages)].sort(), pkgs.slice(0, 3).map(p => p.name).sort());
  const dest = `${f.dir}/runner-release`;
  prepareRunnerSet(repo, f.release, dest, '0.1.0');
  assert.deepEqual(fs.readdirSync(dest).sort(), ['SHA256SUMS', ...pkgs.slice(0, 3).map(p => `${p.name.slice(1).replace('/', '-')}-0.1.0.tgz`)].sort());
  assert.ok(fs.existsSync(`${f.release}/berdyh-bridge-crypto-0.1.0.tgz`));
  packages.delete('@berdyh/bridge-protocol');
  assert.throws(() => runnerClosure(packages), /Missing publishable runtime package/);
});

test('server-only packages: allowed through the adapter, refused from a bridge package at any depth', () => {
  const pkg = (dependencies = {}, extra = {}) => ({ version: '1.0.0', dependencies, ...extra });
  const lock = { packages: {
    '': pkg({ '@berdyh/bridge': 'file:x', '@berdyh/bridge-runner': 'file:y' }),
    'node_modules/@berdyh/bridge': pkg({ '@agentclientprotocol/claude-agent-acp': '1', '@berdyh/bridge-runner': '1' }),
    'node_modules/@berdyh/bridge-runner': pkg(),
    'node_modules/@agentclientprotocol/claude-agent-acp': pkg({ '@anthropic-ai/claude-agent-sdk': '1' }),
    'node_modules/@anthropic-ai/claude-agent-sdk': pkg({}, { peerDependencies: { '@modelcontextprotocol/sdk': '1' } }),
    'node_modules/@modelcontextprotocol/sdk': pkg({ hono: '4', '@hono/node-server': '1' }),
    'node_modules/@hono/node-server': pkg({}, { peerDependencies: { hono: '4' } }),
    'node_modules/hono': pkg(),
  } };
  assert.deepEqual(serverOnlyLeaks(lock), []);
  // install-strategy=nested: the copy sits under its requirer, not at the root.
  const nested = structuredClone(lock);
  nested.packages['node_modules/@berdyh/bridge-runner'].dependencies = { '@clerk/backend': '1' };
  nested.packages['node_modules/@berdyh/bridge-runner/node_modules/@clerk/backend'] = pkg();
  assert.deepEqual(serverOnlyLeaks(nested), ['node_modules/@berdyh/bridge-runner -> node_modules/@berdyh/bridge-runner/node_modules/@clerk/backend']);
  // Indirectly, through a package outside the adapter.
  const indirect = structuredClone(lock);
  indirect.packages['node_modules/@berdyh/bridge-runner'].dependencies = { '@modelcontextprotocol/sdk': '1' };
  assert.ok(serverOnlyLeaks(indirect).some(l => l.startsWith('node_modules/@berdyh/bridge-runner -> @modelcontextprotocol/sdk -> ')));
  // Under an npm alias the folder name hides the package; the lockfile's name does not.
  const aliased = structuredClone(lock);
  aliased.packages['node_modules/@berdyh/bridge-runner'].dependencies = { 'server-http': 'npm:hono@4' };
  aliased.packages['node_modules/server-http'] = { ...pkg(), name: 'hono' };
  assert.deepEqual(serverOnlyLeaks(aliased), ['node_modules/@berdyh/bridge-runner -> node_modules/server-http']);
  // An alias that borrows the adapter's folder name gets no exemption.
  const posing = structuredClone(lock);
  posing.packages['node_modules/@berdyh/bridge-runner'].dependencies = { '@agentclientprotocol/claude-agent-acp': 'npm:@modelcontextprotocol/sdk@1' };
  posing.packages['node_modules/@berdyh/bridge-runner/node_modules/@agentclientprotocol/claude-agent-acp'] = pkg({ hono: '4' }, { name: '@modelcontextprotocol/sdk' });
  assert.ok(serverOnlyLeaks(posing).some(l => l.startsWith('node_modules/@berdyh/bridge-runner -> @agentclientprotocol/claude-agent-acp -> ')));
  // A root copy the lockfile does not name is still attributed.
  const unlisted = structuredClone(lock);
  unlisted.packages[''].dependencies.ws = '8';
  assert.deepEqual(serverOnlyLeaks(unlisted, name => name === 'ws'), ['<root> -> node_modules/ws']);
});

// ---- release hygiene -------------------------------------------------------------------------

const realRoot = path.resolve(import.meta.dirname, '..');
const sites = ['packages/cli/src/version.ts', 'packages/runner/src/acp/proxy.ts', 'scripts/install.sh'];
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A tree shaped like the kit: the real files that repeat the version, copied, plus fixture manifests. */
function kitTree(t) {
  const f = fixture(t);
  const root = `${f.dir}/kit`;
  for (const file of sites) {
    fs.mkdirSync(path.dirname(`${root}/${file}`), { recursive: true });
    fs.copyFileSync(path.join(realRoot, file), `${root}/${file}`);
  }
  const pkgs = [
    { name: '@berdyh/bridge', dir: 'packages/cli', dependencies: { '@berdyh/bridge-runner': 'workspace:*' } },
    { name: '@berdyh/bridge-runner', dir: 'packages/runner', optionalDependencies: { '@berdyh/bridge-protocol': 'workspace:*' } },
    { name: '@berdyh/bridge-protocol', dir: 'packages/protocol' },
    { name: '@berdyh/bridge-sample-plugin', dir: 'examples/sample-plugin', private: true },
  ];
  for (const { dir, ...pkg } of pkgs) {
    fs.mkdirSync(`${root}/${dir}`, { recursive: true });
    fs.writeFileSync(`${root}/${dir}/package.json`, JSON.stringify({ name: pkg.name, version: '0.1.1', ...pkg }, null, 2) + '\n');
  }
  return { ...f, root };
}
const snapshot = root => Object.fromEntries([...sites, 'packages/cli/package.json', 'packages/runner/package.json', 'packages/protocol/package.json', 'examples/sample-plugin/package.json']
  .map(file => [file, fs.readFileSync(`${root}/${file}`, 'utf8')]));

test('a local pack of an unchanged tree gets a prerelease version containing the commit sha; a release keeps the plain version', t => {
  const f = fixture(t);
  const repo = `${f.dir}/repo`;
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(`${repo}/file`, 'one\n');
  git(repo, 'add', 'file');
  git(repo, 'commit', '-q', '-m', 'first');
  const sha = git(repo, 'rev-parse', '--short=7', 'HEAD');
  const clean = gitInfo(repo);
  assert.equal(clean.sha, sha);
  assert.equal(clean.dirty, false);
  const local = packVersion('0.1.1', clean);
  assert.ok(local.startsWith('0.1.1-') && local.includes(sha), local);
  assert.equal(local, packVersion('0.1.1', gitInfo(repo)), 'the same tree, the same version');
  assert.equal(packVersion('0.1.1', { ...clean, release: true }), '0.1.1');
  // An edited tree is a different pack, so it must not share the commit's version.
  fs.writeFileSync(`${repo}/file`, 'two\n');
  const dirty = gitInfo(repo);
  assert.equal(dirty.dirty, true);
  const edited = packVersion('0.1.1', dirty);
  assert.ok(edited.includes(sha) && edited !== local, edited);
  fs.writeFileSync(`${repo}/file`, 'three\n');
  assert.notEqual(packVersion('0.1.1', gitInfo(repo)), edited);
  // An all-digit sha still makes a valid semver prerelease (no numeric identifier with a leading zero).
  assert.equal(packVersion('0.1.1', { sha: '0123456' }), '0.1.1-g0123456');
  assert.throws(() => packVersion('0.1.1-x', { sha }), /plain x\.y\.z/);
});

test('a release version is plain, new to the tree and unused in the registry', () => {
  checkReleaseVersion('0.1.2', ['0.1.1', '0.1.1']);
  assert.throws(() => checkReleaseVersion('0.1.1', ['0.1.1']), /never reused/);
  assert.throws(() => checkReleaseVersion('0.1.0', ['0.1.1']), /never reused/);
  assert.throws(() => checkReleaseVersion('0.1.2-g1234567', ['0.1.1']), /plain x\.y\.z/);
  assert.throws(() => checkReleaseVersion('0.1.2', ['0.1.1'], ['@berdyh/bridge']), /already exists in the registry/);
  assert.equal(checkLocalRegistry('http://127.0.0.1:4873/'), 'http://127.0.0.1:4873');
  assert.throws(() => checkLocalRegistry('https://registry.npmjs.org/'), /loopback registry only/);
  assert.throws(() => checkLocalRegistry('http://registry.example.com'), /loopback registry only/);
});

test('publishable packages skip private ones and come in dependency order', t => {
  const { root } = kitTree(t);
  const list = publishablePackages(root);
  assert.deepEqual(list.map(p => p.pkg.name).sort(), ['@berdyh/bridge', '@berdyh/bridge-protocol', '@berdyh/bridge-runner']);
  assert.deepEqual(publishOrder(list).map(p => p.pkg.name), ['@berdyh/bridge-protocol', '@berdyh/bridge-runner', '@berdyh/bridge']);
});

test('stamping writes one version everywhere it lives and restore puts back the exact bytes', t => {
  const { root } = kitTree(t);
  const before = snapshot(root);
  // The patterns match the real sources (the files above are copies of them), once each.
  const restore = stampVersion(root, '0.1.2-gabcdef0');
  const stamped = snapshot(root);
  for (const p of publishablePackages(root)) assert.equal(p.pkg.version, '0.1.2-gabcdef0');
  assert.equal(JSON.parse(stamped['examples/sample-plugin/package.json']).version, '0.1.1', 'private packages are not published, nor stamped');
  assert.match(stamped['packages/cli/src/version.ts'], /CLI_VERSION = "0.1.2-gabcdef0"/);
  assert.match(stamped['packages/runner/src/acp/proxy.ts'], /RUNNER_INFO = \{ name: "bridge-runner", version: "0.1.2-gabcdef0" \}/);
  assert.equal(stamped['scripts/install.sh'], before['scripts/install.sh'], 'install.sh pins plain versions only');
  restore();
  assert.deepEqual(snapshot(root), before);
  // A release version also moves the installer's pin.
  const restoreRelease = stampVersion(root, '0.1.2');
  assert.match(fs.readFileSync(`${root}/scripts/install.sh`, 'utf8'), /^VERSION=0\.1\.2$/m);
  restoreRelease();
  assert.deepEqual(snapshot(root), before);
  // A source that no longer repeats the version in the expected place fails, and leaves nothing half-stamped.
  fs.writeFileSync(`${root}/packages/cli/src/version.ts`, 'export const CLI_VERSION = process.env.V;\n');
  const odd = snapshot(root);
  assert.throws(() => stampVersion(root, '0.1.2'), /Expected exactly one version in packages\/cli\/src\/version\.ts/);
  assert.deepEqual(snapshot(root), odd);
});

test('the release note names the kit commit and each package integrity, and goes under the marker', () => {
  const bytes = Buffer.from('tarball');
  const integrity = integrityOf(bytes);
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  const note = releaseNote({
    version: '0.1.2', date: '2026-11-05', commit: 'a'.repeat(40), subject: 'chore(release): 0.1.2', registry: 'http://127.0.0.1:4873',
    packs: [{ name: '@berdyh/bridge', integrity, contentId: 'sha256-' + '1'.repeat(64) }, { name: '@berdyh/bridge-runner', integrity, contentId: 'sha256-' + '2'.repeat(64) }],
  });
  assert.ok(note.includes('a'.repeat(40)) && note.includes('| `@berdyh/bridge-runner` |') && note.includes(integrity));
  assert.ok(note.includes('| Package | Integrity | Content id |') && note.includes(`| \`${integrity}\` | \`sha256-${'2'.repeat(64)}\` |`));
  const doc = `# Releases\n\n${RELEASE_MARKER}\n\n### 0.1.0 (old)\n`;
  const out = addReleaseNote(doc, note);
  assert.ok(out.indexOf('### 0.1.2') > out.indexOf(RELEASE_MARKER) && out.indexOf('### 0.1.2') < out.indexOf('### 0.1.0'));
  assert.throws(() => addReleaseNote('# no marker', note), /no release-notes marker/);
});

test('the content id ignores the stamped version and changes with any other byte, mode or path', () => {
  const pack = (version, { readme = '# kit\n', mode = 0o644, extra = [] } = {}) => tgzOf([
    { path: 'package.json', body: JSON.stringify({ name: '@berdyh/bridge-client', version, dependencies: { '@berdyh/bridge-protocol': version, other: '1.2.3' } }, null, 2) },
    { path: 'dist/version.js', body: `export const CLI_VERSION = "${version}";\n` },
    { path: 'dist/info.js', body: `export const info = { name: 'x', version: '${version}' };\n` },
    { path: 'README.md', body: readme, mode },
    ...extra,
  ], gzipSync);
  const a = pack('0.2.0-g1a2b3c4'), b = pack('0.2.0-g5d6e7f8');
  assert.notEqual(integrityOf(a), integrityOf(b));
  assert.match(contentIdOf(a, '0.2.0-g1a2b3c4'), /^sha256-[0-9a-f]{64}$/);
  assert.equal(contentIdOf(a, '0.2.0-g1a2b3c4'), contentIdOf(b, '0.2.0-g5d6e7f8'));
  assert.equal(contentIdOf(pack('0.2.2'), '0.2.2'), contentIdOf(pack('0.2.3'), '0.2.3'));
  const id = contentIdOf(a, '0.2.0-g1a2b3c4');
  assert.notEqual(contentIdOf(pack('0.2.0-g1a2b3c4', { readme: '# kit!\n' }), '0.2.0-g1a2b3c4'), id);
  assert.notEqual(contentIdOf(pack('0.2.0-g1a2b3c4', { mode: 0o755 }), '0.2.0-g1a2b3c4'), id);
  assert.notEqual(contentIdOf(pack('0.2.0-g1a2b3c4', { extra: [{ path: 'dist/new.js', body: '' }] }), '0.2.0-g1a2b3c4'), id);
  // Only the stamped version is normalized: a third-party pin or another kit version still counts.
  const other = tgzOf([{ path: 'package.json', body: JSON.stringify({ name: '@berdyh/bridge-client', version: '0.2.2', dependencies: { '@berdyh/bridge-protocol': '0.2.1' } }) }], gzipSync);
  const same = tgzOf([{ path: 'package.json', body: JSON.stringify({ name: '@berdyh/bridge-client', version: '0.2.2', dependencies: { '@berdyh/bridge-protocol': '0.2.2' } }) }], gzipSync);
  assert.notEqual(contentIdOf(other, '0.2.2'), contentIdOf(same, '0.2.2'));
});

test('the content-id command reads the version from each tarball', t => {
  const dir = fs.mkdtempSync(path.join(path.resolve(import.meta.dirname, '../.ci-local/tmp'), 'content-id-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = ['0.2.0-ga', '0.2.0-gb'].map(v => {
    const file = path.join(dir, `berdyh-bridge-crypto-${v}.tgz`);
    fs.writeFileSync(file, tgzOf([{ path: 'package.json', body: JSON.stringify({ name: '@berdyh/bridge-crypto', version: v }) }, { path: 'index.js', body: `export const v = "${v}";` }], gzipSync));
    return file;
  });
  const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, 'release-set.mjs'), 'content-id', ...files], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const ids = r.stdout.trim().split('\n').map(line => line.split('  ')[0]);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.match(ids[0], /^sha256-[0-9a-f]{64}$/);
});

test('tarFiles reads long paths through the ustar prefix and keeps the mode', () => {
  const long = `dist/${'deep/'.repeat(25)}file.js`;
  const files = tarFiles(tgzOf([{ path: long, body: 'x', mode: 0o755 }, { path: 'package.json', body: '{}' }], gzipSync));
  assert.deepEqual(files.map(f => [f.path, f.mode, f.bytes.toString()]), [[long, 0o755, 'x'], ['package.json', 0o644, '{}']]);
});

// ---- the release step end to end, against fake `pnpm` and `npm` ------------------------------------

const PNPM_SHIM = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
${tgzOf.toString()}
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'pnpm', argv: a }) + '\\n');
if (a[0] === 'run') process.exit(0);
if (a[0] === '--dir') {
  const pkg = JSON.parse(fs.readFileSync(path.join(a[1], 'package.json'), 'utf8'));
  const dest = a[a.indexOf('--pack-destination') + 1];
  fs.writeFileSync(path.join(dest, pkg.name.slice(1).replace('/', '-') + '-' + pkg.version + '.tgz'), tgzOf([{ path: 'package.json', body: JSON.stringify(pkg) }], require('zlib').gzipSync));
  process.exit(0);
}
process.exit(2);
`;
// FAKE_VIEW is how `npm view` answers by default, FAKE_VIEW_ODD ("<name>=<mode>") how it answers for one package.
const NPM_SHIM = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'npm', argv: a }) + '\\n');
const flag = name => a[a.indexOf(name) + 1];
const file = name => path.join(process.env.FAKE_STORE, name.slice(1).replace('/', '-'));
if (a[0] === 'view') {
  const name = a[1].slice(0, a[1].lastIndexOf('@'));
  const [oddName, oddMode] = (process.env.FAKE_VIEW_ODD || '=').split('=');
  const mode = oddName === name ? oddMode : process.env.FAKE_VIEW;
  const error = code => { if (a.includes('--json')) console.log(JSON.stringify({ error: { code } })); else console.error('npm error code ' + code); process.exit(1); };
  if (mode === 'e404') error('E404');
  if (mode === 'refused') error('ECONNREFUSED');
  if (mode === 'server') error('E500');
  if (mode === 'crash') { console.error('npm exploded'); process.exit(1); }
  if (mode === 'taken') console.log(JSON.stringify(a[1].slice(a[1].lastIndexOf('@') + 1)));
  process.exit(0);
}
if (a[0] === 'publish') { fs.mkdirSync(process.env.FAKE_STORE, { recursive: true }); fs.copyFileSync(a[1], file('@' + path.basename(a[1]).replace(/-\\d.*$/, '').replace('berdyh-', 'berdyh/'))); process.exit(0); }
if (a[0] === 'pack') { const name = a[1].slice(0, a[1].lastIndexOf('@')), version = a[1].slice(a[1].lastIndexOf('@') + 1); fs.copyFileSync(file(name), path.join(flag('--pack-destination'), name.slice(1).replace('/', '-') + '-' + version + '.tgz')); process.exit(0); }
if (a[0] === 'install') {
  const prefix = flag('--prefix');
  const deps = JSON.parse(fs.readFileSync(path.join(prefix, 'package.json'), 'utf8')).dependencies;
  const packages = {};
  for (const [name, version] of Object.entries(deps)) packages['node_modules/' + name] = { version, integrity: 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file(name))).digest('base64') };
  fs.writeFileSync(path.join(prefix, 'package-lock.json'), JSON.stringify({ packages }));
  process.exit(0);
}
process.exit(2);
`;

/** A committed kit tree, and a PATH where `pnpm` and `npm` are shims that log every call. */
function fakeRelease(t, { view = 'e404', viewOdd = '', hostile = true } = {}) {
  const kit = kitTree(t);
  fs.mkdirSync(`${kit.root}/docs`, { recursive: true });
  fs.writeFileSync(`${kit.root}/docs/NOTES.md`, `# Releases\n\n${RELEASE_MARKER}\n`);
  git(kit.root, 'init', '-q');
  git(kit.root, 'add', '-A');
  git(kit.root, 'commit', '-q', '-m', 'kit');
  const bin = `${kit.dir}/bin`;
  fs.mkdirSync(bin);
  for (const [name, body] of [['pnpm', PNPM_SHIM], ['npm', NPM_SHIM]]) fs.writeFileSync(`${bin}/${name}`, body, { mode: 0o755 });
  const log = `${kit.dir}/calls.log`;
  fs.writeFileSync(log, '');
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: log, FAKE_STORE: `${kit.dir}/store`, FAKE_VIEW: view, FAKE_VIEW_ODD: viewOdd,
    // Configuration that tries to send the scope somewhere else.
    ...(hostile ? { 'npm_config_@berdyh:registry': 'http://registry.evil.example' } : {}),
  };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const rel = (opts = {}) => release(kit.root, { version: '0.1.2', registry: 'http://127.0.0.1:4874/', dest: `${kit.dir}/out`, ...opts });
  return { ...kit, calls, rel };
}

test('a release writes a release note only when --notes names the file; without it no notes file is read or written', t => {
  const bare = fakeRelease(t);
  const before = fs.readFileSync(`${bare.root}/docs/NOTES.md`, 'utf8');
  fs.rmSync(`${bare.root}/docs/NOTES.md`);
  git(bare.root, 'commit', '-q', '-am', 'no notes file at all');
  assert.equal(bare.rel().packs.length, 3, 'a tree without any notes file releases');
  assert.equal(fs.existsSync(`${bare.root}/docs/NOTES.md`), false, 'and none is created');
  assert.equal(git(bare.root, 'status', '--porcelain'), '');

  const quiet = fakeRelease(t);
  quiet.rel();
  assert.equal(fs.readFileSync(`${quiet.root}/docs/NOTES.md`, 'utf8'), before, 'without notes the notes file is untouched');

  const noted = fakeRelease(t);
  const r = noted.rel({ notes: 'docs/NOTES.md' });
  const doc = fs.readFileSync(`${noted.root}/docs/NOTES.md`, 'utf8');
  assert.ok(doc.indexOf('### 0.1.2') > doc.indexOf(RELEASE_MARKER));
  assert.ok(doc.includes(r.info.full) && r.packs.every(p => doc.includes(p.integrity)));
  assert.match(git(noted.root, 'status', '--porcelain'), /^M docs\/NOTES\.md$/m);
});

test('a notes file without the marker, or missing, aborts the release before anything is packed or published', t => {
  const f = fakeRelease(t);
  fs.writeFileSync(`${f.root}/docs/NOTES.md`, '# no marker\n');
  git(f.root, 'commit', '-q', '-am', 'no marker');
  assert.throws(() => f.rel({ notes: 'docs/NOTES.md' }), /no release-notes marker/);
  assert.throws(() => f.rel({ notes: 'docs/missing.md' }), /ENOENT/);
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.existsSync(`${f.dir}/out`), false);
});

test('the command line passes --notes through, and says when it wrote no note', t => {
  const f = fakeRelease(t);
  fs.mkdirSync(`${f.root}/scripts`, { recursive: true });
  fs.copyFileSync(path.join(realRoot, 'scripts/release-set.mjs'), `${f.root}/scripts/release-set.mjs`);
  git(f.root, 'add', 'scripts/release-set.mjs');
  git(f.root, 'commit', '-q', '-m', 'script');
  const run = (...extra) => spawnSync(process.execPath, [`${f.root}/scripts/release-set.mjs`, 'release', '0.1.2', `${f.dir}/out`, '--registry', 'http://127.0.0.1:4874', ...extra], { encoding: 'utf8', env: process.env, cwd: f.root });
  const without = run();
  assert.equal(without.status, 0, without.stderr);
  assert.match(without.stdout, /no release note written/);
  assert.ok(!fs.readFileSync(`${f.root}/docs/NOTES.md`, 'utf8').includes('### 0.1.2'));
  const withNotes = run('--notes', 'docs/NOTES.md');
  assert.equal(withNotes.status, 0, withNotes.stderr);
  assert.match(withNotes.stdout, /note added to docs\/NOTES\.md/);
  assert.ok(fs.readFileSync(`${f.root}/docs/NOTES.md`, 'utf8').includes('### 0.1.2'));
});

test('every npm call of the release step pins the @berdyh scope to the validated registry', t => {
  const f = fakeRelease(t);
  const npmrc = `${f.dir}/token.npmrc`;
  fs.writeFileSync(npmrc, '@berdyh:registry=http://registry.evil.example\n');
  const origin = 'http://127.0.0.1:4874';
  f.rel({ npmrc });
  const npm = f.calls().filter(c => c.tool === 'npm');
  assert.deepEqual([...new Set(npm.map(c => c.argv[0]))].sort(), ['install', 'pack', 'publish', 'view']);
  for (const { argv } of npm) {
    assert.ok(argv.includes(`--@berdyh:registry=${origin}`), `${argv[0]} does not pin the scope: ${argv.join(' ')}`);
    assert.equal(argv[argv.indexOf('--registry') + 1], origin, `${argv[0]} registry`);
    assert.equal(argv[argv.indexOf('--userconfig') + 1], npmrc, 'the supplied token file is still passed');
  }
  assert.deepEqual(npmArgs(origin, ['view', 'x'], {}), ['view', 'x', '--registry', origin, `--@berdyh:registry=${origin}`, '--update-notifier=false']);
});

test('only an explicit not-found makes a version available; any other lookup failure aborts the release before anything is packed or published', t => {
  const origin = 'http://127.0.0.1:4874';
  // Every answer the lookup can get, and what it means.
  const answers = [
    ['e404', false], ['empty', false], ['taken', true],
    ['refused', 'ECONNREFUSED'], ['server', 'E500'], ['crash', 'npm exploded'],
  ];
  for (const [view, want] of answers) {
    const f = fakeRelease(t, { view });
    const lookup = () => versionInRegistry(origin, '@berdyh/bridge', '0.1.2', { cache: `${f.dir}/cache` });
    if (typeof want === 'boolean') assert.equal(lookup(), want, view);
    else assert.throws(lookup, e => e.message.includes('Could not look up @berdyh/bridge@0.1.2') && e.message.includes(want), view);
  }
  // In the release step: a failed lookup for any one package stops everything, whichever package it is.
  for (const view of ['refused', 'server', 'crash']) {
    for (const odd of ['@berdyh/bridge-protocol', '@berdyh/bridge']) {
      const f = fakeRelease(t, { viewOdd: `${odd}=${view}` });
      assert.throws(() => f.rel(), /Could not look up/, `${view} for ${odd}`);
      assert.deepEqual(f.calls().filter(c => c.tool === 'pnpm' || c.argv[0] === 'publish'), [], 'nothing packed or published');
      assert.equal(fs.existsSync(`${f.dir}/out/0.1.2`), false);
    }
  }
  // A version the registry holds is still refused, and a clean answer for all still releases.
  assert.throws(() => fakeRelease(t, { view: 'taken' }).rel(), /already exists in the registry/);
  assert.equal(fakeRelease(t).rel().packs.length, 3);
});

test('untracked files that enter the build change the pack version fingerprint, and a release refuses them', t => {
  const f = fakeRelease(t);
  const { root } = f;
  fs.writeFileSync(`${root}/.gitignore`, 'ignored.txt\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-q', '-m', 'ignore');
  const clean = gitInfo(root);
  assert.equal(clean.dirty, false);
  assert.deepEqual(clean.untracked, []);
  const cleanVersion = packVersion('0.1.1', clean);
  // A new source file is a different build: dirty, listed, and a version of its own.
  fs.writeFileSync(`${root}/packages/cli/src/extra.ts`, 'export const one = 1;\n');
  const one = gitInfo(root);
  assert.equal(one.dirty, true);
  assert.deepEqual(one.untracked, ['packages/cli/src/extra.ts']);
  const oneVersion = packVersion('0.1.1', one);
  assert.notEqual(oneVersion, cleanVersion);
  assert.ok(oneVersion.includes('.dirty-') && oneVersion.includes(clean.sha), oneVersion);
  assert.equal(packVersion('0.1.1', gitInfo(root)), oneVersion, 'the same tree, the same version');
  // Other content, another file, a symlink, and a file inside a new directory each change it.
  const seen = new Set([cleanVersion, oneVersion]);
  const next = () => { const v = packVersion('0.1.1', gitInfo(root)); assert.ok(!seen.has(v), `${v} repeats an earlier tree`); seen.add(v); };
  fs.writeFileSync(`${root}/packages/cli/src/extra.ts`, 'export const one = 2;\n'); next();
  fs.writeFileSync(`${root}/packages/cli/src/other.ts`, 'x\n'); next();
  fs.symlinkSync('other.ts', `${root}/packages/cli/src/link.ts`); next();
  fs.mkdirSync(`${root}/packages/cli/new`); fs.writeFileSync(`${root}/packages/cli/new/a.ts`, 'a\n'); next();
  // A tracked edit on top is still another tree.
  fs.writeFileSync(`${root}/docs/NOTES.md`, `# Releases\n\n${RELEASE_MARKER}\nedit\n`); next();
  git(root, 'checkout', '--', 'docs/NOTES.md');
  // Ignored files are not build inputs.
  fs.rmSync(`${root}/packages/cli/src/extra.ts`);
  for (const file of ['packages/cli/src/other.ts', 'packages/cli/src/link.ts', 'packages/cli/new']) fs.rmSync(`${root}/${file}`, { recursive: true });
  fs.writeFileSync(`${root}/ignored.txt`, 'x\n');
  assert.equal(gitInfo(root).dirty, false);
  assert.equal(packVersion('0.1.1', gitInfo(root)), cleanVersion);
  // A release refuses an untracked input before it runs anything.
  fs.writeFileSync(`${root}/packages/cli/src/extra.ts`, 'export const one = 1;\n');
  assert.throws(() => f.rel(), /clean head.*untracked files: packages\/cli\/src\/extra\.ts/);
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.existsSync(`${f.dir}/out`), false);
  fs.rmSync(`${root}/packages/cli/src/extra.ts`);
  assert.equal(f.rel().packs.length, 3, 'a clean head releases');
});
