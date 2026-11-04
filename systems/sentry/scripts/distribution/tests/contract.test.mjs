import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  inventory,
  parseIdentity,
  requiredFiles,
  safePath,
  forbidden,
  validate,
} from '../contract.mjs';

const scripts = fileURLToPath(new URL('../', import.meta.url));
const identity = {
  schemaVersion: 1,
  product: 'Sentry',
  version: '0.1.0-beta.1',
  sourceCommit: 'a'.repeat(40),
  runtimeProtocol: 1,
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sentry distribution '));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of requiredFiles('windows-x64')) {
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
    await writeFile(join(root, path), JSON.stringify({ version: identity.version }));
  await seal(root);
  return root;
}
async function seal(root, changes = {}) {
  await rm(join(root, 'distribution.json'), { force: true });
  await writeFile(
    join(root, 'distribution.json'),
    JSON.stringify({
      ...identity,
      buildPlatform: 'win32-x64',
      targetPlatform: 'windows-x64',
      artifactType: 'versioned-archive',
      checksumAlgorithm: 'SHA256',
      toolchain: { pnpm: '9.12.3' },
      components: ['Desktop', 'Linux bootstrap'],
      prerequisites: ['WSL2'],
      files: await inventory(root),
      ...changes,
    }),
  );
}
test('Git-less archive with spaces validates accurate version/platform/SHA', async (t) => {
  const root = await fixture(t);
  const actual = await validate(root);
  assert.equal(actual.sourceCommit, identity.sourceCommit);
  assert.equal(actual.version, identity.version);
  assert.equal(actual.targetPlatform, 'windows-x64');
});
test('tampered component fails checksum validation', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'desktop/Sentry.exe'), 'changed');
  await assert.rejects(validate(root), /Checksum mismatch/);
});

test('resealing cannot hide a missing packaged CLI from either archive validator', async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'cli/sentry-cli.cjs'));
  await seal(root);
  await assert.rejects(validate(root), /Required artifact component missing: cli\/sentry-cli.cjs/);
  if (process.platform === 'win32') {
    const runner = join(root, '..', 'missing-cli-' + process.pid + '.ps1');
    t.after(() => rm(runner, { force: true }));
    const quote = (p) => "'" + p.replaceAll("'", "''") + "'";
    await writeFile(
      runner,
      `. ${quote(join(scripts, 'verify.ps1'))}\nGet-SentryDistribution -Root ${quote(root)} | Out-Null`,
    );
    assert.throws(
      () => execFileSync('powershell.exe', ['-NoProfile', '-File', runner], { stdio: 'pipe' }),
      /Required component missing: cli\/sentry-cli.cjs/,
    );
  }
});

test('RC archive identity validates and refuses a historical-beta component pair', async (t) => {
  const root = await fixture(t);
  const rc = { ...identity, version: '1.0.0-rc.1' };
  for (const path of [
    'build-identity.json',
    'runtime-source/build-identity.json',
    'desktop/resources/app/build-identity.json',
  ])
    await writeFile(join(root, path), JSON.stringify(rc));
  for (const path of ['runtime-source/package.json', 'desktop/resources/app/package.json'])
    await writeFile(join(root, path), JSON.stringify({ version: rc.version }));
  await seal(root, { version: rc.version });
  assert.equal((await validate(root)).version, rc.version);
  await writeFile(join(root, 'runtime-source/build-identity.json'), JSON.stringify(identity));
  await seal(root, { version: rc.version });
  await assert.rejects(validate(root), /Component identity mismatch/);
});

test('stable archive validates and refuses a stale RC runtime even with a resealed inventory', async (t) => {
  const root = await fixture(t);
  const stable = { ...identity, version: '1.0.0' };
  for (const path of [
    'build-identity.json',
    'runtime-source/build-identity.json',
    'desktop/resources/app/build-identity.json',
  ])
    await writeFile(join(root, path), JSON.stringify(stable));
  for (const path of ['runtime-source/package.json', 'desktop/resources/app/package.json'])
    await writeFile(join(root, path), JSON.stringify({ version: stable.version }));
  await seal(root, { version: stable.version });
  assert.equal((await validate(root)).version, '1.0.0');
  await writeFile(
    join(root, 'runtime-source/build-identity.json'),
    JSON.stringify({ ...stable, version: '1.0.0-rc.1' }),
  );
  await seal(root, { version: stable.version });
  await assert.rejects(validate(root), /Component identity mismatch/);
});
test('missing required preload fails even with regenerated inventory', async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'desktop/resources/app/dist/preload/preload.js'));
  await seal(root);
  await assert.rejects(validate(root), /Required artifact component missing/);
});
test('unlisted files and private data reject', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'extra.txt'), 'unlisted');
  await assert.rejects(validate(root), /inventory mismatch/);
  await writeFile(join(root, '.env'), 'fake secret');
  await assert.rejects(validate(root), /Forbidden artifact path/);
});
test('component source SHA and package version must match', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'runtime-source/build-identity.json'),
    JSON.stringify({ ...identity, sourceCommit: 'b'.repeat(40) }),
  );
  await seal(root);
  await assert.rejects(validate(root), /Component identity mismatch/);
  await writeFile(join(root, 'runtime-source/build-identity.json'), JSON.stringify(identity));
  await writeFile(join(root, 'desktop/resources/app/package.json'), '{"version":"1.0.0"}');
  await seal(root);
  await assert.rejects(validate(root), /Package version mismatch/);
});
test('malformed identity, unsupported architecture/platform and unsafe paths fail closed', async (t) => {
  for (const value of [
    {},
    { ...identity, version: '../../data' },
    { ...identity, sourceCommit: 'main' },
    { ...identity, runtimeProtocol: 2 },
  ])
    assert.throws(() => parseIdentity(value));
  for (const path of ['/etc/passwd', '../data', 'a/../data', 'C:/data', 'a\\b', 'a//b'])
    assert.equal(safePath(path), false);
  for (const path of [
    '.git/config',
    '.env.production',
    'credentials/providers.json',
    'user.sqlite-wal',
    'workspaces/project',
    'private.key',
  ])
    assert.equal(forbidden(path), true);
  const root = await fixture(t);
  await seal(root, { targetPlatform: 'windows-arm64' });
  await assert.rejects(validate(root), /Invalid distribution manifest/);
});
test('symlinks are rejected', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fixture(t);
  await symlink('/etc/passwd', join(root, 'escape'));
  await assert.rejects(validate(root), /symlink rejected/);
});
test(
  'PowerShell validator handles Git-less paths with spaces and rejects tampering',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fixture(t);
    const runner = join(root, '..', 'verify-fixture-' + process.pid + '.ps1');
    t.after(() => rm(runner, { force: true }));
    const quote = (p) => "'" + p.replaceAll("'", "''") + "'";
    await writeFile(
      runner,
      `. ${quote(join(scripts, 'verify.ps1'))}\nGet-SentryDistribution -Root ${quote(root)} | Out-Null\n`,
    );
    execFileSync('powershell.exe', ['-NoProfile', '-File', runner]);
    // Relative and short-name roots need the same inventory as absolute roots.
    await writeFile(
      runner,
      `. ${quote(join(scripts, 'verify.ps1'))}\nGet-SentryDistribution -Root ${quote(relative(process.cwd(), root))} | Out-Null\n`,
    );
    execFileSync('powershell.exe', ['-NoProfile', '-File', runner]);
    await writeFile(join(root, 'desktop/Sentry.exe'), 'tampered');
    assert.throws(() =>
      execFileSync('powershell.exe', ['-NoProfile', '-File', runner], { stdio: 'pipe' }),
    );
  },
);
