// Real release router, validator, process checks and GNU timeout; disposable children/HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, requiredFiles } from '../contract.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const linux = { skip: process.platform !== 'linux' };
const identity = {
  schemaVersion: 1,
  product: 'Sentry',
  version: '0.1.0-beta.1',
  sourceCommit: 'a'.repeat(40),
  runtimeProtocol: 1,
};
async function fixture(t, executable = '#!/bin/bash\nexit 0\n') {
  const temp = await mkdtemp(join(tmpdir(), 'sentry lifecycle '));
  const root = join(temp, 'archive'),
    home = join(temp, 'home'),
    bin = join(temp, 'bin');
  const children = [];
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
    // Only PIDs written by this fixture's packaged executable are owned here.
    try {
      process.kill(Number(await readFile(join(temp, 'launched-pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* already exited */
    }
    await rm(temp, { recursive: true, force: true });
  });
  for (const path of requiredFiles('cachyos-x64')) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), 'fixture');
  }
  await mkdir(home);
  await mkdir(bin);
  for (const path of [
    'build-identity.json',
    'runtime-source/build-identity.json',
    'desktop/resources/app/build-identity.json',
  ])
    await writeFile(join(root, path), JSON.stringify(identity));
  for (const path of ['runtime-source/package.json', 'desktop/resources/app/package.json'])
    await writeFile(join(root, path), JSON.stringify({ version: identity.version }));
  for (const file of ['verify.mjs', 'contract.mjs', 'maintenance.mjs'])
    await cp(join(repo, 'distribution', file), join(root, 'scripts/distribution', file));
  await cp(join(repo, 'distribution/release.sh'), join(root, 'sentry'));
  await mkdir(join(root, 'scripts/launcher/linux/lib'), { recursive: true });
  for (const file of ['host-gate.sh', 'desktop-ctl.sh'])
    await cp(
      join(repo, 'launcher/linux/lib', file),
      join(root, 'scripts/launcher/linux/lib', file),
    );
  await writeFile(join(temp, 'os-release'), 'ID=cachyos\n');
  // Scoped real pgrep: never observe or signal an owner's Desktop as a fixture.
  await writeFile(
    join(bin, 'pgrep'),
    '#!/bin/bash\nexec /usr/bin/pgrep -f -- "$FIXTURE_TEMP/desktop-process.cjs.*--sentry-app"\n',
    { mode: 0o755 },
  );
  // Accelerate only the shutdown polling interval. Startup keeps its real 2s bound.
  await writeFile(
    join(bin, 'sleep'),
    '#!/bin/bash\nif [ "$1" != 1 ]; then exec /usr/bin/sleep "$@"; fi\n',
    { mode: 0o755 },
  );
  // Exercise actual GNU timeout/signalling with a shorter fixture deadline.
  await writeFile(
    join(bin, 'timeout'),
    '#!/bin/bash\n[ "$1" = --kill-after=2s ] && [ "$2" = 45s ] || exit 91\nshift 2\nexec /usr/bin/timeout --kill-after=0.2s 1s "$@"\n',
    { mode: 0o755 },
  );
  await writeFile(join(root, 'desktop/sentry'), executable);
  await chmod(join(root, 'desktop/sentry'), 0o755);
  await writeFile(
    join(root, 'scripts/distribution/bootstrap-runtime.sh'),
    '#!/bin/bash\ntouch "$FIXTURE_TEMP/deployed"\n',
  );
  const base = join(home, '.local/share/sentry/runtime');
  await mkdir(join(base, 'previous'), { recursive: true });
  await symlink('previous', join(base, 'current'));
  await writeFile(join(base, 'previous/retained'), 'runtime bytes');
  await writeFile(join(home, 'history.fixture'), 'user data bytes');
  const env = {
    ...process.env,
    HOME: home,
    PATH: bin + ':' + process.env.PATH,
    DISPLAY: ':fixture',
    WAYLAND_DISPLAY: '',
    SENTRY_OS_RELEASE_PATH: join(temp, 'os-release'),
    FIXTURE_TEMP: temp,
  };
  async function seal() {
    await rm(join(root, 'distribution.json'), { force: true });
    await writeFile(
      join(root, 'distribution.json'),
      JSON.stringify({
        ...identity,
        buildPlatform: 'linux-x64',
        targetPlatform: 'cachyos-x64',
        artifactType: 'versioned-archive',
        checksumAlgorithm: 'SHA256',
        toolchain: {},
        components: [],
        prerequisites: [],
        files: await inventory(root),
      }),
    );
  }
  await seal();
  const run = (command, extra = {}) =>
    spawnSync('bash', [join(root, 'sentry'), command], {
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 8000,
    });
  async function processFixture(kind) {
    const entry =
      kind === 'runtime'
        ? join(temp, 'apps/runtime/dist/host.js')
        : join(temp, kind + '-process.cjs');
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, 'process.stdout.write("ready");setInterval(()=>{},60000);');
    const child = spawn(
      process.execPath,
      [entry, ...(kind === 'desktop' ? ['--sentry-app'] : [])],
      { env, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.push(child);
    await once(child.stdout, 'data');
    return child;
  }
  async function retained() {
    assert.equal(await readlink(join(base, 'current')), 'previous');
    assert.equal(await readFile(join(base, 'previous/retained'), 'utf8'), 'runtime bytes');
    assert.equal(await readFile(join(home, 'history.fixture'), 'utf8'), 'user data bytes');
    await assert.rejects(readFile(join(temp, 'deployed')), { code: 'ENOENT' });
  }
  return { root, home, temp, run, seal, processFixture, retained };
}

test(
  'confirmed immediate nonzero startup fails with exit code and dedicated log',
  linux,
  async (t) => {
    const f = await fixture(t, '#!/bin/bash\necho fixture-startup-error >&2\nexit 42\n');
    const other = await f.processFixture('electron');
    const r = f.run('open');
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /exit 42/);
    assert.match(r.stdout + r.stderr, /release-desktop\.log/);
    assert.match(
      await readFile(join(f.home, '.local/share/sentry/logs/release-desktop.log'), 'utf8'),
      /fixture-startup-error/,
    );
    assert.equal(other.exitCode, null);
  },
);
test(
  'surviving startup reports process observation separately from runtime readiness',
  linux,
  async (t) => {
    const f = await fixture(
      t,
      '#!/bin/bash\necho $$ > "$FIXTURE_TEMP/launched-pid"\nexec sleep 60\n',
    );
    const r = f.run('open');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /survived initial startup/);
    assert.match(r.stdout, /Environment.*runtime.*provider/);
    process.kill(Number(await readFile(join(f.temp, 'launched-pid'), 'utf8')), 0);
  },
);
test('missing graphical session refuses launch', linux, async (t) => {
  const f = await fixture(t);
  const r = f.run('open', { DISPLAY: '', WAYLAND_DISPLAY: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /graphical session/);
});
for (const scenario of ['missing', 'invalid'])
  test(scenario + ' executable refuses launch', linux, async (t) => {
    const f = await fixture(t, '#!/missing/interpreter\n');
    if (scenario === 'missing') {
      await rm(join(f.root, 'desktop/sentry'));
      await f.seal();
    }
    const r = f.run('open');
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    if (scenario === 'invalid') assert.match(r.stdout + r.stderr, /release-desktop\.log/);
  });
test(
  'existing-instance exit-zero handoff succeeds, but a nonzero handoff still fails',
  linux,
  async (t) => {
    const f = await fixture(t);
    const desktop = await f.processFixture('desktop');
    const r = f.run('open');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /existing instance/);
    assert.equal(desktop.exitCode, null);
    await writeFile(join(f.root, 'desktop/sentry'), '#!/bin/bash\nexit 42\n');
    await f.seal();
    assert.notEqual(f.run('open').status, 0);
    assert.equal(desktop.exitCode, null);
  },
);
test(
  'exit zero without another Desktop is an early exit, not a surviving process',
  linux,
  async (t) => {
    const f = await fixture(t);
    const r = f.run('open');
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /exit 0/);
  },
);
test(
  'idle and normal graceful stop succeed without touching unrelated Electron',
  linux,
  async (t) => {
    const f = await fixture(
      t,
      '#!/bin/bash\n[ ! -f "$FIXTURE_TEMP/stop-pid" ] || kill -TERM "$(cat "$FIXTURE_TEMP/stop-pid")"\n',
    );
    const other = await f.processFixture('electron');
    assert.equal(f.run('stop').status, 0);
    const desktop = await f.processFixture('desktop');
    await writeFile(join(f.temp, 'stop-pid'), String(desktop.pid));
    assert.equal(f.run('stop').status, 0);
    assert.equal(other.exitCode, null);
    await f.retained();
  },
);
test('hung control cannot signal an existing Desktop or runtime', linux, async (t) => {
  const f = await fixture(
    t,
    '#!/bin/bash\necho $$ > "$FIXTURE_TEMP/launched-pid"\ntrap "" TERM\nexec /usr/bin/sleep 60\n',
  );
  const desktop = await f.processFixture('desktop');
  const runtime = await f.processFixture('runtime');
  const r = f.run('repair');
  assert.equal(r.error, undefined);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /maintenance refused/);
  process.kill(desktop.pid, 0);
  process.kill(runtime.pid, 0);
  await f.retained();
});
for (const scenario of ['failure', 'hang', 'desktop', 'runtime'])
  test(
    scenario + ' refuses setup and retains current/runtime/data and unrelated processes',
    linux,
    async (t) => {
      const script =
        scenario === 'failure'
          ? '#!/bin/bash\nexit 23\n'
          : scenario === 'hang'
            ? '#!/bin/bash\necho control-started > "$FIXTURE_TEMP/control-started"\ntrap "" TERM\necho $$ > "$FIXTURE_TEMP/launched-pid"\nexec /usr/bin/sleep 60\n'
            : '#!/bin/bash\nexit 0\n';
      const f = await fixture(t, script);
      const other = await f.processFixture('electron');
      const active = ['desktop', 'runtime'].includes(scenario)
        ? await f.processFixture(scenario)
        : null;
      const r = f.run('setup');
      assert.notEqual(r.status, 0, r.stdout + r.stderr);
      assert.equal(r.error, undefined, 'launcher exceeded outer safety deadline');
      assert.match(r.stdout + r.stderr, /maintenance refused/);
      if (scenario === 'failure') assert.match(r.stderr, /23/);
      if (scenario === 'hang') {
        assert.equal(await readFile(join(f.temp, 'control-started'), 'utf8'), 'control-started\n');
        assert.match(r.stderr, /timed out|137|124/);
      }
      if (active) assert.equal(active.exitCode, null);
      assert.equal(other.exitCode, null);
      await f.retained();
    },
  );
