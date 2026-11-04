/**
 * HR-02.5 acceptance cleanup regressions: three defects, no architecture change.
 *
 * Bug 1: explicit setup --python displayed/validated system Python.
 * Bug 2: one shared presenter leaked completed stages across models.
 * Bug 3: global arthur --help duplicated model usage lines.
 * Deterministic: fake probe/store/installer, fake version runner,
 * memory state fs, no network/GPU/subprocess/downloads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CliIO } from '../../apps/cli/index';
import { GLOBAL_HELP } from '../../apps/cli/index';
import { CliExit } from '../../src/cli_exit';
import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import { LocalModelStateStore, memoryStateFileSystem } from '../../src/runtime/local-models/state_store';
import type { ModelsContext } from '../../apps/cli/models';
import { runSetup, resolveSetupPython, setupInstallFlags } from '../../apps/cli/setup';
import { runModelsOrSetup, MODELS_HELP, MODELS_INSTALL_HELP, SETUP_HELP } from '../../apps/cli/model_branch';
import { createStagePresenter } from '../../apps/cli/setup_ui';
import { inspectPythonExecutable } from '../../src/runtime/local-models/provisioning/python';
import { windowsNvidiaCuda } from './hardware_fixtures';

function testIo(): CliIO & { outText: string; errText: string } {
  const sink = {
    outText: '',
    errText: '',
    out(text: string): void { sink.outText += text; },
    err(text: string): void { sink.errText += text; },
  };
  return sink;
}

function ctxOf(sink: CliIO, managedRoot = '/managed-hr025'): ModelsContext {
  return { managedRoot, statePath: '/tmp/hr025-models.json', json: false, io: sink };
}

function fakeApp(): never {
  return undefined as never;
}

function testStore(): LocalModelStateStore {
  return LocalModelStateStore.load({ statePath: '/tmp/hr025-models.json', fs: memoryStateFileSystem({}) });
}

const HW = windowsNvidiaCuda();
const PROBE = { detect: async (): Promise<HardwareProfile> => HW };
const EXPLICIT_PY = 'C:/Python312/python.exe';
const BAD_PY = 'C:/no/such/python.exe';

function fakeRunner(): (exe: string, args: readonly string[]) => Promise<{ exit_code: number | null; stdout: string; stderr: string }> {
  return async (exe: string) => {
    if (exe === EXPLICIT_PY) return { exit_code: 0, stdout: 'Python 3.12.10', stderr: '' };
    return { exit_code: 0, stdout: 'Python 3.14.0', stderr: '' };
  };
}

const RUNTIME_ID: Record<string, string> = { 'parakeet-tdt-0.6b-v3': 'python/parakeet-v1', 'omnivoice-bg': 'python/omnivoice-bg-v1' };

function okService(seen: string[], persist?: LocalModelStateStore): never {
  const service = {
    install: async (req: { model_id: string; onProgress?: (e: { model_id: string; phase: string; message: string }) => void }) => {
      seen.push(req.model_id);
      if (persist) {
        await persist.markInstalled(req.model_id, '/live', RUNTIME_ID[req.model_id] ?? 'python/unknown-v1');
        await persist.markConfigured(req.model_id);
        await persist.markValidationPassed(req.model_id, 'fake installer smoke passed');
      }
      for (const phase of ['preflight', 'preparing', 'installing', 'configuring', 'validating', 'completed']) {
        try { if (req.onProgress) req.onProgress({ model_id: req.model_id, phase, message: phase + ' working' }); } catch { /* sink-safe */ }
      }
      return { model_id: req.model_id, outcome: 'completed', phase: 'completed', reason: 'ok' };
    },
  };
  return service as never;
}

function makeRoot(ids: string[]): string {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr025-'));
  const touch = (p: string): void => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); };
  const py = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  const RUNTIME: Record<string, string> = { 'parakeet-tdt-0.6b-v3': 'parakeet-v1', 'omnivoice-bg': 'omnivoice-bg-v1' };
  const WORKER: Record<string, string> = { 'parakeet-tdt-0.6b-v3': 'parakeet_worker.py', 'omnivoice-bg': 'omnivoice_worker.py' };
  const keyOf = (id: string): string => id.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  for (const id of ids) {
    touch(path.join(root, 'runtimes', 'python', String(RUNTIME[id]), ...py));
    touch(path.join(root, 'models', keyOf(id), 'live', String(WORKER[id])));
  }
  return root;
}
// ---- Bug 1: explicit --python is authoritative ----

test('bug1: explicit exe is inspected directly with shared provisioning utils', async () => {
  const run = fakeRunner();
  const explicit = await inspectPythonExecutable(EXPLICIT_PY, run, { minVersion: '3.10.0', maxVersionExclusive: '3.15.0' });
  assert.equal(explicit.status, 'found');
  assert.equal(explicit.version, '3.12.10');
  const resolved = await resolveSetupPython(new Map([['python', EXPLICIT_PY]]), { runPythonVersion: run });
  assert.equal(resolved.executable, EXPLICIT_PY);
  assert.equal(resolved.version, '3.12.10');
});

test('bug1: setup displays 3.12 and forwards the exact exe to installs', async () => {
  const sink = testIo();
  const st = testStore();
  const seen: string[] = [];
  const root = makeRoot(['parakeet-tdt-0.6b-v3', 'omnivoice-bg']);
  const context = ctxOf(sink, root);
  const flags = new Map([['yes', 'true'], ['python', EXPLICIT_PY]]);
  assert.equal(setupInstallFlags(flags).get('python'), EXPLICIT_PY);
  const code = await runSetup(fakeApp(), context, flags, {
    probe: PROBE, store: st, installService: okService(seen, st), runPythonVersion: fakeRunner(),
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(sink.outText.includes('3.12.10'));
  assert.ok(!sink.outText.includes('3.14.0'));
  assert.ok(seen.includes('parakeet-tdt-0.6b-v3'));
  assert.ok(seen.includes('omnivoice-bg'));
});

test('bug1: without --python the system discovery behavior is preserved', async () => {
  const resolved = await resolveSetupPython(new Map(), {
    runPythonVersion: async () => ({ exit_code: 0, stdout: 'Python 3.14.0', stderr: '' }),
  });
  assert.equal(resolved.executable, null);
  assert.equal(resolved.version, '3.14.0');
});

test('bug1: unusable explicit exe fails honestly with no 3.14 fallback', async () => {
  const sink = testIo();
  const run = async (exe: string): Promise<{ exit_code: number | null; stdout: string; stderr: string }> => exe === BAD_PY
    ? { exit_code: 1, stdout: '', stderr: 'not found' }
    : { exit_code: 0, stdout: 'Python 3.14.0', stderr: '' };
  const code = await runSetup(fakeApp(), ctxOf(sink), new Map([['yes', 'true'], ['python', BAD_PY]]), {
    probe: PROBE, store: testStore(), installService: okService([]), runPythonVersion: run,
  });
  assert.notEqual(code, CliExit.SUCCESS);
  assert.ok(!(sink.outText + sink.errText).includes('3.14.0'));
});

test('bug1: spaced --python is rejected with usage, never forwarded', async () => {
  const sink = testIo();
  const code = await runSetup(fakeApp(), ctxOf(sink), new Map([['yes', 'true'], ['python', 'py -3']]), {
    probe: PROBE, store: testStore(), installService: okService([]), runPythonVersion: fakeRunner(),
  });
  assert.equal(code, CliExit.USAGE);
});
// ---- Bug 2: per-model presenter state ----

test('bug2: two sequential model installs each begin with clean presenter state', async () => {
  const sink = testIo();
  const st = testStore();
  const seen: string[] = [];
  const root = makeRoot(['parakeet-tdt-0.6b-v3', 'omnivoice-bg']);
  const context = ctxOf(sink, root);
  const code = await runSetup(fakeApp(), context, new Map([['yes', 'true']]), {
    probe: PROBE, store: st, installService: okService(seen, st), pythonVersion: '3.12.10', tty: false,
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(seen.includes('parakeet-tdt-0.6b-v3'));
  assert.ok(seen.includes('omnivoice-bg'));
  const firstComplete = sink.outText.indexOf('[1/6] Preparing Python runtime: complete');
  const omniHeader = sink.outText.indexOf('Installing OmniVoice BG (omnivoice-bg)');
  assert.ok(omniHeader !== -1);
  assert.ok(firstComplete !== -1 && firstComplete < omniHeader);
  const afterOmni = sink.outText.slice(omniHeader);
  const freshStart = afterOmni.indexOf('[1/6] Preparing Python runtime');
  const ownComplete = afterOmni.indexOf('[1/6] Preparing Python runtime: complete');
  assert.ok(freshStart !== -1);
  assert.ok(ownComplete > freshStart);
});

test('bug2: a fresh presenter never inherits done-state', async () => {
  const first = testIo();
  const p1 = createStagePresenter(first, { tty: false, clock: () => 0 });
  for (let i = 0; i < 6; i += 1) { p1.start(i); p1.complete(i); }
  p1.finish();
  assert.ok(first.outText.includes('[6/6]'));
  const second = testIo();
  const p2 = createStagePresenter(second, { tty: false, clock: () => 0 });
  p2.start(0);
  assert.ok(second.outText.includes('[1/6] Preparing Python runtime'));
  assert.ok(!second.outText.includes(': complete'));
});

// ---- Bug 3: global help has no duplicate model usage lines ----

function countLines(haystack: string, needle: string): number {
  return haystack.split('\n').filter((line) => line.includes(needle)).length;
}

test('bug3: global help contains each top-level usage line exactly once', () => {
  for (const needle of ['models detect', 'models list', 'models recommend', 'models install', 'arthur setup']) {
    assert.equal(countLines(GLOBAL_HELP, needle), 1, 'GLOBAL_HELP repeats ' + needle);
  }
});

test('bug3: scoped help surfaces remain intact', async () => {
  const holder = { config: { voice: { localModelRoot: '', localModelStatePath: '' } } } as never;
  const m = testIo();
  assert.equal(await runModelsOrSetup(holder, 'models', new Map([['help', 'true']]), ['models'], m), 0);
  assert.ok(m.outText === MODELS_HELP);
  assert.ok(m.outText.includes('arthur models install'));
  const i = testIo();
  assert.equal(await runModelsOrSetup(holder, 'models', new Map([['help', 'true']]), ['models', 'install'], i), 0);
  assert.ok(i.outText === MODELS_INSTALL_HELP);
  assert.ok(i.outText.includes('--reinstall'));
  const s = testIo();
  assert.equal(await runModelsOrSetup(holder, 'setup', new Map([['help', 'true']]), ['setup'], s), 0);
  assert.ok(s.outText === SETUP_HELP);
  assert.ok(s.outText.includes('--stt-model'));
});

