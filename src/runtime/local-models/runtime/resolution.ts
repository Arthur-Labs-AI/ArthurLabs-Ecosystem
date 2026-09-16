/**
 * HR-02.5E2-A: runtime descriptor resolution (selection + state -> typed target).
 *
 * Turns the E1 `InstalledModelRuntimeDescriptor` idea into a concrete
 * provider-construction target: given a model kind, hardware, persisted
 * state file, and managed root, it resolves the selected READY model to
 * a `LocalRuntimeTarget` carrying ONLY trusted E1-managed facts:
 * managed python executable, worker/harness path, model-cache env, and
 * model-specific runtime metadata. Providers never rediscover machine
 * paths; everything flows from catalog + state + managed layout.
 *
 * Read-only: never installs, recommends, selects, or mutates. Fails
 * closed with typed `ArthurError`s. Physical existence of the runtime
 * artifacts is verified through the injected `exists` seam (production:
 * node fs; tests: fakes) — persisted `ready=true` alone never suffices.
 */

import * as path from 'node:path';

import { ArthurError } from '../../../core/errors/errors';
import type { HardwareProfile } from '../../hardware/contracts';
import type { LocalModelDefinition, LocalModelKind } from '../contracts';
import { getLocalModelCatalog } from '../catalog';
import { evaluateCompatibility } from '../compatibility';
import { resolveEffectiveSelection } from '../selection';
import { ManagedPathService, toStorageKey } from '../provisioning/paths';
import type { ModelCacheEnv } from '../provisioning/paths';
import { environmentPython } from '../provisioning/python';
import type { InstalledModelState, LocalModelStateFile } from '../state_contracts';

export type RuntimeTargetKind = 'stt-parakeet' | 'tts-omnivoice' | 'tts-bgtts';

export interface LocalRuntimeTarget {
  kind: LocalModelKind;
  target: RuntimeTargetKind;
  model: LocalModelDefinition;
  /** E1-managed python executable (containment-checked, existence-verified). */
  pythonExecutable: string;
  /** E1-managed worker entrypoint in the promoted live dir (existence-verified). */
  entrypoint: string;
  /** Managed model-cache env overlay (HF_*_CACHE/TRANSFORMERS_CACHE/TORCH_HOME). */
  modelEnv: ModelCacheEnv;
  /** Installer-owned extra env (e.g. PARAKEET_MODEL/DEVICE); code-owned keys only. */
  extraEnv: Record<string, string>;
  /** Promoted live dir (containment-checked). */
  liveDir: string;
  /** Why this target was selected (selection source + compatibility). */
  reason: string;
}

export interface ResolveRuntimeArgs {
  kind: LocalModelKind;
  hardware: HardwareProfile;
  state: LocalModelStateFile;
  managedRoot: string;
  catalog?: readonly LocalModelDefinition[];
  env?: NodeJS.ProcessEnv;
  /** Existence probe for runtime artifacts (default: node fs). */
  exists?: (p: string) => boolean;
}

const TARGET_BY_MODEL: Record<string, RuntimeTargetKind> = {
  'parakeet-tdt-0.6b-v3': 'stt-parakeet',
  'omnivoice-bg': 'tts-omnivoice',
  'bgtts-38m-v2': 'tts-bgtts',
};

const RUNTIME_ID_BY_MODEL: Record<string, string> = {
  'parakeet-tdt-0.6b-v3': 'python/parakeet-v1',
  'omnivoice-bg': 'python/omnivoice-bg-v1',
  'bgtts-38m-v2': 'python/bgtts-38m-v2-v1',
};

const ENTRYPOINT_BY_MODEL: Record<string, string> = {
  'parakeet-tdt-0.6b-v3': 'parakeet_worker.py',
  'omnivoice-bg': 'omnivoice_worker.py',
  'bgtts-38m-v2': 'bgtts_worker.py',
};

const EXTRA_ENV_BY_MODEL: Record<string, Record<string, string>> = {
  'parakeet-tdt-0.6b-v3': { PARAKEET_DEVICE: 'cuda', PARAKEET_BACKEND: 'transformers' },
  'omnivoice-bg': {},
  'bgtts-38m-v2': {},
}

const MODEL_ENV_BY_MODEL: Record<string, { key: string; value: string }> = {
  'parakeet-tdt-0.6b-v3': { key: 'PARAKEET_MODEL', value: 'nvidia/parakeet-tdt-0.6b-v3' },
  'omnivoice-bg': { key: 'OMNIVOICE_REPO', value: 'preslaff/omnivoice-bg' },
  'bgtts-38m-v2': { key: 'BGTTS_REPO', value: 'beleata74/BgTTS-38M-V2' },
}

function fail(code: 'INVALID_CONFIG' | 'TOOL_CAPABILITY_UNAVAILABLE', message: string): never {
  throw new ArthurError(code, message);
}

function defaultExists(p: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function resolveRuntimeTarget(args: ResolveRuntimeArgs): LocalRuntimeTarget {
  const catalog = args.catalog ?? getLocalModelCatalog();
  if (typeof args.managedRoot !== 'string' || args.managedRoot.trim() === '') {
    fail('INVALID_CONFIG', 'local runtime resolution needs a managed root');
  }
  const exists = args.exists ?? defaultExists;
  const selection = resolveEffectiveSelection({ kind: args.kind, hardware: args.hardware, state: args.state, catalog, env: args.env });
  if (!selection.model) {
    fail('TOOL_CAPABILITY_UNAVAILABLE', 'no selected local ' + args.kind + ' model (' + selection.reason + ')');
  }
  const model = selection.model;
  const target = TARGET_BY_MODEL[model.id];
  if (!target) {
    fail('INVALID_CONFIG', 'model ' + JSON.stringify(model.id) + ' has no runtime provider mapping');
  }
  if (model.kind !== args.kind) {
    fail('INVALID_CONFIG', 'model ' + JSON.stringify(model.id) + ' is kind ' + JSON.stringify(model.kind) + ' (expected ' + JSON.stringify(args.kind) + ')');
  }
  const compat = evaluateCompatibility(model, args.hardware);
  if (!compat.compatible) {
    fail('TOOL_CAPABILITY_UNAVAILABLE', 'selected model ' + JSON.stringify(model.id) + ' is not compatible with current hardware');
  }
  const entry: InstalledModelState | undefined = args.state.models[model.id];
  if (!entry || !entry.installed) {
    fail('TOOL_CAPABILITY_UNAVAILABLE', 'selected model ' + JSON.stringify(model.id) + ' is not installed');
  }
  if (!entry.configured) {
    fail('TOOL_CAPABILITY_UNAVAILABLE', 'selected model ' + JSON.stringify(model.id) + ' is not configured');
  }
  if (!entry.ready) {
    fail('TOOL_CAPABILITY_UNAVAILABLE', 'selected model ' + JSON.stringify(model.id) + ' is not ready');
  }
  const paths = new ManagedPathService(args.managedRoot);
  const runtimeId = RUNTIME_ID_BY_MODEL[model.id] as string;
  const entryFile = ENTRYPOINT_BY_MODEL[model.id] as string;
  let liveDir = '';
  let runtimeDir = '';
  try {
    liveDir = paths.liveDir(toStorageKey(model.id));
    runtimeDir = paths.runtimeDir(runtimeId);
  } catch (err) {
    fail('INVALID_CONFIG', 'invalid managed path for ' + JSON.stringify(model.id) + ': ' + String(err instanceof Error ? err.message : err));
  }
  // Physical existence: persisted ready=true is last-known state, not
  // proof. Missing/corrupt artifacts fail cleanly (never repair here).
  let pythonExecutable = '';
  try {
    pythonExecutable = environmentPython(paths.layout.root, runtimeDir);
  } catch (err) {
    fail('INVALID_CONFIG', 'invalid runtime python for ' + JSON.stringify(model.id) + ': ' + String(err instanceof Error ? err.message : err));
  }
  const entrypoint = path.join(liveDir, entryFile);
  if (!exists(pythonExecutable)) {
    fail('TOOL_CAPABILITY_UNAVAILABLE', 'managed python missing for ' + JSON.stringify(model.id));
  }
  if (!exists(entrypoint)) {
    fail('TOOL_CAPABILITY_UNAVAILABLE', 'managed worker missing for ' + JSON.stringify(model.id));
  }
  const extraEnv: Record<string, string> = { ...(EXTRA_ENV_BY_MODEL[model.id] ?? {}) };
  const modelEnvId = MODEL_ENV_BY_MODEL[model.id];
  if (modelEnvId) extraEnv[modelEnvId.key] = modelEnvId.value;
  return {
    kind: args.kind,
    target,
    model,
    pythonExecutable,
    entrypoint,
    modelEnv: paths.modelCacheEnv(),
    extraEnv,
    liveDir,
    reason: selection.reason,
  };
}
