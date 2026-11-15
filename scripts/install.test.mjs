import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts/install.sh');
// install.sh pins the CLI's version; the fixtures follow it, and a bump that misses one side fails here.
const version = fs.readFileSync(script, 'utf8').match(/^VERSION=(\S+)$/m)[1];
const versionRe = version.replaceAll('.', '\\.');
const scratch = path.join(root, '.ci-local/tmp');
fs.mkdirSync(scratch, { recursive: true });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(scratch, 'install-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  const release = path.join(dir, `release/${version}`);
  for (const d of [home, bin, release]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    XDG_DATA_HOME: `${home}/.local/share`, XDG_CONFIG_HOME: `${home}/.config`,
    XDG_STATE_HOME: `${home}/.local/state`, npm_config_cache: `${dir}/npm-cache`,
    BRIDGE_INSTALL_BASE: `file://${dir}/release`, TEST_LOG: `${dir}/calls` };
  delete env.NODE_TEST_CONTEXT;
  function executable(name, body) { fs.writeFileSync(`${bin}/${name}`, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); }
  executable('npm', `printf '%s\\n' "$@" >> "$TEST_LOG"
[ "\${FAIL_NPM:-}" != 1 ] || exit 7
prefix=$3
mkdir -p "$prefix/node_modules/.bin" "$prefix/node_modules/@berdyh/bridge/bin"
cat > "$prefix/node_modules/@berdyh/bridge/bin/run.js" <<'STUB'
#!/bin/sh
printf '%s\\n' "$@" >> "$TEST_LOG"
if [ "\${CHECK_TTY:-}" = 1 ]; then
 [ -t 0 ] || { echo 'CHILD STDIN: not a tty' >&2; exit 9; }
 if [ "$1" = setup ]; then
  printf 'Setup approval? '
  read -r answer
  [ "$answer" = approve ] || exit 10
 fi
fi
if [ "$1" = self ]; then
 mkdir -p "$HOME/.local/bin"
 ln -sf "$0" "$HOME/.local/bin/bridge"
 ln -sf "$0" "$HOME/.local/bin/bridge-runner"
fi
STUB
chmod +x "$prefix/node_modules/@berdyh/bridge/bin/run.js"
ln -s ../@berdyh/bridge/bin/run.js "$prefix/node_modules/.bin/bridge"`);
  const names = ['bridge', 'bridge-runner', 'bridge-protocol', 'bridge-crypto', 'bridge-pairing'];
  const digest = createHash('sha256').update('verified bytes').digest('hex');
  for (const name of names) fs.writeFileSync(`${release}/berdyh-${name}-${version}.tgz`, 'verified bytes');
  fs.writeFileSync(`${release}/SHA256SUMS`, names.map(n => `${digest}  berdyh-${n}-${version}.tgz\n`).join(''));
  return { dir, home, bin, release, env, executable };
}
function run(f, args = ['--yes']) {
  return spawnSync('/bin/sh', [script, ...args], { env: f.env, encoding: 'utf8' });
}
function clean(f) {
  assert.ok(!fs.existsSync(`${f.home}/.local`));
  assert.ok(!fs.existsSync(`${f.dir}/calls`));
}
test('refuses old/missing Node and Windows before any write', t => {
  const f = fixture(t);
  const inheritedPath = f.env.PATH;
  f.executable('uname', 'echo Linux');
  f.env.PATH = f.bin;
  assert.match(run(f).stderr, /Node >= 22/); clean(f);
  f.env.PATH = inheritedPath;
  f.executable('node', 'exit 1');
  assert.equal(run(f).status, 1); clean(f);
  f.executable('uname', 'echo MINGW64_NT');
  assert.match(run(f).stderr, /WSL2/); clean(f);
});
test('checksum mismatch and unsafe names never reach npm', t => {
  const f = fixture(t);
  fs.writeFileSync(`${f.release}/berdyh-bridge-${version}.tgz`, 'tampered');
  let r = run(f); assert.equal(r.status, 1); assert.match(r.stderr, /Checksum mismatch/); clean(f);
  fs.writeFileSync(`${f.release}/SHA256SUMS`, `${'0'.repeat(64)}  ../escape.tgz\n`);
  r = run(f); assert.equal(r.status, 1); assert.match(r.stderr, /Invalid SHA256SUMS/); clean(f);
  assert.deepEqual(fs.readdirSync(`${f.home}/.cache/bridge-install`), []);
});
test('one npm install stages all tarballs, promotes, links and forwards setup arguments', t => {
  const f = fixture(t);
  const r = run(f, ['--yes', 'https://app.example', '--json', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  const calls = fs.readFileSync(`${f.dir}/calls`, 'utf8');
  assert.match(calls, new RegExp(`install\n--prefix\n.*versions/\\.staging-${versionRe}-`));
  assert.match(calls, /--ignore-scripts/);
  assert.equal(calls.match(/--prefix/g).length, 1);
  // No tarball on npm's command line (npm would ask the registry for their @berdyh/* edges):
  // the staging package.json, promoted with the version, names them as dependencies and overrides.
  assert.doesNotMatch(calls, /\.tgz/);
  const manifest = JSON.parse(fs.readFileSync(`${f.home}/.local/share/bridge/versions/${version}/package.json`, 'utf8'));
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.overrides, manifest.dependencies);
  const cache = fs.realpathSync(`${f.home}/.cache/bridge-install`);
  assert.deepEqual(Object.keys(manifest.dependencies), ['bridge', 'bridge-crypto', 'bridge-pairing', 'bridge-protocol', 'bridge-runner'].map(n => `@berdyh/${n}`));
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    const m = new RegExp(`^file:(/.*)/(berdyh-[a-z-]+-${versionRe}\\.tgz)$`).exec(spec);
    assert.ok(m, spec);
    assert.equal(path.dirname(m[1]), cache);
    assert.equal(m[2], `${name.replace('@berdyh/', 'berdyh-')}-${version}.tgz`);
  }
  assert.match(calls, new RegExp(`self\ninstall\n--version\n${versionRe}\n--yes`));
  assert.match(calls, /setup\nhttps:\/\/app.example\n--json/);
  assert.deepEqual(fs.readdirSync(`${f.home}/.local/share/bridge/versions`), [version]);
  assert.deepEqual(fs.readdirSync(`${f.home}/.cache/bridge-install`), []);
  const before = fs.readFileSync(`${f.dir}/calls`, 'utf8');
  assert.equal(run(f).status, 0);
  const after = fs.readFileSync(`${f.dir}/calls`, 'utf8');
  assert.equal(after.match(/--prefix/g).length, 1, 'rerun must not invoke npm');
  assert.ok(after.length > before.length);
});
test('failed npm leaves no visible version or staging directory', t => {
  const f = fixture(t); f.env.FAIL_NPM = '1';
  assert.notEqual(run(f).status, 0);
  assert.deepEqual(fs.readdirSync(`${f.home}/.local/share/bridge/versions`), []);
});
for (const base of ['home', 'ancestor', 'share', 'bin']) test(`non-aliased symlinked ${base} installs`, t => {
  const f = fixture(t);
  const target = `${f.dir}/redirected`;
  fs.mkdirSync(target);
  if (base === 'home' || base === 'ancestor') {
    fs.renameSync(f.home, `${target}/home`);
    fs.symlinkSync(target, `${f.dir}/linked-parent`);
    const home = base === 'home' ? f.home : `${f.dir}/linked-parent/home`;
    if (base === 'home') fs.symlinkSync(`${target}/home`, home);
    f.env.HOME = home;
    f.env.XDG_DATA_HOME = `${home}/.local/share`;
    f.env.XDG_CONFIG_HOME = `${home}/.config`;
    f.env.XDG_STATE_HOME = `${home}/.local/state`;
  } else {
    fs.mkdirSync(`${f.home}/.local`, { recursive: true });
    fs.symlinkSync(target, `${f.home}/.local/${base}`);
  }
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(`${f.env.HOME}/.local/bin/bridge`));
});
test('aliased bases are refused before cache or npm writes', t => {
  const f = fixture(t);
  fs.mkdirSync(f.env.XDG_DATA_HOME, { recursive: true });
  fs.symlinkSync(f.env.XDG_DATA_HOME, f.env.XDG_CONFIG_HOME);
  const r = run(f, []);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Aliased layout/);
  assert.ok(!fs.existsSync(`${f.dir}/calls`));
  assert.ok(!fs.existsSync(`${f.home}/.cache`));
});
// A controlling terminal for `sh -c <cmd>`, with its exit status passed through. Linux: util-linux
// script. Elsewhere BSD script needs its own stdin to be a terminal, so Python's pty.spawn makes one.
const PTY_PY = 'import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(["sh","-c",sys.argv[1]])))';
const spawnWithTty = (cmd, options) => process.platform === 'linux'
  ? spawn('script', ['-q', '-e', '-c', cmd, '/dev/null'], options)
  : spawn('python3', ['-I', '-c', PTY_PY, cmd], options);
// util-linux script gives the piped shell a controlling terminal. Input is withheld
// until the path list has appeared, proving that consent precedes even cache writes.
for (const answer of ['n', 'y']) test(`curl | sh reads ${answer} on /dev/tty, no writes before yes`, async t => {
  const f = fixture(t);
  const child = spawnWithTty(`cat '${script}' | sh`, { env: f.env });
  let output = ''; let answered = false;
  child.stdout.on('data', bytes => {
    output += bytes;
    if (!answered && output.includes('Install these paths?')) {
      answered = true;
      assert.deepEqual(fs.readdirSync(f.home), []);
      assert.ok(output.includes(`${f.home}/.local/bin/bridge`));
      assert.ok(output.includes(`${f.home}/.local/bin/bridge-runner`));
      assert.ok(output.includes(`versions/${version}/`));
      child.stdin.write(`${answer}\n`);
    }
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const code = await new Promise(resolve => child.on('close', resolve)); clearTimeout(timer);
  assert.ok(answered, output);
  assert.equal(code, answer === 'y' ? 0 : 1, output);
  if (answer === 'n') assert.deepEqual(fs.readdirSync(f.home), []);
});

test('a bad non-CLI tarball blocks the entire set', t => {
  const f = fixture(t);
  fs.writeFileSync(`${f.release}/berdyh-bridge-runner-${version}.tgz`, 'corrupt');
  assert.match(run(f).stderr, /Checksum mismatch/); clean(f);
});
test('a missing tarball and duplicate sums both fail closed', t => {
  const f = fixture(t);
  fs.rmSync(`${f.release}/berdyh-bridge-runner-${version}.tgz`);
  assert.notEqual(run(f).status, 0); clean(f);
  const sums = fs.readFileSync(`${f.release}/SHA256SUMS`, 'utf8');
  fs.appendFileSync(`${f.release}/SHA256SUMS`, sums);
  assert.match(run(f).stderr, /Invalid SHA256SUMS/); clean(f);
});
test('without a controlling terminal, stdin cannot supply consent', t => {
  const f = fixture(t);
  const r = spawnSync('sh', [script], { env: f.env, detached: true, input: 'yes\n', encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No controlling terminal/);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('a symlinked version is refused without executing its entry', t => {
  const f = fixture(t);
  const versions = `${f.home}/.local/share/bridge/versions`;
  fs.mkdirSync(versions, { recursive: true });
  fs.symlinkSync(f.release, `${versions}/${version}`);
  assert.notEqual(run(f).status, 0);
  assert.ok(!fs.existsSync(`${f.dir}/calls`));
  assert.ok(!fs.existsSync(`${f.home}/.cache`));
});
test('a concurrent promotion is preserved and staging is not nested inside it', t => {
  const f = fixture(t);
  const actualNode = process.execPath;
  // Intercept only the final promotion, after the shell's destination check.
  f.executable('node', `if [ "$1" = --input-type=module ] && [ "$#" = 4 ]; then
    case "$3" in
      */.staging-*) mkdir -p "$4"; printf 'keep' > "$4/competitor" ;;
    esac
  fi
  exec '${actualNode}' "$@"`);
  assert.notEqual(run(f).status, 0);
  const versions = `${f.home}/.local/share/bridge/versions`;
  assert.deepEqual(fs.readdirSync(versions), [version]);
  assert.deepEqual(fs.readdirSync(`${versions}/${version}`), ['competitor']);
  assert.equal(fs.readFileSync(`${versions}/${version}/competitor`, 'utf8'), 'keep');
});

test('piped bootstrap gives self install and setup the terminal for their own prompts', async t => {
  const f = fixture(t);
  f.env.CHECK_TTY = '1';
  const child = spawnWithTty(`cat '${script}' | sh -s -- --yes https://app.example`, { env: f.env });
  let output = ''; let answered = false;
  child.stdout.on('data', bytes => {
    output += bytes;
    if (!answered && output.includes('Setup approval?')) {
      answered = true;
      child.stdin.write('approve\n');
    }
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const code = await new Promise(resolve => child.on('close', resolve)); clearTimeout(timer);
  assert.ok(answered, output);
  assert.equal(code, 0, output);
});
test('headless setup requires its own explicit --yes before any write', t => {
  const f = fixture(t);
  const r = spawnSync('sh', [script, '--yes', 'https://app.example'], { env: f.env, detached: true, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No controlling terminal for setup/);
  assert.deepEqual(fs.readdirSync(f.home), []);
  assert.ok(!fs.existsSync(`${f.dir}/calls`));
  const positional = spawnSync('sh', [script, '--yes', 'https://app.example', '--', '--yes'], { env: f.env, detached: true, encoding: 'utf8' });
  assert.notEqual(positional.status, 0);
  assert.match(positional.stderr, /No controlling terminal for setup/);
  assert.deepEqual(fs.readdirSync(f.home), []);
  const yes = spawnSync('sh', [script, '--yes', 'https://app.example', '--yes'], { env: f.env, detached: true, encoding: 'utf8' });
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(fs.readFileSync(`${f.dir}/calls`, 'utf8'), /setup\nhttps:\/\/app.example\n--yes/);
});
test('server SDK tarballs cannot be handed to the runner install', t => {
  const f = fixture(t);
  const digest = createHash('sha256').update('server').digest('hex');
  fs.writeFileSync(`${f.release}/berdyh-bridge-server-${version}.tgz`, 'server');
  fs.appendFileSync(`${f.release}/SHA256SUMS`, `${digest}  berdyh-bridge-server-${version}.tgz\n`);
  const r = run(f);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exactly the five runner tarballs/);
  clean(f);
});

test('environment-driven node writes (compile cache, coverage, profiles) happen nowhere before consent', t => {
  const f = fixture(t);
  Object.assign(f.env, {
    NODE_COMPILE_CACHE: `${f.home}/compile-cache`,
    NODE_V8_COVERAGE: `${f.home}/coverage`,
    NODE_REDIRECT_WARNINGS: `${f.home}/warnings.log`,
    NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${f.home}/profiles`,
  });
  const r = spawnSync('sh', [script], { env: f.env, detached: true, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /No controlling terminal/);
  assert.deepEqual(fs.readdirSync(f.home), []);
  assert.ok(!fs.existsSync(`${f.dir}/calls`));
});
test('npm cache and logs paths printed are the ones npm writes, whatever .npmrc says', t => {
  const f = fixture(t);
  fs.writeFileSync(`${f.home}/.npmrc`, `cache=${f.home}/rc-cache\nlogs-dir=${f.home}/rc-logs\n`);
  const cache = f.env.npm_config_cache;
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`npm cache: ${cache}\\n`));
  assert.match(r.stdout, new RegExp(`npm logs: ${cache}/_logs\\n`));
  const calls = fs.readFileSync(`${f.dir}/calls`, 'utf8').split('\n');
  const args = calls.slice(calls.indexOf('install'), calls.indexOf('--no-fund') + 1);
  assert.equal(args[args.indexOf('--cache') + 1], cache);
  assert.equal(args[args.indexOf('--logs-dir') + 1], `${cache}/_logs`);
  // The real npm, given these arguments under this .npmrc, writes only to the printed paths.
  const real = spawnSync('sh', ['-c', 'command -v npm'], { env: process.env, encoding: 'utf8' }).stdout.trim();
  const prefix = `${f.dir}/real-prefix`;
  fs.mkdirSync(prefix);
  fs.writeFileSync(`${prefix}/package.json`, '{"private":true}\n');
  args[args.indexOf('--prefix') + 1] = prefix;
  fs.rmSync(cache, { recursive: true, force: true });
  const env = { ...process.env, HOME: f.home };
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key];
  const n = spawnSync(real, [...args, '--offline'], { env, encoding: 'utf8' });
  assert.equal(n.status, 0, n.stderr);
  assert.ok(!fs.existsSync(`${f.home}/rc-cache`) && !fs.existsSync(`${f.home}/rc-logs`));
  assert.ok(fs.readdirSync(`${cache}/_logs`).some(name => name.endsWith('-debug-0.log')));
});
test('an older bridge layout is refused before the path list, any download or any write; there is no migration', t => {
  const markers = {
    'config trust': `.config/bridge/trust`, 'config identity': `.config/bridge/identity`, 'config identity-key': `.config/bridge/identity-key`,
    'config enroll': `.config/bridge/enroll`, 'state apps': `.local/state/bridge/apps`, 'data plugins': `.local/share/bridge/plugins`,
    'data plugin-data': `.local/share/bridge/plugin-data`,
  };
  for (const [name, rel] of Object.entries(markers)) {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.home, rel), { recursive: true });
    fs.writeFileSync(path.join(f.home, rel, 'decoy'), 'mine');
    const r = run(f);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /an older bridge layout is present/, name);
    assert.ok(r.stderr.includes(path.join(f.home, rel)), name);
    assert.match(r.stderr, /run the old `bridge uninstall`, then `bridge setup <url>`/, name);
    assert.doesNotMatch(r.stdout, /will write/, name);
    assert.ok(!fs.existsSync(`${f.dir}/calls`), name);
    assert.ok(!fs.existsSync(`${f.home}/.cache`), name);
    assert.ok(!fs.existsSync(`${f.home}/.local/bin`), name);
    assert.equal(fs.readFileSync(path.join(f.home, rel, 'decoy'), 'utf8'), 'mine', name);
  }
  // A version 1 apps.json (full records inline) is the same marker; a version 2 list is not.
  const f = fixture(t);
  fs.mkdirSync(`${f.home}/.config/bridge`, { recursive: true });
  fs.writeFileSync(`${f.home}/.config/bridge/apps.json`, JSON.stringify({ version: 1, apps: [] }));
  let r = run(f);
  assert.equal(r.status, 1); assert.match(r.stderr, /older bridge layout/); assert.ok(r.stderr.includes('apps.json'));
  assert.ok(!fs.existsSync(`${f.dir}/calls`));
  fs.writeFileSync(`${f.home}/.config/bridge/apps.json`, JSON.stringify({ version: 2, apps: [] }));
  r = run(f);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /will write/);
  // A broken apps.json is not this refusal's business.
  const g = fixture(t);
  fs.mkdirSync(`${g.home}/.config/bridge`, { recursive: true });
  fs.writeFileSync(`${g.home}/.config/bridge/apps.json`, '{nope');
  r = run(g);
  assert.equal(r.status, 0, r.stderr);
});

test('install.sh installs the version the CLI package carries', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8'));
  assert.equal(version, pkg.version);
});
