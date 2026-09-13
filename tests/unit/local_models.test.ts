/**
 * HR-02.5B unit tests: catalog, compatibility, recommendation.
 *
 * Fully deterministic: every hardware profile comes from the HR-02.5A
 * fixtures or inline plain objects. No GPU, subprocess, network, download,
 * or provider construction is involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import { unknownAccelerators } from '../../src/runtime/hardware/contracts';
import type { LocalModelDefinition } from '../../src/runtime/local-models/contracts';
import {
  findLocalModel,
  getLocalModelCatalog,
  validateCatalog,
} from '../../src/runtime/local-models/catalog';
import { evaluateCompatibility } from '../../src/runtime/local-models/compatibility';
import { recommendModel } from '../../src/runtime/local-models/recommendation';
import {
  cpuOnlyX64,
  linuxAmdNoRocm,
  linuxAmdRocm,
  linuxArm64CpuOnly,
  linuxArm64UnknownAccel,
  multiGpuMixed,
  partiallyUnknown,
  windowsNvidiaCuda,
  windowsNvidiaNoCuda,
} from './hardware_fixtures';

function parakeet(): LocalModelDefinition {
  const found = findLocalModel('parakeet-tdt-0.6b-v3');
  assert.ok(found);
  return found;
}

function omnivoice(): LocalModelDefinition {
  const found = findLocalModel('omnivoice-bg');
  assert.ok(found);
  return found;
}

function bgtts(): LocalModelDefinition {
  const found = findLocalModel('bgtts-38m-v2');
  assert.ok(found);
  return found;
}

function withOverrides(base: HardwareProfile, overrides: Partial<HardwareProfile>): HardwareProfile {
  return {
    ...base,
    ...overrides,
    memory: { ...base.memory, ...(overrides.memory ?? {}) },
    cpu: { ...base.cpu, ...(overrides.cpu ?? {}) },
    accelerators: { ...base.accelerators, ...(overrides.accelerators ?? {}) },
  };
}

// ---- catalog ---------------------------------------------------------------

test('catalog holds exactly the three conservative entries', () => {
  const catalog = getLocalModelCatalog();
  assert.deepEqual(catalog.map((m) => m.id), ['parakeet-tdt-0.6b-v3', 'omnivoice-bg', 'bgtts-38m-v2']);
  assert.equal(parakeet().quality_tier, 'high');
  assert.equal(parakeet().support.maturity, 'validated');
  assert.equal(parakeet().requirements.accelerator, 'cuda');
  assert.equal(omnivoice().quality_tier, 'high');
  assert.equal(omnivoice().support.maturity, 'validated');
  assert.equal(bgtts().quality_tier, 'lightweight');
  assert.equal(bgtts().support.maturity, 'experimental');
  assert.ok(bgtts().languages.includes('bg') && bgtts().languages.includes('en'));
});

test('parakeet vram minimum carries headroom over the observed 1.2 GB', () => {
  const req = parakeet().requirements;
  assert.ok((req.min_vram_mb ?? 0) > 1200);
  assert.equal(req.min_vram_mb, 4096);
});

test('omnivoice declares no invented vram figure', () => {
  assert.equal(omnivoice().requirements.min_vram_mb, undefined);
});

test('bgtts is cpu-capable but not arm-validated', () => {
  assert.equal(bgtts().requirements.accelerator, 'cpu');
  assert.ok(!(bgtts().support.validated_platforms ?? []).some((p) => p.includes('arm')));
  assert.ok(!(bgtts().requirements.architectures ?? []).includes('arm64'));
});

test('duplicate ids are rejected', () => {
  assert.throws(() => validateCatalog([parakeet(), parakeet()]), /duplicate id/);
});

test('invalid resource thresholds are rejected', () => {
  const zeroRam: LocalModelDefinition = { ...parakeet(), id: 'x-zero-ram', requirements: { min_ram_mb: 0 } };
  assert.throws(() => validateCatalog([zeroRam]), /minimum RAM/);
  const negVram: LocalModelDefinition = { ...parakeet(), id: 'x-neg-vram', requirements: { min_vram_mb: -5 } };
  assert.throws(() => validateCatalog([negVram]), /minimum VRAM/);
  const nanVram: LocalModelDefinition = { ...parakeet(), id: 'x-nan-vram', requirements: { min_vram_mb: Number.NaN } };
  assert.throws(() => validateCatalog([nanVram]), /minimum VRAM/);
});

test('invalid and empty required fields are rejected', () => {
  const emptyId: LocalModelDefinition = { ...parakeet(), id: '  ' };
  assert.throws(() => validateCatalog([emptyId]), /empty id/);
  const badKind = { ...parakeet(), id: 'x-bad-kind', kind: 'llm' };
  assert.throws(() => validateCatalog([badKind as unknown as LocalModelDefinition]), /model kind/);
  const badTier = { ...parakeet(), id: 'x-bad-tier', quality_tier: 'ultra' };
  assert.throws(() => validateCatalog([badTier as unknown as LocalModelDefinition]), /quality tier/);
  const noLang: LocalModelDefinition = { ...parakeet(), id: 'x-no-lang', languages: [] };
  assert.throws(() => validateCatalog([noLang]), /language/);
  const noProvider: LocalModelDefinition = { ...parakeet(), id: 'x-no-prov', provider_id: '' };
  assert.throws(() => validateCatalog([noProvider]), /provider_id/);
  const badAccel = { ...parakeet(), id: 'x-bad-accel', requirements: { accelerator: 'tpu' } };
  assert.throws(() => validateCatalog([badAccel as unknown as LocalModelDefinition]), /accelerator/);
  const badMaturity = { ...parakeet(), id: 'x-bad-mat', support: { maturity: 'stable' } };
  assert.throws(() => validateCatalog([badMaturity as unknown as LocalModelDefinition]), /maturity/);
});

// ---- compatibility: parakeet ------------------------------------------------

test('parakeet + nvidia 8gb + cuda is compatible', () => {
  const result = evaluateCompatibility(parakeet(), windowsNvidiaCuda());
  assert.equal(result.compatible, true);
  assert.ok(result.reasons.length >= 4);
  assert.ok(result.reasons.every((r) => r.result === 'pass'));
});

test('parakeet + nvidia gpu + cuda unavailable is incompatible', () => {
  const result = evaluateCompatibility(parakeet(), windowsNvidiaNoCuda());
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.some((r) => r.requirement.includes('accelerator: cuda') && r.result === 'fail'));
});

test('parakeet + cuda unknown fails closed', () => {
  const hw = withOverrides(windowsNvidiaCuda(), { accelerators: { ...windowsNvidiaCuda().accelerators, cuda: 'unknown' } });
  const result = evaluateCompatibility(parakeet(), hw);
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.some((r) => r.observed.includes('not proven')));
});

test('parakeet + arm64 is incompatible', () => {
  const result = evaluateCompatibility(parakeet(), linuxArm64CpuOnly());
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.some((r) => r.requirement.startsWith('architecture:') && r.result === 'fail'));
});

test('nvidia presence alone does not satisfy cuda', () => {
  const hw = withOverrides(windowsNvidiaCuda(), { accelerators: { ...windowsNvidiaCuda().accelerators, cuda: 'unavailable' } });
  assert.equal(hw.gpus.length, 1);
  assert.equal(evaluateCompatibility(parakeet(), hw).compatible, false);
});

test('unknown ram when required fails closed', () => {
  const result = evaluateCompatibility(parakeet(), partiallyUnknown());
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.some((r) => r.requirement.includes('minimum RAM') && r.result === 'fail'));
});

test('unknown vram when required fails closed', () => {
  const hw = withOverrides(windowsNvidiaCuda(), {
    gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070', vram_mb: null }],
  });
  const result = evaluateCompatibility(parakeet(), hw);
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.some((r) => r.requirement.includes('minimum VRAM') && r.result === 'fail'));
});

// ---- compatibility: omnivoice / bgtts ---------------------------------------

test('omnivoice + compatible nvidia/cuda machine is compatible', () => {
  const result = evaluateCompatibility(omnivoice(), windowsNvidiaCuda());
  assert.equal(result.compatible, true);
});

test('omnivoice + cpu-only is incompatible', () => {
  const result = evaluateCompatibility(omnivoice(), cpuOnlyX64());
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.some((r) => r.requirement.includes('accelerator: cuda') && r.result === 'fail'));
});

test('bgtts cpu model stays compatible without any gpu', () => {
  const result = evaluateCompatibility(bgtts(), cpuOnlyX64());
  // cpuOnlyX64 is linux/x64 while bgtts requires windows: documents that
  // accelerator:cpu alone does not override the validated OS requirement.
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.some((r) => r.requirement.startsWith('os:') && r.result === 'fail'));
  const winCpu = withOverrides(windowsNvidiaCuda(), { gpus: [], accelerators: { cuda: 'unavailable', rocm: 'unavailable', vulkan: 'available', directml: 'available', npu: 'unknown' } });
  const cpuResult = evaluateCompatibility(bgtts(), winCpu);
  assert.equal(cpuResult.compatible, true);
});

// ---- compatibility: rocm / multi-gpu -----------------------------------------

test('amd presence alone does not satisfy cuda; rocm models need rocm', () => {
  const cudaModel: LocalModelDefinition = { ...parakeet(), id: 'x-cuda-probe' };
  assert.equal(evaluateCompatibility(cudaModel, linuxAmdRocm()).compatible, false);
  const rocmModel: LocalModelDefinition = {
    ...parakeet(),
    id: 'x-rocm-probe',
    requirements: { architectures: ['x64'], operating_systems: ['linux'], min_ram_mb: 8192, accelerator: 'rocm' },
  };
  assert.equal(evaluateCompatibility(rocmModel, linuxAmdRocm()).compatible, true);
  assert.equal(evaluateCompatibility(rocmModel, linuxAmdNoRocm()).compatible, false);
});

test('any single sufficient gpu satisfies vram; vram is never summed', () => {
  const sixGb: LocalModelDefinition = {
    ...parakeet(),
    id: 'x-six-gb',
    requirements: { architectures: ['x64'], operating_systems: ['linux'], min_ram_mb: 8192, min_vram_mb: 6144, accelerator: 'cuda' },
  };
  const split: HardwareProfile = {
    os: 'linux',
    arch: 'x64',
    memory: { total_mb: 131072 },
    cpu: { logical_cores: 64, model: 'AMD EPYC 9554' },
    gpus: [
      { vendor: 'nvidia', name: 'GPU 0', vram_mb: 4096 },
      { vendor: 'nvidia', name: 'GPU 1', vram_mb: 4096 },
    ],
    accelerators: { cuda: 'available', rocm: 'unavailable', vulkan: 'available', directml: 'unavailable', npu: 'unavailable' },
  };
  assert.equal(evaluateCompatibility(sixGb, split).compatible, false);
  const oneBig: HardwareProfile = {
    ...split,
    gpus: [
      { vendor: 'nvidia', name: 'GPU 0', vram_mb: 2048 },
      { vendor: 'nvidia', name: 'GPU 1', vram_mb: 8192 },
    ],
  };
  assert.equal(evaluateCompatibility(sixGb, oneBig).compatible, true);
  assert.equal(evaluateCompatibility(sixGb, multiGpuMixed()).compatible, true);
});

test('unknown accelerator set fails closed for cuda models', () => {
  const result = evaluateCompatibility(parakeet(), withOverrides(partiallyUnknown(), {
    os: 'windows',
    accelerators: unknownAccelerators(),
    gpus: [{ vendor: 'nvidia', name: 'NVIDIA RTX 3060', vram_mb: 8192 }],
    memory: { total_mb: 32768 },
  }));
  assert.equal(result.compatible, false);
});

// ---- recommendation ------------------------------------------------------------

test('quality profile picks the highest compatible quality model', () => {
  const rec = recommendModel({ kind: 'tts', profile: 'quality', hardware: windowsNvidiaCuda() });
  assert.equal(rec.selected && rec.selected.id, 'omnivoice-bg');
  assert.ok(rec.reason.includes('quality profile requested'));
});

test('lightweight profile prefers the lightweight compatible model', () => {
  const rec = recommendModel({ kind: 'tts', profile: 'lightweight', hardware: windowsNvidiaCuda() });
  assert.equal(rec.selected && rec.selected.id, 'bgtts-38m-v2');
});

test('balanced profile follows deterministic balanced preference', () => {
  const first = recommendModel({ kind: 'tts', profile: 'balanced', hardware: windowsNvidiaCuda() });
  const second = recommendModel({ kind: 'tts', profile: 'balanced', hardware: windowsNvidiaCuda() });
  assert.deepEqual(first, second);
  assert.ok(first.selected);
});

test('incompatible high-quality candidate is skipped', () => {
  const rec = recommendModel({ kind: 'tts', profile: 'quality', hardware: cpuOnlyX64() });
  assert.equal(rec.selected, null);
  assert.ok(rec.candidates.length > 0);
  assert.ok(rec.candidates.every((c) => c.compatibility.compatible === false));
});

test('validated beats experimental on an exact tie', () => {
  const a: LocalModelDefinition = {
    id: 'aaa-tie',
    kind: 'tts',
    provider_id: 'p-a',
    quality_tier: 'balanced',
    languages: ['en'],
    requirements: { accelerator: 'cpu' },
    support: { maturity: 'experimental' },
  };
  const b: LocalModelDefinition = { ...a, id: 'zzz-tie', support: { maturity: 'validated' } };
  const hw = withOverrides(windowsNvidiaCuda(), { gpus: [] });
  const rec = recommendModel({ kind: 'tts', profile: 'balanced', hardware: hw, catalog: [a, b] });
  assert.equal(rec.selected && rec.selected.id, 'zzz-tie');
  const rec2 = recommendModel({ kind: 'tts', profile: 'balanced', hardware: hw, catalog: [b, a] });
  assert.equal(rec2.selected && rec2.selected.id, 'zzz-tie');
});

test('no compatible candidates yields null with explanation', () => {
  const rec = recommendModel({ kind: 'stt', profile: 'quality', hardware: linuxArm64UnknownAccel() });
  assert.equal(rec.selected, null);
  assert.ok(rec.reason.includes('no compatible stt model'));
  assert.ok(rec.candidates.length > 0);
});

test('same input repeated gives the exact same recommendation', () => {
  const args = { kind: 'stt' as const, profile: 'quality' as const, hardware: windowsNvidiaCuda() };
  const first = recommendModel(args);
  const second = recommendModel(args);
  assert.deepEqual(first, second);
  assert.equal(first.selected && first.selected.id, 'parakeet-tdt-0.6b-v3');
});

test('recommendation reasons render one fact per line', () => {
  const rec = recommendModel({ kind: 'stt', profile: 'quality', hardware: windowsNvidiaCuda() });
  const lines = rec.reason.split('\n');
  assert.ok(lines.length >= 4);
  assert.ok(lines.some((l) => l.includes('cuda')));
});
