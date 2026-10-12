// Real bootstrap/validation/activation with fixture executables, isolated HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readlink,
  symlink,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { inventory, requiredFiles } from '../contract.mjs';

const scripts = fileURLToPath(new URL('../', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const identity = {
  schemaVersion: 1,
  product: 'Sentry',
  version: '0.1.0-beta.1',
  sourceCommit: 'a'.repeat(40),
  runtimeProtocol: 1,
};
async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'sentry install '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'distribution with spaces'),
    home = join(temp, 'home'),
    bin = join(temp, 'bin');
  await mkdir(home);
  await mkdir(bin);
  for (const path of requiredFiles('cachyos-x64')) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), 'fixture');
  }
  for (const path of [
    'build-identity.json',
    'runtime-source/build-identity.json',
    'desktop/resources/app/build-identity.json',
  ])
    await writeFile(join(root, path), JSON.stringify(identity));
  for (const path of ['runtime-source/package.json', 'desktop/resources/app/package.json'])
    await writeFile(
      join(root, path),
      JSON.stringify({ version: identity.version, packageManager: 'pnpm@9.12.3' }),
    );
  for (const file of [
    'bootstrap-runtime.sh',
    'runtime-check.mjs',
    'maintenance.mjs',
    'verify.mjs',
    'contract.mjs',
  ])
    await cp(join(scripts, file), join(root, 'scripts/distribution', file));
  await mkdir(join(root, 'scripts/launcher/linux/lib'), { recursive: true });
  await cp(
    join(repo, 'launcher/linux/lib/host-gate.sh'),
    join(root, 'scripts/launcher/linux/lib/host-gate.sh'),
  );
  const osRelease = join(temp, 'os-release');
  await writeFile(osRelease, 'ID=cachyos\n');
  for (const tool of ['systemctl', 'systemd-run', 'bwrap', 'socat', 'pacman'])
    await writeFile(join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(bin, 'pnpm'), '#!/bin/sh\necho 9.12.3\n', { mode: 0o755 });
  const fakeHost = `let buf='';process.stdin.on('data', c=>{buf+=c;let n;while((n=buf.indexOf('\\n'))>=0){const r=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);if(r.method==='runtime.hello'){console.log(JSON.stringify({type:'response',id:r.id,ok:true,result:{protocolVersion:1,runtimeVersion:'0.1.0-beta.1',sourceCommit:(process.env.TEST_FAIL_HELLO==='1'||(process.env.TEST_FAIL_ACTIVE==='1'&&process.argv[1].includes('/current/')))?'b'.repeat(40):'a'.repeat(40),platform:'linux',isElectron:false,nodeVersion:process.version}}));}else{process.exit(0);}}});`;
  await writeFile(join(temp, 'fake-host.cjs'), fakeHost);
  await mkdir(join(root, 'apps/runtime/scripts'), { recursive: true });
  await writeFile(
    join(root, 'apps/runtime/scripts/deploy-inner.sh'),
    '#!/bin/bash\nset -eu\n[ "$4" = stage-only ]\n[ "${TEST_FAIL_BUILD:-0}" != 1 ]\nmkdir -p "$HOME/.local/share/sentry/runtime/$2/apps/runtime/dist"\ncp "$TEST_HOST" "$HOME/.local/share/sentry/runtime/$2/apps/runtime/dist/host.js"\n',
  );
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
  const base = join(home, '.local/share/sentry/runtime');
  const env = {
    ...process.env,
    HOME: home,
    PATH: bin + ':' + process.env.PATH,
    DISPLAY: ':fixture',
    SENTRY_OS_RELEASE_PATH: osRelease,
    TEST_HOST: join(temp, 'fake-host.cjs'),
  };
  const run = (extra = {}) =>
    spawnSync('bash', [join(root, 'scripts/distribution/bootstrap-runtime.sh'), 'native'], {
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 30000,
    });
  return { temp, root, home, base, env, run, bin, osRelease };
}
const linux = { skip: process.platform !== 'linux' };
test(
  'first/repeated same-version setup uses distinct candidates and preserves synthetic beta data',
  linux,
  async (t) => {
    const f = await fixture(t);
    const data = join(f.home, '.local/share/sentry');
    await mkdir(join(data, 'projects'), { recursive: true });
    const records = JSON.stringify({
      project: 'synthetic',
      revision: 'revision-fixture',
      completedRun: 'run-fixture',
      findings: [1],
      evidence: [1],
      historicalIssueRetest: [1],
      encryptedPreferences: 'opaque-fixture',
    });
    await writeFile(join(data, 'projects/history.fixture'), records);
    const first = f.run();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const previous = await readlink(join(f.base, 'current'));
    const second = f.run();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.notEqual(await readlink(join(f.base, 'current')), previous);
    assert.ok((await readdir(f.base)).includes(previous));
    assert.equal(await readFile(join(data, 'projects/history.fixture'), 'utf8'), records);
  },
);
for (const scenario of ['TEST_FAIL_BUILD', 'TEST_FAIL_HELLO', 'TEST_FAIL_ACTIVE']) {
  test(scenario + ' preserves previous runtime and data', linux, async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.base, 'previous'), { recursive: true });
    await symlink('previous', join(f.base, 'current'));
    const result = f.run({ [scenario]: '1' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(await readlink(join(f.base, 'current')), 'previous');
  });
  test(scenario + ' first install leaves no fake current', linux, async (t) => {
    const f = await fixture(t);
    const result = f.run({ [scenario]: '1' });
    assert.notEqual(result.status, 0);
    await assert.rejects(readlink(join(f.base, 'current')), { code: 'ENOENT' });
  });
}
test(
  'unsupported native distro and architecture, missing prerequisite, interrupted lock refuse before deployment',
  linux,
  async (t) => {
    const f = await fixture(t);
    await writeFile(f.osRelease, 'ID=ubuntu\n');
    assert.notEqual(f.run().status, 0);
    await writeFile(f.osRelease, 'ID=cachyos\n');
    await writeFile(join(f.bin, 'uname'), '#!/bin/sh\necho aarch64\n', { mode: 0o755 });
    assert.notEqual(f.run().status, 0);
    await rm(join(f.bin, 'uname'));
    await writeFile(join(f.bin, 'pnpm'), '#!/bin/sh\necho 10.0.0\n', { mode: 0o755 });
    assert.notEqual(f.run().status, 0);
    await writeFile(join(f.bin, 'pnpm'), '#!/bin/sh\necho 9.12.3\n', { mode: 0o755 });
    await mkdir(join(f.base, '.release-maintenance'), { recursive: true });
    const locked = f.run();
    assert.notEqual(locked.status, 0);
    assert.match(locked.stderr, /interrupted lock/);
    await assert.rejects(readlink(join(f.base, 'current')), { code: 'ENOENT' });
  },
);
test(
  'a running source/runtime process refuses release maintenance without replacement',
  linux,
  async (t) => {
    const f = await fixture(t);
    const entry = join(f.base, 'previous/apps/runtime/dist/host.js');
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, 'process.stdout.write("ready");setInterval(()=>{},60000);');
    await symlink('previous', join(f.base, 'current'));
    const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout, 'data');
    try {
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /still running/);
      assert.equal(await readlink(join(f.base, 'current')), 'previous');
      assert.equal(child.exitCode, null);
    } finally {
      child.kill();
      await once(child, 'close');
    }
  },
);
