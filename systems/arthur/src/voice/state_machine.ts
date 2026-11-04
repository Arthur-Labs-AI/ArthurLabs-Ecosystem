/**
 * Deterministic voice state machine (Phase 3 spec section 9).
 *
 * All transitions are explicit and validated against a fixed table; an
 * illegal transition throws VOICE_STATE_INVALID instead of silently moving.
 * No ad hoc booleans spread across the controller - the machine is the single
 * source of truth for voice state.
 *
 * Transitions (spec section 9):
 *   DISABLED -> IDLE                        (enable)
 *   IDLE -> LISTENING                       (wake / push-to-talk)
 *   IDLE -> DISABLED                        (disable)
 *   LISTENING -> CAPTURING                  (speech detected)
 *   LISTENING -> IDLE                       (no-speech timeout / cancel)
 *   CAPTURING -> TRANSCRIBING_FINAL         (VAD end-of-utterance)
 *   CAPTURING -> IDLE                       (cancel)
 *   TRANSCRIBING_FINAL -> THINKING          (final transcript)
 *   TRANSCRIBING_FINAL -> IDLE              (empty transcript / cancel)
 *   THINKING -> SPEAKING                    (first speakable response chunk)
 *   THINKING -> IDLE                        (empty answer / cancel)
 *   THINKING -> INTERRUPTING                (user speech while reasoning)
 *   SPEAKING -> IDLE                        (response completes)
 *   SPEAKING -> INTERRUPTING                (barge-in)
 *   INTERRUPTING -> LISTENING               (all cancelled -> listen again)
 *   INTERRUPTING -> IDLE                    (all cancelled, nothing pending)
 *   ANY ACTIVE STATE -> DISABLED            (disable cancels all resources)
 *   ANY ACTIVE STATE -> ERROR               (fatal component error)
 *   ERROR -> IDLE                           (recover)
 *   ERROR -> DISABLED                       (disable)
 */

import { VoiceError, VoiceErrorCode, VoiceState } from "./contracts";

export type StateListener = (from: VoiceState, to: VoiceState, reason: string) => void;

const TABLE: Readonly<Record<VoiceState, readonly VoiceState[]>> = {
  [VoiceState.DISABLED]: [VoiceState.IDLE],
  // SPEAKING from IDLE is a documented extension for proactive spoken
  // confirmations (mode switch, approval outcome).
  [VoiceState.IDLE]: [VoiceState.LISTENING, VoiceState.SPEAKING, VoiceState.DISABLED, VoiceState.ERROR],
  [VoiceState.LISTENING]: [VoiceState.CAPTURING, VoiceState.IDLE, VoiceState.DISABLED, VoiceState.ERROR],
  [VoiceState.CAPTURING]: [
    VoiceState.TRANSCRIBING_FINAL,
    VoiceState.IDLE,
    VoiceState.DISABLED,
    VoiceState.ERROR,
  ],
  [VoiceState.TRANSCRIBING_FINAL]: [
    VoiceState.THINKING,
    VoiceState.IDLE,
    VoiceState.DISABLED,
    VoiceState.ERROR,
  ],
  [VoiceState.THINKING]: [
    VoiceState.SPEAKING,
    VoiceState.IDLE,
    VoiceState.INTERRUPTING,
    VoiceState.DISABLED,
    VoiceState.ERROR,
  ],
  [VoiceState.SPEAKING]: [VoiceState.IDLE, VoiceState.INTERRUPTING, VoiceState.DISABLED, VoiceState.ERROR],
  [VoiceState.INTERRUPTING]: [VoiceState.LISTENING, VoiceState.IDLE, VoiceState.DISABLED, VoiceState.ERROR],
  [VoiceState.ERROR]: [VoiceState.IDLE, VoiceState.DISABLED],
};

export class VoiceStateMachine {
  private currentState: VoiceState = VoiceState.DISABLED;
  private readonly listeners = new Set<StateListener>();

  get state(): VoiceState {
    return this.currentState;
  }

  canTransition(to: VoiceState): boolean {
    return TABLE[this.currentState].includes(to);
  }

  /**
   * Transition to the target state with a reason. Throws VOICE_STATE_INVALID
   * for illegal transitions (fail closed, spec section 37).
   */
  transition(to: VoiceState, reason: string): VoiceState {
    const from = this.currentState;
    if (!TABLE[from].includes(to)) {
      throw new VoiceError(
        VoiceErrorCode.VOICE_STATE_INVALID,
        "Illegal voice state transition " + from + " -> " + to,
        "state_machine",
      );
    }
    this.currentState = to;
    for (const listener of this.listeners) {
      try {
        listener(from, to, reason);
      } catch {
        // Listeners must never break the state machine.
      }
    }
    return to;
  }

  /** Force a state (used by the controller to enter ERROR after a fatal error). */
  enterError(reason: string): void {
    this.transition(VoiceState.ERROR, reason);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}