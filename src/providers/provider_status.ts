/**
 * FRS-02 §11: effective provider source attribution + safe status (§2/§12).
 *
 * One generic place extends the FRS-01 bootstrap idea WITHOUT re-parsing
 * env files inside providers code and WITHOUT teaching any provider module
 * where config files live: callers hand this module three already-parsed
 * layers (ambient process env snapshot, repo .env record, machine config
 * record) plus code-owned defaults, and it reports configured/not
 * configured + source for each provider selection — never secret values.
 *
 * Source categories: process_env | repo_env | machine_config | code_default.
 */

import { DEFAULT_VOICE_SETTINGS } from '../voice/config';
import { DEEPSEEK_DEFAULT_BASE_URL } from '../models/providers/deepseek';
import { resolveCredentialState, type CredentialName } from './credentials';
import type { ProviderReadiness } from './readiness';

export type ConfigSource = 'process_env' | 'repo_env' | 'machine_config' | 'code_default';

export interface EffectiveValue {
  /** Effective string (empty when unset); secrets use configuredLabel instead. */
  display: string;
  source: ConfigSource;
}

export interface SecretState {
  /** Never the value: "configured" / "not configured" only. */
  display: 'configured' | 'not configured';
  configured: boolean;
  source: Exclude<ConfigSource, 'code_default'> | 'absent';
}

export interface LayerSnapshot {
  ambient: NodeJS.ProcessEnv | Record<string, string | undefined>;
  repo: Record<string, string>;
  machine: Record<string, string>;
}

function layerHas(layer: NodeJS.ProcessEnv | Record<string, string | undefined> | Record<string, string>, name: string): boolean {
  const value = (layer as Record<string, string | undefined>)[name];
  return typeof value === 'string' && value !== '';
}

function layerValue(layer: NodeJS.ProcessEnv | Record<string, string | undefined> | Record<string, string>, name: string): string | undefined {
  const value = (layer as Record<string, string | undefined>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Generic effective-value resolution honoring FRS-01 precedence. */
export function effectiveValue(name: string, layers: LayerSnapshot, codeDefault: string): EffectiveValue {
  if (layerHas(layers.ambient, name)) return { display: layerValue(layers.ambient, name) as string, source: 'process_env' };
  if (layerHas(layers.repo, name)) return { display: layerValue(layers.repo, name) as string, source: 'repo_env' };
  if (layerHas(layers.machine, name)) return { display: layerValue(layers.machine, name) as string, source: 'machine_config' };
  return { display: codeDefault, source: 'code_default' };
}

/** Secret-safe credential state (configured/not configured + source). */
export function secretState(name: CredentialName, layers: LayerSnapshot): SecretState {
  const state = resolveCredentialState(name, layers);
  if (!state.configured) return { display: 'not configured', configured: false, source: 'absent' };
  return { display: 'configured', configured: true, source: state.source };
}

export interface ReasoningStatus {
  provider: EffectiveValue;
  model: EffectiveValue;
  baseUrl: EffectiveValue;
  apiKey: SecretState;
}

export interface CloudVoiceStatus {
  openaiKey: SecretState;
  sttModel: EffectiveValue;
  ttsModel: EffectiveValue;
  ttsVoice: EffectiveValue;
}

export interface ProvidersStatus {
  reasoning: ReasoningStatus;
  cloudVoice: CloudVoiceStatus;
}

/**
 * Build the safe providers status from explicit layers + code defaults.
 * Defaults come from existing code (settings.ts / voice/config.ts /
 * deepseek provider) — never duplicated into a second schema.
 */
export function buildProvidersStatus(layers: LayerSnapshot): ProvidersStatus {
  return {
    reasoning: {
      provider: effectiveValue('ARTHUR_MODEL_PROVIDER', layers, 'fake'),
      model: effectiveValue('ARTHUR_MODEL_NAME', layers, ''),
      baseUrl: effectiveValue('DEEPSEEK_BASE_URL', layers, DEEPSEEK_DEFAULT_BASE_URL),
      apiKey: secretState('DEEPSEEK_API_KEY', layers),
    },
    cloudVoice: {
      openaiKey: secretState('OPENAI_API_KEY', layers),
      sttModel: effectiveValue('ARTHUR_CLOUD_STT_MODEL', layers, DEFAULT_VOICE_SETTINGS.cloudSttModel),
      ttsModel: effectiveValue('ARTHUR_CLOUD_TTS_MODEL', layers, DEFAULT_VOICE_SETTINGS.cloudTtsModel),
      ttsVoice: effectiveValue('ARTHUR_CLOUD_TTS_VOICE', layers, DEFAULT_VOICE_SETTINGS.cloudTtsVoice),
    },
  };
}

export interface ProvidersStatusJson {
  reasoning: {
    provider: { value: string; source: ConfigSource };
    model: { value: string; source: ConfigSource };
    base_url: { value: string; source: ConfigSource };
    api_key: { configured: boolean; source: SecretState['source'] };
  };
  cloud_voice: {
    openai_key: { configured: boolean; source: SecretState['source'] };
    stt_model: { value: string; source: ConfigSource };
    tts_model: { value: string; source: ConfigSource };
    tts_voice: { value: string; source: ConfigSource };
  };
  readiness?: ProviderReadiness[];
}

/** Machine-readable status: exactly one JSON object, no secret values. */
export function providersStatusJson(status: ProvidersStatus, readiness?: ProviderReadiness[]): ProvidersStatusJson {
  const out: ProvidersStatusJson = {
    reasoning: {
      provider: { value: status.reasoning.provider.display, source: status.reasoning.provider.source },
      model: { value: status.reasoning.model.display, source: status.reasoning.model.source },
      base_url: { value: status.reasoning.baseUrl.display, source: status.reasoning.baseUrl.source },
      api_key: { configured: status.reasoning.apiKey.configured, source: status.reasoning.apiKey.source },
    },
    cloud_voice: {
      openai_key: { configured: status.cloudVoice.openaiKey.configured, source: status.cloudVoice.openaiKey.source },
      stt_model: { value: status.cloudVoice.sttModel.display, source: status.cloudVoice.sttModel.source },
      tts_model: { value: status.cloudVoice.ttsModel.display, source: status.cloudVoice.ttsModel.source },
      tts_voice: { value: status.cloudVoice.ttsVoice.display, source: status.cloudVoice.ttsVoice.source },
    },
  };
  if (readiness !== undefined) out.readiness = readiness;
  return out;
}

/** Human-readable status lines (safe: no secret values by construction). */
export function renderProvidersStatus(status: ProvidersStatus, readiness?: ProviderReadiness[]): string {
  const lines: string[] = [];
  lines.push('Reasoning');
  lines.push('  provider: ' + status.reasoning.provider.display + '  ' + status.reasoning.provider.source);
  lines.push('  model: ' + (status.reasoning.model.display === '' ? '(default)' : status.reasoning.model.display) + '  ' + status.reasoning.model.source);
  lines.push('  API key: ' + status.reasoning.apiKey.display + '  ' + (status.reasoning.apiKey.source === 'absent' ? 'absent' : status.reasoning.apiKey.source));
  lines.push('');
  lines.push('Cloud Voice');
  lines.push('  OpenAI key: ' + status.cloudVoice.openaiKey.display + '  ' + (status.cloudVoice.openaiKey.source === 'absent' ? 'absent' : status.cloudVoice.openaiKey.source));
  lines.push('  STT model: ' + status.cloudVoice.sttModel.display + '  ' + status.cloudVoice.sttModel.source);
  lines.push('  TTS model: ' + status.cloudVoice.ttsModel.display + '  ' + status.cloudVoice.ttsModel.source);
  lines.push('  TTS voice: ' + status.cloudVoice.ttsVoice.display + '  ' + status.cloudVoice.ttsVoice.source);
  if (readiness !== undefined && readiness.length > 0) {
    lines.push('');
    lines.push('Readiness');
    for (const item of readiness) {
      lines.push('  ' + item.id + ' (' + item.capability + '): ' + item.status.toUpperCase());
    }
  }
  return lines.join('\n') + '\n';
}
