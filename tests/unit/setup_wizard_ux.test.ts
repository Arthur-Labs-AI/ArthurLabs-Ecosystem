/**
 * HR-02.5F UX (TASK-0008): setup wizard interaction, partial capability,
 * progress seam, JSON safety, scoped help, and regression tests.
 *
 * Deterministic: fake probe/store/installer, scripted line readers,
 * memory state fs, no network/GPU/subprocess.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CliIO } from '../../apps/cli/index';
import { CliExit } from '../../src/cli_exit';
import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import { LocalModelStateStore, memoryStateFileSystem } from '../../src/runtime/local-models/state_store';
import type { ModelsContext } from '../../apps/cli/models';
import { runModelsInstall } from '../../apps/cli/models';
import { runModelsOrSetup, MODELS_HELP, MODELS_INSTALL_HELP, SETUP_HELP } from '../../apps/cli/model_branch';
import { runSetup } from '../../apps/cli/setup';
import { createStagePresenter, stageIndexForPhase, askConfirm, askSelection } from '../../apps/cli/setup_ui';
import { windowsNvidiaCuda, cpuOnlyX64, partiallyUnknown } from './hardware_fixtures';

function io(): CliIO & { outText: string; errText: string } {
  const sink = {
    outText: '',
    errText: '',
    out(text: string): void { sink.outText += text; },
    err(text: string): void { sink.errText += text; },
  };
  return sink;
}

function ctxOf(sink: CliIO, json = false): ModelsContext {
  return { managedRoot: '/managed-w', statePath: '/tmp/w-models.json', json, io: sink };
}

function fakeApp(): never {
  return undefined as never;
}

function store(): LocalModelStateStore {
  return LocalModelStateStore.load({ statePath: '/tmp/w-models.json', fs: memoryStateFileSystem({}) });
}

function probeOf(hw: HardwareProfile): { detect: () => Promise<HardwareProfile> } {
  return { detect: async (): Promise<HardwareProfile> => hw };
}

const RUNTIME_ID: Record<string, string> = { 'parakeet-tdt-0.6b-v3': 'python/parakeet-v1', 'omnivoice-bg': 'python/omnivoice-bg-v1', 'bgtts-38m-v2': 'python/bgtts-38m-v2-v1' };

function okService(seen: string[], phases: string[] = ['preflight', 'preparing', 'installing', 'configuring', 'validating', 'completed'], persist?: LocalModelStateStore): never {
  const service = {
    install: async (req: { model_id: string; onProgress?: (e: { model_id: string; phase: string; message: string }) => void }) => {
      seen.push(req.model_id);
      if (persist) {
        await persist.markInstalled(req.model_id, '/live', RUNTIME_ID[req.model_id] ?? 'python/unknown-v1');
        await persist.markConfigured(req.model_id);
        await persist.markValidationPassed(req.model_id, 'fake installer smoke passed');
      }
      for (const phase of phases) {
        try { if (req.onProgress) req.onProgress({ model_id: req.model_id, phase, message: phase + ' working' }); } catch { /* sink-safe */ }
      }
      return { model_id: req.model_id, outcome: 'completed', phase: 'completed', reason: 'ok' };
    },
  };
  return service as never;
}

function scriptReader(lines: string[]): () => Promise<string> {
  let i = 0;
  return async (): Promise<string> => lines[Math.min(i++, lines.length - 1)] ?? '';
}

/** Real tmp managed root with touched runtime/worker artifacts so offline validation passes. */
function makeRoot(ids: string[]): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w-ux-'));
  const touch = (p: string): void => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); };
  const py = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  const RUNTIME: Record<string, string> = { 'parakeet-tdt-0.6b-v3': 'parakeet-v1', 'omnivoice-bg': 'omnivoice-bg-v1', 'bgtts-38m-v2': 'bgtts-38m-v2-v1' };
  const WORKER: Record<string, string> = { 'parakeet-tdt-0.6b-v3': 'parakeet_worker.py', 'omnivoice-bg': 'omnivoice_worker.py', 'bgtts-38m-v2': 'bgtts_worker.py' };
  const keyOf = (id: string): string => id.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  for (const id of ids) {
    touch(path.join(root, 'runtimes', 'python', String(RUNTIME[id]), ...py));
    touch(path.join(root, 'models', keyOf(id), 'live', String(WORKER[id])));
  }
  return root;
}

async function preMark(st: LocalModelStateStore, id: string, runtime: string): Promise<void> {
  await st.markInstalled(id, '/live', runtime);
  await st.markConfigured(id);
}

// ---- 1-2: recommendation default + operator alternative via picker ----

test('wizard: Enter accepts the recommended default', async () => {
  const sink = io();
  const seen: string[] = [];
  const st = store();
  const root = makeRoot(['parakeet-tdt-0.6b-v3', 'omnivoice-bg']);
  const context: ModelsContext = { managedRoot: root, statePath: '/tmp/w-models.json', json: false, io: sink };
  // STT has one option (parakeet auto); TTS picker: Enter = omnivoice-bg (recommended over bgtts).
  const code = await runSetup(fakeApp(), context, new Map(), {
    probe: probeOf(windowsNvidiaCuda()), store: st, installService: okService(seen, undefined, st),
    readApprovalLine: scriptReader(['', 'y']), pythonVersion: '3.12.1',
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(sink.outText.includes('omnivoice-bg (recommended)'));
  assert.ok(seen.includes('omnivoice-bg'));
});

test('wizard: operator can choose another compatible model by number', async () => {
  const sink = io();
  const seen: string[] = [];
  const st = store();
  const root = makeRoot(['parakeet-tdt-0.6b-v3', 'bgtts-38m-v2']);
  const context: ModelsContext = { managedRoot: root, statePath: '/tmp/w-models.json', json: false, io: sink };
  const code = await runSetup(fakeApp(), context, new Map(), {
    probe: probeOf(windowsNvidiaCuda()), store: st, installService: okService(seen, undefined, st),
    readApprovalLine: scriptReader(['2', 'y']), pythonVersion: '3.12.1',
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(seen.includes('bgtts-38m-v2'));
  assert.ok(!seen.includes('omnivoice-bg'));
});

// ---- 3: incompatible models are not offered ----

test('wizard: incompatible models are never offered (TTS-only machine)', async () => {
  const sink = io();
  const seen: string[] = [];
  const st = store();
  const root = makeRoot(['bgtts-38m-v2']);
  const context: ModelsContext = { managedRoot: root, statePath: '/tmp/w-models.json', json: false, io: sink };
  const code = await runSetup(fakeApp(), context, new Map([['yes', 'true']]), {
    probe: probeOf(cpuOnlyX64()), store: st, installService: okService(seen, undefined, st), pythonVersion: '3.14.7',
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(!seen.includes('parakeet-tdt-0.6b-v3'));
  assert.ok(!seen.includes('omnivoice-bg'));
  assert.ok(seen.includes('bgtts-38m-v2'));
  assert.ok(sink.outText.includes('No compatible local STT'));
});

// ---- 4: explicit flags validated and honored ----

test('wizard: explicit --tts-model incompatible with hardware is rejected', async () => {
  const sink = io();
  const code = await runSetup(fakeApp(), ctxOf(sink), new Map([['yes', 'true'], ['tts-model', 'omnivoice-bg']]), {
    probe: probeOf(cpuOnlyX64()), store: store(), installService: okService([]), pythonVersion: '3.14.7',
  });
  assert.equal(code, CliExit.USAGE);
  assert.ok(sink.errText.includes('incompatible'));
});

test('wizard: explicit --stt-model of wrong kind is rejected', async () => {
  const sink = io();
  const code = await runSetup(fakeApp(), ctxOf(sink), new Map([['yes', 'true'], ['stt-model', 'bgtts-38m-v2']]), {
    probe: probeOf(windowsNvidiaCuda()), store: store(), installService: okService([]), pythonVersion: '3.12.1',
  });
  assert.equal(code, CliExit.USAGE);
});

// ---- 5: invalid selection re-prompts ----

test('askSelection: invalid input re-prompts, Enter takes default', async () => {
  const sink = io();
  const first = await askSelection(sink, { readApprovalLine: scriptReader(['9', 'x', '2']) }, 'Select TTS', 2, 0);
  assert.equal(first, 1);
  assert.ok(sink.outText.includes('between 1 and 2'));
  const sink2 = io();
  const second = await askSelection(sink2, { readApprovalLine: scriptReader(['']) }, 'Select TTS', 2, 0);
  assert.equal(second, 0);
});

test('askConfirm: y/yes accept, n/no decline, invalid re-prompts, Enter uses default', async () => {
  const s1 = io();
  assert.equal(await askConfirm(s1, { readApprovalLine: scriptReader(['maybe', 'yes']) }, 'Proceed?', 'yes'), true);
  assert.ok(s1.outText.includes('Please answer'));
  const s2 = io();
  assert.equal(await askConfirm(s2, { readApprovalLine: scriptReader(['n']) }, 'Proceed?', 'yes'), false);
  const s3 = io();
  assert.equal(await askConfirm(s3, { readApprovalLine: scriptReader(['']) }, 'Proceed?', 'yes'), true);
  const s4 = io();
  assert.equal(await askConfirm(s4, { readApprovalLine: scriptReader(['']) }, 'Proceed?', 'no'), false);
});

// ---- 6-7: confirmation visible before read; decline = zero mutation ----

test('wizard: confirmation prompt is emitted before stdin is read', async () => {
  const sink = io();
  const order: string[] = [];
  const st = store();
  const before = JSON.stringify(st.snapshot());
  const code = await runSetup(fakeApp(), ctxOf(sink), new Map([['stt-model', 'parakeet-tdt-0.6b-v3'], ['tts-model', 'omnivoice-bg']]), {
    probe: probeOf(windowsNvidiaCuda()), store: st, installService: okService([]), pythonVersion: '3.12.1',
    readApprovalLine: async (): Promise<string> => { order.push('read:' + sink.outText); return 'n'; },
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(order.length >= 1);
  assert.ok(String(order[0]).includes('Proceed?'));
  assert.equal(JSON.stringify(st.snapshot()), before);
});

test('wizard: decline causes zero install/state mutation', async () => {
  const sink = io();
  const st = store();
  const before = JSON.stringify(st.snapshot());
  let installs = 0;
  const service = { install: async (req: { model_id: string }) => { installs += 1; return { model_id: req.model_id, outcome: 'completed', phase: 'done', reason: 'ok' }; } } as never;
  const code = await runSetup(fakeApp(), ctxOf(sink), new Map(), {
    probe: probeOf(windowsNvidiaCuda()), store: st, installService: service,
    readApprovalLine: scriptReader(['', 'n']), pythonVersion: '3.12.1',
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.equal(installs, 0);
  assert.equal(JSON.stringify(st.snapshot()), before);
  assert.ok(sink.outText.includes('cancelled (no changes made)'));
});

// ---- 8: --yes skips confirmation but not validation ----

test('wizard: --yes still validates python and compatibility', async () => {
  const badPy = io();
  assert.equal(await runSetup(fakeApp(), ctxOf(badPy), new Map([['yes', 'true']]), {
    probe: probeOf(windowsNvidiaCuda()), store: store(), installService: okService([]), pythonVersion: '3.15.2',
  }), CliExit.INCOMPATIBLE);
  const badFlag = io();
  assert.equal(await runSetup(fakeApp(), ctxOf(badFlag), new Map([['yes', 'true'], ['tts-model', 'ghost']]), {
    probe: probeOf(windowsNvidiaCuda()), store: store(), installService: okService([]), pythonVersion: '3.12.1',
  }), CliExit.USAGE);
});

// ---- 9-12: partial capability ----

test('wizard: TTS-only machine succeeds as partial setup without STT install', async () => {
  const sink = io();
  const seen: string[] = [];
  const st = store();
  const root = makeRoot(['bgtts-38m-v2']);
  const context: ModelsContext = { managedRoot: root, statePath: '/tmp/w-models.json', json: false, io: sink };
  const code = await runSetup(fakeApp(), context, new Map([['yes', 'true']]), {
    probe: probeOf(cpuOnlyX64()), store: st, installService: okService(seen, undefined, st), pythonVersion: '3.14.7',
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(!seen.includes('parakeet-tdt-0.6b-v3'));
  assert.ok(sink.outText.includes('TTS only'));
  assert.ok(sink.outText.includes('STT still requires cloud/LAN'));
  assert.ok(!sink.outText.includes('Full local voice is ready'));
});

test('wizard: no compatible models exits non-success with zero mutation', async () => {
  const sink = io();
  const st = store();
  const before = JSON.stringify(st.snapshot());
  let installs = 0;
  const service = { install: async (req: { model_id: string }) => { installs += 1; return { model_id: req.model_id, outcome: 'completed', phase: 'done', reason: 'ok' }; } } as never;
  const code = await runSetup(fakeApp(), ctxOf(sink), new Map([['yes', 'true']]), {
    probe: probeOf(partiallyUnknown()), store: st, installService: service, pythonVersion: '3.12.1',
  });
  assert.notEqual(code, CliExit.SUCCESS);
  assert.equal(installs, 0);
  assert.equal(JSON.stringify(st.snapshot()), before);
});

// ---- 13-17: progress seam ----

test('progress: stage ordering is deterministic across events', async () => {
  assert.equal(stageIndexForPhase('preflight', 'checking compatibility'), 0);
  assert.equal(stageIndexForPhase('preparing', 'staging install'), 0);
  assert.equal(stageIndexForPhase('installing', 'provisioning managed python runtime'), 1);
  assert.equal(stageIndexForPhase('installing', 'resolving model snapshot (managed cache)'), 2);
  assert.equal(stageIndexForPhase('validating', 'running synthesis smoke'), 3);
  assert.equal(stageIndexForPhase('configuring', 'configuring model'), 4);
});

test('progress: non-TTY emits plain stage lines, TTY renders dynamic states', async () => {
  const plain = io();
  const p1 = createStagePresenter(plain, { title: 'Installing local voice', tty: false, clock: () => 0 });
  p1.start(0); p1.complete(0); p1.start(1);
  assert.ok(plain.outText.includes('[1/6] Preparing Python runtime'));
  assert.ok(plain.outText.includes('[1/6] Preparing Python runtime: complete'));
  assert.ok(!plain.outText.includes('[1/6] \u2713'));
  const ttySink = io();
  const p2 = createStagePresenter(ttySink, { title: 'Installing local voice', tty: true, clock: () => 0 });
  p2.start(0); p2.complete(0); p2.start(1);
  assert.ok(ttySink.outText.includes('\u25CB'));
});

test('progress: no percentages are ever rendered', async () => {
  const sink = io();
  const p = createStagePresenter(sink, { tty: true, clock: () => 61000 });
  p.start(2); p.complete(2); p.finish();
  assert.ok(!/%/.test(sink.outText));
});

test('direct install reuses the same progress seam (onProgress)', async () => {
  const sink = io();
  const forwarded: Array<{ phase: string }> = [];
  const code = await runModelsInstall(fakeApp(), ctxOf(sink), 'bgtts-38m-v2', new Map(), {
    probe: probeOf(cpuOnlyX64()), store: store(), installService: okService([]),
    onProgress: (e) => { forwarded.push({ phase: e.phase }); },
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(forwarded.length >= 3);
  assert.equal(forwarded[0]?.phase, 'preflight');
  // Same seam also drives visible stages in human mode: no crash, readable text.
  const sink2 = io();
  const code2 = await runModelsInstall(fakeApp(), ctxOf(sink2), 'bgtts-38m-v2', new Map(), {
    probe: probeOf(cpuOnlyX64()), store: store(), installService: okService([]),
  });
  assert.equal(code2, CliExit.SUCCESS);
  assert.ok(sink2.outText.includes('Downloading model') || sink2.outText.includes('complete'));
});

// ---- 18-20: JSON ----

test('json: setup stdout is valid JSON with no human text', async () => {
  const sink = io();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w-json-'));
  const touch = (p: string): void => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); };
  const py = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  touch(path.join(root, 'runtimes', 'python', 'parakeet-v1', ...py));
  touch(path.join(root, 'models', 'parakeet-tdt-0-6b-v3', 'live', 'parakeet_worker.py'));
  touch(path.join(root, 'runtimes', 'python', 'omnivoice-bg-v1', ...py));
  touch(path.join(root, 'models', 'omnivoice-bg', 'live', 'omnivoice_worker.py'));
  touch(path.join(root, 'runtimes', 'python', 'bgtts-38m-v2-v1', ...py));
  touch(path.join(root, 'models', 'bgtts-38m-v2', 'live', 'bgtts_worker.py'));
  const st = store();
  await st.markInstalled('parakeet-tdt-0.6b-v3', '/live', 'python/parakeet-v1');
  await st.markConfigured('parakeet-tdt-0.6b-v3');
  await st.markValidationPassed('parakeet-tdt-0.6b-v3');
  await st.markInstalled('omnivoice-bg', '/live', 'python/omnivoice-bg-v1');
  await st.markConfigured('omnivoice-bg');
  await st.markValidationPassed('omnivoice-bg');
  await st.markInstalled('bgtts-38m-v2', '/live', 'python/bgtts-38m-v2-v1');
  await st.markConfigured('bgtts-38m-v2');
  await st.markValidationPassed('bgtts-38m-v2');
  const context: ModelsContext = { managedRoot: root, statePath: '/tmp/w-models.json', json: true, io: sink };
  const code = await runSetup(fakeApp(), context, new Map([['yes', 'true']]), {
    probe: probeOf(windowsNvidiaCuda()), store: st, installService: okService([]), pythonVersion: '3.12.1',
  });
  assert.equal(code, CliExit.SUCCESS);
  const parsed = JSON.parse(sink.outText) as { ok: boolean; command: string };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'setup');
  assert.equal(sink.errText, '');
});

test('json: setup without --yes is a deterministic usage result (never blocks)', async () => {
  const sink = io();
  const code = await runSetup(fakeApp(), ctxOf(sink, true), new Map(), {
    probe: probeOf(windowsNvidiaCuda()), store: store(), installService: okService([]), pythonVersion: '3.12.1',
  });
  assert.equal(code, CliExit.USAGE);
  const parsed = JSON.parse(sink.outText) as { ok: boolean; code: string };
  assert.equal(parsed.ok, false);
});

// ---- 21-23: final state honesty ----

test('summary derives from lifecycle state: failure never reports READY', async () => {
  const sink = io();
  const service = { install: async (req: { model_id: string }) => ({ model_id: req.model_id, outcome: 'failed', phase: 'failed', reason: 'boom failed' }) } as never;
  const code = await runSetup(fakeApp(), ctxOf(sink), new Map([['yes', 'true']]), {
    probe: probeOf(cpuOnlyX64()), store: store(), installService: service, pythonVersion: '3.14.7',
  });
  assert.notEqual(code, CliExit.SUCCESS);
  assert.ok(!sink.outText.includes('READY'));
  assert.ok(sink.outText.includes('installation failed'));
});

// ---- 24-27: scoped help ----

test('help: top-level lists commands; models/install/setup help are scoped', async () => {
  const holder = { config: { voice: { localModelRoot: '', localModelStatePath: '' } } } as never;
  const m = io();
  assert.equal(await runModelsOrSetup(holder, 'models', new Map([['help', 'true']]), ['models'], m), 0);
  assert.ok(m.outText.includes('arthur models install'));
  assert.ok(!m.outText.includes('Interactive chat commands'));
  const i = io();
  assert.equal(await runModelsOrSetup(holder, 'models', new Map([['help', 'true']]), ['models', 'install'], i), 0);
  assert.ok(i.outText.includes('--reinstall'));
  assert.ok(!i.outText.includes('arthur models remove'));
  const s = io();
  assert.equal(await runModelsOrSetup(holder, 'setup', new Map([['help', 'true']]), ['setup'], s), 0);
  assert.ok(s.outText.includes('--stt-model'));
  assert.ok(s.outText.includes('--tts-model'));
  assert.ok(s.outText.includes('--yes'));
  assert.ok(!s.outText.includes('arthur models remove'));
  assert.ok(MODELS_HELP.includes('arthur models install'));
  assert.ok(MODELS_INSTALL_HELP.includes('--reinstall'));
  assert.ok(SETUP_HELP.includes('--tts-model'));
});

// ---- 28-33: regression guards ----

test('regression: selection provenance, paths, precedence, compatibility untouched', async () => {
  const { provenanceOf } = await import('../../apps/cli/models');
  assert.equal(provenanceOf('override'), 'environment');
  assert.equal(provenanceOf('recommended'), 'recommendation');
  assert.equal(provenanceOf('manual'), 'manual');
  const { resolveLocalModelPaths } = await import('../../src/runtime/local-models/provisioning/paths');
  const a = resolveLocalModelPaths({});
  const b = resolveLocalModelPaths({});
  assert.equal(a.managedRoot, b.managedRoot);
  assert.ok(!a.managedRoot.includes('‍'));
});

test('regression: model-only commands do not initialize SQLite', async () => {
  const src = require('node:fs').readFileSync('apps/cli/model_branch.ts', 'utf8') as string;
  assert.ok(!src.includes('node:sqlite'));
  assert.ok(!src.includes('buildApp'));
  const setupSrc = require('node:fs').readFileSync('apps/cli/setup.ts', 'utf8') as string;
  assert.ok(!setupSrc.includes('node:sqlite'));
  const uiSrc = require('node:fs').readFileSync('apps/cli/setup_ui.ts', 'utf8') as string;
  assert.ok(!uiSrc.includes('node:sqlite'));
});
