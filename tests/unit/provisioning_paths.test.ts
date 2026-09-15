/**
 * HR-02.5D2 unit tests: managed paths + staging/promotion.
 *
 * Fully deterministic: in-memory filesystem seam, no real I/O outside
 * temp-dir-free memory, no network, no GPU, no models.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { ArthurError } from '../../src/core/errors/errors';
import {
  ManagedPathService,
  assertInsideRoot,
  assertNoEscapeThroughLinks,
  canonicalizeRoot,
  defaultLocalModelRoot,
  memoryPathoscopy,
  resolveAppDataRoot,
  toStorageKey,
} from '../../src/runtime/local-models/provisioning/paths';
import {
  cleanupPaths,
  commitStagedDirectory,
  createStagingArea,
  discardStagingArea,
  memoryProvisioningFs,
  recoverLiveFromBackup,
  scanRecoveryNeeded,
} from '../../src/runtime/local-models/provisioning/staging';

const ROOT = path.resolve('/managed');

function codeOf(err: unknown): string {
  assert.ok(err instanceof ArthurError);
  return (err as ArthurError).code;
}

// ---- storage keys ---------------------------------------------------------------

test('valid model ids map to safe storage keys', () => {
  assert.equal(toStorageKey('parakeet-tdt-0.6b-v3'), 'parakeet-tdt-0-6b-v3');
  assert.equal(toStorageKey('OmniVoice_BG'), 'omnivoice-bg');
  assert.equal(toStorageKey('bgtts-38m-v2'), 'bgtts-38m-v2');
});

test('hostile ids cannot become paths', () => {
  assert.throws(() => toStorageKey('../evil'), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  assert.throws(() => toStorageKey(''), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  assert.throws(() => toStorageKey('...'), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  assert.throws(() => toStorageKey('x'.repeat(300)), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
});

test('path traversal and absolute escape are rejected', () => {
  assert.throws(() => assertInsideRoot(ROOT, path.join(ROOT, '..', 'evil'), 't'), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  assert.throws(() => assertInsideRoot(ROOT, '/etc/passwd', 't'), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  assert.throws(() => assertInsideRoot(ROOT, 'C:\\Windows\\x', 't'), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  assert.throws(() => assertInsideRoot(ROOT, path.join(ROOT, 'sub', '..', '..', 'x'), 't'), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  // The root itself and strict children pass.
  assert.equal(assertInsideRoot(ROOT, ROOT, 't'), path.normalize(ROOT));
  assert.ok(assertInsideRoot(ROOT, path.join(ROOT, 'models', 'x'), 't').length > 0);
});

test('managed layout stays under the root', () => {
  const svc = new ManagedPathService(ROOT);
  assert.equal(svc.layout.root, ROOT);
  assert.ok(svc.liveDir('parakeet-tdt-0-6b-v3').startsWith(ROOT));
  assert.ok(svc.runtimeDir('py-1').startsWith(ROOT));
  assert.ok(svc.cachePath('a.bin').startsWith(ROOT));
  assert.throws(() => svc.modelDir('../evil'), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  assert.throws(() => svc.runtimeDir('../../evil'), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  assert.throws(() => svc.cachePath('../../evil.bin'), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
});

test('cleanup cannot delete outside the root', () => {
  const fs = memoryProvisioningFs([ROOT, path.join(ROOT, 'models')]);
  const report = cleanupPaths(ROOT, fs, [path.join(ROOT, 'models', 'x'), '/etc/passwd', path.join(ROOT, '..', 'sibling')]);
  assert.deepEqual(report.removed, [path.join(ROOT, 'models', 'x')]);
  assert.equal(report.kept.length, 2);
  assert.equal(report.errors.length, 2);
});

// ---- staging / promotion -----------------------------------------------------------

test('staging area is created outside the live path', () => {
  const fs = memoryProvisioningFs([ROOT]);
  const svc = new ManagedPathService(ROOT);
  const live = svc.liveDir('model-a');
  const area = createStagingArea(ROOT, fs, live, 'model-a');
  assert.notEqual(area.stagingDir, live);
  assert.ok(area.stagingDir.startsWith(path.dirname(live)));
  assert.ok(fs.exists(area.stagingDir));
  assert.equal(fs.exists(live), false);
});

test('successful promotion moves staging to live', () => {
  const fs = memoryProvisioningFs([ROOT]);
  const svc = new ManagedPathService(ROOT);
  const live = svc.liveDir('model-a');
  const area = createStagingArea(ROOT, fs, live, 'model-a');
  const result = commitStagedDirectory(ROOT, fs, area.stagingDir, live);
  assert.equal(result.outcome, 'promoted');
  assert.equal(fs.exists(live), true);
  assert.equal(fs.exists(area.stagingDir), false);
});

test('live install is preserved until promotion completes', () => {
  const fs = memoryProvisioningFs([ROOT]);
  const svc = new ManagedPathService(ROOT);
  const live = svc.liveDir('model-a');
  const first = createStagingArea(ROOT, fs, live, 'model-a');
  fs.files.set(path.join(first.stagingDir, 'v1.bin'), 'v1');
  assert.equal(commitStagedDirectory(ROOT, fs, first.stagingDir, live).outcome, 'promoted');
  const second = createStagingArea(ROOT, fs, live, 'model-a');
  // Live v1 is intact while v2 is staged (no direct live writes).
  assert.deepEqual(fs.files.get(path.join(live, 'v1.bin')), 'v1');
  assert.equal(fs.exists(second.stagingDir), true);
  fs.files.set(path.join(second.stagingDir, 'v2.bin'), 'v2');
  assert.equal(commitStagedDirectory(ROOT, fs, second.stagingDir, live).outcome, 'promoted');
  assert.deepEqual(fs.files.get(path.join(live, 'v2.bin')), 'v2');
});

test('promotion failure restores the previous live install', () => {
  const svc = new ManagedPathService(ROOT);
  const live = svc.liveDir('model-a');
  const fs = memoryProvisioningFs([ROOT, live]);
  fs.files.set(path.join(live, 'v1.bin'), 'v1');
  // Inject failure on the staged->live rename only.
  const area = createStagingArea(ROOT, fs, live, 'model-a');
  const failing = memoryProvisioningFs([], { [area.stagingDir]: 'fail' });
  // Seed the failing fs with the same tree.
  failing.mkdirp(live);
  failing.files.set(path.join(live, 'v1.bin'), 'v1');
  failing.mkdirp(area.stagingDir);
  const result = commitStagedDirectory(ROOT, failing, area.stagingDir, live);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.previous_preserved, true);
  assert.equal(failing.exists(live), true);
});

test('failed staging area is discarded without touching live', () => {
  const fs = memoryProvisioningFs([ROOT]);
  const svc = new ManagedPathService(ROOT);
  const live = svc.liveDir('model-a');
  const first = createStagingArea(ROOT, fs, live, 'model-a');
  fs.files.set(path.join(first.stagingDir, 'v1.bin'), 'v1');
  assert.equal(commitStagedDirectory(ROOT, fs, first.stagingDir, live).outcome, 'promoted');
  const bad = createStagingArea(ROOT, fs, live, 'model-a');
  fs.files.set(path.join(bad.stagingDir, 'junk.bin'), 'junk');
  discardStagingArea(ROOT, fs, bad.stagingDir);
  assert.equal(fs.exists(bad.stagingDir), false);
  assert.equal(fs.exists(live), true);
  assert.deepEqual(fs.files.get(path.join(live, 'v1.bin')), 'v1');
});

test('discard refuses non-staging directories', () => {
  const fs = memoryProvisioningFs([ROOT]);
  const svc = new ManagedPathService(ROOT);
  const live = svc.liveDir('model-a');
  assert.throws(() => discardStagingArea(ROOT, fs, live), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
});

test('recovery scan reports leftovers without deleting', () => {
  const fs = memoryProvisioningFs([ROOT]);
  const svc = new ManagedPathService(ROOT);
  const live = svc.liveDir('model-a');
  const area = createStagingArea(ROOT, fs, live, 'model-a');
  void area;
  const scan = scanRecoveryNeeded(ROOT, fs, [svc.modelDir('model-a')]);
  assert.equal(scan.needs_attention, true);
  assert.ok(scan.staging_dirs.length >= 1);
  // Scan is report-only: nothing was removed.
  assert.equal(fs.exists(live), false);
});


// ---- correction 1: canonical root + link defense -----------------------------------------

test('same configured root resolves identically regardless of caller', () => {
  const a = resolveAppDataRoot({ configured: '/data/arthur' });
  const b = resolveAppDataRoot({ configured: '/data/arthur' });
  assert.equal(a, b);
  const c = canonicalizeRoot(a, memoryPathoscopy({}));
  const d = canonicalizeRoot(b, memoryPathoscopy({}));
  assert.equal(c, d);
});

test('default data root without explicit config never depends on cwd', () => {
  // No configured root, no ARTHUR_DATA_DIR: the fallback must be a
  // stable per-user location. Different user env values change it
  // (different users), but cwd never does — resolveAppDataRoot takes
  // no cwd input at all (the type has no such field).
  const winEnv = { LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local' };
  const first = resolveAppDataRoot({ env: winEnv, platform: 'win32' });
  const second = resolveAppDataRoot({ env: winEnv, platform: 'win32' });
  assert.equal(first, second);
  assert.ok(!first.includes('work'));
  const linuxEnv = { HOME: '/home/op' };
  assert.equal(
    defaultLocalModelRoot({ env: linuxEnv, platform: 'linux' }, memoryPathoscopy({})),
    defaultLocalModelRoot({ env: linuxEnv, platform: 'linux' }, memoryPathoscopy({})),
  );
  // Explicit dev override still permits a repo-local ./data location.
  assert.equal(resolveAppDataRoot({ configured: './data', env: {} }), path.resolve('./data'));
});

test('windows implicit root uses LOCALAPPDATA, never the roaming profile', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local', APPDATA: 'C:\\Users\\op\\AppData\\Roaming' };
  const root = resolveAppDataRoot({ env, platform: 'win32' });
  assert.ok(root.includes('Local'));
  assert.ok(!root.includes('Roaming'));
  assert.equal(root, path.resolve('C:\\Users\\op\\AppData\\Local\\ARTHUR'));
});

test('APPDATA alone does not satisfy the windows implicit root', () => {
  // APPDATA without LOCALAPPDATA: no stable machine-local location is
  // known, so resolution fails typed instead of roaming by default.
  assert.throws(
    () => resolveAppDataRoot({ env: { APPDATA: 'C:\\Users\\op\\AppData\\Roaming' }, platform: 'win32' }),
    (e: unknown) => (e as ArthurError).code === 'INVALID_CONFIG',
  );
});

test('no stable user-data location fails typed instead of temp fallback', () => {
  assert.throws(
    () => resolveAppDataRoot({ env: {}, platform: 'win32' }),
    (e: unknown) => (e as ArthurError).code === 'INVALID_CONFIG',
  );
  assert.throws(
    () => resolveAppDataRoot({ env: {}, platform: 'linux' }),
    (e: unknown) => (e as ArthurError).code === 'INVALID_CONFIG',
  );
  assert.throws(
    () => defaultLocalModelRoot({ env: {}, platform: 'linux' }, memoryPathoscopy({})),
    (e: unknown) => (e as ArthurError).code === 'INVALID_CONFIG',
  );
});

test('symlink escape of the live dir is rejected', () => {
  const scope = memoryPathoscopy({ [path.join(ROOT, 'models', 'evil', 'live')]: '/etc/secret' });
  assert.throws(
    () => assertNoEscapeThroughLinks(canonicalizeRoot(ROOT, scope), path.join(ROOT, 'models', 'evil', 'live'), 'live dir', scope),
    (e: unknown) => codeOf(e) === 'INVALID_CONFIG',
  );
});

test('cleanup through a symlink escape is refused', () => {
  const target = path.join(ROOT, 'models', 'evil');
  const scope = memoryPathoscopy({ [target]: '/etc/secret' });
  const fs = memoryProvisioningFs([ROOT]);
  const report = cleanupPaths(ROOT, fs, [target], { scope });
  assert.deepEqual(report.removed, []);
  assert.equal(report.kept.length, 1);
  assert.ok(report.errors[0] && (report.errors[0] as string).includes('outside root'));
});

test('promotion with a linked parent is rejected', () => {
  const svc = new ManagedPathService(ROOT);
  const live = svc.liveDir('model-a');
  const scope = memoryPathoscopy({ [path.dirname(live)]: '/tmp/elsewhere' });
  const fs = memoryProvisioningFs([ROOT]);
  const area = createStagingArea(ROOT, fs, live, 'model-a');
  const result = commitStagedDirectory(ROOT, fs, area.stagingDir, live, { scope });
  assert.equal(result.outcome, 'failed');
  assert.ok((result.reason ?? '').includes('symlink') || (result.reason ?? '').includes('managed root'));
});

test('promotion with a linked staging dir is rejected', () => {
  const svc = new ManagedPathService(ROOT);
  const live = svc.liveDir('model-a');
  const fs = memoryProvisioningFs([ROOT]);
  const area = createStagingArea(ROOT, fs, live, 'model-a');
  const scope = memoryPathoscopy({ [area.stagingDir]: '/tmp/elsewhere' });
  const result = commitStagedDirectory(ROOT, fs, area.stagingDir, live, { scope });
  assert.equal(result.outcome, 'failed');
});

test('managed model cache stays inside the root', () => {
  const svc = new ManagedPathService(ROOT);
  assert.ok(svc.layout.hfCacheDir.startsWith(svc.layout.root));
  assert.ok(svc.layout.hfHubDir.startsWith(svc.layout.hfCacheDir));
  assert.ok(svc.layout.hfXetDir.startsWith(svc.layout.hfCacheDir));
  assert.ok(svc.layout.hfAssetsDir.startsWith(svc.layout.hfCacheDir));
  const env = svc.modelCacheEnv();
  assert.equal(env.HF_HUB_CACHE, svc.layout.hfHubDir);
  assert.equal(env.HF_XET_CACHE, svc.layout.hfXetDir);
  assert.equal(env.HF_ASSETS_CACHE, svc.layout.hfAssetsDir);
  assert.equal(env.TRANSFORMERS_CACHE, svc.layout.hfHubDir);
  for (const value of Object.values(env)) {
    assert.ok(path.normalize(value).startsWith(path.normalize(ROOT)));
  }
});

test('ambient external HF cache variables cannot redirect managed env', () => {
  // Even with hostile ambient variables, the managed env builder emits
  // only containment-checked managed paths (callers use it as the
  // subprocess overlay, overriding ambient values).
  process.env['HF_HUB_CACHE'] = '/tmp/evil-hub';
  process.env['HF_XET_CACHE'] = '/tmp/evil-xet';
  process.env['HF_ASSETS_CACHE'] = '/tmp/evil-assets';
  process.env['TRANSFORMERS_CACHE'] = '/tmp/evil-tr';
  try {
    const svc = new ManagedPathService(ROOT);
    const env = svc.modelCacheEnv();
    assert.ok(!Object.values(env).some((v) => v.includes('evil')));
    assert.equal(env.HF_HUB_CACHE, svc.layout.hfHubDir);
    assert.equal(env.HF_XET_CACHE, svc.layout.hfXetDir);
  } finally {
    delete process.env['HF_HUB_CACHE'];
    delete process.env['HF_XET_CACHE'];
    delete process.env['HF_ASSETS_CACHE'];
    delete process.env['TRANSFORMERS_CACHE'];
  }
});

test('managed overlay leaves credential discovery intact and mints no token', () => {
  // HF_HOME is absent (user token store + HF_TOKEN_PATH/HF_TOKEN keep
  // working); HF_TOKEN is not a managed key and is never emitted.
  const { isManagedEnvKey } = require('../../src/runtime/local-models/provisioning/paths') as typeof import('../../src/runtime/local-models/provisioning/paths');
  assert.equal(isManagedEnvKey('HF_HOME'), false);
  assert.equal(isManagedEnvKey('HF_TOKEN'), false);
  assert.equal(isManagedEnvKey('HF_TOKEN_PATH'), false);
  assert.equal(isManagedEnvKey('HF_HUB_CACHE'), true);
  const svc = new ManagedPathService(ROOT);
  const env = svc.modelCacheEnv();
  assert.ok(!('HF_HOME' in env));
  assert.ok(!('HF_TOKEN' in env));
  assert.ok(JSON.stringify(env).toLowerCase().includes('token') === false);
});

test('backup recovery restores live only when unambiguous', () => {
  const fs = memoryProvisioningFs([ROOT]);
  const svc = new ManagedPathService(ROOT);
  const live = svc.liveDir('model-a');
  fs.mkdirp(live + '.backup-1');
  fs.mkdirp(live + '.backup-2');
  const ambiguous = recoverLiveFromBackup(ROOT, fs, live);
  assert.equal(ambiguous.outcome, 'failed');
  const fs2 = memoryProvisioningFs([ROOT]);
  fs2.mkdirp(live + '.backup-1');
  fs2.files.set(path.join(live + '.backup-1', 'v1.bin'), 'v1');
  const single = recoverLiveFromBackup(ROOT, fs2, live);
  assert.equal(single.outcome, 'promoted');
  assert.equal(fs2.exists(live), true);
});
