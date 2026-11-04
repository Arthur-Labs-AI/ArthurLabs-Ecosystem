/**
 * Deterministic scripted VAD for tests (Phase 3 spec section 7.2).
 *
 * The script maps frame index -> classification, and the provider emits
 * transition events at the script boundaries. This makes end-of-utterance
 * and barge-in tests fully deterministic.
 *
 * Two transition modes:
 * - default: every "speech" frame re-emits speech_started (legacy barge-in
 *   tests rely on the per-frame boundary).
 * - realisticTransitions: speech_started fires once per episode, like the
 *   real LocalEnergyVadProvider, so sustained-speech barge-in is exercised
 *   against the same shape of stream the runtime sees.
 */

import { PcmFrame, VadConfig, VadProvider, VadResult } from "../contracts";

export type VadScriptStep = "silence" | "speech" | "speech_low" | "end";

export interface FakeVadOptions {
  /** Emit speech_started only at episode start (models the real VAD). */
  realisticTransitions?: boolean;
}

export class FakeVadProvider implements VadProvider {
  /** Per-frame script; the last entry repeats forever. */
  private script: VadScriptStep[] = [];
  private index = 0;
  private speakingFlag = false;
  private speechFrames = 0;
  resetCount = 0;
  /** Latches the first speech_started / speech_ended timestamp for tests. */
  readonly transitions: Array<{ transition: string; atMs: number }> = [];
  private readonly realistic: boolean;

  constructor(private readonly config?: VadConfig, opts: FakeVadOptions = {}) {
    this.realistic = opts.realisticTransitions ?? false;
  }

  id(): string {
    return "fake-vad";
  }

  setScript(script: VadScriptStep[]): void {
    this.script = script;
    this.index = 0;
    this.speakingFlag = false;
    this.speechFrames = 0;
  }

  reset(): void {
    this.resetCount += 1;
    this.index = 0;
    this.speakingFlag = false;
    this.speechFrames = 0;
  }

  process(frame: PcmFrame): VadResult {
    const step = this.script[this.index] ?? this.script[this.script.length - 1] ?? "silence";
    this.index += 1;
    if (step === "speech" || step === "speech_low") {
      const probability = step === "speech" ? 0.9 : 0.75;
      this.speechFrames += 1;
      const wasSpeaking = this.speakingFlag;
      this.speakingFlag = true;
      // Default mode: every speech step emits the boundary. Realistic mode:
      // only the first frame of the episode emits speech_started, matching
      // LocalEnergyVadProvider's per-episode transition shape.
      const emitTransition = this.realistic ? !wasSpeaking : true;
      if (emitTransition) {
        this.transitions.push({ transition: "speech_started", atMs: frame.timestamp_ms });
      }
      return {
        speechProbability: probability,
        // 0.75 is above any sane end threshold (speech) but below the
        // stronger playback-active barge-in probability (speech_low).
        isSpeech: true,
        transition: emitTransition ? "speech_started" : undefined,
      };
    }
    if (step === "end") {
      if (this.speakingFlag) {
        this.speakingFlag = false;
        this.transitions.push({ transition: "speech_ended", atMs: frame.timestamp_ms });
        return { speechProbability: 0.1, isSpeech: false, transition: "speech_ended" };
      }
      return { speechProbability: 0.1, isSpeech: false };
    }
    return { speechProbability: 0.05, isSpeech: false };
  }
}
