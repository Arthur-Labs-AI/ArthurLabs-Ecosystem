/**
 * HR-02.5E2-D: bounded local voice provider factory.
 *
 * Maps concrete model ids to their runtime providers — never generic
 * installer/backend ids (provisioning `backend` is not runtime
 * identity). Consumes selection + state + managed layout; performs no
 * install/recommend/select mutations and no hidden model switching:
 * the resolved selection IS the provider (or a typed failure).
 *
 *   parakeet-tdt-0.6b-v3 -> ManagedParakeetSttProvider (stt)
 *   omnivoice-bg          -> ManagedLocalTtsProvider omnivoice-tts
 *   bgtts-38m-v2          -> ManagedLocalTtsProvider bgtts-tts
 */

import { ArthurError } from '../../../core/errors/errors';
import type { HardwareProfile } from '../../hardware/contracts';
import type { LocalModelDefinition, LocalModelKind } from '../contracts';
import type { LocalModelStateFile } from '../state_contracts';
import { resolveRuntimeTarget, type LocalRuntimeTarget, type ResolveRuntimeArgs } from './resolution';
import { ManagedParakeetSttProvider } from './managed_stt';
import { makeBgTtsProvider, makeOmniVoiceTtsProvider } from './managed_tts';
import type { SttProvider, TtsProvider } from '../../../voice/contracts';

export interface LocalVoiceFactoryDeps {
  hardware: HardwareProfile;
  state: LocalModelStateFile;
  managedRoot: string;
  catalog?: readonly LocalModelDefinition[];
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
}

export interface LocalSttProviderRef {
  kind: 'stt';
  modelId: string;
  provider: SttProvider & { shutdown(): Promise<void>; healthy?: boolean; describe?: () => LocalRuntimeTarget };
  target: LocalRuntimeTarget;
}

export interface LocalTtsProviderRef {
  kind: 'tts';
  modelId: string;
  provider: TtsProvider & { shutdown(): Promise<void>; healthy?: boolean; describe?: () => LocalRuntimeTarget };
  target: LocalRuntimeTarget;
}

function baseArgs(kind: LocalModelKind, deps: LocalVoiceFactoryDeps): ResolveRuntimeArgs {
  return { kind, hardware: deps.hardware, state: deps.state, managedRoot: deps.managedRoot, catalog: deps.catalog, env: deps.env, exists: deps.exists };
}

function unknownModel(kind: LocalModelKind, modelId: string): never {
  throw new ArthurError('INVALID_CONFIG', 'no local ' + kind + ' provider mapping for ' + JSON.stringify(modelId));
}

export function createLocalSttProvider(deps: LocalVoiceFactoryDeps): LocalSttProviderRef {
  const target = resolveRuntimeTarget(baseArgs('stt', deps));
  if (target.target !== 'stt-parakeet') return unknownModel('stt', target.model.id);
  return { kind: 'stt', modelId: target.model.id, provider: new ManagedParakeetSttProvider(target), target };
}

export function createLocalTtsProvider(deps: LocalVoiceFactoryDeps): LocalTtsProviderRef {
  const target = resolveRuntimeTarget(baseArgs('tts', deps));
  if (target.target === 'tts-omnivoice') {
    return { kind: 'tts', modelId: target.model.id, provider: makeOmniVoiceTtsProvider(target), target };
  }
  if (target.target === 'tts-bgtts') {
    return { kind: 'tts', modelId: target.model.id, provider: makeBgTtsProvider(target), target };
  }
  return unknownModel('tts', target.model.id);
}

export function tryCreateLocalSttProvider(deps: LocalVoiceFactoryDeps): LocalSttProviderRef | null {
  try {
    return createLocalSttProvider(deps);
  } catch {
    return null;
  }
}

export function tryCreateLocalTtsProvider(deps: LocalVoiceFactoryDeps): LocalTtsProviderRef | null {
  try {
    return createLocalTtsProvider(deps);
  } catch {
    return null;
  }
}
