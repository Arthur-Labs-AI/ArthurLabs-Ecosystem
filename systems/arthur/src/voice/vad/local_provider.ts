/**
 * Local offline VAD (Phase 3 spec sections 11, 26).
 *
 * Zero-dependency frame-level speech detector: RMS energy mapped to a
 * 0..1 speech probability, hysteresis thresholds, debounce frames, and
 * min-speech rejection of tiny clicks. Deterministic per frame; the
 * controller owns utterance-level timeouts (no-speech / max-utterance).
 */

import { frameEnergy, PcmFrame, VadConfig, VadProvider, VadResult } from "../contracts";

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export interface LocalVadOptions {
  /** Energy (RMS) mapped to probability 1.0. */
  speechEnergyCeiling?: number;
  /** Energy (RMS) mapped to probability 0.0. */
  silenceEnergyFloor?: number;
}

export class LocalEnergyVadProvider implements VadProvider {
  private readonly config: VadConfig;
  private readonly speechEnergyCeiling: number;
  private readonly silenceEnergyFloor: number;
  private speaking = false;
  private aboveStartRun = 0;
  private belowEndRun = 0;
  private speechStartedAtMs = 0;
  private speechSamples = 0;

  constructor(config: VadConfig, opts: LocalVadOptions = {}) {
    this.config = config;
    this.speechEnergyCeiling = opts.speechEnergyCeiling ?? 2400;
    this.silenceEnergyFloor = opts.silenceEnergyFloor ?? 60;
  }

  id(): string {
    return "local-energy-vad";
  }

  reset(): void {
    this.speaking = false;
    this.aboveStartRun = 0;
    this.belowEndRun = 0;
    this.speechStartedAtMs = 0;
    this.speechSamples = 0;
  }

  process(frame: PcmFrame): VadResult {
    const energy = frameEnergy(frame);
    const probability = this.energyToProbability(energy);
    const isSpeech = probability >= this.config.speechEndThreshold;

    if (!this.speaking) {
      if (probability >= this.config.speechStartThreshold) {
        this.aboveStartRun += 1;
        if (this.aboveStartRun >= this.config.speechStartFrames) {
          // Debounced start; check min duration at end (tiny clicks are
          // rejected there because the debounce itself filters blips).
          this.speaking = true;
          this.speechStartedAtMs = frame.timestamp_ms;
          this.speechSamples = 0;
          this.aboveStartRun = 0;
          this.belowEndRun = 0;
          return { speechProbability: probability, isSpeech: true, transition: "speech_started" };
        }
      } else {
        this.aboveStartRun = 0;
      }
      return { speechProbability: probability, isSpeech: false };
    }

    // Speaking: track duration; end after sustained below-end probability.
    this.speechSamples += 1;
    const speechDurationMs = frame.timestamp_ms - this.speechStartedAtMs + frame.duration_ms;
    if (probability < this.config.speechEndThreshold) {
      this.belowEndRun += 1;
    } else {
      this.belowEndRun = 0;
    }
    const silenceMs = this.belowEndRun * frame.duration_ms;
    const endOfSpeech =
      this.belowEndRun >= this.config.speechEndFrames && silenceMs >= this.config.endSilenceMs;
    if (endOfSpeech) {
      this.speaking = false;
      this.aboveStartRun = 0;
      this.belowEndRun = 0;
      const minMet = speechDurationMs >= this.config.minSpeechMs;
      return {
        speechProbability: probability,
        isSpeech: false,
        transition: minMet ? "speech_ended" : undefined,
      };
    }
    return { speechProbability: probability, isSpeech: true };
  }

  private energyToProbability(energy: number): number {
    const range = this.speechEnergyCeiling - this.silenceEnergyFloor;
    if (range <= 0) return energy > this.speechEnergyCeiling ? 1 : 0;
    return clamp01((energy - this.silenceEnergyFloor) / range);
  }
}
