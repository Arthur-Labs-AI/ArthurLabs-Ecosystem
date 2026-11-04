/**
 * HR-02 OpenAI cloud STT provider ("openai-stt", runtime_mode = cloud).
 *
 * Voice provider ONLY: audio in, transcript out. It never receives ARTHUR
 * tools, approvals, memory, or conversation ownership — the committed final
 * transcript flows VoiceController -> ConversationLoopRunner -> the
 * configured ModelProvider (DeepSeek today).
 *
 * Transport (default): OpenAI audio transcription REST endpoint
 * (multipart/form-data, structured fields, JSON response parsed strictly).
 * Optional realtime session: when a header-capable WebSocket factory is
 * injected, PCM is streamed over the realtime transcription session and
 * delta events surface as partial SttEvents (observability only — never
 * authoritative; only the completed final enters the conversation loop).
 *
 * TASK-0024 wire-body invariant: structured payload -> JSON.stringify ->
 * exact bytes sent. No regex redaction over serialized bodies; redaction
 * belongs to logs/diagnostics only (this file never logs the key).
 */

import type { PcmFrame, SttEvent, SttOptions, SttProvider } from "../contracts";
import { VoiceProviderError, type VoiceFailureCategory } from "../../runtime/voice_errors";

export const OPENAI_STT_PROVIDER_ID = "openai-stt";

/** Bounded complete-utterance audio retention (120 s @16 kHz mono s16le). */
export const OPENAI_STT_MAX_AUDIO_BYTES = 120 * 16000 * 2;
/** Bounded request/session duration (60 s). */
export const OPENAI_STT_TIMEOUT_MS = 60_000;
/** PCM chunk size for realtime streaming (100 ms @16 kHz mono s16le). */
const REALTIME_CHUNK_BYTES = 16000 * 2;

/** Minimal header-capable WebSocket seam (injectable for tests). */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
}

export interface OpenAiSttOptions {
  apiKey: string;
  model: string;
  /** Transcription REST endpoint (default OpenAI). */
  baseUrl?: string;
  /** Realtime WebSocket endpoint base (default OpenAI realtime). */
  realtimeUrl?: string;
  /** Domain vocabulary hint (ARTHUR/Nexus/...); sent as prompt data only. */
  initialPrompt?: string;
  requestTimeoutMs?: number;
  maxAudioBytes?: number;
  fetchFn?: typeof fetch;
  /** Optional header-capable realtime socket factory (partials path). */
  socketFactory?: (url: string, model: string, apiKey: string) => RealtimeSocket;
  logger?: { warn(message: string, fields?: Record<string, unknown>): void; error(message: string, fields?: Record<string, unknown>): void };
}

function toFailure(status: number, code: string): VoiceFailureCategory {
  if (status === 401 || status === 403) return "provider_auth_failure";
  if (status === 408 || status === 429 || status >= 500) return "provider_timeout";
  void code;
  return "provider_request_failure";
}

/**
 * Models verified on POST /v1/audio/transcriptions (this provider's REST path).
 * A model ID existing in the catalog does NOT imply endpoint support:
 * gpt-live-transcribe is a realtime-transport model whose session contract is
 * not implemented here, so it is excluded until that dedicated transport is
 * built and live-tested. The injectable socketFactory seam stays for it.
 */
export const OPENAI_TRANSCRIPTION_ENDPOINT_MODELS = [
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "whisper-1",
] as const;

/** Fail-closed guard: only verified transcription-endpoint models on REST. */
export function isTranscriptionEndpointModel(model: string): boolean {
  return (OPENAI_TRANSCRIPTION_ENDPOINT_MODELS as readonly string[]).includes(model);
}

function parseFinalTranscript(body: unknown): { text: string; language?: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new VoiceProviderError("provider_protocol_failure", "openai stt: malformed response envelope");
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.text !== "string") {
    throw new VoiceProviderError("provider_protocol_failure", "openai stt: response missing text");
  }
  const language = typeof obj.language === "string" && obj.language !== "" ? obj.language : undefined;
  return { text: obj.text, language };
}

export class OpenAiSttProvider implements SttProvider {
  private readonly cancelled = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly sockets = new Map<string, RealtimeSocket>();
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly realtimeUrl: string;
  private readonly initialPrompt: string;
  private readonly requestTimeoutMs: number;
  private readonly maxAudioBytes: number;
  private readonly fetchFn: typeof fetch;
  private readonly socketFactory?: (url: string, model: string, apiKey: string) => RealtimeSocket;
  private readonly logger?: OpenAiSttOptions["logger"];

  constructor(opts: OpenAiSttOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1/audio/transcriptions").replace(/\/$/, "");
    // Realtime session base; the model travels as a query parameter.
    this.realtimeUrl = (opts.realtimeUrl ?? "wss://api.openai.com/v1/realtime").replace(/\/$/, "");
    this.initialPrompt = opts.initialPrompt ?? "";
    this.requestTimeoutMs = opts.requestTimeoutMs ?? OPENAI_STT_TIMEOUT_MS;
    this.maxAudioBytes = opts.maxAudioBytes ?? OPENAI_STT_MAX_AUDIO_BYTES;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.socketFactory = opts.socketFactory;
    this.logger = opts.logger;
  }

  id(): string {
    return OPENAI_STT_PROVIDER_ID;
  }

  /** Cloud availability = configured (non-empty key + model). No network probing. */
  get available(): boolean {
    return this.apiKey.trim() !== "" && this.model.trim() !== "";
  }

  /**
   * Build the structured transcription request fields. Pure (testable):
   * returns the exact multipart field map; the wire body is assembled from
   * it without post-serialization transforms.
   */
  buildRequestFields(languageHint: string | undefined): Record<string, string> {
    // REST-path contract: only verified /v1/audio/transcriptions models.
    // The realtime leg (socketFactory) keeps its own model contract.
    if (!isTranscriptionEndpointModel(this.model)) {
      throw new Error("unsupported model for /v1/audio/transcriptions: " + this.model);
    }
    const fields: Record<string, string> = { model: this.model, response_format: "json" };
    // Language is deliberately UNSET by default (auto incl. Bulgarian +
    // English code-switching). An explicit engine hint travels only when the
    // utterance options carry one; never hard-force English.
    if (languageHint && languageHint.trim() !== "" && languageHint !== "auto") {
      fields.language = languageHint.trim().slice(0, 16);
    }
    // Domain vocabulary as API-supported context prompting (data, never logged).
    const prompt = this.initialPrompt.trim().slice(0, 500);
    if (prompt !== "") fields.prompt = prompt;
    return fields;
  }

  /** Serialize a realtime control frame: structured object -> exact JSON bytes. */
  serializeFrame(frame: Record<string, unknown>): string {
    const body = JSON.stringify(frame);
    JSON.parse(body);
    return body;
  }

  /** Authorization header value (never logged; tests assert construction only). */
  authorizationHeader(): string {
    return "Bearer " + this.apiKey;
  }

  async *transcribeStream(input: AsyncIterable<PcmFrame>, options: SttOptions): AsyncIterable<SttEvent> {
    const utteranceId = options.utteranceId;
    if (!this.available || this.cancelled.has(utteranceId)) {
      yield { type: "error", code: "STT_FAILED" };
      return;
    }
    // 1) Buffer the COMPLETE utterance (bounded) — the same bytes are reused
    // for realtime streaming and, on failure, handed to the local fallback
    // by the ROUTER (never partial-stitched across providers here).
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const frame of input) {
        if (this.cancelled.has(utteranceId)) return;
        if (frame.sample_rate_hz !== 16000 || frame.channels !== 1 || frame.sample_format !== "s16le") {
          yield { type: "error", code: "STT_FAILED" };
          return;
        }
        const buf = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
        total += buf.length;
        if (total > this.maxAudioBytes) {
          yield { type: "error", code: "STT_FAILED" };
          return;
        }
        chunks.push(buf);
      }
    } catch {
      yield { type: "error", code: "STT_FAILED" };
      return;
    }
    if (this.cancelled.has(utteranceId)) return;
    const audio = Buffer.concat(chunks);

    // 2) Optional realtime session (partials path) when a factory is present.
    if (this.socketFactory) {
      yield* this.transcribeRealtime(utteranceId, audio, options);
      return;
    }
    // 3) Default REST transcription path.
    yield* this.transcribeRest(utteranceId, audio, options);
  }

  private async *transcribeRest(
    utteranceId: string,
    audio: Buffer,
    options: SttOptions,
  ): AsyncIterable<SttEvent> {
    const controller = new AbortController();
    this.controllers.set(utteranceId, controller);
    const timer = setTimeout(() => controller.abort(new Error("openai stt timed out")), this.requestTimeoutMs);
    try {
      const wav = wavWrap16kMono(audio);
      const fields = this.buildRequestFields(options.language);
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "utterance.wav");
      let response: Response;
      try {
        response = await this.fetchFn(this.baseUrl, {
          method: "POST",
          headers: { Authorization: this.authorizationHeader() },
          body: form,
          signal: controller.signal,
        });
      } catch (err) {
        if (this.cancelled.has(utteranceId) || controller.signal.aborted) return;
        throw new VoiceProviderError("provider_request_failure", "openai stt: request failed");
      }
      if (this.cancelled.has(utteranceId)) return;
      if (!response.ok) {
        const category = toFailure(response.status, "STT_FAILED");
        // Never include provider bodies (may contain secrets) in errors/logs.
        this.logger?.warn("openai stt request failed", { status: response.status });
        throw new VoiceProviderError(category, "openai stt: request failed with status " + response.status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new VoiceProviderError("provider_protocol_failure", "openai stt: invalid json response");
      }
      if (this.cancelled.has(utteranceId)) return;
      const parsed = parseFinalTranscript(body);
      yield { type: "final", text: parsed.text, language: parsed.language ?? options.language };
    } catch (err) {
      if (this.cancelled.has(utteranceId)) return;
      if (err instanceof VoiceProviderError) {
        yield { type: "error", code: err.category === "provider_auth_failure" ? "STT_AUTH_FAILED" : "STT_FAILED" };
        return;
      }
      yield { type: "error", code: "STT_FAILED" };
    } finally {
      clearTimeout(timer);
      this.controllers.delete(utteranceId);
      this.cancelled.delete(utteranceId);
    }
  }

  private async *transcribeRealtime(
    utteranceId: string,
    audio: Buffer,
    options: SttOptions,
  ): AsyncIterable<SttEvent> {
    const controller = new AbortController();
    this.controllers.set(utteranceId, controller);
    const timer = setTimeout(() => this.failRealtime(utteranceId, "timeout"), this.requestTimeoutMs);
    let socket: RealtimeSocket;
    try {
      socket = this.socketFactory!(this.realtimeUrl + "?model=" + encodeURIComponent(this.model), this.model, this.apiKey);
    } catch {
      clearTimeout(timer);
      this.controllers.delete(utteranceId);
      yield { type: "error", code: "STT_FAILED" };
      return;
    }
    this.sockets.set(utteranceId, socket);
    // Structured session configuration (JSON.stringify only — never edited).
    const sessionUpdate = this.serializeFrame({
      type: "transcription_session.update",
      input_audio_format: "pcm16",
      input_audio_transcription: {
        model: this.model,
        ...(options.language && options.language !== "auto" ? { language: options.language } : {}),
        ...(this.initialPrompt.trim() !== "" ? { prompt: this.initialPrompt.trim().slice(0, 500) } : {}),
      },
      turn_detection: { type: "server_vad" },
    });
    // Partial/delta queue: deltas yield as in-stream partial SttEvents
    // (observability only — never authoritative), interleaved with the
    // terminal completed event below.
    const partialQueue: string[] = [];
    let partialWaiter: (() => void) | undefined;
    const wakePartial = (): void => {
      const waiter = partialWaiter;
      partialWaiter = undefined;
      waiter?.();
    };
    let terminal: { text: string; language?: string } | { error: VoiceProviderError } | undefined;
    let terminalWaiter: (() => void) | undefined;
    const wakeTerminal = (): void => {
      const waiter = terminalWaiter;
      terminalWaiter = undefined;
      waiter?.();
    };
    socket.onmessage = (event: { data: unknown }) => {
      let msg: Record<string, unknown>;
      try {
        msg = typeof event.data === "string" ? (JSON.parse(event.data) as Record<string, unknown>) : {};
      } catch {
        terminal = { error: new VoiceProviderError("provider_protocol_failure", "openai stt: malformed realtime event") };
        wakeTerminal();
        return;
      }
      this.handleRealtimeEvent(msg, {
        onDelta: (text: string) => {
          partialQueue.push(text);
          try {
            this.partialSink?.(text);
          } catch { /* sink must never break routing */ }
          wakePartial();
        },
        onCompleted: (text: string, language?: string) => {
          terminal = { text, language };
          wakeTerminal();
        },
        onError: (err: VoiceProviderError) => {
          terminal = { error: err };
          wakeTerminal();
        },
      });
    };
    socket.onerror = () => {
      terminal = { error: new VoiceProviderError("provider_request_failure", "openai stt: realtime error") };
      wakeTerminal();
    };
    socket.onclose = () => {
      terminal = { error: new VoiceProviderError("provider_request_failure", "openai stt: realtime closed") };
      wakeTerminal();
    };
    controller.signal.addEventListener(
      "abort",
      () => {
        terminal = { error: new VoiceProviderError("provider_cancelled", "cancelled") };
        wakeTerminal();
        wakePartial();
      },
      { once: true },
    );
    try {
      socket.send(sessionUpdate);
      // Stream buffered PCM as base64 chunks, then commit the buffer.
      for (let offset = 0; offset < audio.length; offset += REALTIME_CHUNK_BYTES) {
        if (this.cancelled.has(utteranceId) || controller.signal.aborted) return;
        const slice = audio.subarray(offset, offset + REALTIME_CHUNK_BYTES);
        socket.send(this.serializeFrame({ type: "input_audio_buffer.append", audio: slice.toString("base64") }));
      }
      if (this.cancelled.has(utteranceId) || controller.signal.aborted) return;
      socket.send(this.serializeFrame({ type: "input_audio_buffer.commit" }));
      for (;;) {
        while (partialQueue.length > 0) {
          const text = partialQueue.shift() as string;
          if (!this.cancelled.has(utteranceId) && !controller.signal.aborted) {
            yield { type: "partial", text, stability: 0.5 };
          }
        }
        if (terminal !== undefined) break;
        await new Promise<void>((resolve) => {
          terminalWaiter = resolve;
          // A delta that arrived between the queue drain and this wait
          // must not be missed: re-check before parking.
          if (partialQueue.length > 0 || terminal !== undefined) resolve();
          else partialWaiter = resolve;
        });
      }
      while (partialQueue.length > 0) {
        const text = partialQueue.shift() as string;
        void text;
      }
      if (this.cancelled.has(utteranceId) || controller.signal.aborted) return;
      if (terminal === undefined || "error" in (terminal as object)) {
        const err = (terminal as { error: VoiceProviderError } | undefined)?.error;
        throw err ?? new VoiceProviderError("provider_request_failure", "openai stt: realtime ended");
      }
      const result = terminal as { text: string; language?: string };
      yield { type: "final", text: result.text, language: result.language ?? options.language };
    } catch (err) {
      if (this.cancelled.has(utteranceId) || controller.signal.aborted) return;
      const category = err instanceof VoiceProviderError ? err.category : "provider_request_failure";
      yield { type: "error", code: category === "provider_auth_failure" ? "STT_AUTH_FAILED" : "STT_FAILED" };
    } finally {
      clearTimeout(timer);
      this.controllers.delete(utteranceId);
      this.sockets.delete(utteranceId);
      this.cancelled.delete(utteranceId);
      try { socket.close(); } catch { /* clean close best effort */ }
    }
  }

  /**
   * Map one realtime server event. Delta/partial events queue into the
   * in-stream partial flow (observability only — never authoritative);
   * completed resolves the single authoritative final; explicit error
   * payloads become bounded provider errors. Unknown events are tolerated.
   */
  private partialSink: ((text: string) => void) | undefined;

  /** Attach a partial-transcript sink (controller observability path). */
  setPartialSink(sink: ((text: string) => void) | undefined): void {
    this.partialSink = sink;
  }

  private handleRealtimeEvent(
    msg: Record<string, unknown>,
    flow: {
      onDelta(text: string): void;
      onCompleted(text: string, language?: string): void;
      onError(err: VoiceProviderError): void;
    },
  ): void {
    const type = typeof msg.type === "string" ? msg.type : "";
    // Completed final transcript (authoritative).
    if (
      type === "conversation.item.input_audio_transcription.completed" ||
      type === "input_audio_transcription.completed" ||
      type === "transcription.completed"
    ) {
      const text = typeof msg.transcript === "string" ? msg.transcript : "";
      const language = typeof msg.language === "string" ? msg.language : undefined;
      flow.onCompleted(text, language);
      return;
    }
    // Partial/delta transcript (observability only — never authoritative).
    if (
      type === "conversation.item.input_audio_transcription.delta" ||
      type === "input_audio_transcription.delta" ||
      type === "transcription.delta"
    ) {
      const delta = typeof msg.delta === "string" ? msg.delta : typeof msg.text === "string" ? (msg.text as string) : "";
      if (delta !== "") flow.onDelta(delta);
      return;
    }
    if (type === "error") {
      flow.onError(new VoiceProviderError("provider_request_failure", "openai stt: realtime error event"));
      return;
    }
    // All other server events (session created/updated, buffer committed,
    // VAD markers): tolerated, awaited through.
  }

  private failRealtime(utteranceId: string, _reason: string): void {
    void _reason;
    const controller = this.controllers.get(utteranceId);
    try { controller?.abort(new Error("openai stt timed out")); } catch { /* idempotent */ }
    const socket = this.sockets.get(utteranceId);
    try { socket?.close(); } catch { /* best effort */ }
  }

  async cancel(utteranceId: string): Promise<void> {
    this.cancelled.add(utteranceId);
    const controller = this.controllers.get(utteranceId);
    if (controller) {
      try { controller.abort(new Error("voice cancelled: " + utteranceId)); } catch { /* idempotent */ }
    }
    const socket = this.sockets.get(utteranceId);
    if (socket) {
      try { socket.close(); } catch { /* best effort */ }
    }
  }
}

/** Deterministic WAV wrapper: 16 kHz mono s16le PCM -> RIFF/WAVE bytes. */
export function wavWrap16kMono(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(16000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
