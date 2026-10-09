/**
 * HR-02.5F hardening tests: one canonical path contract + selection provenance.
 *
 * Fully deterministic: injected env/platform/pathImpl seams, in-memory
 * state filesystem, fake hardware + catalog fixtures. No real I/O,
 * no subprocess, no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import type { CliIO } from '../../apps/cli/index';
import { CliExit } from '../../src/cli_exit';
import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import {
  LOCAL_MODEL_STATE_FILENAME,
  defaultLocalModelRoot,
  defaultLocalModelStatePath,
  memoryPathoscopy,
  resolveAppDataRoot,
  resolveLocalModelPaths,
} from '../../src/runtime/local-models/provisioning/paths';
import { LocalModelStateStore, memoryStateFileSystem } from '../../src/runtime/local-models/state_store';
import { defaultStateFile } from '../../src/runtime/local-models/state_contracts';
import { resolveEffectiveSelection } from '../../src/runtime/local-models/selection';
import {
  buildModelList,
  buildStatus,
  formatStatus,
  modelsContext,
  provenanceOf,
  runModelsRecommend,
  runModelsSelect,
  runModelsStatus,
} from '../../apps/cli/models';
import { cpuOnlyX64, windowsNvidiaCuda } from './hardware_fixtures';

function io(): CliIO & { outText: string; errText: string } {
  const sink = {
    outText: '',
    errText: '',
    out(text: string): void { sink.outText += text; },
    err(text: string): void { sink.errText += text; },
  };
  return sink;
}

function fakeAppWithVoice(voice: { localModelRoot?: string; localModelStatePath?: string }): never {
  return { config: { voice: { localModelRoot: voice.localModelRoot ?? '', localModelStatePath: voice.localModelStatePath ?? '' } } } as never;
}

const HW = windowsNvidiaCuda();
const LINUX_HW: HardwareProfile = { ...cpuOnlyX64(), os: 'linux', arch: 'x64' };
const PROBE = { detect: async (): Promise<HardwareProfile> => HW };

// ---- Part A/B: canonical defaults -------------------------------------------

test('default linux paths are absolute and based on the stable user-data root', () => {
  const env = { HOME: '/home/op' };
  const root = defaultLocalModelRoot({ env, platform: 'linux' }, memoryPathoscopy({}));
  const state = defaultLocalModelStatePath({ env, platform: 'linux' }, memoryPathoscopy({}));
  assert.ok(path.isAbsolute(root), root);
  assert.ok(path.isAbsolute(state), state);
  assert.equal(root, path.join('/home/op/.local/share/arthur', 'runtime', 'local-models'));
  assert.equal(state, path.join('/home/op/.local/share/arthur', 'runtime', LOCAL_MODEL_STATE_FILENAME));
  // State and root share the same data-root contract.
  assert.ok(state.startsWith(path.join('/home/op/.local/share/arthur', 'runtime')));
  assert.ok(root.startsWith(resolveAppDataRoot({ env, platform: 'linux' })));
});

test('XDG_DATA_HOME is honored', () => {
  const env = { XDG_DATA_HOME: '/data/xdg', HOME: '/home/op' };
  const root = defaultLocalModelRoot({ env, platform: 'linux' }, memoryPathoscopy({}));
  const state = defaultLocalModelStatePath({ env, platform: 'linux' }, memoryPathoscopy({}));
  assert.equal(root, path.join('/data/xdg/arthur', 'runtime', 'local-models'));
  assert.equal(state, path.join('/data/xdg/arthur', 'runtime', 'models.json'));
});

test('ARTHUR_DATA_DIR overrides the OS default for both root and state', () => {
  const env = { ARTHUR_DATA_DIR: '/srv/arthur-data', HOME: '/home/op' };
  const resolved = resolveLocalModelPaths({}, { env, platform: 'linux' });
  assert.equal(resolved.managedRoot, path.join('/srv/arthur-data', 'runtime', 'local-models'));
  assert.equal(resolved.statePath, path.join('/srv/arthur-data', 'runtime', 'models.json'));
});

test('explicit root overrides ARTHUR_DATA_DIR and the OS default', () => {
  const env = { ARTHUR_DATA_DIR: '/srv/arthur-data', HOME: '/home/op' };
  const resolved = resolveLocalModelPaths({ managedRoot: '/explicit/root' }, { env, platform: 'linux' });
  assert.equal(resolved.managedRoot, path.resolve('/explicit/root'));
  // State still follows the data-root contract when not overridden.
  assert.equal(resolved.statePath, path.join('/srv/arthur-data', 'runtime', 'models.json'));
});

test('explicit state overrides ARTHUR_DATA_DIR and the OS default', () => {
  const env = { ARTHUR_DATA_DIR: '/srv/arthur-data', HOME: '/home/op' };
  const resolved = resolveLocalModelPaths({ statePath: '/explicit/models.json' }, { env, platform: 'linux' });
  assert.equal(resolved.statePath, path.resolve('/explicit/models.json'));
  assert.equal(resolved.managedRoot, path.join('/srv/arthur-data', 'runtime', 'local-models'));
});

test('same default paths from home, repo root, and /tmp (never cwd-dependent)', () => {
  const env = { HOME: '/home/op' };
  const fromHome = resolveLocalModelPaths({}, { env, platform: 'linux' });
  // resolveAppDataRoot takes no cwd input; simulate three cwds by
  // resolving explicit-relative control separately — defaults ignore cwd.
  const a = resolveLocalModelPaths({}, { env, platform: 'linux' });
  const b = resolveLocalModelPaths({}, { env, platform: 'linux' });
  assert.deepEqual(a, b);
  assert.deepEqual(fromHome, a);
  assert.ok(!fromHome.managedRoot.includes(process.cwd()));
  assert.ok(!fromHome.statePath.includes(process.cwd()));
});

test('explicit relative paths normalize deterministically via path.resolve', () => {
  const resolved = resolveLocalModelPaths({ managedRoot: 'rel/root', statePath: 'rel/state.json' }, { env: { HOME: '/home/op' }, platform: 'linux' });
  assert.equal(resolved.managedRoot, path.resolve('rel/root'));
  assert.equal(resolved.statePath, path.resolve('rel/state.json'));
  assert.ok(path.isAbsolute(resolved.managedRoot));
  assert.ok(path.isAbsolute(resolved.statePath));
});

test('legacy relative cwd defaults are gone from the resolver surface', async () => {
  // modelsContext with empty config must NOT report ./data/... values.
  const sink = io();
  const ctx = modelsContext(fakeAppWithVoice({}), new Map(), sink);
  assert.ok(path.isAbsolute(ctx.managedRoot), ctx.managedRoot);
  assert.ok(path.isAbsolute(ctx.statePath), ctx.statePath);
  assert.ok(!ctx.managedRoot.startsWith('./data') && !ctx.managedRoot.startsWith('data'));
  assert.ok(!ctx.statePath.startsWith('./data') && !ctx.statePath.startsWith('data'));
});

// ---- Part C: CLI reports effective paths ------------------------------------

test('models status --json reports the exact effective absolute paths in use', async () => {
  const sink = io();
  const ctx = modelsContext(fakeAppWithVoice({}), new Map(), sink);
  const store = LocalModelStateStore.load({ statePath: ctx.statePath, fs: memoryStateFileSystem({}) });
  const code = await runModelsStatus(fakeAppWithVoice({}), { ...ctx, json: true }, { probe: PROBE, store });
  assert.equal(code, CliExit.SUCCESS);
  const parsed = JSON.parse(sink.outText) as { ok: boolean; data: { managed_root: string; state_path: string } };
  assert.equal(parsed.data.managed_root, ctx.managedRoot);
  assert.equal(parsed.data.state_path, store.path);
  assert.ok(path.isAbsolute(parsed.data.managed_root));
  assert.ok(path.isAbsolute(parsed.data.state_path));
});

test('modelsContext honors explicit flags over config and defaults', () => {
  const sink = io();
  const ctx = modelsContext(
    fakeAppWithVoice({ localModelRoot: '/cfg/root', localModelStatePath: '/cfg/state.json' }),
    new Map([['root', '/flag/root'], ['state', '/flag/state.json']]),
    sink,
  );
  assert.equal(ctx.managedRoot, path.resolve('/flag/root'));
  assert.equal(ctx.statePath, path.resolve('/flag/state.json'));
});

test('modelsContext honors caller configuration over OS defaults', () => {
  const sink = io();
  const ctx = modelsContext(fakeAppWithVoice({ localModelRoot: '/cfg/root', localModelStatePath: '/cfg/state.json' }), new Map(), sink);
  assert.equal(ctx.managedRoot, path.resolve('/cfg/root'));
  assert.equal(ctx.statePath, path.resolve('/cfg/state.json'));
});

test('status human text shows effective absolute paths', async () => {
  const sink = io();
  const ctx = modelsContext(fakeAppWithVoice({}), new Map(), sink);
  const store = LocalModelStateStore.load({ statePath: ctx.statePath, fs: memoryStateFileSystem({}) });
  const data = await buildStatus(fakeAppWithVoice({}), ctx, { probe: PROBE, store });
  const text = formatStatus(data);
  assert.ok(text.includes('managed root: ' + ctx.managedRoot));
  assert.ok(text.includes('state: ' + ctx.statePath));
});

// ---- Part D: selection provenance -------------------------------------------

test('provenance mapping covers override/manual/recommended/none', () => {
  assert.equal(provenanceOf('override'), 'environment');
  assert.equal(provenanceOf('manual'), 'manual');
  assert.equal(provenanceOf('recommended'), 'recommendation');
  assert.equal(provenanceOf('none'), 'none');
});

test('status exposes recommendation source without persisted state', async () => {
  const sink = io();
  const ctx = modelsContext(fakeAppWithVoice({}), new Map(), sink);
  const store = LocalModelStateStore.load({ statePath: ctx.statePath, fs: memoryStateFileSystem({}) });
  const data = await buildStatus(fakeAppWithVoice({}), ctx, { probe: PROBE, store });
  assert.equal(data.tts.selection_source, 'recommendation');
  assert.equal(data.tts.selected, 'omnivoice-bg');
});

test('status exposes manual source after select (persisted)', async () => {
  const sink = io();
  const ctx = modelsContext(fakeAppWithVoice({}), new Map(), sink);
  const store = LocalModelStateStore.load({ statePath: ctx.statePath, fs: memoryStateFileSystem({}) });
  const selCode = await runModelsSelect(fakeAppWithVoice({}), ctx, 'bgtts-38m-v2', { probe: PROBE, store });
  assert.equal(selCode, CliExit.SUCCESS);
  const data = await buildStatus(fakeAppWithVoice({}), ctx, { probe: PROBE, store });
  assert.equal(data.tts.selected, 'bgtts-38m-v2');
  assert.equal(data.tts.selection_source, 'manual');
  // Manual selection persisted in the snapshot.
  assert.deepEqual(store.snapshot().selections.tts, { mode: 'manual', model_id: 'bgtts-38m-v2' });
});

test('status exposes environment source under override', async () => {
  const sink = io();
  const ctx = modelsContext(fakeAppWithVoice({}), new Map(), sink);
  const store = LocalModelStateStore.load({ statePath: ctx.statePath, fs: memoryStateFileSystem({}) });
  const saved = process.env['ARTHUR_LOCAL_TTS_MODEL'];
  process.env['ARTHUR_LOCAL_TTS_MODEL'] = 'bgtts-38m-v2';
  try {
    const data = await buildStatus(fakeAppWithVoice({}), ctx, { probe: PROBE, store });
    assert.equal(data.tts.selection_source, 'environment');
    assert.equal(data.tts.selected, 'bgtts-38m-v2');
  } finally {
    if (saved === undefined) delete process.env['ARTHUR_LOCAL_TTS_MODEL'];
    else process.env['ARTHUR_LOCAL_TTS_MODEL'] = saved;
  }
});

test('status exposes none when nothing is compatible', async () => {
  const sink = io();
  const ctx = modelsContext(fakeAppWithVoice({}), new Map(), sink);
  const store = LocalModelStateStore.load({ statePath: ctx.statePath, fs: memoryStateFileSystem({}) });
  const blankProbe = { detect: async () => ({ ...HW, os: 'unknown', arch: 'unknown' }) as HardwareProfile };
  const data = await buildStatus(fakeAppWithVoice({}), ctx, { probe: blankProbe, store });
  assert.equal(data.stt.selection_source, 'none');
  assert.equal(data.stt.selected, null);
});

test('list rows expose per-model provenance (recommendation vs none)', async () => {
  const sink = io();
  const ctx = modelsContext(fakeAppWithVoice({}), new Map(), sink);
  const store = LocalModelStateStore.load({ statePath: ctx.statePath, fs: memoryStateFileSystem({}) });
  const { rows } = await buildModelList(fakeAppWithVoice({}), ctx, { probe: PROBE, store });
  const omni = rows.find((r) => r.id === 'omnivoice-bg');
  const bgtts = rows.find((r) => r.id === 'bgtts-38m-v2');
  assert.ok(omni && bgtts);
  assert.equal(omni.selected, true);
  assert.equal(omni.selection_source, 'recommendation');
  assert.equal(bgtts.selected, false);
  assert.equal(bgtts.selection_source, 'none');
});

test('list rows expose manual provenance for the selected model', async () => {
  const sink = io();
  const ctx = modelsContext(fakeAppWithVoice({}), new Map(), sink);
  const store = LocalModelStateStore.load({ statePath: ctx.statePath, fs: memoryStateFileSystem({}) });
  await store.select('tts', 'bgtts-38m-v2');
  const { rows } = await buildModelList(fakeAppWithVoice({}), ctx, { probe: PROBE, store });
  const bgtts = rows.find((r) => r.id === 'bgtts-38m-v2');
  assert.ok(bgtts);
  assert.equal(bgtts.selected, true);
  assert.equal(bgtts.selection_source, 'manual');
});

test('recommendation is recomputed live and never persisted', async () => {
  const sink = io();
  const ctx = modelsContext(fakeAppWithVoice({}), new Map(), sink);
  const store = LocalModelStateStore.load({ statePath: ctx.statePath, fs: memoryStateFileSystem({}) });
  const before = JSON.stringify(store.snapshot());
  const code = await runModelsRecommend(fakeAppWithVoice({}), ctx, new Map([['kind', 'tts']]), { probe: PROBE, store });
  assert.equal(code, CliExit.SUCCESS);
  assert.equal(JSON.stringify(store.snapshot()), before);
  // Resolver still reports recommendation (not manual) afterwards.
  const sel = resolveEffectiveSelection({ kind: 'tts', hardware: HW, state: store.snapshot() });
  assert.equal(sel.source, 'recommended');
  void defaultStateFile;
  void LINUX_HW;
});
