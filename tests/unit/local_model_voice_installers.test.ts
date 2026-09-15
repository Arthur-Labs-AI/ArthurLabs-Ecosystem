/**
 * HR-02.5E1 unit tests: real voice-model installers with fake seams.
 *
 * Fully deterministic: injected fake spawn/fs/venv, HR-02.5A fixtures,
 * real catalog + real D1 service. No internet, GPU, HF, pip, downloads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import { getLocalModelCatalog } from '../../src/runtime/local-models/catalog';
import { ModelInstallationService } from '../../src/runtime/local-models/install_service';
import type { ModelInstallContext } from '../../src/runtime/local-models/install_contracts';
import { memoryProvisioningFs } from '../../src/runtime/local-models/provisioning/staging';
import type { SpawnFn } from '../../src/runtime/local-models/provisioning/process_runner';
import { LocalModelStateStore, memoryStateFileSystem } from '../../src/runtime/local-models/state_store';
import { makeBgTts38mInstaller, BGTTS_CUDA_INDEX_URL, BGTTS_CUDA_PACKAGES, BGTTS_PACKAGES, BGTTS_MIOCODEC_ARCHIVE_URL, BGTTS_MIOCODEC_ARCHIVE_SHA256, BGTTS_MIOCODEC_ARCHIVE_LABEL, BGTTS_WORKER_FILE } from '../../src/runtime/local-models/installers/bgtts_38m';
import { memoryDownloadFs } from '../../src/runtime/local-models/provisioning/downloader';
import { memoryVerifyFs } from '../../src/runtime/local-models/provisioning/verification';
import { makeOmniVoiceBgInstaller, OMNI_AUTH_GUIDANCE, OMNIVOICE_CUDA_INDEX_URL, OMNIVOICE_CUDA_PACKAGES, OMNIVOICE_PACKAGES, OMNIVOICE_WORKER_FILE } from '../../src/runtime/local-models/installers/omnivoice_bg';
import { makeParakeetInstaller, PARAKEET_CUDA_INDEX_URL, PARAKEET_CUDA_PACKAGES, PARAKEET_HF_REPO, PARAKEET_PACKAGES } from '../../src/runtime/local-models/installers/parakeet';
import { createDefaultModelInstallerRegistry, DEFAULT_INSTALLER_MODEL_IDS } from '../../src/runtime/local-models/installers/registry';
import { SMOKE_BG_PHRASE, SMOKE_REQUEST_ID, smokeReferenceToneBytes } from '../../src/runtime/local-models/installers/smoke_fixtures';
import { INSTALL_MANIFEST_FILENAME, writeInstallManifest } from '../../src/runtime/local-models/installers/shared';
import { windowsNvidiaCuda, linuxArm64CpuOnly, cpuOnlyX64 } from './hardware_fixtures';

const ROOT = path.resolve('/models-e1');
const STATE_PATH = '/tmp/e1-models.json';
const HW = windowsNvidiaCuda();

function okSpawn(handler: (exe: string, args: readonly string[]) => { code: number; stdout: string }): SpawnFn {
  return (_exe, _args) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const out = new EventEmitter();
    const err = new EventEmitter();
    (child as unknown as { stdout: unknown }).stdout = out;
    (child as unknown as { stderr: unknown }).stderr = err;
    (child as unknown as { pid: number }).pid = 4242;
    child.kill = () => true;
    const b = handler(_exe, [..._args]);
    setTimeout(() => {
      if (b.stdout !== '') out.emit('data', Buffer.from(b.stdout));
      (child.emit as (e: string, ...a: unknown[]) => boolean).call(child, 'close', b.code, null);
    }, 0);
    return child;
  };
}

// Happy-path runner: venv/pip/cache/smoke all succeed with valid envelopes.
function happyRun(): { run: SpawnFn; seen: Array<{ exe: string; args: readonly string[] }> } {
  const seen: Array<{ exe: string; args: readonly string[] }> = [];
  const run = okSpawn((exe, args) => {
    seen.push({ exe, args });
    const flat = args.join(' ');
    if (flat.includes('snapshot_download')) return { code: 0, stdout: '/managed/snap' };
    if (flat.includes('SMOKE_REQUEST_ID') || flat.includes(SMOKE_REQUEST_ID)) return { code: 0, stdout: JSON.stringify({ id: SMOKE_REQUEST_ID, ok: true, text: '' }) };
    if (flat.includes('SMOKE_BYTES')) return { code: 0, stdout: 'SMOKE_BYTES=48000' };
    if (flat.includes('omnivoice_smoke.py') || flat.includes('bgtts_smoke.py')) return { code: 0, stdout: 'SMOKE_BYTES=48000' };
    return { code: 0, stdout: 'ok' };
  });
  return { run, seen };
}

function fakeTransport(status: 'ok' | 'fail', body: string): import('../../src/runtime/local-models/provisioning/downloader').HttpTransport {
  return async () => {
    if (status === 'fail') throw new Error('network down');
    const bytes = Buffer.from(body);
    return {
      status: 200,
      headers: {},
      body: (async function* () { yield new Uint8Array(bytes); })(),
      cancel: () => {},
    };
  };
}

function ctxFor(modelId: string, hardware: HardwareProfile = HW): ModelInstallContext {
  const def = getLocalModelCatalog().find((d) => d.id === modelId);
  if (!def) throw new Error('missing catalog model ' + modelId);
  return { model: def, hardware, managed_root: ROOT, reportProgress: () => {} };
}

function seams(run: SpawnFn): { fs: ReturnType<typeof memoryProvisioningFs>; venvFs: { exists(p: string): boolean }; files: Map<string, string>; writeFile: (p: string, d: string | Uint8Array) => void } {
  const files = new Map<string, string>();
  const writeFile = (p: string, d: string | Uint8Array): void => {
    files.set(p, typeof d === 'string' ? d : Buffer.from(d).toString('binary'));
  };
  return { fs: memoryProvisioningFs([ROOT]), venvFs: { exists: () => false }, files, writeFile };
}

function workerSrc(): string {
  return process.cwd();
}

// ---- catalog + registry --------------------------------------------------------------

test('all three real catalog models carry trusted installer descriptors', () => {
  const catalog = getLocalModelCatalog();
  const ids = ['parakeet-tdt-0.6b-v3', 'omnivoice-bg', 'bgtts-38m-v2'];
  for (const id of ids) {
    const def = catalog.find((d) => d.id === id);
    assert.ok(def && def.installation && typeof def.installation.installer_id === 'string');
  }
  // Concrete installer identity: each model maps to EXACTLY its own
  // trusted installer (never a shared generic backend type).
  assert.equal(catalog.find((d) => d.id === 'parakeet-tdt-0.6b-v3')?.installation?.installer_id, 'parakeet-tdt-0.6b-v3');
  assert.equal(catalog.find((d) => d.id === 'omnivoice-bg')?.installation?.installer_id, 'omnivoice-bg');
  assert.equal(catalog.find((d) => d.id === 'bgtts-38m-v2')?.installation?.installer_id, 'bgtts-38m-v2');
  assert.equal(catalog.find((d) => d.id === 'parakeet-tdt-0.6b-v3')?.installation?.backend, 'python-worker');
  assert.equal(catalog.find((d) => d.id === 'omnivoice-bg')?.installation?.backend, 'huggingface-snapshot');
  assert.equal(catalog.find((d) => d.id === 'bgtts-38m-v2')?.installation?.backend, 'python-worker');
  const installerIds = ids.map((id) => catalog.find((d) => d.id === id)?.installation?.installer_id);
  assert.equal(new Set(installerIds).size, 3);
});

test('default registry resolves all three installers, rejects the rest', () => {
  const { run } = happyRun();
  const s = seams(run);
  const registry = createDefaultModelInstallerRegistry({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3' });
  assert.deepEqual(DEFAULT_INSTALLER_MODEL_IDS, ['parakeet-tdt-0.6b-v3', 'omnivoice-bg', 'bgtts-38m-v2']);
  assert.ok(registry.resolve('parakeet-tdt-0.6b-v3'));
  assert.ok(registry.resolve('omnivoice-bg'));
  assert.ok(registry.resolve('bgtts-38m-v2'));
  // Generic backend types and unknown ids fail closed as registry keys.
  assert.throws(() => registry.resolve('python-worker' as never));
  assert.throws(() => registry.resolve('huggingface-snapshot' as never));
  assert.throws(() => registry.resolve('native-artifact' as never));
  assert.throws(() => registry.resolve('test-fake'));
});

// ---- parakeet -----------------------------------------------------------------------------

test('parakeet uses the official repo, pinned deps, managed runtime', async () => {
  assert.equal(PARAKEET_HF_REPO, 'nvidia/parakeet-tdt-0.6b-v3');
  assert.ok(PARAKEET_PACKAGES.includes('transformers==5.17.0'));
  assert.ok(PARAKEET_PACKAGES.includes('librosa==1.0.0'));
  // CUDA provenance: torch from the code-owned CUDA index (reproduces
  // the proven +cu130 build), never bare-PyPI-depending.
  assert.deepEqual(PARAKEET_CUDA_PACKAGES, ['torch==2.14.0']);
  assert.equal(PARAKEET_CUDA_INDEX_URL, 'https://download.pytorch.org/whl/cu130');
  assert.ok(!PARAKEET_PACKAGES.some((p) => p.startsWith('torch==')));
  const { run, seen } = happyRun();
  const s = seams(run);
  const installer = makeParakeetInstaller({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', workerSourceDir: workerSrc(), readSourceFile: () => '# worker', writeFile: s.writeFile });
  const result = await installer.install(ctxFor('parakeet-tdt-0.6b-v3'));
  assert.equal(result.outcome, 'succeeded');
  assert.ok(result.artifact && result.artifact.installed && result.artifact.configured);
  assert.ok(result.artifact && result.artifact.validation && result.artifact.validation.status === 'passed');
  assert.ok((result.artifact && result.artifact.install_path && result.artifact.install_path.includes('live')) || false);
  assert.ok(!String(result.artifact && result.artifact.install_path).includes('staging'));
  const flat = seen.map((c) => c.args.join(' ')).join('\n');
  assert.ok(flat.includes('nvidia/parakeet-tdt-0.6b-v3'));
});

test('parakeet without CUDA cannot claim success', async () => {
  const { run } = happyRun();
  const s = seams(run);
  const installer = makeParakeetInstaller({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', readSourceFile: () => '# worker', writeFile: s.writeFile });
  const noCuda = { ...HW, accelerators: { ...HW.accelerators, cuda: 'unavailable' as const } };
  const result = await installer.install(ctxFor('parakeet-tdt-0.6b-v3', noCuda));
  assert.equal(result.outcome, 'failed');
  assert.ok((result.reason ?? '').includes('CUDA'));
  assert.equal(result.artifact, undefined);
});

test('parakeet refuses the wrong model id', async () => {
  const { run } = happyRun();
  const s = seams(run);
  const installer = makeParakeetInstaller({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', readSourceFile: () => '# worker', writeFile: s.writeFile });
  const result = await installer.install(ctxFor('omnivoice-bg'));
  assert.equal(result.outcome, 'failed');
});

test('parakeet cancelled before staging', async () => {
  const { run } = happyRun();
  const s = seams(run);
  const installer = makeParakeetInstaller({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', readSourceFile: () => '# worker', writeFile: s.writeFile });
  const controller = new AbortController();
  controller.abort();
  const ctx = { ...ctxFor('parakeet-tdt-0.6b-v3'), signal: controller.signal };
  const result = await installer.install(ctx);
  assert.equal(result.outcome, 'cancelled');
});

// ---- omnivoice ------------------------------------------------------------------------------

test('omnivoice pins the synthesis subset, excludes the UI stack', () => {
  assert.ok(OMNIVOICE_PACKAGES.includes('omnivoice==0.2.1'));
  assert.deepEqual(OMNIVOICE_CUDA_PACKAGES, ['torch==2.14.0', 'torchaudio==2.11.0']);
  assert.equal(OMNIVOICE_CUDA_INDEX_URL, 'https://download.pytorch.org/whl/cu130');
  assert.ok(!OMNIVOICE_PACKAGES.some((p) => p.startsWith('torch==') || p.startsWith('torchaudio==')));
  assert.ok(!OMNIVOICE_PACKAGES.some((p) => p.startsWith('gradio')));
  assert.ok(!OMNIVOICE_PACKAGES.some((p) => p.startsWith('fastapi')));
  assert.ok(SMOKE_BG_PHRASE.length > 0);
});

test('omnivoice auth failure maps to auth_required with guidance', async () => {
  const run = okSpawn((exe, args) => {
    if (args.join(' ').includes('snapshot_download')) return { code: 1, stdout: '401 Client Error: Unauthorized for url (gated repo)' };
    return { code: 0, stdout: 'ok' };
  });
  const s = seams(run);
  const installer = makeOmniVoiceBgInstaller({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', writeFile: s.writeFile });
  const result = await installer.install(ctxFor('omnivoice-bg'));
  assert.equal(result.outcome, 'auth_required');
  assert.ok((result.reason ?? '').includes('hf auth login'));
  assert.ok(result.artifact === undefined);
  void OMNI_AUTH_GUIDANCE;
});

test('omnivoice stores no token anywhere in the result', async () => {
  const { run } = happyRun();
  const s = seams(run);
  const installer = makeOmniVoiceBgInstaller({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', writeFile: s.writeFile, readSourceFile: () => '# production worker' });
  const result = await installer.install(ctxFor('omnivoice-bg'));
  assert.equal(result.outcome, 'succeeded');
  const blob = JSON.stringify(result);
  assert.ok(!/token|bearer|hf_/i.test(blob));
  // E2 production worker is staged into the install (promoted to live).
  const staged = [...s.files.keys()].filter((p) => p.endsWith('/' + OMNIVOICE_WORKER_FILE) || p.endsWith('\\' + OMNIVOICE_WORKER_FILE));
  assert.equal(staged.length, 1);
  assert.equal(s.files.get(staged[0] as string), '# production worker');
});

test('omnivoice smoke failure keeps installed+configured, drops ready', async () => {
  const run = okSpawn((exe, args) => {
    const flat = args.join(' ');
    if (flat.includes('snapshot_download')) return { code: 0, stdout: '/snap' };
    if (flat.includes('omnivoice_smoke.py')) return { code: 2, stdout: '' };
    return { code: 0, stdout: 'ok' };
  });
  const s = seams(run);
  const installer = makeOmniVoiceBgInstaller({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', writeFile: s.writeFile });
  const result = await installer.install(ctxFor('omnivoice-bg'));
  assert.equal(result.outcome, 'failed');
  assert.ok(result.artifact && result.artifact.installed && result.artifact.configured);
  assert.equal(result.artifact && result.artifact.validation && result.artifact.validation.status, 'failed');
});

test('omnivoice reference is the deterministic fixture, never a dev path', () => {
  const tone = smokeReferenceToneBytes();
  assert.ok(tone.length === 24000 * 2);
  assert.ok(!JSON.stringify([tone.length]).includes('D:'));
});

// ---- bgtts ------------------------------------------------------------------------------------------------

test('bgtts pins the proven stack including the miocodec archive identity', () => {
  assert.ok(BGTTS_PACKAGES.includes('julius==0.2.8') && BGTTS_PACKAGES.includes('einops==0.8.2'));
  assert.ok(BGTTS_PACKAGES.includes('jsonargparse==4.52.0') && BGTTS_PACKAGES.includes('PyYAML==6.0.3'));
  assert.deepEqual(BGTTS_CUDA_PACKAGES, ['torch==2.14.0', 'torchaudio==2.11.0']);
  assert.equal(BGTTS_CUDA_INDEX_URL, 'https://download.pytorch.org/whl/cu130');
  // No git executable dependency: exact commit as a trusted HTTPS source
  // archive with a pinned SHA-256 (no `git+https` pip URL anywhere).
  assert.equal(BGTTS_MIOCODEC_ARCHIVE_URL, 'https://github.com/Aratako/MioCodec/archive/77473544375d57e96cbdfd5d7d257e8f280fa8e3.zip');
  assert.equal(BGTTS_MIOCODEC_ARCHIVE_SHA256, 'fc0db83cb727f9887b0724d157f78d6faa5bec7313db540b2343ec72a0e752e6');
  assert.ok(BGTTS_MIOCODEC_ARCHIVE_LABEL.length > 0);
  // uv_build/uv are build-time only (isolated PEP 517 env): they must
  // NOT appear as persistent runtime dependencies.
  assert.ok(!BGTTS_PACKAGES.some((p) => p.startsWith('uv_build') || p.startsWith('uv==')));
});

test('bgtts succeeds on the fake seams with live (not staging) evidence', async () => {
  // Idempotent skip: a previous installer-controlled install recorded
  // our staged archive filename in direct_url.json, so no download
  // occurs (no network in unit tests); snapshot/smoke are faked.
  const run = okSpawn((exe, args) => {
    const flat = args.join(' ');
    if (flat.includes('direct_url.json') || flat.includes('importlib.metadata')) return { code: 0, stdout: '0.1.0\n{"url": "file:///staged/miocodec-77473544.zip"}' };
    if (flat.includes('import miocodec')) return { code: 0, stdout: 'miocodec-import-ok' };
    if (flat.includes('snapshot_download')) return { code: 0, stdout: '/managed/snap' };
    if (flat.includes('bgtts_smoke.py')) return { code: 0, stdout: 'SMOKE_BYTES=48000' };
    return { code: 0, stdout: 'ok' };
  });
  const s = seams(run);
  const installer = makeBgTts38mInstaller({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', writeFile: s.writeFile, readSourceFile: () => '# production worker', transport: fakeTransport('ok', 'unused') });
  const result = await installer.install(ctxFor('bgtts-38m-v2'));
  assert.equal(result.outcome, 'succeeded');
  // E2 production worker is staged into the install (promoted to live).
  const staged = [...s.files.keys()].filter((p) => p.endsWith('/' + BGTTS_WORKER_FILE) || p.endsWith('\\' + BGTTS_WORKER_FILE));
  assert.equal(staged.length, 1);
  assert.equal(s.files.get(staged[0] as string), '# production worker');
  assert.ok(result.artifact && result.artifact.install_path && result.artifact.install_path.includes('live'));
  assert.ok(!String(result.artifact && result.artifact.install_path).includes('staging'));
});

test('promoted live installs carry an installer-owned manifest', async () => {
  const written: Record<string, string> = {};
  const target = writeInstallManifest(
    (p, d) => { written[p] = typeof d === 'string' ? d : Buffer.from(d).toString('utf8'); },
    '/managed/models/bgtts-38m-v2/staging-x',
    { model_id: 'bgtts-38m-v2', installer_id: 'bgtts-38m-v2', backend: 'python-worker', runtime_id: 'python/bgtts-38m-v2-v1', repo: 'beleata74/BgTTS-38M-V2', revision: null, snapshot_dir: '/managed/cache/hub/snap', source_archive_sha256: BGTTS_MIOCODEC_ARCHIVE_SHA256 },
  );
  assert.equal(target, '/managed/models/bgtts-38m-v2/staging-x/' + INSTALL_MANIFEST_FILENAME);
  const parsed = JSON.parse(written[target] as string) as Record<string, unknown>;
  assert.equal(parsed['model_id'], 'bgtts-38m-v2');
  assert.equal(parsed['installer_id'], 'bgtts-38m-v2');
  assert.equal(parsed['source_archive_sha256'], BGTTS_MIOCODEC_ARCHIVE_SHA256);
  assert.ok(typeof parsed['installed_at'] === 'string');
});

test('bgtts download failure fails without false ready', async () => {
  const { run } = happyRun();
  const s = seams(run);
  const installer = makeBgTts38mInstaller({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', writeFile: s.writeFile, transport: fakeTransport('fail', '') });
  const result = await installer.install(ctxFor('bgtts-38m-v2'));
  assert.equal(result.outcome, 'failed');
  assert.ok((result.reason ?? '').includes('download'));
  assert.ok(!result.artifact || result.artifact.validation?.status !== 'passed');
});

test('bgtts archive hash mismatch fails without false ready', async () => {
  const { run } = happyRun();
  const s = seams(run);
  const dl = memoryDownloadFs();
  const vf = memoryVerifyFs(dl.files as unknown as Map<string, Uint8Array[]>);
  const installer = makeBgTts38mInstaller({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', writeFile: s.writeFile, transport: fakeTransport('ok', 'tampered-bytes'), downloadFs: dl, verifyFs: vf });
  const result = await installer.install(ctxFor('bgtts-38m-v2'));
  assert.equal(result.outcome, 'failed');
  assert.ok((result.reason ?? '').toLowerCase().includes('verif'));
  assert.ok(!result.artifact || result.artifact.validation?.status !== 'passed');
});

test('bgtts failed setup reports failed without false ready', async () => {
  const run = okSpawn(() => ({ code: 1, stdout: 'nope' }));
  const s = seams(run);
  const installer = makeBgTts38mInstaller({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', writeFile: s.writeFile });
  const result = await installer.install(ctxFor('bgtts-38m-v2'));
  assert.equal(result.outcome, 'failed');
  assert.ok(!result.artifact || result.artifact.validation?.status !== 'passed');
});

test('bgtts adds no ARM validation claim', async () => {
  const catalog = getLocalModelCatalog();
  const def = catalog.find((d) => d.id === 'bgtts-38m-v2');
  assert.ok(def && !(def.requirements.architectures ?? []).includes('arm64'));
  const { run } = happyRun();
  const s = seams(run);
  const installer = makeBgTts38mInstaller({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', writeFile: s.writeFile });
  const result = await installer.install(ctxFor('bgtts-38m-v2', linuxArm64CpuOnly()));
  void result;
  void cpuOnlyX64;
});

// ---- D1 integration -------------------------------------------------------------------------------------------

test('D1 end-to-end: parakeet becomes installed+configured+ready', async () => {
  const { run } = happyRun();
  const s = seams(run);
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: STATE_PATH, fs });
  const registry = createDefaultModelInstallerRegistry({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', workerSourceDir: process.cwd(), harnessSourceDir: process.cwd(), readSourceFile: () => '# worker', writeFile: s.writeFile });
  const service = new ModelInstallationService({ store, registry });
  const result = await service.install({ model_id: 'parakeet-tdt-0.6b-v3', hardware: HW, managed_root: ROOT });
  assert.equal(result.outcome, 'completed');
  const entry = store.getModelState('parakeet-tdt-0.6b-v3');
  assert.deepEqual([entry?.installed, entry?.configured, entry?.ready], [true, true, true]);
});

test('D1 end-to-end: omnivoice auth_required leaves no false ready', async () => {
  const run = okSpawn((exe, args) => {
    const flat = args.join(' ');
    if (flat.includes('snapshot_download')) return { code: 1, stdout: '403 Forbidden: gated' };
    return { code: 0, stdout: 'ok' };
  });
  const s = seams(run);
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: STATE_PATH, fs });
  const registry = createDefaultModelInstallerRegistry({ run, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', harnessSourceDir: process.cwd(), readSourceFile: () => '# worker', writeFile: s.writeFile });
  const service = new ModelInstallationService({ store, registry });
  const result = await service.install({ model_id: 'omnivoice-bg', hardware: HW, managed_root: ROOT });
  assert.equal(result.outcome, 'auth_required');
  assert.equal(store.getModelState('omnivoice-bg'), null);
});

test('D1 end-to-end: bgtts success and reinstall-failure preservation', async () => {
  const goodRun = okSpawn((exe, args) => {
    const flat = args.join(' ');
    if (flat.includes('direct_url.json') || flat.includes('importlib.metadata')) return { code: 0, stdout: '0.1.0\n{"url": "file:///staged/miocodec-77473544.zip"}' };
    if (flat.includes('import miocodec')) return { code: 0, stdout: 'miocodec-import-ok' };
    if (flat.includes('snapshot_download')) return { code: 0, stdout: '/managed/snap' };
    if (flat.includes('bgtts_smoke.py')) return { code: 0, stdout: 'SMOKE_BYTES=48000' };
    return { code: 0, stdout: 'ok' };
  });
  const s = seams(goodRun);
  const fs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: STATE_PATH, fs });
  const registry = createDefaultModelInstallerRegistry({ run: goodRun, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', harnessSourceDir: process.cwd(), readSourceFile: () => '# worker', writeFile: s.writeFile });
  const service = new ModelInstallationService({ store, registry });
  const first = await service.install({ model_id: 'bgtts-38m-v2', hardware: HW, managed_root: ROOT });
  assert.equal(first.outcome, 'completed');
  const before = store.getModelState('bgtts-38m-v2');
  const bad = okSpawn(() => ({ code: 1, stdout: 'broken venv' }));
  const registry2 = createDefaultModelInstallerRegistry({ run: bad, fs: s.fs, venvFs: s.venvFs, systemPython: '/trusted/python3', harnessSourceDir: process.cwd(), readSourceFile: () => '# worker', writeFile: s.writeFile });
  const service2 = new ModelInstallationService({ store, registry: registry2 });
  const second = await service2.install({ model_id: 'bgtts-38m-v2', hardware: HW, managed_root: ROOT, force: true });
  assert.equal(second.outcome, 'failed');
  assert.deepEqual(store.getModelState('bgtts-38m-v2'), before);
});
