/**
 * HR-02.5C unit tests: persistent state, lifecycle, selection precedence.
 *
 * Fully deterministic: the file system is an in-memory seam, hardware
 * comes from HR-02.5A fixtures, and no real models, GPU, network, Python,
 * download, or provider construction is involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ArthurError } from '../../src/core/errors/errors';
import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import type { LocalModelStateFile } from '../../src/runtime/local-models/state_contracts';
import {
  defaultStateFile,
  parseStateFile,
  serializeStateFile,
} from '../../src/runtime/local-models/state_contracts';
import { LocalModelStateStore, memoryStateFileSystem } from '../../src/runtime/local-models/state_store';
import { resolveEffectiveSelection, resolveRunnableSelection } from '../../src/runtime/local-models/selection';
import {
  cpuOnlyX64,
  linuxArm64CpuOnly,
  partiallyUnknown,
  windowsNvidiaCuda,
  windowsNvidiaNoCuda,
} from './hardware_fixtures';

const PATH = '/tmp/arthur-test/models.json';

function codeOf(err: unknown): string {
  assert.ok(err instanceof ArthurError);
  return (err as ArthurError).code;
}

function withState(base: HardwareProfile): { hardware: HardwareProfile } {
  return { hardware: base };
}

// ---- persistence -------------------------------------------------------------

test('missing file yields default state', () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  const snap = store.snapshot();
  assert.equal(snap.version, 1);
  assert.deepEqual(snap.selections, { stt: { mode: 'auto' }, tts: { mode: 'auto' }, model: { mode: 'auto' } });
  assert.deepEqual(snap.models, {});
  assert.equal(fs.atomicWrites.length, 0);
});

test('write then reload preserves equality via the atomic seam', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.markInstalled('omnivoice-bg', '/models/omni', 'engine-v1');
  await store.markConfigured('omnivoice-bg');
  await store.markValidationPassed('omnivoice-bg', '2026-01-01T00:00:00Z', 'smoke ok');
  await store.select('tts', 'omnivoice-bg');
  assert.ok(fs.atomicWrites.length >= 4);
  assert.ok(fs.atomicWrites.every((p) => p === PATH));
  const raw = fs.files.get(PATH) as string;
  assert.ok(raw.endsWith('\n'));
  const reloaded = LocalModelStateStore.load({ statePath: PATH, fs });
  assert.deepEqual(reloaded.snapshot(), store.snapshot());
  const reparsed = parseStateFile(JSON.parse(raw), PATH);
  assert.deepEqual(reparsed, store.snapshot());
});

test('deterministic serialization is byte-stable', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.markInstalled('b-model');
  await store.markInstalled('a-model');
  const first = fs.files.get(PATH) as string;
  const again = serializeStateFile(store.snapshot());
  assert.equal(first, again);
  assert.ok(first.indexOf('"a-model"') < first.indexOf('"b-model"'));
});

test('unsupported version is rejected and the file is preserved', () => {
  const bad = JSON.stringify({ version: 99, selections: {}, models: {} });
  const fs = memoryStateFileSystem({ [PATH]: bad });
  assert.throws(() => LocalModelStateStore.load({ statePath: PATH, fs }), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  assert.equal(fs.files.get(PATH), bad);
});

test('malformed json is rejected and the file is preserved', () => {
  const bad = '{not json,,,';
  const fs = memoryStateFileSystem({ [PATH]: bad });
  assert.throws(() => LocalModelStateStore.load({ statePath: PATH, fs }), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  assert.equal(fs.files.get(PATH), bad);
});

test('wrong field types are rejected', () => {
  const bad = JSON.stringify({ version: 1, selections: { tts: { mode: 'sometimes' } }, models: {} });
  const fs = memoryStateFileSystem({ [PATH]: bad });
  assert.throws(() => LocalModelStateStore.load({ statePath: PATH, fs }), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  const bad2 = JSON.stringify({ version: 1, selections: {}, models: { x: { installed: 'yes', configured: false, ready: false } } });
  const fs2 = memoryStateFileSystem({ [PATH]: bad2 });
  assert.throws(() => LocalModelStateStore.load({ statePath: PATH, fs: fs2 }), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
});

test('impossible lifecycle state on disk is rejected', () => {
  const bad = JSON.stringify({
    version: 1,
    selections: {},
    models: { x: { installed: false, configured: false, ready: true } },
  });
  const fs = memoryStateFileSystem({ [PATH]: bad });
  assert.throws(() => LocalModelStateStore.load({ statePath: PATH, fs }), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  const bad2 = JSON.stringify({
    version: 1,
    selections: {},
    models: { x: { installed: false, configured: true, ready: false } },
  });
  const fs2 = memoryStateFileSystem({ [PATH]: bad2 });
  assert.throws(() => LocalModelStateStore.load({ statePath: PATH, fs: fs2 }), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
});

test('unknown lifecycle fields are rejected (no secret smuggling)', () => {
  const bad = JSON.stringify({
    version: 1,
    selections: {},
    models: { x: { installed: true, configured: true, ready: false, hf_token: 'secret' } },
  });
  const fs = memoryStateFileSystem({ [PATH]: bad });
  assert.throws(() => LocalModelStateStore.load({ statePath: PATH, fs }), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
});

// ---- lifecycle ------------------------------------------------------------------

test('install -> configure -> validate-pass reaches ready', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.markInstalled('omnivoice-bg');
  assert.equal(store.getModelState('omnivoice-bg') && (store.getModelState('omnivoice-bg') as { ready: boolean }).ready, false);
  await store.markConfigured('omnivoice-bg');
  await store.markValidationPassed('omnivoice-bg');
  const entry = store.getModelState('omnivoice-bg');
  assert.deepEqual([entry && entry.installed, entry && entry.configured, entry && entry.ready], [true, true, true]);
  assert.equal(entry && entry.last_validation && entry.last_validation.status, 'passed');
});

test('failed validation clears ready and records failure', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.markInstalled('omnivoice-bg');
  await store.markConfigured('omnivoice-bg');
  await store.markValidationPassed('omnivoice-bg');
  await store.markValidationFailed('omnivoice-bg', '2026-02-02T00:00:00Z', 'engine crashed');
  const entry = store.getModelState('omnivoice-bg');
  assert.equal(entry && entry.ready, false);
  assert.equal(entry && entry.installed, true);
  assert.equal(entry && entry.last_validation && entry.last_validation.status, 'failed');
  assert.equal(entry && entry.last_validation && entry.last_validation.reason, 'engine crashed');
});

test('uninstall clears configured and ready', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.markInstalled('omnivoice-bg');
  await store.markConfigured('omnivoice-bg');
  await store.markValidationPassed('omnivoice-bg');
  await store.removeModelState('omnivoice-bg');
  assert.equal(store.getModelState('omnivoice-bg'), null);
});

test('cannot persist ready without installed and configured', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await assert.rejects(() => store.markConfigured('ghost'), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  await store.markInstalled('ghost');
  await assert.rejects(() => store.markValidationPassed('ghost'), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
});

test('same-process concurrent mutations serialize without lost updates', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await Promise.all([store.markInstalled('a'), store.markInstalled('b'), store.selectAuto('tts')]);
  const snap = store.snapshot();
  assert.ok(snap.models['a'] && snap.models['a'].installed);
  assert.ok(snap.models['b'] && snap.models['b'].installed);
});

// ---- selection precedence ------------------------------------------------------------

test('override beats manual beats recommendation', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.select('tts', 'bgtts-38m-v2');
  const { hardware } = withState(windowsNvidiaCuda());
  const manual = resolveEffectiveSelection({ kind: 'tts', hardware, state: store.snapshot() });
  assert.equal(manual.source, 'manual');
  assert.equal(manual.model && manual.model.id, 'bgtts-38m-v2');
  const over = resolveEffectiveSelection({
    kind: 'tts', hardware, state: store.snapshot(), env: { ARTHUR_LOCAL_TTS_MODEL: 'omnivoice-bg' },
  });
  assert.equal(over.source, 'override');
  assert.equal(over.model && over.model.id, 'omnivoice-bg');
});

test('auto resolves to the live recommendation', () => {
  const sel = resolveEffectiveSelection({ kind: 'tts', hardware: windowsNvidiaCuda(), state: defaultStateFile() });
  assert.equal(sel.source, 'recommended');
  assert.equal(sel.model && sel.model.id, 'omnivoice-bg');
});

test('override auto falls through to normal precedence', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.select('tts', 'bgtts-38m-v2');
  const { hardware } = withState(windowsNvidiaCuda());
  const sel = resolveEffectiveSelection({ kind: 'tts', hardware, state: store.snapshot(), env: { ARTHUR_LOCAL_TTS_MODEL: 'auto' } });
  assert.equal(sel.source, 'manual');
});

test('unknown override model is a config error', () => {
  const { hardware } = withState(windowsNvidiaCuda());
  assert.throws(
    () => resolveEffectiveSelection({ kind: 'tts', hardware, env: { ARTHUR_LOCAL_TTS_MODEL: 'nope-nope' } }),
    (e: unknown) => codeOf(e) === 'INVALID_CONFIG',
  );
});

test('wrong-kind override is a config error', () => {
  const { hardware } = withState(windowsNvidiaCuda());
  assert.throws(
    () => resolveEffectiveSelection({ kind: 'tts', hardware, env: { ARTHUR_LOCAL_TTS_MODEL: 'parakeet-tdt-0.6b-v3' } }),
    (e: unknown) => codeOf(e) === 'INVALID_CONFIG',
  );
});

test('incompatible override resolves blocked, not silent fallback', () => {
  const { hardware } = withState(linuxArm64CpuOnly());
  const sel = resolveEffectiveSelection({ kind: 'tts', hardware, env: { ARTHUR_LOCAL_TTS_MODEL: 'omnivoice-bg' } });
  assert.equal(sel.source, 'override');
  assert.equal(sel.model, null);
  assert.ok(sel.reason.includes('blocked'));
});

test('manual incompatible model is rejected with reason', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.select('tts', 'omnivoice-bg');
  const sel = resolveEffectiveSelection({ kind: 'tts', hardware: linuxArm64CpuOnly(), state: store.snapshot() });
  assert.equal(sel.source, 'manual');
  assert.equal(sel.model, null);
  assert.ok(sel.reason.includes('incompatible'));
});

test('manual compatible but not installed is selected yet not runnable', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.select('tts', 'omnivoice-bg');
  const { hardware } = withState(windowsNvidiaCuda());
  const eff = resolveEffectiveSelection({ kind: 'tts', hardware, state: store.snapshot() });
  assert.equal(eff.model && eff.model.id, 'omnivoice-bg');
  const run = resolveRunnableSelection({ kind: 'tts', hardware, state: store.snapshot() });
  assert.equal(run.runnable, false);
  assert.ok(run.reason.includes('not installed'));
});

test('auto recommendation not installed is selected but not runnable', () => {
  const { hardware } = withState(windowsNvidiaCuda());
  const eff = resolveEffectiveSelection({ kind: 'tts', hardware, state: defaultStateFile() });
  assert.equal(eff.model && eff.model.id, 'omnivoice-bg');
  const run = resolveRunnableSelection({ kind: 'tts', hardware, state: defaultStateFile() });
  assert.equal(run.runnable, false);
  assert.ok(run.reason.includes('not installed'));
  assert.ok(!run.reason.includes('bgtts-38m-v2'));
});

test('ready compatible model is runnable', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.markInstalled('omnivoice-bg');
  await store.markConfigured('omnivoice-bg');
  await store.markValidationPassed('omnivoice-bg');
  const { hardware } = withState(windowsNvidiaCuda());
  const run = resolveRunnableSelection({ kind: 'tts', hardware, state: store.snapshot() });
  assert.equal(run.runnable, true);
  assert.equal(run.model && run.model.id, 'omnivoice-bg');
  assert.ok(run.reason.includes('ready'));
});

test('no compatible hardware yields none source', () => {
  const sel = resolveEffectiveSelection({ kind: 'stt', hardware: linuxArm64CpuOnly(), state: defaultStateFile() });
  assert.equal(sel.source, 'none');
  assert.equal(sel.model, null);
  const run = resolveRunnableSelection({ kind: 'stt', hardware: linuxArm64CpuOnly(), state: defaultStateFile() });
  assert.equal(run.runnable, false);
});

test('selectAuto clears manual state', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.select('tts', 'bgtts-38m-v2');
  await store.selectAuto('tts');
  assert.deepEqual(store.snapshot().selections.tts, { mode: 'auto' });
  const sel = resolveEffectiveSelection({ kind: 'tts', hardware: windowsNvidiaCuda(), state: store.snapshot() });
  assert.equal(sel.source, 'recommended');
});

// ---- catalog drift -------------------------------------------------------------------------

test('stale installed model id is tolerated as orphaned metadata', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.markInstalled('retired-model-v1');
  await store.markConfigured('retired-model-v1');
  await store.markValidationPassed('retired-model-v1');
  const snap = store.snapshot();
  assert.ok(snap.models['retired-model-v1']);
  const sel = resolveEffectiveSelection({ kind: 'tts', hardware: windowsNvidiaCuda(), state: snap });
  assert.equal(sel.model && sel.model.id, 'omnivoice-bg');
});

test('stale manual selected model id surfaces invalid selection', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.select('tts', 'retired-model-v1');
  const sel = resolveEffectiveSelection({ kind: 'tts', hardware: windowsNvidiaCuda(), state: store.snapshot() });
  assert.equal(sel.source, 'manual');
  assert.equal(sel.model, null);
  assert.ok(sel.reason.includes('not in the catalog'));
});

// ---- determinism --------------------------------------------------------------------------------

test('same hardware catalog state and overrides give the same selection', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  await store.markInstalled('omnivoice-bg');
  await store.markConfigured('omnivoice-bg');
  await store.markValidationPassed('omnivoice-bg');
  const state: LocalModelStateFile = store.snapshot();
  const env = { ARTHUR_LOCAL_TTS_MODEL: 'omnivoice-bg' };
  const first = resolveRunnableSelection({ kind: 'tts', hardware: windowsNvidiaCuda(), state, env });
  const second = resolveRunnableSelection({ kind: 'tts', hardware: windowsNvidiaCuda(), state: JSON.parse(JSON.stringify(state)) as LocalModelStateFile, env: { ...env } });
  assert.deepEqual(first, second);
});

test('cuda-unavailable hardware never selects a cuda model', () => {
  void partiallyUnknown;
  void windowsNvidiaNoCuda;
  void cpuOnlyX64;
  const sel = resolveEffectiveSelection({ kind: 'stt', hardware: windowsNvidiaNoCuda(), state: defaultStateFile() });
  assert.equal(sel.source, 'none');
  assert.equal(sel.model, null);
});
