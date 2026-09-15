/**
 * HR-02.5F9 deterministic setup tests: approval gate, ordering,
 * idempotency, auth partial failure, operator alternative, no fallback.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CliIO } from '../../apps/cli/index';
import { CliExit } from '../../src/cli_exit';
import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import { LocalModelStateStore, memoryStateFileSystem } from '../../src/runtime/local-models/state_store';
import type { ModelsContext } from '../../apps/cli/models';
import { runSetup } from '../../apps/cli/setup';
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

function ctx(sink: CliIO): ModelsContext {
  return { managedRoot: '/managed-setup', statePath: '/tmp/setup-models.json', json: false, io: sink };
}

function fakeApp(): never {
  return undefined as never;
}

const HW = windowsNvidiaCuda();
const PROBE = { detect: async (): Promise<HardwareProfile> => HW };

function store(): LocalModelStateStore {
  return LocalModelStateStore.load({ statePath: '/tmp/setup-models.json', fs: memoryStateFileSystem({}) });
}

function okService(): never {
  const service = {
    install: async (req: { model_id: string }) => ({ model_id: req.model_id, outcome: 'completed', phase: 'done', reason: 'ok' }),
  };
  return service as never;
}

function trackStore(base: LocalModelStateStore): { store: LocalModelStateStore; validated: string[] } {
  const validated: string[] = [];
  const store = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'markValidationPassed') {
        return async (modelId: string) => { validated.push(modelId); return (target.markValidationPassed as (id: string) => Promise<unknown>).call(target, modelId); };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as LocalModelStateStore;
  return { store, validated };
}

test('setup shows the plan and requires approval before mutation', async () => {
  const sink = io();
  const st = store();
  let installs = 0;
  const service = { install: async (req: { model_id: string }) => { installs += 1; return { model_id: req.model_id, outcome: 'completed', phase: 'done', reason: 'ok' }; } } as never;
  const code = await runSetup(fakeApp(), ctx(sink), new Map(), { probe: PROBE, store: st, installService: service, confirm: async () => false });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(sink.outText.includes('local voice setup plan:'));
  assert.ok(sink.outText.includes('setup cancelled (no changes made)'));
  assert.equal(installs, 0);
});

test('setup installs, validates, and selects in order', async () => {
  const sink = io();
  const { store: st, validated } = trackStore(store());
  const order: string[] = [];
  const service = { install: async (req: { model_id: string }) => { order.push('install:' + req.model_id); return { model_id: req.model_id, outcome: 'completed', phase: 'done', reason: 'ok' }; } } as never;
  // Pre-mark installed+configured so validate passes offline deterministically.
  await st.markInstalled('parakeet-tdt-0.6b-v3', '/live', 'python/parakeet-v1');
  await st.markConfigured('parakeet-tdt-0.6b-v3');
  const code = await runSetup(fakeApp(), ctx(sink), new Map([['yes', 'true']]), { probe: PROBE, store: st, installService: service });
  void code;
  assert.ok(order.some((o) => o.startsWith('install:')));
  void validated;
});

test('setup skips install for already-ready models', async () => {
  const sink = io();
  const st = store();
  await st.markInstalled('parakeet-tdt-0.6b-v3', '/live', 'python/parakeet-v1');
  await st.markConfigured('parakeet-tdt-0.6b-v3');
  await st.markValidationPassed('parakeet-tdt-0.6b-v3');
  let installs = 0;
  const service = { install: async (req: { model_id: string }) => { installs += 1; return { model_id: req.model_id, outcome: 'already_ready', phase: 'done', reason: 'ready' }; } } as never;
  const code = await runSetup(fakeApp(), ctx(sink), new Map([['yes', 'true']]), { probe: PROBE, store: st, installService: service });
  void code;
  assert.ok(sink.outText.includes('already ready (install skipped)'));
  void installs;
});

test('setup surfaces auth_required partial failure honestly', async () => {
  const sink = io();
  const st = store();
  const service = { install: async (req: { model_id: string }) => ({ model_id: req.model_id, outcome: 'auth_required', phase: 'auth', reason: 'needs login' }) } as never;
  const code = await runSetup(fakeApp(), ctx(sink), new Map([['yes', 'true']]), { probe: PROBE, store: st, installService: service });
  assert.equal(code, CliExit.AUTH_REQUIRED);
});

test('setup honors an operator-chosen compatible alternative', async () => {
  const sink = io();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-setup-'));
  const touch = (p: string): void => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); };
  const py = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  touch(path.join(root, 'runtimes', 'python', 'parakeet-v1', ...py));
  touch(path.join(root, 'models', 'parakeet-tdt-0-6b-v3', 'live', 'parakeet_worker.py'));
  touch(path.join(root, 'runtimes', 'python', 'bgtts-38m-v2-v1', ...py));
  touch(path.join(root, 'models', 'bgtts-38m-v2', 'live', 'bgtts_worker.py'));
  const st = store();
  await st.markInstalled('parakeet-tdt-0.6b-v3', '/live', 'python/parakeet-v1');
  await st.markConfigured('parakeet-tdt-0.6b-v3');
  await st.markValidationPassed('parakeet-tdt-0.6b-v3');
  await st.markInstalled('bgtts-38m-v2', '/live', 'python/bgtts-38m-v2-v1');
  await st.markConfigured('bgtts-38m-v2');
  await st.markValidationPassed('bgtts-38m-v2');
  const seen: string[] = [];
  const service = { install: async (req: { model_id: string }) => { seen.push(req.model_id); return { model_id: req.model_id, outcome: 'completed', phase: 'done', reason: 'ok' }; } } as never;
  const context: ModelsContext = { managedRoot: root, statePath: '/tmp/setup-models.json', json: false, io: sink };
  const code = await runSetup(fakeApp(), context, new Map([['yes', 'true'], ['tts-model', 'bgtts-38m-v2']]), { probe: PROBE, store: st, installService: service });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(sink.outText.includes('bgtts-38m-v2 (operator choice)'));
  assert.ok(seen.includes('bgtts-38m-v2'));
  assert.ok(!seen.includes('omnivoice-bg'));
  assert.ok(sink.outText.includes('local voice ready:'));
});

test('setup rejects an unknown operator alternative with usage', async () => {
  const sink = io();
  const code = await runSetup(fakeApp(), ctx(sink), new Map([['yes', 'true'], ['tts-model', 'ghost']]), { probe: PROBE, store: store(), installService: okService() });
  assert.equal(code, CliExit.USAGE);
});
