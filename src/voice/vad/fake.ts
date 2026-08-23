/**
 * Deterministic scripted VAD for tests (Phase 3 spec section 7.2).
 *
 * The script maps frame index -> classification, and the provider emits
 * transition events at the script boundaries. This makes end-of-utterance
 * and barge-in tests fully deterministic.
 */

import { PcmFrame, VadConfig, VadProvider, VadResult } from "../contracts";

export type VadScriptStep = "silence" | "speech" | "end";

export class FakeVadProvider implements VadProvider {
  /** Per-frame script; the last entry repeats forever. */
  private script: VadScriptStep[] = [];
  private index = 0;
  private speakingFlag = false;
  private speechFrames = 0;
  resetCount = 0;
  /** Latches the first speech_started / speech_ended timestamp for tests. */
  readonly transitions: Array<{ transition: string; atMs: number }> = [];

  constructor(private readonly config?: VadConfig) {}

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
    if (step === "speech") {
      this.speechFrames += 1;
      this.speakingFlag = true;
      // Every speech step emits the boundary: barge-in eligibility counts
      // consecutive speech_started runs while playback is active.
      this.transitions.push({ transition: "speech_started", atMs: frame.timestamp_ms });
      return { speechProbability: 0.9, isSpeech: true, transition: "speech_started" };
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