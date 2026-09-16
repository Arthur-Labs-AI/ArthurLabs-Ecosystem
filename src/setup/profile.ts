/**
 * FRS-04: experience profiles and their dependency graphs.
 *
 * Profiles map ONLY to features/policies that exist in the current runtime:
 * cloud DeepSeek reasoning, OpenAI/local STT/TTS routing policies, local
 * audio devices, and the HR-02.5 managed model catalog. HR-03 hybrid
 * routing does not exist — local voice keeps cloud reasoning and the UI
 * must say so (never 'offline mode').
 */

export const SETUP_PROFILES = ['cloud_voice', 'local_voice', 'text_only', 'custom'] as const;

export type SetupProfile = (typeof SETUP_PROFILES)[number];

export function isSetupProfile(value: unknown): value is SetupProfile {
  return typeof value === 'string' && (SETUP_PROFILES as readonly string[]).includes(value);
}

export const PROFILE_LABELS: Record<SetupProfile, string> = {
  cloud_voice: 'Cloud voice',
  local_voice: 'Local voice',
  text_only: 'Text only',
  custom: 'Custom',
}

export const PROFILE_DESCRIPTIONS: Record<SetupProfile, string> = {
  cloud_voice: 'DeepSeek reasoning with OpenAI speech recognition and speech output.',
  local_voice: 'Speech recognition and speech output stay on this machine. Reasoning still uses DeepSeek until hybrid intelligence routing is added.',
  text_only: 'DeepSeek reasoning only. No microphone, no speech output, no model downloads.',
  custom: 'Choose speech recognition, speech output, and activation individually from currently supported options.',
};

export interface ProfileDependencies {
  deepseekCredential: boolean;
  openaiCredential: boolean;
  audio: boolean;
  localSttModel: boolean;
  localTtsModel: boolean;
}

/** Which setup steps each profile requires (irrelevant questions are skipped). */
export function dependenciesFor(profile: SetupProfile): ProfileDependencies {
  switch (profile) {
    case 'cloud_voice':
      return { deepseekCredential: true, openaiCredential: true, audio: true, localSttModel: false, localTtsModel: false };
    case 'local_voice':
      return { deepseekCredential: true, openaiCredential: false, audio: true, localSttModel: true, localTtsModel: true };
    case 'text_only':
      return { deepseekCredential: true, openaiCredential: false, audio: false, localSttModel: false, localTtsModel: false };
    case 'custom':
      // Custom resolves per-question: every dependency is possible.
      return { deepseekCredential: true, openaiCredential: true, audio: true, localSttModel: true, localTtsModel: true };
  }
}

export type SttChoice = 'openai' | 'local';
export type TtsChoice = 'openai' | 'local';

export interface CustomVoiceChoices {
  stt: SttChoice;
  tts: TtsChoice;
  audio: boolean;
}

/** Custom dependencies derive from the user's own STT/TTS/audio choices. */
export function dependenciesForCustom(choices: CustomVoiceChoices): ProfileDependencies {
  return {
    deepseekCredential: true,
    openaiCredential: choices.stt === 'openai' || choices.tts === 'openai',
    audio: choices.audio || choices.stt === 'local' || choices.tts === 'local',
    localSttModel: choices.stt === 'local',
    localTtsModel: choices.tts === 'local',
  };
}

/**
 * Derive the likely current profile from effective config (preselection).
 * Returns null when the state matches no profile cleanly (=> custom).
 */
export function deriveCurrentProfile(effective: { voiceEnabled: boolean; sttPolicy: string; ttsPolicy: string; audioConfigured: boolean }): SetupProfile | null {
  if (!effective.voiceEnabled) return 'text_only';
  if (effective.sttPolicy === 'local_only' || effective.ttsPolicy === 'local_only') {
    if (effective.sttPolicy === 'local_only' && effective.ttsPolicy === 'local_only') return 'local_voice';
    return null;
  }
  if (effective.sttPolicy === 'cloud_preferred' && effective.ttsPolicy === 'cloud_preferred') return 'cloud_voice';
  return null;
}