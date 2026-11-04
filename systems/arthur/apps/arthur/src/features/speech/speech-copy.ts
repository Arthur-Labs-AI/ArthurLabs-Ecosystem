import type { SpeechFailure } from "@arthur/contracts";

/** What each voice-output failure means to a person. Bounded and fixed: nothing a provider said can appear here. */
export const SPEECH_FAILURE_MESSAGE: Record<SpeechFailure, string> = {
  notConfigured: "Listening needs an AI connection. Connect one in Settings → AI & Voice.",
  invalidCredential: "The voice service rejected the saved key. Check it in Settings → AI & Voice.",
  unreachable: "Couldn’t reach the voice service. Check the connection and try again.",
  unsupported: "The voice service doesn’t offer that voice.",
  synthesisFailed: "The voice service couldn’t produce speech this time. Try again.",
  playbackFailed: "This device couldn’t play the audio.",
  unavailable: "This device can’t play speech.",
};
