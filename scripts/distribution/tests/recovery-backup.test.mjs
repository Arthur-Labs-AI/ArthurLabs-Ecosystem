import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  SentryDatabase,
  SentryRepository,
  RuntimeInstanceLease,
} from '../../../packages/persistence/dist/index.js';
import { sealBundle, verifyBundle } from './recovery-backup.mjs';

const identity = {
  sourceCommit: 'c78faa74717b0f430a859730e98c3c4915e7b03f',
  version: '0.1.0-beta.1',
  runtimeProtocol: 1,
};
test('unrelated directories are refused before reading a backup receipt', async () => {
  await assert.rejects(verifyBundle(tmpdir(), identity));
  await assert.rejects(sealBundle(tmpdir(), identity));
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sentry-recovery-backup-'));
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'sentry-recovery-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data'));
  await mkdir(join(root, 'profile/credentials'), { recursive: true });
  const generation = { generation: 'synthetic-generation', fixtureOnly: true };
  for (const path of [
    'fixture.json',
    'data/recovery-generation.json',
    'profile/recovery-generation.json',
  ])
    await writeFile(join(root, path), JSON.stringify(generation));
  const db = new SentryDatabase({ dataRoot: join(root, 'data') });
  db.close();
  await writeFile(
    join(root, 'profile/credentials/providers.json'),
    JSON.stringify({
      version: 1,
      secrets: { DEEPSEEK_API_KEY: Buffer.from('opaque-synthetic-ciphertext').toString('base64') },
    }),
  );
  await writeFile(join(root, 'data/export.json'), '{"synthetic":true}\n');
  return root;
}
test('sealed stopped backup verifies complete data/profile bytes and never activates a runtime', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'retained-current'), 'previous');
  const receipt = await sealBundle(root, identity);
  assert.deepEqual((await verifyBundle(root, identity)).files, receipt.files);
  assert.equal(await readFile(join(root, 'retained-current'), 'utf8'), 'previous');
});
test('missing database refuses before manifest creation', async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'data/sentry.db'));
  await assert.rejects(sealBundle(root, identity));
  await assert.rejects(readFile(join(root, 'backup.json')), { code: 'ENOENT' });
});
for (const kind of ['missing', 'changed', 'extra'])
  test(kind + ' backup material refuses without rewriting backup', async (t) => {
    const root = await fixture(t);
    await sealBundle(root, identity);
    const original = await readFile(join(root, 'backup.json'));
    if (kind === 'missing') await rm(join(root, 'data/export.json'));
    if (kind === 'changed') await writeFile(join(root, 'data/export.json'), 'corrupt');
    if (kind === 'extra') await writeFile(join(root, 'data/untracked'), 'extra generation');
    await assert.rejects(verifyBundle(root, identity));
    assert.deepEqual(await readFile(join(root, 'backup.json')), original);
  });
test('mixed profile generation refuses', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'profile/recovery-generation.json'),
    JSON.stringify({ generation: 'different', fixtureOnly: true }),
  );
  await assert.rejects(sealBundle(root, identity));
});
test('mismatched recovery version/protocol/source refuses', async (t) => {
  const root = await fixture(t);
  await sealBundle(root, identity);
  for (const other of [
    { ...identity, version: '9.0.0' },
    { ...identity, runtimeProtocol: 2 },
    { ...identity, sourceCommit: 'a'.repeat(40) },
  ])
    await assert.rejects(verifyBundle(root, other));
});
test('unsupported schema generation refuses', async (t) => {
  const root = await fixture(t);
  const db = new SentryDatabase({ dataRoot: join(root, 'data') });
  db.connection.exec('CREATE TABLE unsupported_generation(id TEXT);');
  db.close();
  await assert.rejects(sealBundle(root, identity));
});
test('corrupt SQLite refuses', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'data/sentry.db'), 'not sqlite');
  await assert.rejects(sealBundle(root, identity));
});
test('nonempty WAL refuses the stopped checkpointed-backup contract', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'data/sentry.db-wal'), 'uncheckpointed');
  await assert.rejects(sealBundle(root, identity));
});
test('unreleased runtime and profile lock refuse', async (t) => {
  const root = await fixture(t);
  const db = new SentryDatabase({ dataRoot: join(root, 'data') });
  new RuntimeInstanceLease(new SentryRepository(db), { autoHeartbeat: false }).start();
  db.close();
  await assert.rejects(sealBundle(root, identity));
  const clean = await fixture(t);
  await writeFile(join(clean, 'profile/SingletonLock'), 'active');
  await assert.rejects(sealBundle(clean, identity));
});
test('second seal refuses existing receipt and preserves original', async (t) => {
  const root = await fixture(t);
  await sealBundle(root, identity);
  const original = await readFile(join(root, 'backup.json'));
  await assert.rejects(sealBundle(root, identity));
  assert.deepEqual(await readFile(join(root, 'backup.json')), original);
});
test('symlink material refuses', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fixture(t);
  await symlink('export.json', join(root, 'data/alias'));
  await assert.rejects(sealBundle(root, identity));
});
test(
  'root marker symlink refuses instead of reading unrelated material',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await fixture(t),
      outside = await mkdtemp(join(tmpdir(), 'sentry-unrelated-marker-'));
    assert.ok(resolve(outside).startsWith(resolve(tmpdir()) + sep + 'sentry-unrelated-marker-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'marker.json'), await readFile(join(root, 'fixture.json')));
    await rm(join(root, 'fixture.json'));
    await symlink(join(outside, 'marker.json'), join(root, 'fixture.json'));
    await assert.rejects(sealBundle(root, identity));
  },
);
test('special object-property filenames are inventoried and tampering is rejected', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'data/__proto__'), 'synthetic material');
  const receipt = await sealBundle(root, identity);
  assert.equal(Object.hasOwn(receipt.files.data, '__proto__'), true);
  await writeFile(join(root, 'data/__proto__'), 'changed');
  await assert.rejects(verifyBundle(root, identity));
});
