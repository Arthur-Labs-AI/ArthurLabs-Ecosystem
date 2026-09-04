/**
 * VoiceTurnController (Phase 3 spec sections 5, 9, 17, 18, 20, 21, 29-35).
 *
 * The deterministic owner of the local voice loop: wake/PTT -> VAD -> STT ->
 * ConversationService (streaming) -> SpeechFormatter/Chunker -> TTS ->
 * playback, with barge-in, echo protection, approval-by-voice, generation
 * guards, and typed metrics. Only one active foreground voice turn owns the
 * microphone response loop at a time (single turn authority).
 *
 * Privacy invariants (spec section 27): raw audio lives in bounded memory
 * buffers only, is cleared after each utterance, and never reaches logs,
 * persistence, or the DeepSeek payload.
 */

import { randomUUID } from "node:crypto";

import type { ArthurMode } from "../core/modes/mode";
import type { ConversationService } from "../core/conversation/service";
import type { StreamingTurnEvent } from "../core/conversation/streaming_service";
import type { SessionStore } from "../sessions/store";
import type { SecretSanitizer } from "../security/sanitize";
import type { Logger } from "../observability/logging";
import type { Metrics } from "../observability/metrics";
import {
  ACTIVE_VOICE_STATES,
  PcmFrame,
  SttProvider,
  TtsProvider,
  VadProvider,
  VadResult,
  VoiceError,
  VoiceErrorCode,
  VoiceSession,
  VoiceState,
  WakeEvent,
} from "./contracts";
import type { VoiceSettings } from "./config";
import { VoiceClientCommand, VoiceClientEvent, voiceEventTs } from "./events";
import { CancellationScope } from "./cancellation/cancellation_scope";
import { VoiceStateMachine } from "./state_machine";
import type { AudioCapture } from "./audio/capture";
import type { AudioPlayback } from "./audio/playback";
import { RingBuffer } from "./audio/ring_buffer";
import type { WakeWordGateway } from "./wake/gateway";
import type { SpeechFormatter } from "./speech/formatter";
import { SpeakableChunk, SpeakableChunker } from "./speech/chunker";
import { boundTranscript, isUsableTranscript, normalizeTranscript } from "./stt/contracts";
import { estimateSpeechMs } from "./tts/contracts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Push-based async frame stream handed to STT. Bounded queue: the oldest
 * frames are dropped past the cap so memory stays bounded while capture is
 * faster than the engine (spec section 34).
 */
class FrameStream implements AsyncIterable<PcmFrame> {
  private readonly queue: PcmFrame[] = [];
  private readonly waiters: Array<() => void> = [];
  private ended = false;
  dropped = 0;

  constructor(private readonly maxQueuedFrames = 200) {}

  push(frame: PcmFrame): void {
    if (this.ended) return;
    if (this.queue.length >= this.maxQueuedFrames) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(frame);
    this.wake();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiters.shift();
    waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<PcmFrame> {
    for (;;) {
      const frame = this.queue.shift();
      if (frame) {
        yield frame;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/**
 * Bounded FIFO used for the speakable-chunk queue (TTS backpressure).
 * put() awaits while full; take() awaits while empty.
 */
class BoundedQueue<T> {
  private readonly items: T[] = [];
  private readonly putWaiters: Array<() => void> = [];
  private readonly takeWaiters: Array<(item: T) => void> = [];
  private closedFlag = false;

  constructor(private readonly capacity: number) {}

  get length(): number {
    return this.items.length;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  async put(item: T): Promise<void> {
    for (;;) {
      if (this.closedFlag) return;
      if (this.items.length < this.capacity) {
        this.items.push(item);
        const waiter = this.takeWaiters.shift();
        waiter?.(item);
        return;
      }
      await new Promise<void>((resolve) => this.putWaiters.push(resolve));
    }
  }

  async take(): Promise<T | undefined> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        const waiter = this.putWaiters.shift();
        waiter?.();
        return item;
      }
      if (this.closedFlag) return undefined;
      await new Promise<T>((resolve) => this.takeWaiters.push(resolve));
    }
  }

  clear(): void {
    this.items.length = 0;
    while (this.putWaiters.length > 0) this.putWaiters.shift()?.();
    while (this.takeWaiters.length > 0) this.takeWaiters.shift()?.(undefined as unknown as T);
  }

  /** Wake one blocked take() with undefined (used to stop a stale pump). */
  poke(): void {
    const waiter = this.takeWaiters.shift();
    waiter?.(undefined as unknown as T);
  }

  /** Re-open after close() (enable again after disable). */
  reopen(): void {
    this.closedFlag = false;
    this.items.length = 0;
  }

  close(): void {
    this.closedFlag = true;
    this.clear();
  }
}


// ---------------------------------------------------------------------------
// VoiceTurnController
// ---------------------------------------------------------------------------

export interface VoiceControllerDeps {
  settings: VoiceSettings;
  conversation: ConversationService;
  store: SessionStore;
  capture: AudioCapture;
  playback: AudioPlayback;
  wake: WakeWordGateway;
  vad: VadProvider;
  stt: SttProvider;
  tts: TtsProvider;
  formatter: SpeechFormatter;
  logger: Logger;
  metrics: Metrics;
  sanitizer: SecretSanitizer;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Initial ARTHUR session binding (may be set later via setSession). */
  arthurSessionId?: string;
}

export interface ApprovalIntentResult {
  handled: boolean;
  approvalId?: string;
}

const APPROVAL_INTENT = /^(yes|yeah|yep|sure|ok|okay|do it|go ahead|approve|confirm|agree)([.,!?]|\s|$)/i;
// Explicit approval ids are UUIDs; anything else (e.g. "yes please") must
// not be mistaken for an id, or generic intents would be dropped.
const APPROVAL_WITH_ID = /^(approve|confirm|yes)[\s:]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const BARGE_IN_MIN_PROBABILITY = 0.7;
/**
 * Stronger speech-probability threshold while playback is active (TASK-0007):
 * speaker echo is loud but a deliberate interruption is louder. Energy-VAD
 * cannot distinguish echo from user speech (no AEC yet) - this threshold plus
 * the sustained-frame requirement (settings.bargeInMinSpeechMs) is the
 * software mitigation; headphones remain the deterministic verification path.
 */
const BARGE_IN_MIN_PROBABILITY_PLAYING = 0.8;

export class VoiceTurnController {
  readonly voiceSessionId: string = `voice-${randomUUID()}`;
  private readonly settings: VoiceSettings;
  private readonly conversation: ConversationService;
  private readonly store: SessionStore;
  private readonly capture: AudioCapture;
  private readonly playback: AudioPlayback;
  private readonly wake: WakeWordGateway;
  private readonly vad: VadProvider;
  private readonly stt: SttProvider;
  private readonly tts: TtsProvider;
  private readonly formatter: SpeechFormatter;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly sanitizer: SecretSanitizer;
  private readonly now: () => number;
  private readonly machine = new VoiceStateMachine();
  private readonly subscribers = new Set<(event: VoiceClientEvent) => void>();
  private readonly preRoll: RingBuffer;
  private readonly chunker = new SpeakableChunker();
  private readonly ttsQueue: BoundedQueue<SpeakableChunk>;
  private arthurSessionId: string;
  private inputDeviceId = "default";
  private outputDeviceId = "default";
  private generation = 0;
  private activeScope: CancellationScope | undefined;
  private frameStream: FrameStream | undefined;
  private sttOptions: { utteranceId: string; language?: string; maxTranscriptChars: number; audioDurationMs?: number } | undefined;
  private activeTurnId: string | undefined;
  private activeUtteranceId: string | undefined;
  private utteranceAudioMs = 0;
  /**
   * BUG 1 (TASK-0007): while true, the utterance lifecycle is owned by the
   * PTT button. VAD may detect speech, but temporary silence must never
   * finalize the utterance - only pttStop() (or the max-utterance safety
   * timeout) may. Wake-word mode keeps normal VAD end-of-speech.
   */
  private pttActive = false;
  private toolHeld = false;
  private speakPending = false;
  private toolBufferedText = "";
  private turnCompletedFlag = false;
  private ttsFailureSpoken = false;
  private currentSynthesisId: string | undefined;
  private utteranceStartTs: number | undefined;
  private speakingTurnId: string | undefined;
  private bargeInRun = 0;
  /** Sustained frames required before barge-in fires (from bargeInMinSpeechMs). */
  private readonly bargeInMinFrames: number;
  private noSpeechTimer: ReturnType<typeof setTimeout> | undefined;
  private maxUtteranceTimer: ReturnType<typeof setTimeout> | undefined;
  private closedFlag = false;
  private readonly pendingApprovals = new Map<string, { tool_name: string; session_id: string }>();
  private speakPumpPromise: Promise<void> | undefined;
  private speakPumpRunning = false;
  private pumpEpoch = 0;
  private speakPumpGeneration = 0;
  private readonly createdAt = new Date().toISOString();

  constructor(deps: VoiceControllerDeps) {
    this.settings = deps.settings;
    this.conversation = deps.conversation;
    this.store = deps.store;
    this.capture = deps.capture;
    this.playback = deps.playback;
    this.wake = deps.wake;
    this.vad = deps.vad;
    this.stt = deps.stt;
    this.tts = deps.tts;
    this.formatter = deps.formatter;
    this.logger = deps.logger.child("voice");
    this.metrics = deps.metrics;
    this.sanitizer = deps.sanitizer;
    this.now = deps.now ?? Date.now;
    this.arthurSessionId = deps.arthurSessionId ?? "";
    this.preRoll = new RingBuffer({
      // BUG 2 (TASK-0007): ~700 ms of bounded in-memory pre-roll so the first
      // syllables survive Windows microphone/VAD start latency. Memory-only;
      // drained into the utterance STT stream on speech_started.
      maxMs: Math.max(700, deps.settings.frameDurationMs * 32),
      maxBytes: 128 * 1024,
    });
    this.ttsQueue = new BoundedQueue<SpeakableChunk>(deps.settings.ttsMaxQueueChunks);
    this.bargeInMinFrames = Math.max(
      1,
      Math.ceil(deps.settings.bargeInMinSpeechMs / Math.max(1, deps.settings.frameDurationMs)),
    );
    this.machine.subscribe((from, to, reason) => {
      this.metrics.counter("voice.state_transition", 1, { from, to, reason });
      this.emit({ type: "voice.state", state: to, reason, session_id: this.voiceSessionId, ts: voiceEventTs(this.now()) });
    });
  }

  // ---- public API --------------------------------------------------------

  get state(): VoiceState {
    return this.machine.state;
  }

  get sessionId(): string {
    return this.arthurSessionId;
  }

  /** Voice session record (spec section 22) - operational, ephemeral. */
  voiceSession(): VoiceSession {
    return {
      voice_session_id: this.voiceSessionId,
      arthur_session_id: this.arthurSessionId,
      state: this.machine.state,
      active_utterance_id: this.activeUtteranceId,
      active_turn_id: this.activeTurnId,
      input_device_id: this.inputDeviceId,
      output_device_id: this.outputDeviceId,
      wake_enabled: this.settings.wakeEnabled && this.wake.available,
      push_to_talk_enabled: true,
      created_at: this.createdAt,
      updated_at: new Date(this.now()).toISOString(),
    };
  }

  subscribe(listener: (event: VoiceClientEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Bind the voice path to an existing ARTHUR session (mode read server-side). */
  setSession(sessionId: string): void {
    if (this.store.getSession(sessionId)) {
      this.arthurSessionId = sessionId;
      this.emitSession();
    } else {
      throw new VoiceError(VoiceErrorCode.VOICE_STATE_INVALID, `Unknown session: ${sessionId}`, "session");
    }
  }

  setDevices(inputDeviceId?: string, outputDeviceId?: string): void {
    if (inputDeviceId) this.inputDeviceId = inputDeviceId;
    if (outputDeviceId) this.outputDeviceId = outputDeviceId;
    this.emitSession();
  }

  /**
   * Enable the voice path: DISABLED -> IDLE. Starts capture and the wake
   * detector. Fails closed (stays DISABLED) when no microphone is usable;
   * degraded to PTT-only when wake is unavailable (spec section 33).
   */
  async enable(sessionId?: string): Promise<void> {
    if (sessionId) {
      if (!this.store.getSession(sessionId)) {
        throw new VoiceError(VoiceErrorCode.VOICE_STATE_INVALID, `Unknown session: ${sessionId}`, "session");
      }
      this.arthurSessionId = sessionId;
    }
    if (this.machine.state !== VoiceState.DISABLED) return;
    if (this.closedFlag) {
      throw new VoiceError(VoiceErrorCode.VOICE_DISABLED, "Voice controller is closed", "controller");
    }
    if (!this.capture.available) {
      this.emitError(VoiceErrorCode.AUDIO_INPUT_UNAVAILABLE, "No usable microphone; voice stays disabled, text path is unaffected", "capture");
      return;
    }
    if (!this.arthurSessionId) {
      this.emitError(VoiceErrorCode.VOICE_STATE_INVALID, "Bind an ARTHUR session before enabling voice", "session");
      throw new VoiceError(VoiceErrorCode.VOICE_STATE_INVALID, "Bind an ARTHUR session before enabling voice", "session");
    }
    try {
      this.ttsQueue.reopen();
      await this.capture.start((frame) => this.onFrame(frame));
      this.machine.transition(VoiceState.IDLE, "enable");
      if (this.settings.wakeEnabled) {
        if (this.wake.available) {
          await this.wake.start(
            {
              wakeWord: this.settings.wakeWord,
              sampleRateHz: this.settings.sampleRateHz,
              frameDurationMs: this.settings.frameDurationMs,
              preRollMs: 400,
              threshold: 0.6,
            },
            (event) => this.onWake(event),
          );
        } else {
          this.emitError(VoiceErrorCode.WAKE_UNAVAILABLE, "Wake provider unavailable; push-to-talk remains available", "wake");
        }
      }
      this.emitSession();
      this.logger.info("voice enabled", { session_id: this.arthurSessionId });
    } catch (err) {
      await this.capture.stop().catch(() => undefined);
      this.emitError(VoiceErrorCode.AUDIO_INPUT_UNAVAILABLE, err instanceof Error ? err.message : "microphone start failed", "capture");
    }
  }

  /** Disable from any state: cancels resources and reaches DISABLED. */
  async disable(): Promise<void> {
    await this.cancelActive("disable");
    await this.wake.stop().catch(() => undefined);
    await this.capture.stop().catch(() => undefined);
    await this.playback.stop().catch(() => undefined);
    this.vad.reset();
    this.chunker.reset();
    this.ttsQueue.close();
    this.preRoll.clear();
    this.clearTimers();
    this.pendingApprovals.clear();
    if (this.machine.state !== VoiceState.DISABLED) {
      this.machine.transition(VoiceState.DISABLED, "disable");
    }
    this.emitSession();
    this.logger.info("voice disabled");
  }

  /**
   * Push-to-talk start. Works with wake disabled or unavailable. Only one
   * foreground turn may own the mic loop: while a turn is active a second
   * PTT start raises VOICE_BUSY.
   */
  async pttStart(): Promise<void> {
    if (this.machine.state === VoiceState.DISABLED) {
      throw new VoiceError(VoiceErrorCode.VOICE_DISABLED, "Voice is not enabled", "controller");
    }
    if (ACTIVE_VOICE_STATES.includes(this.machine.state) && this.machine.state !== VoiceState.LISTENING) {
      this.emitError(VoiceErrorCode.VOICE_BUSY, "A voice turn is already in progress", "controller");
      throw new VoiceError(VoiceErrorCode.VOICE_BUSY, "A voice turn is already in progress", "controller");
    }
    if (this.machine.state !== VoiceState.LISTENING) {
      this.machine.transition(VoiceState.LISTENING, "push_to_talk");
    }
    // PTT boundary (TASK-0007 follow-up): audio captured BEFORE the button
    // press belongs to no PTT utterance - discard the IDLE pre-roll and any
    // stale VAD episode so STT only ever sees post-button audio. Wake mode
    // intentionally keeps its pre-wake pre-roll (onWake does not clear).
    this.preRoll.clear();
    this.vad.reset();
    // BUG 1 (TASK-0007): PTT owns the utterance lifecycle from here until
    // pttStop. Pauses are allowed; no VAD silence may finalize the utterance.
    this.pttActive = true;
    this.beginListenTimers("ptt");
  }

  /**
   * Push-to-talk stop: the ONLY user path that finalizes an active PTT
   * utterance (the max-utterance safety timeout is the other). Finalizes the
   * current utterance, or returns to IDLE if no speech was captured.
   */
  async pttStop(): Promise<void> {
    this.pttActive = false;
    if (this.machine.state === VoiceState.CAPTURING) {
      this.finalizeUtterance("ptt_stop");
    } else if (this.machine.state === VoiceState.LISTENING) {
      this.clearTimers();
      this.machine.transition(VoiceState.IDLE, "ptt_stop_no_speech");
    }
  }

  /** Cancel the current speak/generate pipeline (user stop). */
  async interrupt(reason = "user_stop"): Promise<void> {
    if (!ACTIVE_VOICE_STATES.includes(this.machine.state)) return;
    await this.cancelActive(reason);
    this.generation += 1;
    this.clearTimers();
    // A stale open VAD episode must not leak into the next listening window
    // (same discipline as bargeIn/disable; BUG 4 hardening).
    this.vad.reset();
    this.bargeInRun = 0;
    if (this.machine.state !== VoiceState.DISABLED) {
      this.machine.transition(VoiceState.IDLE, reason);
    }
  }

  /** Handle one realtime client command (spec section 23). */
  async handleClientCommand(command: VoiceClientCommand): Promise<void> {
    switch (command.type) {
      case "voice.enable":
        await this.enable(command.arthur_session_id);
        break;
      case "voice.disable":
        await this.disable();
        break;
      case "voice.ptt.start":
        await this.pttStart();
        break;
      case "voice.ptt.stop":
        await this.pttStop();
        break;
      case "voice.interrupt":
        await this.interrupt("user_stop");
        break;
      case "voice.set_device":
        this.setDevices(command.input_device_id, command.output_device_id);
        break;
      case "voice.set_session":
        this.setSession(command.arthur_session_id);
        break;
      case "voice.mode":
        await this.switchMode(command.mode);
        break;
      case "voice.answer_approval":
        await this.answerApproval(command.approve);
        break;
      default: {
        const exhaustive: never = command;
        void exhaustive;
      }
    }
  }

  /**
   * Mode switch by voice command: invokes the SAME explicit Phase 1
   * mode-change operation (spec section 21). Never derived from STT text.
   */
  private async switchMode(mode: ArthurMode): Promise<void> {
    if (!this.arthurSessionId) {
      throw new VoiceError(VoiceErrorCode.VOICE_STATE_INVALID, "No ARTHUR session bound", "session");
    }
    const result = await this.conversation.changeMode(this.arthurSessionId, { mode });
    void result;
    this.emitSession();
    await this.speakText(`Switched to ${mode} mode.`);
  }

  // ---- wake / frame routing ----------------------------------------------

  private onWake(event: WakeEvent): void {
    if (this.closedFlag) return;
    this.metrics.counter("wake.detected", 1, { provider: event.provider });
    this.metrics.timer("wake.latency_ms", Math.max(0, this.now() - event.detected_at_ms), { provider: event.provider });
    this.emit({ type: "wake.detected", provider: event.provider, latency_ms: Math.max(0, this.now() - event.detected_at_ms), ts: voiceEventTs(this.now()) });
    if (this.machine.state === VoiceState.IDLE) {
      // Pre-roll: frames captured before the wake moment are replayed into
      // the STT stream so the first syllable is not lost (memory-only).
      this.machine.transition(VoiceState.LISTENING, "wake_detected");
      this.beginListenTimers("wake");
    }
    // Wake while already listening/capturing is a no-op (no new turn).
  }

  private onFrame(frame: PcmFrame): void {
    if (this.closedFlag) return;
    const state = this.machine.state;
    if (state === VoiceState.IDLE) {
      // Wake processing (paused while speaking - echo protection) + pre-roll.
      this.wake.processFrame(frame);
      this.preRoll.push(frame);
      return;
    }
    if (state === VoiceState.LISTENING || state === VoiceState.CAPTURING) {
      const result = this.vad.process(frame);
      if (state === VoiceState.LISTENING) {
        if (result.transition === "speech_started") {
          // BUG 2 (TASK-0007): transfer pre-roll ownership. Drain returns the
          // bounded window of frames captured strictly BEFORE this one and
          // clears the buffer; the current frame is pushed exactly once below
          // so nothing is duplicated. Memory-only (privacy invariant).
          const preRoll = this.preRoll.drain();
          this.beginUtterance();
          for (const buffered of preRoll) {
            this.frameStream?.push(buffered);
          }
          this.frameStream?.push(frame);
        } else {
          this.preRoll.push(frame);
        }
      } else if (state === VoiceState.CAPTURING) {
        if (this.utteranceStartTs === undefined) this.utteranceStartTs = frame.timestamp_ms;
        this.utteranceAudioMs = Math.max(
          this.utteranceAudioMs,
          Math.max(0, frame.timestamp_ms - this.utteranceStartTs) + frame.duration_ms,
        );
        this.frameStream?.push(frame);
        // BUG 1 (TASK-0007): while PTT owns the utterance, temporary VAD
        // silence must NOT finalize - the button (or the max-utterance safety
        // timeout) decides. Wake-word mode keeps normal end-of-speech.
        if (!this.pttActive && result.transition === "speech_ended") {
          this.recordUtteranceMs(result);
          this.finalizeUtterance("vad_end");
        }
      }
      return;
    }
    if (state === VoiceState.SPEAKING || state === VoiceState.THINKING) {
      // Barge-in monitoring (BUG 4, TASK-0007): user speech during playback/
      // generation must be SUSTAINED high-probability speech. A single loud
      // frame or speaker echo must not cancel the turn. Per-frame counting
      // (not per-transition) makes the gate work with the real VAD, where
      // speech_started fires only once per episode, and the reset on
      // non-speech frames makes short transients expire immediately.
      // Limitation: energy VAD cannot distinguish speaker echo from user
      // speech (no AEC); the sustained gate + stronger playback threshold is
      // the documented software mitigation.
      const result = this.vad.process(frame);
      const threshold = this.playback.playing
        ? BARGE_IN_MIN_PROBABILITY_PLAYING
        : BARGE_IN_MIN_PROBABILITY;
      if (result.isSpeech && result.speechProbability >= threshold) {
        this.bargeInRun += 1;
        if (this.bargeInRun >= this.bargeInMinFrames) {
          this.bargeInRun = 0;
          void this.bargeIn();
        }
      } else {
        this.bargeInRun = 0;
      }
      return;
    }
    // TRANSCRIBING_FINAL / INTERRUPTING / ERROR / DISABLED: frames ignored.
  }

  /**
   * Barge-in: stop playback/TTS/generation promptly; new speech takes
   * priority (spec section 17 - CRITICAL).
   */
  private async bargeIn(): Promise<void> {
    if (!ACTIVE_VOICE_STATES.includes(this.machine.state)) return;
    this.bargeInRun = 0;
    const detectedAt = this.now();
    this.machine.transition(VoiceState.INTERRUPTING, "barge_in");
    await this.cancelActive("barge_in");
    // The interrupted turn is finished; the next utterance is a new generation.
    this.generation += 1;
    const stopMs = this.now() - detectedAt;
    this.metrics.timer("voice.barge_in_ms", stopMs, {});
    this.metrics.counter("voice.cancel_reason", 1, { reason: "barge_in" });
    this.emitError(VoiceErrorCode.VOICE_CANCELLED, "Interrupted by user speech", "controller");
    this.clearTimers();
    this.vad.reset();
    // Return to listening so the new utterance wins immediately.
    this.machine.transition(VoiceState.LISTENING, "barge_in_listen");
    this.beginListenTimers("barge_in");
  }

  private beginListenTimers(reason: string): void {
    this.clearTimers();
    const generation = this.generation;
    this.noSpeechTimer = setTimeout(() => {
      if (this.closedFlag || this.generation !== generation) return;
      if (this.machine.state === VoiceState.LISTENING) {
        this.clearTimers();
        this.machine.transition(VoiceState.IDLE, "no_speech_timeout");
        this.emitError(VoiceErrorCode.VOICE_TIMEOUT, "No speech detected", "vad");
      }
    }, this.settings.noSpeechTimeoutMs);
    void reason;
  }

  private recordUtteranceMs(result: VadResult): void {
    void result;
    if (this.utteranceAudioMs > 0) {
      this.metrics.timer("vad.utterance_ms", this.utteranceAudioMs, {});
    }
  }

  /** Begin CAPTURING: create the frame stream and start local STT. */
  private beginUtterance(): void {
    if (this.machine.state !== VoiceState.LISTENING) return;
    this.clearTimers();
    this.machine.transition(VoiceState.CAPTURING, "speech_started");
    const generation = ++this.generation;
    const utteranceId = `utt-${randomUUID()}`;
    this.activeUtteranceId = utteranceId;
    this.toolHeld = false;
    this.bargeInRun = 0;
    this.utteranceAudioMs = 0;
    this.utteranceStartTs = undefined;
    const stream = new FrameStream();
    this.frameStream = stream;
    const sttOptions = {
      utteranceId,
      language: this.settings.sttLanguage === "auto" ? undefined : this.settings.sttLanguage,
      maxTranscriptChars: this.settings.maxTranscriptChars,
    };
    this.sttOptions = sttOptions;
    // Max-utterance hard bound (spec section 11).
    this.maxUtteranceTimer = setTimeout(() => {
      if (this.closedFlag || this.generation !== generation) return;
      if (this.machine.state === VoiceState.CAPTURING) {
        this.finalizeUtterance("max_utterance");
      }
    }, this.settings.maxUtteranceMs);
    void this.transcribe(generation, utteranceId, stream, sttOptions);
  }

  private finalizeUtterance(reason: string): void {
    if (this.machine.state !== VoiceState.CAPTURING) return;
    this.clearTimers();
    this.pttActive = false;
    // Privacy invariant: any pre-roll frames not yet drained are dropped.
    this.preRoll.clear();
    this.machine.transition(VoiceState.TRANSCRIBING_FINAL, reason);
    if (this.frameStream) {
      this.frameStream.end();
    }
    if (this.sttOptions) {
      this.sttOptions.audioDurationMs = this.utteranceAudioMs;
    }
  }


  // ---- STT + conversation turn -------------------------------------------

  private async transcribe(
    generation: number,
    utteranceId: string,
    stream: FrameStream,
    sttOptions: { utteranceId: string; language?: string; maxTranscriptChars: number; audioDurationMs?: number },
  ): Promise<void> {
    try {
      const events = this.stt.transcribeStream(stream, sttOptions);
      for await (const event of events) {
        // Stale-event guard (spec section 30): only the current generation
        // may mutate state or create turns.
        if (this.closedFlag || this.generation !== generation) return;
        if (event.type === "partial") {
          const safe = this.sanitizer.sanitizeText(normalizeTranscript(event.text));
          if (safe !== "") {
            this.emit({ type: "stt.partial", utterance_id: utteranceId, text: safe, ts: voiceEventTs(this.now()) });
          }
        } else if (event.type === "final") {
          const safe = this.sanitizer.sanitizeText(
            boundTranscript(normalizeTranscript(event.text), this.settings.maxTranscriptChars),
          );
          this.emit({
            type: "stt.final",
            utterance_id: utteranceId,
            text: safe,
            confidence: event.confidence,
            ts: voiceEventTs(this.now()),
          });
          await this.handleFinalTranscript(generation, utteranceId, safe, event.language);
          return;
        } else if (event.type === "error") {
          // STT failure: no fabricated transcript, no turn (spec section 33).
          this.emitError(event.code as VoiceErrorCode, "Speech recognition failed", "stt");
          this.returnToIdle("stt_failed");
          return;
        }
      }
    } catch (err) {
      if (this.closedFlag || this.generation !== generation) return;
      this.emitError(VoiceErrorCode.STT_FAILED, err instanceof Error ? err.message : "STT stream failed", "stt");
      this.returnToIdle("stt_failed");
    }
  }

  private async handleFinalTranscript(
    generation: number,
    utteranceId: string,
    text: string,
    _language?: string,
  ): Promise<void> {
    if (this.closedFlag || this.generation !== generation) return;
    if (!isUsableTranscript(text)) {
      // Empty/low-confidence/noise utterance: discard, ask for repetition.
      this.emitError(VoiceErrorCode.STT_EMPTY, "No usable speech recognized", "stt");
      this.returnToIdle("stt_empty");
      return;
    }
    if (this.machine.state !== VoiceState.TRANSCRIBING_FINAL) return;
    this.machine.transition(VoiceState.THINKING, "final_transcript");
    // The previous utterance's VAD episode is closed: reset so its residual
    // "still speaking" state cannot leak into this turn's barge-in monitor
    // and self-trigger a cancellation (BUG 4).
    this.vad.reset();
    this.bargeInRun = 0;

    const session = this.store.getSession(this.arthurSessionId);
    if (!session) {
      this.emitError(VoiceErrorCode.VOICE_STATE_INVALID, "Voice session is not bound to an ARTHUR session", "session");
      this.returnToIdle("session_missing");
      return;
    }
    const scope = new CancellationScope();
    this.activeScope = scope;
    // STT is a cancellable resource of this turn (spec section 29).
    scope.register({ id: "stt", cancel: () => this.stt.cancel(utteranceId) });
    this.chunker.reset();
    this.toolHeld = false;
    this.toolBufferedText = "";
    this.turnCompletedFlag = false;
    this.ttsFailureSpoken = false;
    // One speak pump per turn; stale pumps exit on the next generation.
    this.ensureSpeakPump(generation);

    const request = {
      session_id: session.id,
      mode: session.mode,
      message: text,
      client_request_id: `voice-${utteranceId}`,
      metadata: { client_type: "voice" as const },
    };
    try {
      for await (const event of this.conversation.streamTurn(request, scope.signal)) {
        if (this.closedFlag || this.generation !== generation) return;
        switch (event.type) {
          case "turn_started":
            this.activeTurnId = event.turn_id;
            break;
          case "text_delta":
            this.emit({
              type: "assistant.text.delta",
              turn_id: this.activeTurnId ?? "",
              text: event.text,
              ts: voiceEventTs(this.now()),
            });
            if (this.toolHeld) {
              this.toolBufferedText += event.text;
            } else {
              this.dispatchDeltas(event.text, generation);
            }
            break;
          case "tool_call":
            // Hold speech: never speak a fragment that could be invalidated
            // by a pending tool call or approval (spec section 16).
            this.toolHeld = true;
            break;
          case "approval_required":
            for (const approval of event.approvals) {
              this.pendingApprovals.set(approval.approval_id, {
                tool_name: approval.tool_name,
                session_id: session.id,
              });
            }
            this.emitApprovalRequired(event.approvals, session.id);
            break;
          case "turn_completed":
            await this.handleTurnCompleted(event, generation);
            return;
          case "turn_interrupted":
            this.toolHeld = false;
            this.toolBufferedText = "";
            this.chunker.reset();
            this.ttsQueue.clear();
            return;
          case "turn_failed":
            this.emitError(VoiceErrorCode.MODEL_FAILED, event.message, "conversation");
            this.returnToIdle("turn_failed");
            return;
          case "usage":
            break; // token metrics are recorded by the conversation service
        }
      }
    } catch (err) {
      if (this.closedFlag || this.generation !== generation) return;
      if (scope.cancelled) return;
      this.emitError(
        VoiceErrorCode.MODEL_FAILED,
        err instanceof Error ? err.message : "conversation failed",
        "conversation",
      );
      this.returnToIdle("conversation_failed");
    }
  }

  private async handleTurnCompleted(
    event: Extract<StreamingTurnEvent, { type: "turn_completed" }>,
    generation: number,
  ): Promise<void> {
    this.activeTurnId = event.turn_id;
    this.turnCompletedFlag = true;
    this.emit({
      type: "assistant.turn.completed",
      turn_id: event.turn_id,
      status: event.status,
      ts: voiceEventTs(this.now()),
    });
    if (event.status === "needs_approval") {
      // Approval-wait: speak the request; NO premature success speech. The
      // exact approval binding is resolved via conversation.approve() only.
      this.dispatchSpeakOnce(event.display_text, generation);
      return;
    }
    if (event.tool_calls.length > 0) {
      // Tool turn: speak only the final (post-tool) text, not fragments
      // that were held while tool/approval semantics were pending.
      this.toolHeld = false;
      this.toolBufferedText = "";
      this.dispatchSpeakOnce(event.display_text, generation);
      return;
    }
    // Pure text turn: streaming already spoke; flush any residue.
    this.toolHeld = false;
    const chunks = this.chunker.flush();
    for (const chunk of chunks) await this.enqueueSpeech(chunk, generation);
    if (!this.speakPending) {
      // Nothing was (or will be) spoken: complete immediately.
      this.finishSpeech();
    }
  }

  // ---- speech pipeline ----------------------------------------------------

  private dispatchDeltas(text: string, generation: number): void {
    const chunks = this.chunker.push(text);
    for (const chunk of chunks) {
      void this.enqueueSpeech(chunk, generation);
    }
  }

  /** Speak one final text (approval requests, tool-turn answers). */
  private dispatchSpeakOnce(text: string, generation: number): void {
    const formatted = this.formatter.format(this.sanitizer.sanitizeText(text));
    if (formatted === "") {
      if (!this.speakPending) this.finishSpeech();
      return;
    }
    const chunk: SpeakableChunk = { sequence: 0, text: formatted, final: true };
    void this.enqueueSpeech(chunk, generation);
  }

  /**
   * Enqueue a speakable chunk with TTS backpressure (spec section 16): the
   * producer awaits when the bounded queue is full, so unbounded TTS queue
   * growth is impossible.
   */
  private async enqueueSpeech(chunk: SpeakableChunk, generation: number): Promise<void> {
    if (this.closedFlag || generation !== this.generation) return;
    if (chunk.text === "") return;
    if (this.machine.state !== VoiceState.SPEAKING) {
      this.machine.transition(VoiceState.SPEAKING, "first_speakable_chunk");
      this.speakingTurnId = this.activeTurnId;
      // Fresh barge-in window for the new playback phase (BUG 4): residual
      // runs from the generation phase must not carry over.
      this.bargeInRun = 0;
      // Echo protection (spec section 18): the wake word is muted while
      // ARTHUR speaks so its own voice can never re-trigger listening.
      this.wake.setPaused(true);
      this.emit({
        type: "assistant.speech.started",
        turn_id: this.activeTurnId ?? "",
        ts: voiceEventTs(this.now()),
      });
    }
    this.speakPending = true;
    await this.ttsQueue.put(chunk);
  }

  /**
   * Start (or restart) the single TTS pump. A running pump for an older
   * generation is poked so it exits; exactly one pump consumes the queue.
   */
  private ensureSpeakPump(generation: number): void {
    const epoch = ++this.pumpEpoch;
    this.speakPumpGeneration = generation;
    if (this.speakPumpRunning) this.ttsQueue.poke();
    this.speakPumpRunning = true;
    this.speakPumpPromise = this.runSpeakPump(generation, epoch).finally(() => {
      if (this.pumpEpoch === epoch) {
        this.speakPumpRunning = false;
        this.speakPumpGeneration = 0;
      }
    });
  }

  private async runSpeakPump(generation: number, epoch: number): Promise<void> {
    let ttsFailureAnnounced = false;
    for (;;) {
      if (this.closedFlag || epoch !== this.pumpEpoch || generation !== this.generation) return;
      const chunk = await this.ttsQueue.take();
      if (chunk === undefined) return; // queue cleared/closed
      if (this.closedFlag || epoch !== this.pumpEpoch || generation !== this.generation) return;
      if (chunk.text === "") continue;
      if (!this.tts.available) {
        if (!ttsFailureAnnounced && !this.ttsFailureSpoken) {
          ttsFailureAnnounced = true;
          this.ttsFailureSpoken = true;
          // Display text remains available; TTS failure must not fail the
          // completed model turn (spec section 33).
          this.emitError(VoiceErrorCode.TTS_FAILED, "TTS unavailable; response text is available", "tts");
        }
        continue;
      }
      const synthesisId = `synth-${this.voiceSessionId}-${generation}-${chunk.sequence}`;
      this.currentSynthesisId = synthesisId;
      const request = {
        synthesisId,
        text: chunk.text,
        voice: this.settings.ttsVoice,
        sampleRateHz: this.settings.sampleRateHz,
      };
      try {
        await this.playback.play(this.tts.synthesizeStream(request));
      } catch (err) {
        if (this.closedFlag || generation !== this.generation) return;
        this.emitError(VoiceErrorCode.TTS_FAILED, err instanceof Error ? err.message : "playback failed", "playback");
      } finally {
        this.currentSynthesisId = undefined;
      }
      if (this.closedFlag || generation !== this.generation) return;
      if (this.turnCompletedFlag && this.ttsQueue.length === 0) {
        this.finishSpeech();
      }
    }
  }

  private finishSpeech(): void {
    if (this.speakingTurnId) {
      this.emit({
        type: "assistant.speech.ended",
        turn_id: this.speakingTurnId,
        ts: voiceEventTs(this.now()),
      });
    }
    this.speakingTurnId = undefined;
    this.turnCompletedFlag = false;
    this.speakPending = false;
    if (this.machine.state === VoiceState.SPEAKING) {
      this.machine.transition(VoiceState.IDLE, "response_complete");
      this.wake.setPaused(false);
    }
  }

  /** Speak a short proactive confirmation (mode switch, approval outcome). */
  private async speakText(text: string): Promise<void> {
    if (this.closedFlag) return;
    if (!this.tts.available) {
      this.emitError(VoiceErrorCode.TTS_FAILED, "TTS unavailable", "tts");
      return;
    }
    const formatted = this.formatter.format(this.sanitizer.sanitizeText(text));
    if (formatted === "") return;
    const generation = this.generation;
    const chunk: SpeakableChunk = { sequence: 0, text: formatted, final: true };
    if (this.machine.state !== VoiceState.SPEAKING) {
      this.machine.transition(VoiceState.SPEAKING, "proactive_speech");
      this.speakingTurnId = this.activeTurnId;
      this.wake.setPaused(true);
      this.emit({ type: "assistant.speech.started", turn_id: this.activeTurnId ?? "", ts: voiceEventTs(this.now()) });
    }
    this.speakPending = true;
    await this.ttsQueue.put(chunk);
    this.ensureSpeakPump(generation);
  }

  // ---- approval by voice (spec sections 19, 20) ---------------------------

  /**
   * Explicit approval answer from a client command.
   */
  async answerApproval(approve: boolean): Promise<void> {
    if (!approve) {
      // Reject the single unambiguous pending approval, if any.
      const pending = this.unambiguousPendingApprovals();
      if (pending.length === 1) {
        const approval = pending[0];
        if (approval) {
          try {
            const outcome = await this.conversation.reject(approval.id);
            this.emitApprovalOutcome(outcome);
          } catch (err) {
            this.emitError(VoiceErrorCode.VOICE_STATE_INVALID, err instanceof Error ? err.message : "reject failed", "approval");
          }
        }
      }
      return;
    }
    const pending = this.unambiguousPendingApprovals();
    if (pending.length === 1 && pending[0]) {
      await this.resolveApproval(pending[0].id);
    } else if (pending.length > 1) {
      this.emitAmbiguous(pending.length);
    }
  }

  /**
   * Approval intent from a spoken transcript (STT final). Fail closed: a
   * generic "yes" executes only when there is exactly one unambiguous
   * pending approval in the active trusted session (spec section 20).
   */
  async handleApprovalIntent(text: string): Promise<ApprovalIntentResult> {
    const normalized = normalizeTranscript(text);
    const withId = APPROVAL_WITH_ID.exec(normalized);
    if (withId) {
      const approvalId = withId[2];
      if (approvalId && this.pendingApprovals.has(approvalId)) {
        await this.resolveApproval(approvalId);
        return { handled: true, approvalId };
      }
      return { handled: false };
    }
    if (!APPROVAL_INTENT.test(normalized)) return { handled: false };
    const pending = this.unambiguousPendingApprovals();
    if (pending.length === 0) return { handled: false };
    if (pending.length === 1 && pending[0]) {
      await this.resolveApproval(pending[0].id);
      return { handled: true, approvalId: pending[0].id };
    }
    // Multiple pending approvals: never guess - ask which one (spec 20).
    this.emitAmbiguous(pending.length);
    return { handled: true };
  }

  /** Pending approvals for the active session, unexpired, from the store. */
  private unambiguousPendingApprovals(): Array<{ id: string; tool_name: string }> {
    if (!this.arthurSessionId) return [];
    const nowMs = this.now();
    return this.store
      .listPendingApprovals(this.arthurSessionId)
      .filter((a) => a.status === "pending" && new Date(a.expires_at).getTime() > nowMs)
      .map((a) => ({ id: a.id, tool_name: a.tool_name }));
  }

  /**
   * Resolve exactly one approval through the Phase 1 ApprovalService path.
   * Expired/mismatched approvals throw APPROVAL_INVALID and execute nothing.
   */
  private async resolveApproval(approvalId: string): Promise<void> {
    try {
      const outcome = await this.conversation.approve(approvalId);
      this.emitApprovalOutcome(outcome);
      if (outcome.status === "approved") {
        const summary = (outcome.result_summary ?? "").slice(0, 300);
        await this.speakText(summary !== "" ? `Done. ${summary}` : "Approved.");
      } else {
        await this.speakText("Not approved.");
      }
    } catch (err) {
      // Fail closed: nothing executes on ambiguity/expiry/mismatch.
      this.emitError(
        VoiceErrorCode.VOICE_STATE_INVALID,
        err instanceof Error ? err.message : "approval failed",
        "approval",
      );
    } finally {
      this.pendingApprovals.delete(approvalId);
    }
  }

  private emitApprovalRequired(
    approvals: Array<{ approval_id: string; tool_name: string }>,
    sessionId: string,
  ): void {
    const pendingCount = this.unambiguousPendingApprovals().length;
    for (const approval of approvals) {
      this.emit({
        type: "approval.required",
        approval_id: approval.approval_id,
        tool_name: approval.tool_name,
        session_id: sessionId,
        pending_count: pendingCount,
        ts: voiceEventTs(this.now()),
      });
    }
  }

  private emitAmbiguous(count: number): void {
    this.emit({
      type: "approval.ambiguous",
      session_id: this.arthurSessionId,
      pending_count: count,
      ts: voiceEventTs(this.now()),
    });
    void this.speakText(`There are ${count} pending approvals. Please name the one you want to approve.`);
  }

  private emitApprovalOutcome(
    outcome: { approval_id: string; tool_name: string; status: string; result_summary?: string },
  ): void {
    this.emit({
      type: "approval.outcome",
      approval_id: outcome.approval_id,
      status: outcome.status,
      result_summary: outcome.result_summary ? this.sanitizer.capSummary(outcome.result_summary) : undefined,
      ts: voiceEventTs(this.now()),
    });
  }

  // ---- cancellation / cleanup ---------------------------------------------

  /**
   * Cancel every resource of the active turn: CancellationScope (DeepSeek
   * stream), STT, TTS synthesis, audio playback, chunker, and the bounded
   * TTS queue. Idempotent; late events are dropped by generation guards.
   */
  private async cancelActive(reason: string): Promise<void> {
    const scope = this.activeScope;
    this.activeScope = undefined;
    if (scope) await scope.cancel(reason);
    await this.playback.stop().catch(() => undefined);
    if (this.currentSynthesisId) {
      await this.tts.cancel(this.currentSynthesisId).catch(() => undefined);
    }
    this.frameStream?.end();
    this.frameStream = undefined;
    this.sttOptions = undefined;
    this.chunker.reset();
    this.ttsQueue.clear();
    this.toolHeld = false;
    this.toolBufferedText = "";
    this.turnCompletedFlag = false;
    this.speakPending = false;
    this.activeUtteranceId = undefined;
    // PTT ownership dies with the turn; no pre-roll may survive it (privacy).
    this.pttActive = false;
    this.preRoll.clear();
    this.wake.setPaused(false);
    if (reason !== "disable") {
      this.metrics.counter("voice.cancel_reason", 1, { reason });
    }
    this.logger.info("voice turn cancelled", { reason });
  }

  private returnToIdle(reason: string): void {
    if (this.machine.state === VoiceState.DISABLED) return;
    if (ACTIVE_VOICE_STATES.includes(this.machine.state)) {
      this.machine.transition(VoiceState.IDLE, reason);
    }
  }

  private clearTimers(): void {
    if (this.noSpeechTimer) {
      clearTimeout(this.noSpeechTimer);
      this.noSpeechTimer = undefined;
    }
    if (this.maxUtteranceTimer) {
      clearTimeout(this.maxUtteranceTimer);
      this.maxUtteranceTimer = undefined;
    }
  }

  /**
   * Safe component health for /v1/voice/status (spec sections 24, 35).
   * Never includes secrets, raw audio info, paths, or OS internals.
   */
  status(): {
    enabled: boolean;
    state: VoiceState;
    wake: { id: string; available: boolean; detail?: string };
    vad: { id: string; available: boolean; detail?: string };
    stt: { id: string; available: boolean; detail?: string };
    tts: { id: string; available: boolean; detail?: string };
    audio_input: { id: string; available: boolean; detail?: string };
    audio_output: { id: string; available: boolean; detail?: string };
    wake_word: string;
    stt_language: string;
    tts_voice: string;
    raw_audio_retention: boolean;
    session?: { voice_session_id: string; arthur_session_id: string; mode?: string };
  } {
    const mode = this.arthurSessionId ? this.store.getSession(this.arthurSessionId)?.mode : undefined;
    return {
      enabled: this.machine.state !== VoiceState.DISABLED,
      state: this.machine.state,
      wake: { id: this.wake.id, available: this.wake.available, detail: this.wake.available ? undefined : "wake unavailable; PTT fallback" },
      vad: { id: this.vad.id(), available: true },
      stt: { id: this.stt.id(), available: this.stt.available, detail: this.stt.available ? undefined : "no local STT engine configured" },
      tts: { id: this.tts.id(), available: this.tts.available, detail: this.tts.available ? undefined : "no local TTS engine configured" },
      audio_input: { id: this.capture.id(), available: this.capture.available, detail: this.capture.available ? undefined : "no microphone" },
      audio_output: { id: this.playback.id(), available: this.playback.available, detail: this.playback.available ? undefined : "no speaker" },
      wake_word: this.settings.wakeWord,
      stt_language: this.settings.sttLanguage,
      tts_voice: this.settings.ttsVoice,
      raw_audio_retention: this.settings.rawAudioRetention,
      session: this.arthurSessionId
        ? { voice_session_id: this.voiceSessionId, arthur_session_id: this.arthurSessionId, mode }
        : undefined,
    };
  }

  /** Release all voice resources (mic, wake, playback, engines). */
  async close(): Promise<void> {
    if (this.closedFlag) return;
    this.closedFlag = true;
    await this.disable();
    this.logger.info("voice controller closed");
  }

  // ---- emit helpers ---------------------------------------------------------

  private emit(event: VoiceClientEvent): void {
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // Subscribers must never break the voice loop.
      }
    }
  }

  private emitError(code: VoiceErrorCode, message: string, component?: string): void {
    this.metrics.counter("voice.error", 1, { code });
    this.emit({
      type: "voice.error",
      code,
      message: this.sanitizer.sanitizeText(message),
      component,
      ts: voiceEventTs(this.now()),
    });
    this.logger.warn("voice error", { code, component, message: this.sanitizer.sanitizeText(message) });
  }

  private emitSession(): void {
    this.emit({ type: "voice.session", session: this.voiceSession(), ts: voiceEventTs(this.now()) });
  }
}