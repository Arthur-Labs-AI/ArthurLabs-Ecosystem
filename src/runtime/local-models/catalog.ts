/**
 * HR-02.5B: declarative trusted in-code model catalog.
 *
 * All model-specific facts live here and ONLY here. Compatibility and
 * recommendation code is generic: it reads definitions, never branches
 * on model ids, vendors, or names. Adding a model means appending one
 * definition object — no if/else elsewhere.
 *
 * Conservatism notes (see §5 of the task):
 * - parakeet-tdt-0.6b-v3: observed ~1.2 GB VRAM in the production worker
 *   test on Windows x64 / RTX 3060 Ti / CUDA FP16. The encoded minimum is
 *   4096 MB — a ~3.4x headroom margin covering allocator overhead,
 *   driver variance, and concurrent desktop composition. The exact
 *   observed figure is deliberately NOT the threshold.
 * - omnivoice-bg: verified very-high quality on the Windows/NVIDIA dev
 *   machine, but no measured VRAM figure exists. min_vram_mb is therefore
 *   OMITTED (unknown VRAM then fails closed per-check) and the desktop
 *   CUDA requirement is carried by accelerator + min_ram_mb instead.
 *   A benchmark-derived VRAM threshold is PENDING — do not invent one.
 * - bgtts-38m-v2: ~38M params, tested on Windows/NVIDIA, experimental.
 *   It CAN execute on CPU (accelerator: cpu) but that is a theoretical
 *   runtime capability, not a validated production target: validated
 *   platforms list Windows x64 / CUDA only. ARM64/Arthur Box are NOT
 *   validated — size alone proves nothing about the CPU execution path.
 */

import type { LocalModelDefinition } from './contracts';
import {
  isLocalModelAccelerator,
  isLocalModelKind,
  isModelInstallerId,
  isModelQualityTier,
  isProvisioningBackend,
  isSupportMaturity,
} from './contracts';

const PARAKEET_TDT_06B_V3: LocalModelDefinition = {
  id: 'parakeet-tdt-0.6b-v3',
  kind: 'stt',
  provider_id: 'parakeet-stt',
  quality_tier: 'high',
  languages: ['multilingual'],
  requirements: {
    architectures: ['x64'],
    operating_systems: ['windows'],
    min_ram_mb: 8192,
    min_vram_mb: 4096,
    accelerator: 'cuda',
  },
  support: {
    maturity: 'validated',
    validated_platforms: ['windows-x64-cuda'],
  },
  installation: { installer_id: 'parakeet-tdt-0.6b-v3', backend: 'python-worker' },
};

const OMNIVOICE_BG: LocalModelDefinition = {
  id: 'omnivoice-bg',
  kind: 'tts',
  provider_id: 'omnivoice-tts',
  quality_tier: 'high',
  languages: ['bg'],
  requirements: {
    architectures: ['x64'],
    operating_systems: ['windows'],
    min_ram_mb: 16384,
    accelerator: 'cuda',
  },
  support: {
    maturity: 'validated',
    validated_platforms: ['windows-x64-cuda'],
  },
  installation: { installer_id: 'omnivoice-bg', backend: 'huggingface-snapshot' },
};

const BGTTS_38M_V2: LocalModelDefinition = {
  id: 'bgtts-38m-v2',
  kind: 'tts',
  provider_id: 'bgtts-tts',
  quality_tier: 'lightweight',
  languages: ['bg', 'en'],
  requirements: {
    architectures: ['x64'],
    operating_systems: ['windows'],
    min_ram_mb: 4096,
    accelerator: 'cpu',
  },
  support: {
    maturity: 'experimental',
    validated_platforms: ['windows-x64-cuda'],
  },
  installation: { installer_id: 'bgtts-38m-v2', backend: 'python-worker' },
};

const DEFINITIONS: LocalModelDefinition[] = [PARAKEET_TDT_06B_V3, OMNIVOICE_BG, BGTTS_38M_V2];

export const LOCAL_MODEL_IDS = ['parakeet-tdt-0.6b-v3', 'omnivoice-bg', 'bgtts-38m-v2'] as const;

export type LocalModelId = (typeof LOCAL_MODEL_IDS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error('invalid model catalog: ' + message);
}

// Construction-time validation: the catalog is trusted developer-authored
// source data, so any malformation is programmer error and fails fast.
export function validateCatalog(definitions: readonly LocalModelDefinition[]): void {
  const seen = new Set<string>();
  for (const def of definitions) {
    if (!isRecord(def)) fail('definition must be an object');
    if (typeof def.id !== 'string' || def.id.trim() === '') fail('empty id');
    if (seen.has(def.id)) fail('duplicate id ' + JSON.stringify(def.id));
    seen.add(def.id);
    if (!isLocalModelKind(def.kind)) fail('unsupported model kind for ' + JSON.stringify(def.id));
    if (typeof def.provider_id !== 'string' || def.provider_id.trim() === '') {
      fail('empty provider_id for ' + JSON.stringify(def.id));
    }
    if (!isModelQualityTier(def.quality_tier)) fail('unknown quality tier for ' + JSON.stringify(def.id));
    if (!Array.isArray(def.languages) || def.languages.length === 0) {
      fail('empty language list for ' + JSON.stringify(def.id));
    }
    for (const lang of def.languages) {
      if (typeof lang !== 'string' || lang.trim() === '') fail('empty language for ' + JSON.stringify(def.id));
    }
    if (!isRecord(def.requirements)) fail('requirements must be an object for ' + JSON.stringify(def.id));
    const req = def.requirements;
    if (req.min_ram_mb !== undefined) {
      if (typeof req.min_ram_mb !== 'number' || !Number.isFinite(req.min_ram_mb) || req.min_ram_mb <= 0) {
        fail('invalid minimum RAM for ' + JSON.stringify(def.id));
      }
    }
    if (req.min_vram_mb !== undefined) {
      if (typeof req.min_vram_mb !== 'number' || !Number.isFinite(req.min_vram_mb) || req.min_vram_mb <= 0) {
        fail('invalid minimum VRAM for ' + JSON.stringify(def.id));
      }
    }
    if (req.accelerator !== undefined && !isLocalModelAccelerator(req.accelerator)) {
      fail('unsupported accelerator for ' + JSON.stringify(def.id));
    }
    if (!isRecord(def.support)) fail('support must be an object for ' + JSON.stringify(def.id));
    if (!isSupportMaturity(def.support.maturity)) fail('unknown maturity for ' + JSON.stringify(def.id));
    if (def.support.validated_platforms !== undefined) {
      if (!Array.isArray(def.support.validated_platforms)) fail('validated_platforms must be an array for ' + JSON.stringify(def.id));
      for (const p of def.support.validated_platforms) {
        if (typeof p !== 'string' || p.trim() === '') fail('empty validated platform for ' + JSON.stringify(def.id));
      }
    }
    if (def.installation !== undefined) {
      if (!isRecord(def.installation)) fail('installation must be an object for ' + JSON.stringify(def.id));
      if (!isModelInstallerId(def.installation.installer_id)) fail('unknown installer id for ' + JSON.stringify(def.id));
      if (!isProvisioningBackend(def.installation.backend)) fail('unknown provisioning backend for ' + JSON.stringify(def.id));
    }
  }
}

// The validated catalog. Frozen so callers can never mutate shared state.
export function getLocalModelCatalog(): readonly LocalModelDefinition[] {
  validateCatalog(DEFINITIONS);
  return Object.freeze([...DEFINITIONS]);
}

export function findLocalModel(id: string): LocalModelDefinition | null {
  for (const def of getLocalModelCatalog()) {
    if (def.id === id) return def;
  }
  return null;
}
