/**
 * HR-02.5E2: synchronous stable selection identity for lazy legs.
 *
 * Computes, WITHOUT hardware access, which model id a lazy leg
 * advertises for its lifetime:
 * - manual selection: the selected id, when catalog/kind/lifecycle
 *   (installed + configured + ready) check out. Hardware compatibility
 *   is NOT checked here — the async path verifies it and fails closed.
 * - auto selection: the rank-first model (profile tier -> maturity ->
 *   id) with a READY lifecycle. The async path verifies THAT model
 *   strictly (compatible + present) and fails closed on mismatch —
 *   never substituting a lower-ranked model behind the advertised id.
 * - anything else: null (leg keeps its fallback identity forever).
 *
 * Read-only over an injected state snapshot + catalog. No hardware,
 * no I/O, no mutation. Deterministic: same inputs => same id.
 */

import type { LocalModelDefinition, LocalModelKind, RecommendationProfile } from '../contracts';
import { getLocalModelCatalog } from '../catalog';
import { rankModelsOfKind } from '../recommendation';
import type { InstalledModelState, LocalModelStateFile } from '../state_contracts';

export const PROVIDER_ID_BY_MODEL: Record<string, string> = {
  'parakeet-tdt-0.6b-v3': 'parakeet-stt',
  'omnivoice-bg': 'omnivoice-tts',
  'bgtts-38m-v2': 'bgtts-tts',
};

function lifecycleReady(state: LocalModelStateFile, modelId: string): InstalledModelState | null {
  const entry = state.models[modelId];
  if (!entry || !entry.installed || !entry.configured || !entry.ready) return null;
  return entry;
}

function catalogEntry(catalog: readonly LocalModelDefinition[], modelId: string, kind: LocalModelKind): LocalModelDefinition | null {
  for (const def of catalog) {
    if (def.id === modelId && def.kind === kind) return def;
  }
  return null;
}

export interface PeekSelectionArgs {
  kind: LocalModelKind;
  state: LocalModelStateFile;
  catalog?: readonly LocalModelDefinition[];
  profile?: RecommendationProfile;
  env?: NodeJS.ProcessEnv;
}

const OVERRIDE_ENV_BY_KIND: Record<LocalModelKind, string> = {
  stt: 'ARTHUR_LOCAL_STT_MODEL',
  tts: 'ARTHUR_LOCAL_TTS_MODEL',
  model: 'ARTHUR_LOCAL_MODEL',
};

export function peekSelectedModelId(args: PeekSelectionArgs): string | null {
  const catalog = args.catalog ?? getLocalModelCatalog();
  const profile = args.profile ?? 'quality';
  const overrideRaw = args.env ? args.env[OVERRIDE_ENV_BY_KIND[args.kind]] : undefined;
  const overrideId = typeof overrideRaw === 'string' && overrideRaw.trim() !== '' && overrideRaw.trim().toLowerCase() !== 'auto' ? overrideRaw.trim() : null;
  if (overrideId) {
    const def = catalogEntry(catalog, overrideId, args.kind);
    if (!def) return null;
    if (!lifecycleReady(args.state, def.id)) return null;
    return def.id;
  }
  const selection = args.state.selections[args.kind];
  if (selection && selection.mode === 'manual' && typeof selection.model_id === 'string') {
    const def = catalogEntry(catalog, selection.model_id, args.kind);
    if (!def) return null;
    if (!lifecycleReady(args.state, def.id)) return null;
    return def.id;
  }
  for (const def of rankModelsOfKind(catalog, args.kind, profile)) {
    if (lifecycleReady(args.state, def.id)) return def.id;
  }
  return null;
}

export function providerIdForModel(modelId: string): string | null {
  return PROVIDER_ID_BY_MODEL[modelId] ?? null;
}
