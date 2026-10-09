/**
 * HR-02.5D1 unit tests: installation orchestration core.
 *
 * Fully deterministic: concrete installers are in-memory fakes, the
 * state file is an in-memory seam, hardware comes from HR-02.5A
 * fixtures. No downloads, no Python, no GPU, no network, no providers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ArthurError } from '../../src/core/errors/errors';
import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import type { LocalModelDefinition } from '../../src/runtime/local-models/contracts';
import type {
  InstallationProgressEvent,
  InstallerResult,
  ModelInstaller,
} from '../../src/runtime/local-models/install_contracts';
import { ModelInstallerRegistry } from '../../src/runtime/local-models/install_registry';
import { ModelInstallationService } from '../../src/runtime/local-models/install_service';
import { LocalModelStateStore, memoryStateFileSystem } from '../../src/runtime/local-models/state_store';
import {
  cpuOnlyX64,
  linuxArm64CpuOnly,
  windowsNvidiaCuda,
} from './hardware_fixtures';

const PATH = '/tmp/arthur-test/install-models.json';

function codeOf(err: unknown): string {
  assert.ok(err instanceof ArthurError);
  return (err as ArthurError).code;
}

// A fake catalog entry carrying a trusted test installer identity. Real
// catalog entries stay installation-unavailable in D1 (no invented data).
function fakeModel(id: string, kind: 'stt' | 'tts' | 'model' = 'tts'): LocalModelDefinition {
  return {
    id,
    kind,
    provider_id: 'test-provider',
    quality_tier: 'balanced',
    languages: ['en'],
    requirements: { architectures: ['x64'], operating_systems: ['windows'], min_ram_mb: 1024 },
    support: { maturity: 'experimental' },
    installation: { installer_id: 'test-fake', backend: 'python-worker' },
  };
}

function succeed(result?: Partial<InstallerResult>): ModelInstaller {
  return {
    id: 'test-fake',
    install: async ({ reportProgress, model }) => {
      reportProgress({ model_id: model.id, phase: 'installing', message: 'fake writing bytes' });
      return { outcome: 'succeeded', artifact: { installed: true, configured: true, install_path: '/fake/' + model.id, runtime_id: 'fake-1' }, ...result };
    },
  };
}

function harness(opts: { installer?: ModelInstaller; catalog?: LocalModelDefinition[]; hardware?: HardwareProfile } = {}): { service: ModelInstallationService; store: LocalModelStateStore } {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  const registry = new ModelInstallerRegistry();
  registry.register(opts.installer ?? succeed());
  const service = new ModelInstallationService({ store, registry, catalog: opts.catalog ?? [fakeModel('fake-tts-1')] });
  return { service, store };
}

const HW = windowsNvidiaCuda();

// ---- registry ---------------------------------------------------------------

test('duplicate installer ids are rejected', () => {
  const registry = new ModelInstallerRegistry();
  registry.register(succeed());
  assert.throws(() => registry.register(succeed()), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
});

test('unknown installer id fails clearly', () => {
  const registry = new ModelInstallerRegistry();
  assert.throws(() => registry.resolve('ghost-installer' as never), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
  // Backend technique names are not registry keys.
  assert.throws(() => registry.resolve('python-worker' as never), (e: unknown) => codeOf(e) === 'INVALID_CONFIG');
});

// ---- preflight gates ---------------------------------------------------------

test('unknown model id fails preflight without side effects', async () => {
  const { service, store } = harness();
  const result = await service.install({ model_id: 'ghost', hardware: HW });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.phase, 'preflight');
  assert.deepEqual(store.snapshot().models, {});
});

test('incompatible hardware is blocked before any side effect', async () => {
  const { service, store } = harness({ hardware: linuxArm64CpuOnly() });
  const result = await service.install({ model_id: 'fake-tts-1', hardware: linuxArm64CpuOnly() });
  assert.equal(result.outcome, 'incompatible');
  assert.equal(result.phase, 'preflight');
  assert.ok(result.reason.includes('architecture'));
  assert.deepEqual(store.snapshot().models, {});
});

test('model without installer metadata is unsupported', async () => {
  const plain: LocalModelDefinition = { ...fakeModel('plain-1'), installation: undefined };
  const { service } = harness({ catalog: [plain] });
  const result = await service.install({ model_id: 'plain-1', hardware: HW });
  assert.equal(result.outcome, 'unsupported');
  assert.equal(result.phase, 'preflight');
});

test('unregistered installer id is unsupported', async () => {
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  const service = new ModelInstallationService({ store, registry: new ModelInstallerRegistry(), catalog: [fakeModel('fake-tts-1')] });
  const result = await service.install({ model_id: 'fake-tts-1', hardware: HW });
  assert.equal(result.outcome, 'unsupported');
});

test('real catalog entries are installation-unavailable in D1', async () => {
  const { getLocalModelCatalog } = await import('../../src/runtime/local-models/catalog');
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: PATH, fs });
  const registry = new ModelInstallerRegistry();
  registry.register(succeed());
  const service = new ModelInstallationService({ store, registry, catalog: getLocalModelCatalog() });
  for (const def of getLocalModelCatalog()) {
    const result = await service.install({ model_id: def.id, hardware: windowsNvidiaCuda() });
    assert.equal(result.outcome, 'unsupported', def.id);
  }
  assert.deepEqual(store.snapshot().models, {});
});

// ---- happy path + events --------------------------------------------------------

test('successful install drives installed->configured->ready with ordered events', async () => {
  const { service, store } = harness();
  const events: InstallationProgressEvent[] = [];
  const result = await service.install({ model_id: 'fake-tts-1', hardware: HW }, events);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.phase, 'completed');
  const entry = store.getModelState('fake-tts-1');
  assert.deepEqual([entry && entry.installed, entry && entry.configured, entry && entry.ready], [true, true, true]);
  assert.equal(entry && entry.install_path, '/fake/fake-tts-1');
  const phases = events.map((e) => e.phase);
  assert.deepEqual(phases[0], 'preflight');
  assert.ok(phases.includes('preparing'));
  assert.ok(phases.includes('installing'));
  assert.ok(phases.includes('configuring'));
  assert.ok(phases.includes('validating'));
  assert.deepEqual(phases[phases.length - 1], 'completed');
  assert.ok(events.every((e) => e.model_id === 'fake-tts-1' && typeof e.message === 'string'));
});

test('already-ready without force returns already_ready without side effects', async () => {
  const { service, store } = harness();
  await service.install({ model_id: 'fake-tts-1', hardware: HW });
  let calls = 0;
  const fs2 = store;
  void fs2;
  const counting: ModelInstaller = {
    id: 'test-fake',
    install: async () => {
      calls += 1;
      return { outcome: 'succeeded', artifact: { installed: true, configured: true } };
    },
  };
  const registry = new ModelInstallerRegistry();
  registry.register(counting);
  const service2 = new ModelInstallationService({ store, registry, catalog: [fakeModel('fake-tts-1')] });
  const result = await service2.install({ model_id: 'fake-tts-1', hardware: HW });
  assert.equal(result.outcome, 'already_ready');
  assert.equal(calls, 0);
});

test('force reinstalls an already-ready model', async () => {
  const { service } = harness();
  await service.install({ model_id: 'fake-tts-1', hardware: HW });
  const result = await service.install({ model_id: 'fake-tts-1', hardware: HW, force: true });
  assert.equal(result.outcome, 'completed');
});

test('concurrent same-model installs return already_in_progress', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow: ModelInstaller = {
    id: 'test-fake',
    install: async () => {
      await gate;
      return { outcome: 'succeeded', artifact: { installed: true, configured: true } };
    },
  };
  const { service, store } = harness({ installer: slow });
  const first = service.install({ model_id: 'fake-tts-1', hardware: HW });
  // Let the first request claim the in-flight guard.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(service.installationsInFlight(), ['fake-tts-1']);
  const second = await service.install({ model_id: 'fake-tts-1', hardware: HW });
  assert.equal(second.outcome, 'already_in_progress');
  release();
  const done = await first;
  assert.equal(done.outcome, 'completed');
  assert.equal(store.getModelState('fake-tts-1') && (store.getModelState('fake-tts-1') as { ready: boolean }).ready, true);
});

// ---- corrected failure semantics ------------------------------------------------------

test('installer failure before durable install creates no false state', async () => {
  const failing: ModelInstaller = {
    id: 'test-fake',
    install: async () => ({ outcome: 'failed', reason: 'disk exploded' }),
  };
  const { service, store } = harness({ installer: failing });
  const result = await service.install({ model_id: 'fake-tts-1', hardware: HW });
  assert.equal(result.outcome, 'failed');
  assert.equal(store.getModelState('fake-tts-1'), null);
});

test('throwing installer maps to failed without false state', async () => {
  const throwing: ModelInstaller = {
    id: 'test-fake',
    install: async () => { throw new Error('boom'); },
  };
  const { service, store } = harness({ installer: throwing });
  const result = await service.install({ model_id: 'fake-tts-1', hardware: HW });
  assert.equal(result.outcome, 'failed');
  assert.equal(store.getModelState('fake-tts-1'), null);
});

test('configured=false persists installed=true/configured=false/ready=false', async () => {
  const noConfigure: ModelInstaller = {
    id: 'test-fake',
    install: async () => ({ outcome: 'succeeded', artifact: { installed: true, configured: false }, reason: 'config script failed' }),
  };
  const { service, store } = harness({ installer: noConfigure });
  const result = await service.install({ model_id: 'fake-tts-1', hardware: HW });
  assert.equal(result.outcome, 'failed');
  const entry = store.getModelState('fake-tts-1');
  assert.deepEqual([entry && entry.installed, entry && entry.configured, entry && entry.ready], [true, false, false]);
});

test('validation failure persists installed+configured with failed evidence', async () => {
  const badValidation: ModelInstaller = {
    id: 'test-fake',
    install: async () => ({
      outcome: 'succeeded',
      artifact: { installed: true, configured: true, validation: { status: 'failed', reason: 'smoke test mismatch' } },
    }),
  };
  const { service, store } = harness({ installer: badValidation });
  const result = await service.install({ model_id: 'fake-tts-1', hardware: HW });
  assert.equal(result.outcome, 'failed');
  const entry = store.getModelState('fake-tts-1');
  assert.deepEqual([entry && entry.installed, entry && entry.configured, entry && entry.ready], [true, true, false]);
  assert.equal(entry && entry.last_validation && entry.last_validation.status, 'failed');
  assert.equal(entry && entry.last_validation && entry.last_validation.reason, 'smoke test mismatch');
});

test('failed reinstall leaves the previous good installation unchanged', async () => {
  const { service, store } = harness();
  await service.install({ model_id: 'fake-tts-1', hardware: HW });
  const before = store.getModelState('fake-tts-1');
  assert.equal(before && before.ready, true);
  const failing: ModelInstaller = {
    id: 'test-fake',
    install: async () => ({ outcome: 'failed', reason: 'new bits corrupt' }),
  };
  const registry = new ModelInstallerRegistry();
  registry.register(failing);
  const service2 = new ModelInstallationService({ store, registry, catalog: [fakeModel('fake-tts-1')] });
  const result = await service2.install({ model_id: 'fake-tts-1', hardware: HW, force: true });
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(store.getModelState('fake-tts-1'), before);
});

test('failed configure over good installation restores previous state', async () => {
  const { service, store } = harness();
  await service.install({ model_id: 'fake-tts-1', hardware: HW });
  const before = store.getModelState('fake-tts-1');
  const noConfigure: ModelInstaller = {
    id: 'test-fake',
    install: async () => ({ outcome: 'succeeded', artifact: { installed: true, configured: false }, reason: 'bad config' }),
  };
  const registry = new ModelInstallerRegistry();
  registry.register(noConfigure);
  const service2 = new ModelInstallationService({ store, registry, catalog: [fakeModel('fake-tts-1')] });
  const result = await service2.install({ model_id: 'fake-tts-1', hardware: HW, force: true });
  assert.equal(result.outcome, 'failed');
  assert.ok(result.reason.includes('previous installation left unchanged'));
  assert.deepEqual(store.getModelState('fake-tts-1'), before);
});

test('cancelled install before durable work preserves prior state', async () => {
  const { service, store } = harness();
  const controller = new AbortController();
  controller.abort();
  const result = await service.install({ model_id: 'fake-tts-1', hardware: HW, signal: controller.signal });
  assert.equal(result.outcome, 'cancelled');
  assert.equal(store.getModelState('fake-tts-1'), null);
});

test('installer-reported cancellation maps to cancelled', async () => {
  const cancelling: ModelInstaller = {
    id: 'test-fake',
    install: async () => ({ outcome: 'cancelled', reason: 'user stopped it' }),
  };
  const { service, store } = harness({ installer: cancelling });
  const result = await service.install({ model_id: 'fake-tts-1', hardware: HW });
  assert.equal(result.outcome, 'cancelled');
  assert.equal(store.getModelState('fake-tts-1'), null);
});

test('auth_required surfaces without state changes', async () => {
  const gated: ModelInstaller = {
    id: 'test-fake',
    install: async () => ({ outcome: 'auth_required', reason: 'login required' }),
  };
  const { service, store } = harness({ installer: gated });
  const result = await service.install({ model_id: 'fake-tts-1', hardware: HW });
  assert.equal(result.outcome, 'auth_required');
  assert.equal(store.getModelState('fake-tts-1'), null);
});

// NOTE (HR-02.5D1 scope): no installation-level uninstall operation is
// exposed in D1 — actual uninstall (artifact cleanup) belongs to D2.
// `LocalModelStateStore.removeModelState` remains covered by the HR-02.5C
// suite (tests/unit/local_model_state.test.ts).

test('restore rollback rejects an impossible snapshot', async () => {
  const { store } = harness();
  await assert.rejects(
    () => store.restoreModelStateInternal('fake-tts-1', { model_id: 'fake-tts-1', installed: false, configured: false, ready: true }),
    (e: unknown) => e instanceof ArthurError && (e as ArthurError).code === 'INVALID_CONFIG',
  );
  assert.equal(store.getModelState('fake-tts-1'), null);
});

test('installer receives only the minimal context shape', async () => {
  let seen: string[] = [];
  const spy: ModelInstaller = {
    id: 'test-fake',
    install: async (ctx) => {
      seen = Object.keys(ctx).sort();
      return { outcome: 'succeeded', artifact: { installed: true, configured: true } };
    },
  };
  const { service } = harness({ installer: spy });
  await service.install({ model_id: 'fake-tts-1', hardware: HW, managed_root: '/managed' });
  assert.deepEqual(seen, ['hardware', 'managed_root', 'model', 'reportProgress', 'signal']);
});

test('cpu-only hardware can install a cpu-requirement fake model', async () => {
  void cpuOnlyX64;
  const cpuModel: LocalModelDefinition = {
    ...fakeModel('fake-cpu-1'),
    requirements: { architectures: ['x64'], operating_systems: ['linux'] },
  };
  delete cpuModel.requirements.accelerator;
  const { service, store } = harness({ catalog: [cpuModel] });
  const hw: HardwareProfile = { ...cpuOnlyX64(), gpus: [] };
  const result = await service.install({ model_id: 'fake-cpu-1', hardware: hw });
  assert.equal(result.outcome, 'completed');
  assert.equal(store.getModelState('fake-cpu-1') && (store.getModelState('fake-cpu-1') as { ready: boolean }).ready, true);
});
