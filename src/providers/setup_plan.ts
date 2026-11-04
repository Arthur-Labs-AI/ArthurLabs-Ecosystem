/**
 * FRS-02 §5/§9/§10/§14: in-memory provider setup transaction plan.
 *
 * The interactive flow builds a plan FIRST (secrets validated in memory,
 * never persisted mid-flow) and commits ONCE at the end through a single
 * atomic FRS-01 machine-config patch:
 *
 *   secret entered in memory → validate with provider → success →
 *   ask/save → persist via CredentialStore (+ explicit non-secret choices)
 *
 * Cancel before Save = zero persistent mutation. A failed final atomic
 * write leaves existing config valid (FRS-01 atomicity). Invalid newly
 * entered secrets are never persisted; the operator may retry/skip/cancel.
 *
 * Machine-config writes (§10): only explicit choices that differ from
 * code defaults or are required credentials. Code-owned defaults
 * (ARTHUR_CLOUD_STT_MODEL=gpt-4o-transcribe etc.) are NEVER dumped merely
 * because setup ran — defaults belong to code. Non-secret overrides are
 * persisted only when the operator explicitly changes a supported setting.
 */

import { ArthurError } from '../core/errors/errors';
import { DEFAULT_VOICE_SETTINGS } from '../voice/config';
import { DEEPSEEK_DEFAULT_BASE_URL } from '../models/providers/deepseek';
import { checkDeepSeekReadiness } from './deepseek_readiness';
import { checkOpenAiSttReadiness, checkOpenAiTtsReadiness } from './openai_voice_readiness';
import type { CredentialName } from './credentials';
import type { ProviderReadiness } from './readiness';

export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';

export interface SetupPlanSecrets {
  deepseekApiKey?: string;
  openaiApiKey?: string;
}

export interface SetupPlanChoices {
  /** Explicit reasoning provider selection (deepseek). Undefined = untouched. */
  modelProvider?: string;
  /** Explicit reasoning model id. Undefined = untouched (code default). */
  modelName?: string;
  /** Explicit DeepSeek base URL override. Undefined = untouched. */
  deepseekBaseUrl?: string;
  /** Explicit cloud STT model override. Undefined = code default. */
  cloudSttModel?: string;
  /** Explicit cloud TTS model override. Undefined = code default. */
  cloudTtsModel?: string;
  /** Explicit cloud TTS voice override. Undefined = code default. */
  cloudTtsVoice?: string;
}

export interface ValidationDeps {
  fetchFn?: typeof fetch;
  deepseekBaseUrl?: string;
  deepseekModel?: string;
  cloudSttModel?: string;
  cloudTtsModel?: string;
  cloudTtsVoice?: string;
}

export interface SetupPlan {
  secrets: SetupPlanSecrets;
  choices: SetupPlanChoices;
}

export function emptySetupPlan(): SetupPlan {
  return { secrets: {}, choices: {} };
}

/** True when the plan carries no mutation at all (idempotent rerun). */
export function isEmptyPlan(plan: SetupPlan): boolean {
  return (
    plan.secrets.deepseekApiKey === undefined &&
    plan.secrets.openaiApiKey === undefined &&
    plan.choices.modelProvider === undefined &&
    plan.choices.modelName === undefined &&
    plan.choices.deepseekBaseUrl === undefined &&
    plan.choices.cloudSttModel === undefined &&
    plan.choices.cloudTtsModel === undefined &&
    plan.choices.cloudTtsVoice === undefined
  );
}

export interface EffectiveConfig {
  deepseekApiKey: string;
  openaiApiKey: string;
  modelProvider: string;
  modelName: string;
  deepseekBaseUrl: string;
  cloudSttModel: string;
  cloudTtsModel: string;
  cloudTtsVoice: string;
}

/**
 * Validate newly entered plan secrets IN MEMORY (before any persistence).
 * Returns per-provider readiness; never writes. Throws nothing for
 * validation outcomes — failures are data (retry/skip/cancel), not
 * exceptions. Secrets in this function are never logged or rendered.
 */
export async function validatePlanSecrets(
  plan: SetupPlan,
  effective: EffectiveConfig,
  deps: ValidationDeps = {},
): Promise<{ deepseek?: ProviderReadiness; stt?: ProviderReadiness; tts?: ProviderReadiness }> {
  const out: { deepseek?: ProviderReadiness; stt?: ProviderReadiness; tts?: ProviderReadiness } = {};
  if (plan.secrets.deepseekApiKey !== undefined) {
    out.deepseek = await checkDeepSeekReadiness(
      {
        apiKey: plan.secrets.deepseekApiKey,
        model: deps.deepseekModel ?? (effective.modelName !== '' ? effective.modelName : DEEPSEEK_DEFAULT_MODEL),
        baseUrl: deps.deepseekBaseUrl ?? (effective.deepseekBaseUrl !== '' ? effective.deepseekBaseUrl : DEEPSEEK_DEFAULT_BASE_URL),
      },
      deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {},
    );
  }
  if (plan.secrets.openaiApiKey !== undefined) {
    const sttModel = deps.cloudSttModel ?? effective.cloudSttModel;
    const ttsModel = deps.cloudTtsModel ?? effective.cloudTtsModel;
    const ttsVoice = deps.cloudTtsVoice ?? effective.cloudTtsVoice;
    out.stt = await checkOpenAiSttReadiness(
      { apiKey: plan.secrets.openaiApiKey, model: sttModel },
      deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {},
    );
    out.tts = await checkOpenAiTtsReadiness(
      { apiKey: plan.secrets.openaiApiKey, model: ttsModel, voice: ttsVoice },
      deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {},
    );
  }
  return out;
}

export interface MachinePatch {
  set: Record<string, string>;
  remove: string[];
}

/**
 * Compile the in-memory plan into ONE machine-config patch (§10/§14).
 * Only explicit choices differing from code defaults, plus validated new
 * credentials. Never dumps defaults (cloud STT/TTS model/voice stay
 * unset when the operator kept code defaults). Never sets
 * ARTHUR_VOICE_ENABLED (FRS-04 owns voice enablement). Touches no model
 * state, DB files, local-model state, or audio commands.
 */
export function compileMachinePatch(plan: SetupPlan): MachinePatch {
  const set: Record<string, string> = {};
  const remove: string[] = [];
  if (plan.secrets.deepseekApiKey !== undefined) set['DEEPSEEK_API_KEY'] = plan.secrets.deepseekApiKey;
  if (plan.secrets.openaiApiKey !== undefined) set['OPENAI_API_KEY'] = plan.secrets.openaiApiKey;
  if (plan.choices.modelProvider !== undefined) {
    if (plan.choices.modelProvider === 'deepseek') set['ARTHUR_MODEL_PROVIDER'] = 'deepseek';
    else throw new ArthurError('INVALID_REQUEST', 'unsupported reasoning provider selection');
  }
  if (plan.choices.modelName !== undefined) {
    if (plan.choices.modelName.trim() === '') remove.push('ARTHUR_MODEL_NAME');
    else set['ARTHUR_MODEL_NAME'] = plan.choices.modelName;
  }
  if (plan.choices.deepseekBaseUrl !== undefined) {
    if (plan.choices.deepseekBaseUrl === DEEPSEEK_DEFAULT_BASE_URL) remove.push('DEEPSEEK_BASE_URL');
    else set['DEEPSEEK_BASE_URL'] = plan.choices.deepseekBaseUrl;
  }
  if (plan.choices.cloudSttModel !== undefined) {
    // Defaults belong to code: an explicit re-selection of the code
    // default REMOVES any stale override instead of writing it back.
    if (plan.choices.cloudSttModel === DEFAULT_VOICE_SETTINGS.cloudSttModel) remove.push('ARTHUR_CLOUD_STT_MODEL');
    else set['ARTHUR_CLOUD_STT_MODEL'] = plan.choices.cloudSttModel;
  }
  if (plan.choices.cloudTtsModel !== undefined) {
    if (plan.choices.cloudTtsModel === DEFAULT_VOICE_SETTINGS.cloudTtsModel) remove.push('ARTHUR_CLOUD_TTS_MODEL');
    else set['ARTHUR_CLOUD_TTS_MODEL'] = plan.choices.cloudTtsModel;
  }
  if (plan.choices.cloudTtsVoice !== undefined) {
    if (plan.choices.cloudTtsVoice === DEFAULT_VOICE_SETTINGS.cloudTtsVoice) remove.push('ARTHUR_CLOUD_TTS_VOICE');
    else set['ARTHUR_CLOUD_TTS_VOICE'] = plan.choices.cloudTtsVoice;
  }
  return { set, remove };
}

/** Secret names touched by a patch (for tests; names only, never values). */
export function patchSecretNames(patch: MachinePatch): CredentialName[] {
  const names: CredentialName[] = [];
  if (patch.set['DEEPSEEK_API_KEY'] !== undefined) names.push('DEEPSEEK_API_KEY');
  if (patch.set['OPENAI_API_KEY'] !== undefined) names.push('OPENAI_API_KEY');
  return names;
}
