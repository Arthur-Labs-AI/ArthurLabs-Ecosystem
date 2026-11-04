/**
 * HR-02.5C: effective + runnable model selection resolver.
 *
 * Precedence (deterministic, first match wins):
 *   1. trusted env/developer override (ARTHUR_LOCAL_STT_MODEL /
 *      ARTHUR_LOCAL_TTS_MODEL / ARTHUR_LOCAL_MODEL; "auto" falls through)
 *   2. persisted manual selection (catalog + kind + compatibility checked)
 *   3. automatic recommendation (recomputed live, never persisted)
 *   4. no local selection
 *
 * Manual selection NEVER bypasses compatibility: an incompatible manual
 * pick resolves to model=null with a structured blocking reason. Being
 * selected does NOT require being installed (the installer needs to know
 * the target); being RUNNABLE additionally requires compatible +
 * installed + configured + ready. Auto mode never silently substitutes a
 * lower-tier model when the recommendation is not ready — it reports
 * "recommended but not installed/ready" transparently.
 *
 * No providers are constructed here; results are definition references.
 */

import { ArthurError } from '../../core/errors/errors';
import type { HardwareProfile } from '../hardware/contracts';
import type { LocalModelDefinition, LocalModelKind, RecommendationProfile } from './contracts';
import { getLocalModelCatalog } from './catalog';
import { evaluateCompatibility } from './compatibility';
import { recommendModel } from './recommendation';
import type { LocalModelStateFile, SelectionSource } from './state_contracts';
import { defaultStateFile } from './state_contracts';

export const LOCAL_MODEL_ENV_VARS: Record<LocalModelKind, string> = {
  stt: 'ARTHUR_LOCAL_STT_MODEL',
  tts: 'ARTHUR_LOCAL_TTS_MODEL',
  model: 'ARTHUR_LOCAL_MODEL',
};

export interface EffectiveModelSelection {
  kind: LocalModelKind;
  model: LocalModelDefinition | null;
  source: SelectionSource;
  reason: string;
}

export interface RunnableModelSelection extends EffectiveModelSelection {
  runnable: boolean;
}

export interface ResolveSelectionArgs {
  kind: LocalModelKind;
  hardware: HardwareProfile;
  state?: LocalModelStateFile;
  catalog?: readonly LocalModelDefinition[];
  profile?: RecommendationProfile;
  env?: NodeJS.ProcessEnv;
}

function readOverride(kind: LocalModelKind, env: NodeJS.ProcessEnv | undefined): string | null {
  if (!env) return null;
  const raw = env[LOCAL_MODEL_ENV_VARS[kind]];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'auto') return null;
  return trimmed;
}

function describeCompat(model: LocalModelDefinition, hardware: HardwareProfile): string {
  const result = evaluateCompatibility(model, hardware);
  if (result.compatible) return 'compatible with ' + hardware.arch + '/' + hardware.os + '; hardware requirements satisfied';
  const blocking = result.reasons
    .filter((reason) => reason.result === 'fail')
    .map((reason) => reason.requirement + ' | ' + reason.observed)
    .join('; ');
  return 'incompatible: ' + blocking;
}

function resolveFromCatalog(catalog: readonly LocalModelDefinition[], modelId: string): LocalModelDefinition | null {
  for (const def of catalog) {
    if (def.id === modelId) return def;
  }
  return null;
}

function readinessOf(state: LocalModelStateFile | undefined, modelId: string): { installed: boolean; configured: boolean; ready: boolean } {
  const entry = state ? state.models[modelId] : undefined;
  return { installed: entry ? entry.installed : false, configured: entry ? entry.configured : false, ready: entry ? entry.ready : false };
}

function applyRunnable(selection: EffectiveModelSelection, state: LocalModelStateFile | undefined, hardware: HardwareProfile): RunnableModelSelection {
  if (selection.model === null) {
    return { ...selection, runnable: false };
  }
  const compat = evaluateCompatibility(selection.model, hardware);
  const life = readinessOf(state, selection.model.id);
  if (!compat.compatible) {
    return { ...selection, runnable: false, reason: selection.reason + '\nnot runnable: ' + describeCompat(selection.model, hardware) };
  }
  if (!life.installed) {
    return { ...selection, runnable: false, reason: selection.reason + '\nnot runnable: ' + selection.model.id + ' is not installed' };
  }
  if (!life.configured) {
    return { ...selection, runnable: false, reason: selection.reason + '\nnot runnable: ' + selection.model.id + ' is not configured' };
  }
  if (!life.ready) {
    return { ...selection, runnable: false, reason: selection.reason + '\nnot runnable: ' + selection.model.id + ' is not ready' };
  }
  return { ...selection, runnable: true, reason: selection.reason + '\nready: installed, configured, and validated' };
}

export function resolveEffectiveSelection(args: ResolveSelectionArgs): EffectiveModelSelection {
  const catalog = args.catalog ?? getLocalModelCatalog();
  const state = args.state ?? defaultStateFile();
  const profile = args.profile ?? 'quality';

  const overrideId = readOverride(args.kind, args.env);
  if (overrideId !== null) {
    const def = resolveFromCatalog(catalog, overrideId);
    if (!def) {
      throw new ArthurError('INVALID_CONFIG', 'unknown local model override ' + LOCAL_MODEL_ENV_VARS[args.kind] + '=' + JSON.stringify(overrideId));
    }
    if (def.kind !== args.kind) {
      throw new ArthurError(
        'INVALID_CONFIG',
        'local model override ' + LOCAL_MODEL_ENV_VARS[args.kind] + '=' + JSON.stringify(overrideId) + ' is kind ' + JSON.stringify(def.kind) + ' (expected ' + JSON.stringify(args.kind) + ')',
      );
    }
    const compat = evaluateCompatibility(def, args.hardware);
    if (!compat.compatible) {
      return { kind: args.kind, model: null, source: 'override', reason: 'override ' + overrideId + ' blocked: ' + describeCompat(def, args.hardware) };
    }
    return { kind: args.kind, model: def, source: 'override', reason: 'override ' + overrideId + ' selected; ' + describeCompat(def, args.hardware) };
  }

  const selection = state.selections[args.kind];
  if (selection && selection.mode === 'manual') {
    const manualId = selection.model_id as string;
    const def = resolveFromCatalog(catalog, manualId);
    if (!def) {
      return { kind: args.kind, model: null, source: 'manual', reason: 'manual selection ' + JSON.stringify(manualId) + ' is not in the catalog (stale selection)' };
    }
    if (def.kind !== args.kind) {
      return { kind: args.kind, model: null, source: 'manual', reason: 'manual selection ' + JSON.stringify(manualId) + ' is kind ' + JSON.stringify(def.kind) + ' (expected ' + JSON.stringify(args.kind) + ')' };
    }
    const compat = evaluateCompatibility(def, args.hardware);
    if (!compat.compatible) {
      return { kind: args.kind, model: null, source: 'manual', reason: 'manual selection ' + manualId + ' blocked: ' + describeCompat(def, args.hardware) };
    }
    return { kind: args.kind, model: def, source: 'manual', reason: 'manual selection ' + manualId + '; ' + describeCompat(def, args.hardware) };
  }

  const recommendation = recommendModel({ kind: args.kind, profile, hardware: args.hardware, catalog });
  if (recommendation.selected) {
    const life = readinessOf(state, recommendation.selected.id);
    void life;
    return {
      kind: args.kind,
      model: recommendation.selected,
      source: 'recommended',
      reason: 'recommended ' + recommendation.selected.id + ' (' + profile + ' profile); ' + describeCompat(recommendation.selected, args.hardware),
    };
  }
  return { kind: args.kind, model: null, source: 'none', reason: 'no compatible ' + args.kind + ' model (' + profile + ' profile requested)' };
}

export function resolveRunnableSelection(args: ResolveSelectionArgs): RunnableModelSelection {
  const effective = resolveEffectiveSelection(args);
  return applyRunnable(effective, args.state, args.hardware);
}
