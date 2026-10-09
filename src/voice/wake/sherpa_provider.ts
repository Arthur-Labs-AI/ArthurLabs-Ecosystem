/**
 * True Wake Word v1 provider (TASK-0009): streaming keyword spotting with
 * sherpa-onnx.
 *
 * The provider implements the existing WakeWordProvider contract and accepts
 * the same PCM frames the controller already routes through WakeWordGateway
 * (no second microphone pipeline, no audio persistence, no network). It runs
 * the sherpa-onnx streaming KeywordSpotter in-process against the small
 * English GigaSpeech zipformer KWS model (INT8 files preferred when present)
 * and wakes ONLY on the configured literal keyword (default "arthur").
 *
 * Failure semantics (fail closed):
 *  - unavailable model files or a missing package => available === false, so
 *    the controller keeps voice enabled with PTT fallback and never wakes;
 *  - native initialization failures reject start() => enable() fails closed
 *    with a path-free error message (text/PTT unaffected);
 *  - runtime KWS errors mark the provider failed and stop processing instead
 *    of ever fabricating a wake event.
 *
 * Memory discipline: samples are converted into a short-lived Float32Array
 * per frame (bounded by the frame size) and at most one carried byte across
 * frame boundaries. No raw audio is retained, logged, or persisted.
 */

import { existsSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { PcmFrame, WakeEvent, WakeWordConfig, WakeWordProvider } from "../contracts";

/** Minimal structural logger for lifecycle events (app Logger satisfies this). */
export interface WakeLogSink {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Provider id surfaced by /v1/voice/status (never paths or file names). */
export const SHERPA_WAKE_PROVIDER_ID = "sherpa-kws-wake";

/** Sentencepiece "space" marker used by BPE tokens (U+2581). */
const SENTENCEPIECE_SPACE = /\u2581/g;

/**
 * Hard per-frame decode budget. A 20 ms frame (~320 samples) only ever
 * produces a couple of decode cycles; exceeding this means the engine is
 * misbehaving, so the provider fails closed instead of spinning.
 */
export const MAX_DECODES_PER_FRAME = 64;

/**
 * Normalize a keyword/result string for EXACT comparison only: lowercase,
 * drop the sentencepiece space marker and all whitespace. Partial or
 * substring matches never compare equal.
 */
export function normalizeKeywordText(text: string): string {
  return text.toLowerCase().replace(SENTENCEPIECE_SPACE, "").replace(/\s+/g, "");
}

// ---------------------------------------------------------------------------
// Injectable KWS adapter (mirrors the sherpa-onnx-node KeywordSpotter API)
// ---------------------------------------------------------------------------

/** Result of one decode cycle (KeywordResult in sherpa-onnx). */
export interface SherpaKwsResult {
  keyword?: string;
  tokens?: string[];
}

/** One live KWS stream fed with normalized float32 samples in [-1, 1]. */
export interface SherpaKwsStream {
  acceptWaveform(samples: Float32Array, sampleRateHz: number): void;
}

/**
 * Engine facade over a keyword spotter. Shape follows sherpa-onnx-node:
 * isReady/decode/getResult/reset live on the spotter, acceptWaveform on the
 * stream. releaseStream/release are explicit lifecycle hooks; the native
 * adapter no-ops them (the addon releases native handles via GC), while test
 * fakes use them to assert resource discipline.
 */
export interface SherpaKwsEngine {
  createStream(): SherpaKwsStream;
  isReady(stream: SherpaKwsStream): boolean;
  decode(stream: SherpaKwsStream): void;
  getResult(stream: SherpaKwsStream): SherpaKwsResult;
  reset(stream: SherpaKwsStream): void;
  releaseStream(stream: SherpaKwsStream): void;
  release(): void;
}

export interface SherpaKwsEngineConfig {
  encoderPath: string;
  decoderPath: string;
  joinerPath: string;
  tokensPath: string;
  keywordsFile: string;
  keywordsScore: number;
  keywordsThreshold: number;
  numThreads: number;
  sampleRateHz: number;
  featureDim: number;
}

export type SherpaKwsEngineFactory = (config: SherpaKwsEngineConfig) => SherpaKwsEngine;

interface NativeKwsSpotter {
  createStream(): unknown;
  isReady(stream: unknown): boolean;
  decode(stream: unknown): void;
  getResult(stream: unknown): SherpaKwsResult;
  reset(stream: unknown): void;
}

/**
 * Default factory: the real sherpa-onnx-node KeywordSpotter. Import and
 * construction errors are reduced to path-free classification messages so
 * engine output can never leak machine paths into events/logs.
 */
export function createNativeSherpaKwsEngineFactory(): SherpaKwsEngineFactory {
  return (config: SherpaKwsEngineConfig): SherpaKwsEngine => {
    let KeywordSpotter: new (cfg: unknown) => NativeKwsSpotter;
    try {
      // Lazy require: the package is only touched when a sherpa wake provider
      // actually starts (PTT/text modes never load the native addon).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      KeywordSpotter = require("sherpa-onnx-node").KeywordSpotter;
    } catch {
      throw new Error(
        "sherpa-onnx-node is unavailable (wake stays unavailable; push-to-talk is unaffected)",
      );
    }
    let spotter: NativeKwsSpotter;
    try {
      spotter = new KeywordSpotter({
        featConfig: { sampleRate: config.sampleRateHz, featureDim: config.featureDim },
        modelConfig: {
          transducer: {
            encoder: config.encoderPath,
            decoder: config.decoderPath,
            joiner: config.joinerPath,
          },
          tokens: config.tokensPath,
          numThreads: config.numThreads,
          debug: 0,
          provider: "cpu",
        },
        maxActivePaths: 4,
        numTrailingBlanks: 1,
        keywordsScore: config.keywordsScore,
        keywordsThreshold: config.keywordsThreshold,
        keywordsFile: config.keywordsFile,
      });
    } catch (err) {
      const kind = err instanceof Error ? err.name : "unknown";
      throw new Error(`sherpa KWS initialization failed (${kind}); check the wake model files and generated keywords file`);
    }
    const nativeStreams = new WeakMap<SherpaKwsStream, {
      acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
    }>();
    return {
      createStream: () => {
        const native = spotter.createStream() as {
          acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
        };
        const wrapped: SherpaKwsStream = {
          acceptWaveform: (samples, sampleRateHz) => native.acceptWaveform({ samples, sampleRate: sampleRateHz }),
        };
        // The addon methods take the NATIVE stream object (it reads
        // stream.handle); keep the mapping so the adapter surface stays
        // engine-agnostic while every isReady/decode/getResult/reset call
        // receives the real pointer. WeakMap => no leak when dropped.
        nativeStreams.set(wrapped, native);
        return wrapped;
      },
      isReady: (stream) => spotter.isReady(nativeStreamOf(stream)),
      decode: (stream) => spotter.decode(nativeStreamOf(stream)),
      getResult: (stream) => spotter.getResult(nativeStreamOf(stream)),
      reset: (stream) => spotter.reset(nativeStreamOf(stream)),
      releaseStream: (stream) => {
        nativeStreams.delete(stream);
      },
      // The sherpa-onnx-node API has no explicit dispose; native handles are
      // freed by GC once unreferenced. Dropping our references in stop() is
      // therefore the release mechanism, and this hook stays a no-op.
      release: () => undefined,
    };
    function nativeStreamOf(stream: SherpaKwsStream) {
      const native = nativeStreams.get(stream);
      if (!native) throw new Error("unknown KWS stream (not created by this engine)");
      return native;
    }
  };
}

// ---------------------------------------------------------------------------
// Model file resolution (deterministic, INT8 preferred)
// ---------------------------------------------------------------------------

export interface SherpaModelFiles {
  encoderPath: string;
  decoderPath: string;
  joinerPath: string;
  tokensPath: string;
  keywordsFile: string;
  usedInt8: boolean;
}

/**
 * Resolve the transducer model files inside one model directory. The official
 * kws-zipformer-gigaspeech package guarantees deterministic file names
 * (encoder/decoder/joiner epoch-12-avg-2-chunk-16-left-64[.int8].onnx plus
 * tokens.txt); selection is therefore deterministic per directory: prefer
 * the INT8 quantization, then the lexicographically first candidate.
 *
 * @returns null when the directory or a required file is missing/unusable.
 */
export function resolveSherpaModelFiles(modelDir: string, keywordsFile: string): SherpaModelFiles | null {
  const dir = modelDir.trim() === "" ? null : resolve(modelDir);
  if (!dir || !existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const pick = (prefix: string): { path: string; int8: boolean } | null => {
    const candidates = entries
      .filter((name) => name.toLowerCase().startsWith(prefix) && extname(name).toLowerCase() === ".onnx")
      .sort((a, b) => Number(b.includes(".int8.")) - Number(a.includes(".int8.")) || a.localeCompare(b));
    const best = candidates[0];
    return best ? { path: join(dir, best), int8: best.includes(".int8.") } : null;
  };
  const encoder = pick("encoder");
  const decoder = pick("decoder");
  const joiner = pick("joiner");
  const tokensPath = join(dir, "tokens.txt");
  const keywords = keywordsFile.trim() === "" ? join(dir, "keywords_arthur.txt") : resolve(keywordsFile);
  if (!encoder || !decoder || !joiner) return null;
  if (!existsSync(tokensPath) || !existsSync(keywords)) return null;
  return {
    encoderPath: encoder.path,
    decoderPath: decoder.path,
    joinerPath: joiner.path,
    tokensPath,
    keywordsFile: keywords,
    usedInt8: encoder.int8 || decoder.int8 || joiner.int8,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface SherpaWakeProviderOptions {
  /** Machine-local sherpa KWS model directory (models/ is git-ignored). */
  modelDir: string;
  /** Generated keywords file; empty = <modelDir>/keywords_arthur.txt. */
  keywordsFile?: string;
  keywordsScore: number;
  keywordsThreshold: number;
  numThreads: number;
  /** Injectable engine factory (deterministic tests); default = native. */
  engineFactory?: SherpaKwsEngineFactory;
  /** Secret-safe logger (paths, audio and binary data are never logged). */
  logger?: WakeLogSink;
}

export interface SherpaWakeStats {
  active: boolean;
  failed: boolean;
  framesProcessed: number;
  detectionCount: number;
  carriedBytes: number;
}

export class SherpaWakeWordProvider implements WakeWordProvider {
  private handler: ((event: WakeEvent) => void) | undefined;
  private engine: SherpaKwsEngine | undefined;
  private stream: SherpaKwsStream | undefined;
  private activeFlag = false;
  private failedFlag = false;
  private expectedKeyword = "";
  private carryByte: number | null = null;
  private framesProcessed = 0;
  private detectionCount = 0;
  private readonly opts: Required<Pick<SherpaWakeProviderOptions, "modelDir" | "keywordsFile" | "keywordsScore" | "keywordsThreshold" | "numThreads">> &
    SherpaWakeProviderOptions;

  constructor(opts: SherpaWakeProviderOptions) {
    this.opts = {
      modelDir: opts.modelDir,
      keywordsFile: opts.keywordsFile ?? "",
      keywordsScore: opts.keywordsScore,
      keywordsThreshold: opts.keywordsThreshold,
      numThreads: opts.numThreads,
      engineFactory: opts.engineFactory,
      logger: opts.logger,
    };
  }

  id(): string {
    return SHERPA_WAKE_PROVIDER_ID;
  }

  /**
   * True when the configured model files exist (and, without an injected
   * factory, the sherpa-onnx-node package resolves). Checked fresh each
   * time so downloading the model does not require rebuilding the app.
   */
  get available(): boolean {
    if (!resolveSherpaModelFiles(this.opts.modelDir, this.opts.keywordsFile)) return false;
    if (this.opts.engineFactory) return true;
    try {
      require.resolve("sherpa-onnx-node");
    } catch {
      return false;
    }
    return true;
  }

  async start(config: WakeWordConfig, onWake: (event: WakeEvent) => void): Promise<void> {
    // Clean restart semantics: a second start never stacks handlers or
    // streams (repeated enable/disable stays leak-free).
    if (this.activeFlag || this.engine || this.stream) await this.stop();
    const files = resolveSherpaModelFiles(this.opts.modelDir, this.opts.keywordsFile);
    if (!files) {
      // Classification only - never paths.
      throw new Error(
        "sherpa wake model files are missing or incomplete (run tools/voice/setup_sherpa_wake.ps1 and check ARTHUR_WAKE_MODEL_DIR/ARTHUR_WAKE_KEYWORDS_FILE)",
      );
    }
    const factory = this.opts.engineFactory ?? createNativeSherpaKwsEngineFactory();
    let engine: SherpaKwsEngine;
    let stream: SherpaKwsStream;
    try {
      engine = factory({
        encoderPath: files.encoderPath,
        decoderPath: files.decoderPath,
        joinerPath: files.joinerPath,
        tokensPath: files.tokensPath,
        keywordsFile: files.keywordsFile,
        keywordsScore: this.opts.keywordsScore,
        keywordsThreshold: this.opts.keywordsThreshold,
        numThreads: this.opts.numThreads,
        sampleRateHz: config.sampleRateHz,
        featureDim: 80,
      });
      stream = engine.createStream();
    } catch (err) {
      this.opts.logger?.error("sherpa wake init failed", {
        provider: SHERPA_WAKE_PROVIDER_ID,
        classification: "kws-init-failed",
        reason: err instanceof Error ? err.message : "unknown",
      });
      throw err;
    }
    this.engine = engine;
    this.stream = stream;
    this.handler = onWake;
    this.expectedKeyword = normalizeKeywordText(config.wakeWord);
    this.activeFlag = true;
    this.failedFlag = false;
    this.carryByte = null;
    this.framesProcessed = 0;
    this.detectionCount = 0;
    this.opts.logger?.info("sherpa wake started", {
      provider: SHERPA_WAKE_PROVIDER_ID,
      threads: this.opts.numThreads,
      quantization: files.usedInt8 ? "int8" : "fp32",
      threshold: this.opts.keywordsThreshold,
    });
  }

  async stop(): Promise<void> {
    const wasLive = this.activeFlag || this.engine !== undefined || this.stream !== undefined;
    this.activeFlag = false;
    this.handler = undefined;
    this.expectedKeyword = "";
    this.carryByte = null;
    const engine = this.engine;
    const stream = this.stream;
    this.engine = undefined;
    this.stream = undefined;
    if (engine) {
      try {
        if (stream) engine.releaseStream(stream);
        engine.release();
      } catch {
        // Releasing must never throw past stop().
      }
    }
    if (wasLive) {
      this.opts.logger?.info("sherpa wake stopped", { provider: SHERPA_WAKE_PROVIDER_ID });
    }
  }

  /**
   * Feed one microphone frame into the streaming KWS. Never throws, never
   * emits anything but the configured keyword, and never retains audio.
   */
  processFrame(frame: PcmFrame): void {
    if (!this.activeFlag || this.failedFlag || !this.engine || !this.stream) return;
    try {
      this.acceptPcm(frame);
      // Decode everything the engine has buffered (bounded by one frame of
      // audio per call; ~320 samples never queues more than a few decodes).
      let decodes = 0;
      while (this.engine.isReady(this.stream)) {
        if (decodes >= MAX_DECODES_PER_FRAME) {
          this.failClosed("kws-decode-loop-guard", new Error("per-frame decode budget exceeded"));
          return;
        }
        decodes += 1;
        this.engine.decode(this.stream);
        const result = this.engine.getResult(this.stream);
        if (this.isConfiguredKeyword(result)) {
          // Exactly one event per detection; the stream reset demanded by
          // the KWS API also clears state so the same audio cannot re-fire.
          this.detectionCount += 1;
          this.handler?.({ kind: "wake_detected", detected_at_ms: frame.timestamp_ms, provider: SHERPA_WAKE_PROVIDER_ID });
          this.engine.reset(this.stream);
          break;
        }
      }
      this.framesProcessed += 1;
    } catch (err) {
      this.failClosed("kws-frame-failed", err);
    }
  }

  /** Small operational snapshot for tests/telemetry (never audio or paths). */
  stats(): SherpaWakeStats {
    return {
      active: this.activeFlag,
      failed: this.failedFlag,
      framesProcessed: this.framesProcessed,
      detectionCount: this.detectionCount,
      carriedBytes: this.carryByte === null ? 0 : 1,
    };
  }

  // ---- internals -----------------------------------------------------------

  /** s16le bytes -> float32 in [-1, 1]; one odd trailing byte is carried. */
  private acceptPcm(frame: PcmFrame): void {
    const stream = this.stream;
    if (!stream) return;
    const data = frame.data;
    let low: number | null = this.carryByte;
    const samples = new Float32Array(Math.floor((data.byteLength + (low !== null ? 1 : 0)) / 2));
    let si = 0;
    for (let i = 0; i < data.byteLength; i++) {
      const byte = data[i] as number;
      if (low === null) {
        low = byte; // low byte of a little-endian s16 sample
        continue;
      }
      let value = ((byte << 8) | low) as number;
      if (value >= 0x8000) value -= 0x10000;
      samples[si] = value / 32768;
      si += 1;
      low = null;
    }
    this.carryByte = low;
    if (si > 0) {
      stream.acceptWaveform(samples, frame.sample_rate_hz);
    }
  }

  /**
   * EXACT match only: the normalized result keyword (or its full token
   * sequence) must equal the normalized configured wake word. Empty,
   * partial, or unrelated results never wake.
   */
  private isConfiguredKeyword(result: SherpaKwsResult | undefined): boolean {
    if (!result || this.expectedKeyword === "") return false;
    if (typeof result.keyword === "string" && normalizeKeywordText(result.keyword) === this.expectedKeyword) {
      return true;
    }
    if (
      Array.isArray(result.tokens) &&
      result.tokens.length > 0 &&
      normalizeKeywordText(result.tokens.join(" ")) === this.expectedKeyword
    ) {
      return true;
    }
    return false;
  }

  /**
   * Runtime KWS failure: log a classification once, stop processing, emit
   * nothing. Push-to-talk and the text path are untouched.
   */
  private failClosed(classification: string, err: unknown): void {
    if (this.failedFlag) return;
    this.failedFlag = true;
    this.opts.logger?.error("sherpa wake failed closed", {
      provider: SHERPA_WAKE_PROVIDER_ID,
      classification,
      reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    });
  }
}
