/**
 * HR-02.5F deterministic CLI tests: models commands over fake seams.
 *
 * No network, GPU, models, or HF login: fake probe/state/installer/fs.
 * Covers detect/list/recommend/install/select/status/validate/remove
 * contracts including exit codes, JSON envelopes, and no-mutation rules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CliIO } from '../../apps/cli/index';
import { CliExit } from '../../src/cli_exit';
import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import { unknownAccelerators } from '../../src/runtime/hardware/contracts';
import { LocalModelStateStore, memoryStateFileSystem } from '../../src/runtime/local-models/state_store';
import type { ModelsContext } from '../../apps/cli/models';
import {
  buildModelList,
  formatHardware,
  runModelsDetect,
  runModelsInstall,
  runModelsList,
  runModelsRecommend,
  runModelsRemove,
  runModelsSelect,
  runModelsStatus,
  runModelsValidate,
} from '../../apps/cli/models';
import { windowsNvidiaCuda } from './hardware_fixtures';

function io(): CliIO & { outText: string; errText: string } {
  const sink = {
    outText: '',
    errText: '',
    out(text: string): void { sink.outText += text; },
    err(text: string): void { sink.errText += text; },
  };
  return sink;
}

function ctx(sink: CliIO, json = false): ModelsContext {
  return { managedRoot: '/managed-f', statePath: '/tmp/f-models.json', json, io: sink };
}

function fakeApp(): never {
  return undefined as never;
}

const HW = windowsNvidiaCuda();
const PROBE = { detect: async (): Promise<HardwareProfile> => HW };

function readyStore(): LocalModelStateStore {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: '/tmp/f-models.json', fs });
  return store;
}

function fakeInstallService(outcome: string): never {
  void outcome;
  return undefined as never;
}

test('detect renders normalized hardware with explicit unknowns', async () => {
  const sink = io();
  const code = await runModelsDetect(fakeApp(), ctx(sink), { probe: PROBE });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(sink.outText.includes('os: windows'));
  assert.ok(sink.outText.includes('RTX 4070'));
  assert.ok(sink.outText.includes('cuda: available'));
  // Unknown facts stay unknown (never inferred).
  const unknownHw: HardwareProfile = { ...HW, os: 'unknown', arch: 'unknown', gpus: [], accelerators: unknownAccelerators() };
  const text = formatHardware(unknownHw);
  assert.ok(text.includes('os: unknown'));
  assert.ok(text.includes('gpus: none detected'));
  assert.ok(text.includes('cuda: unknown'));
});

test('detect JSON envelope is stable', async () => {
  const sink = io();
  const code = await runModelsDetect(fakeApp(), ctx(sink, true), { probe: PROBE });
  assert.equal(code, CliExit.SUCCESS);
  const parsed = JSON.parse(sink.outText) as { ok: boolean; command: string; data: { os: string } };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'models detect');
  assert.equal(parsed.data.os, 'windows');
});

test('list separates installed/configured/ready and marks selection', async () => {
  const sink = io();
  const store = readyStore();
  await store.select('tts', 'omnivoice-bg');
  await store.markInstalled('omnivoice-bg', '/live', 'python/omnivoice-bg-v1');
  // configured but NOT ready: ready must stay false distinctly.
  await store.markConfigured('omnivoice-bg');
  const { rows } = await buildModelList(fakeApp(), ctx(sink), { probe: PROBE, store });
  const omni = rows.find((r) => r.id === 'omnivoice-bg');
  assert.ok(omni);
  assert.equal(omni.installed, true);
  assert.equal(omni.configured, true);
  assert.equal(omni.ready, false);
  assert.equal(omni.selected, true);
  assert.equal(omni.runnable, false);
  assert.equal(omni.compatible, true);
});

test('list surfaces unknown compatibility explicitly', async () => {
  const sink = io();
  const store = readyStore();
  const blank: HardwareProfile = { os: 'unknown', arch: 'unknown', memory: { total_mb: null }, cpu: { logical_cores: null, model: null }, gpus: [], accelerators: unknownAccelerators() };
  const { rows } = await buildModelList(fakeApp(), ctx(sink), { probe: { detect: async () => blank }, store });
  const pq = rows.find((r) => r.id === 'parakeet-tdt-0.6b-v3');
  assert.ok(pq);
  assert.equal(pq.compatible, false);
  assert.ok(pq.compatibility_note.includes('unknown'));
});

test('recommend covers profiles and kinds without mutating state', async () => {
  const store = readyStore();
  for (const profile of ['quality', 'balanced', 'lightweight']) {
    const sink = io();
    const code = await runModelsRecommend(fakeApp(), ctx(sink), new Map([['profile', profile]]), { probe: PROBE, store });
    assert.equal(code, CliExit.SUCCESS);
    assert.ok(sink.outText.includes('stt:'));
    assert.ok(sink.outText.includes('tts:'));
  }
  const before = JSON.stringify(store.snapshot());
  const sink = io();
  const code = await runModelsRecommend(fakeApp(), ctx(sink), new Map([['kind', 'stt']]), { probe: PROBE, store });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(!sink.outText.includes('tts:'));
  assert.equal(JSON.stringify(store.snapshot()), before);
});

test('recommend rejects bad profile/kind with usage', async () => {
  const sink = io();
  assert.equal(await runModelsRecommend(fakeApp(), ctx(sink), new Map([['profile', 'ultra']]), { probe: PROBE, store: readyStore() }), CliExit.USAGE);
  assert.equal(await runModelsRecommend(fakeApp(), ctx(sink), new Map([['kind', 'model']]), { probe: PROBE, store: readyStore() }), CliExit.USAGE);
});

test('install delegates to the D1 service with structured outcomes', async () => {
  void fakeInstallService;
  const store = readyStore();
  const outcomes: string[] = ['completed', 'already_ready', 'incompatible', 'auth_required', 'failed'];
  const expected: number[] = [CliExit.SUCCESS, CliExit.SUCCESS, CliExit.INCOMPATIBLE, CliExit.AUTH_REQUIRED, CliExit.VALIDATION_FAILED];
  for (let i = 0; i < outcomes.length; i += 1) {
    const outcome = outcomes[i] as string;
    const service = { install: async () => ({ model_id: 'omnivoice-bg', outcome, phase: 'done', reason: outcome }) } as never;
    const sink = io();
    const code = await runModelsInstall(fakeApp(), ctx(sink), 'omnivoice-bg', new Map(), { probe: PROBE, store, installService: service });
    assert.equal(code, expected[i]);
    if (outcome === 'completed' || outcome === 'already_ready') assert.ok(sink.outText.includes(outcome));
    else assert.ok(sink.errText.includes(outcome) || sink.outText.includes(outcome));
  }
});

test('install rejects spaced python values with usage', async () => {
  const sink = io();
  assert.equal(await runModelsInstall(fakeApp(), ctx(sink), 'omnivoice-bg', new Map([['python', 'py -3']]), { probe: PROBE, store: readyStore() }), CliExit.USAGE);
});

test('install rejects unknown ids and honors force', async () => {
  const sink = io();
  assert.equal(await runModelsInstall(fakeApp(), ctx(sink), 'ghost', new Map(), { probe: PROBE, store: readyStore() }), CliExit.USAGE);
  let sawForce: boolean | undefined;
  const service = { install: async (req: { force?: boolean }) => { sawForce = req.force; return { model_id: 'omnivoice-bg', outcome: 'completed', phase: 'done', reason: 'ok' }; } } as never;
  await runModelsInstall(fakeApp(), ctx(sink), 'omnivoice-bg', new Map([['reinstall', 'true']]), { probe: PROBE, store: readyStore(), installService: service });
  assert.equal(sawForce, true);
});

test('select accepts compatible, rejects incompatible and wrong-kind', async () => {
  const store = readyStore();
  const sink = io();
  // Compatible manual selection (parakeet is cuda-compatible here).
  assert.equal(await runModelsSelect(fakeApp(), ctx(sink), 'parakeet-tdt-0.6b-v3', { probe: PROBE, store }), CliExit.SUCCESS);
  assert.ok(sink.outText.includes('selected but not runnable'));
  // Incompatible: linuxArm fixture would fail; simulate via blank hw.
  const blank: HardwareProfile = { os: 'unknown', arch: 'unknown', memory: { total_mb: null }, cpu: { logical_cores: null, model: null }, gpus: [], accelerators: unknownAccelerators() };
  assert.equal(await runModelsSelect(fakeApp(), ctx(sink), 'parakeet-tdt-0.6b-v3', { probe: { detect: async () => blank }, store }), CliExit.INCOMPATIBLE);
  // Unknown id.
  assert.equal(await runModelsSelect(fakeApp(), ctx(sink), 'ghost', { probe: PROBE, store }), CliExit.USAGE);
  // No install happened (selection only).
  assert.equal(store.getModelState('parakeet-tdt-0.6b-v3'), null);
});

test('status reports per-kind lifecycle distinctly', async () => {
  const sink = io();
  const store = readyStore();
  await store.select('stt', 'parakeet-tdt-0.6b-v3');
  const code = await runModelsStatus(fakeApp(), ctx(sink), { probe: PROBE, store });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(sink.outText.includes('STT selected: parakeet-tdt-0.6b-v3'));
  assert.ok(sink.outText.includes('installed: false'));
  assert.ok(sink.outText.includes('managed root: /managed-f'));
});

test('validate keeps READY honest and fails closed on missing artifacts', async () => {
  const store = readyStore();
  await store.markInstalled('bgtts-38m-v2', '/live', 'python/bgtts-38m-v2-v1');
  await store.markConfigured('bgtts-38m-v2');
  await store.markValidationPassed('bgtts-38m-v2');
  const sink = io();
  // Managed root has no real artifacts: validation must fail, preserve
  // installed/configured, set ready=false, no reinstall.
  const code = await runModelsValidate(fakeApp(), ctx(sink), 'bgtts-38m-v2', { probe: PROBE, store });
  assert.equal(code, CliExit.VALIDATION_FAILED);
  const entry = store.getModelState('bgtts-38m-v2');
  assert.equal(entry && entry.ready, false);
  assert.equal(entry && entry.installed, true);
  assert.equal(entry && entry.configured, true);
  assert.equal(entry && entry.last_validation && entry.last_validation.status, 'failed');
});

test('remove requires confirmation and deletes only contained paths', async () => {
  const store = readyStore();
  await store.select('tts', 'omnivoice-bg');
  await store.markInstalled('omnivoice-bg', '/live', 'python/omnivoice-bg-v1');
  await store.markConfigured('omnivoice-bg');
  const deleted: string[] = [];
  const fs = { exists: () => true, removeRecursive: (p: string) => { deleted.push(p); } };
  const sink = io();
  // Without --yes: usage failure, nothing deleted, state intact.
  assert.equal(await runModelsRemove(fakeApp(), ctx(sink), 'omnivoice-bg', new Map(), { store, removalFs: fs }), CliExit.USAGE);
  assert.equal(deleted.length, 0);
  assert.ok(store.getModelState('omnivoice-bg')?.installed);
  // With --yes: model dir + unshared runtime removed, selection kept.
  const code = await runModelsRemove(fakeApp(), ctx(sink), 'omnivoice-bg', new Map([['yes', 'true']]), { store, removalFs: fs });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(deleted.length >= 1);
  const rootNorm = require('node:path').normalize(require('node:path').resolve('/managed-f'));
  assert.ok(deleted.every((p) => require('node:path').normalize(p).startsWith(rootNorm)));
  assert.equal(store.getModelState('omnivoice-bg'), null);
  assert.equal(store.snapshot().selections.tts.mode, 'manual');
});

test('remove rejects traversal and unknown ids', async () => {
  const sink = io();
  assert.equal(await runModelsRemove(fakeApp(), ctx(sink), '../../evil', new Map([['yes', 'true']]), { store: readyStore() }), CliExit.USAGE);
  assert.equal(await runModelsRemove(fakeApp(), ctx(sink), 'ghost', new Map([['yes', 'true']]), { store: readyStore() }), CliExit.USAGE);
});
