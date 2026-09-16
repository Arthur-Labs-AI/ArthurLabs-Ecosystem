/**
 * FRS-04: unified in-memory setup plan.
 *
 * Every machine-config change stays IN MEMORY until final Apply: the plan
 * carries secret values (never rendered), explicit non-secret choices,
 * device identity, generated commands, and the local-model install queue.
 * Exactly ONE updateMachineConfig() commits the accumulated patch after
 * required model installs succeed.
 */

import type { SetupProfile, ProfileDependencies } from './profile';

export interface PlannedSecrets {
  deepseekApiKey?: string;
  openaiApiKey?: string;
}

export interface PlannedProviders {
  modelProvider?: string;
  modelName?: string;
  deepseekValidated: string;
  openaiSttReady: boolean;
  openaiTtsReady: boolean;
  deepseekSource: string;
  openaiSource: string;
}

export interface PlannedAudio {
  inputId?: string;
  inputLabel?: string;
  outputId?: string;
  captureCommand?: string;
  playbackCommand?: string;
  captureReady: boolean;
  signalDetected: boolean;
  audibleConfirmed: boolean | string;
}

export interface PlannedLocalModel {
  kind: string;
  modelId: string;
  via: string;
  alreadyReady: boolean;
}

export interface PlannedVoice {
  voiceEnabled?: boolean;
  sttPolicy?: string;
  ttsPolicy?: string;
  wakeEnabled?: boolean;
}

export interface UnifiedSetupPlan {
  profile: SetupProfile;
  dependencies: ProfileDependencies;
  secrets: PlannedSecrets;
  providers: PlannedProviders;
  audio: PlannedAudio;
  localModels: PlannedLocalModel[];
  voice: PlannedVoice;
}

export function emptyUnifiedPlan(profile: SetupProfile, dependencies: ProfileDependencies): UnifiedSetupPlan {
  return {
    profile,
    dependencies,
    secrets: {},
    providers: { deepseekValidated: 'not_attempted', openaiSttReady: false, openaiTtsReady: false, deepseekSource: 'absent', openaiSource: 'absent' },
    audio: { captureReady: false, signalDetected: false, audibleConfirmed: 'unknown' },
    localModels: [],
    voice: {},
  };
}

export interface UnifiedMachinePatch {
  set: Record<string, string>;
  remove: string[];
}

function mergePatchInto(target: UnifiedMachinePatch, patch: UnifiedMachinePatch): void {
  for (const keys of Object.keys(patch.set)) {
    target.set[keys] = patch.set[keys] as string;
  }
  for (const key of patch.remove) {
    if (target.set[key] === undefined && target.remove.indexOf(key) === -1) target.remove.push(key);
  }
}

export function compileUnifiedPatch(plan: UnifiedSetupPlan, opts: { providerPatch: UnifiedMachinePatch; audioPatch: UnifiedMachinePatch; voiceDefaults: { voiceEnabled: boolean; sttPolicy: string; ttsPolicy: string; wakeEnabled: boolean }; effectiveVoice: { voiceEnabled: boolean; sttPolicy: string; ttsPolicy: string; wakeEnabled: boolean } }): UnifiedMachinePatch {
  const out: UnifiedMachinePatch = { set: {}, remove: [] };
  mergePatchInto(out, opts.providerPatch);
  mergePatchInto(out, opts.audioPatch);
  const voice = plan.voice;
  if (voice.voiceEnabled === true) out.set['ARTHUR_VOICE_ENABLED'] = 'true';
  if (voice.voiceEnabled === false) {
    if (opts.effectiveVoice.voiceEnabled) out.set['ARTHUR_VOICE_ENABLED'] = 'false';
  }
  if (typeof voice.sttPolicy === 'string') {
    if (voice.sttPolicy !== opts.voiceDefaults.sttPolicy) out.set['ARTHUR_STT_POLICY'] = voice.sttPolicy;
  }
  if (typeof voice.ttsPolicy === 'string') {
    if (voice.ttsPolicy !== opts.voiceDefaults.ttsPolicy) out.set['ARTHUR_TTS_POLICY'] = voice.ttsPolicy;
  }
  if (typeof voice.wakeEnabled === 'boolean') {
    if (voice.wakeEnabled !== opts.voiceDefaults.wakeEnabled) out.set['ARTHUR_WAKE_ENABLED'] = voice.wakeEnabled ? 'true' : 'false';
  }
  return out;
}

export function isEmptyUnifiedPlanPatch(patch: UnifiedMachinePatch): boolean {
  return Object.keys(patch.set).length === 0 && patch.remove.length === 0;
}

export function unifiedPatchSecretNames(patch: UnifiedMachinePatch): string[] {
  const names: string[] = [];
  if (patch.set['DEEPSEEK_API_KEY'] !== undefined) names.push('DEEPSEEK_API_KEY');
  if (patch.set['OPENAI_API_KEY'] !== undefined) names.push('OPENAI_API_KEY');
  return names;
}
