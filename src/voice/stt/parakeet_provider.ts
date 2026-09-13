/**
 * HR-02 Parakeet local STT provider ("parakeet-stt", runtime_mode = local).
 *
 * Boundary: VoiceController -> SttRouter -> ParakeetSttProvider -> bounded
 * local IPC -> Parakeet worker -> NVIDIA model. The Node side depends only
 * on the SttProvider contract; no NVIDIA/Python concepts leak above it.
 *
 * Audio contract: 16 kHz, mono, s16le PCM (the ARTHUR internal format — no
 * transcoding on this path). Utterances buffer complete audio in memory
 * (bounded ~120 s); temporary files are never used on the Node side (the
 * worker owns its own bounded temp lifecycle, if any).
 *
 * Process rules: fixed trusted worker command (argument array, no shell),
 * bounded stdout/stderr, cancellation support, normalized errors, no
 * secrets on CLI, no model-supplied paths.
 *
 * Crash diagnostics are opt-in (ARTHUR_PARAKEET_DEBUG=1): disabled, production
 * logging is byte-identical to before; enabled, a worker exit reports the exit
 * code, signal, in-flight request count, and the bounded stderr tail. A native
 * termination (CUDA fault, abort, segfault) cannot be caught in Python, so this
 * Node-side exit evidence is the only diagnosis for it. Diagnostics never carry
 * audio, base64, transcripts, environment values, or secrets, never throw, and
 * never alter request settlement, worker timing, or worker lifecycle.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import type { PcmFrame, SttEvent, SttOptions, SttProvider } from "../contracts";
import type { LogSink, TextSanitizer } from "../process_util";
import { VoiceProviderError } from "../../runtime/voice_errors";

export const PARAKEET_STT_PROVIDER_ID = "parakeet-stt";
export const PARAKEET_DEFAULT_MODEL = "nvidia/parakeet-tdt-0.6b-v3";

/** Bounded complete-utterance audio retention (120 s @16 kHz mono s16le). */
export const PARAKEET_MAX_AUDIO_BYTES = 120 * 16000 * 2;
/** Bounded JSONL line size (generous envelope over max audio base64). */
export const PARAKEET_MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Default worker deadline per utterance (60 s). */
export const PARAKEET_TIMEOUT_MS = 60_000;
/** Opt-in crash-diagnostics switch (unset = production logging, unchanged). */
export const PARAKEET_DEBUG_ENV = "ARTHUR_PARAKEET_DEBUG";
/** Worker-side switch forwarded to the child when diagnostics are enabled. */
export const PARAKEET_WORKER_DEBUG_ENV = "PARAKEET_DEBUG";
/** Hard cap (bytes) for the stderr tail embedded in a crash diagnostic. */
export const PARAKEET_DIAG_STDERR_BYTES = 4096;

export interface ParakeetWorkerConfig {
  /** Fixed trusted worker command as argv (default: python worker script). */
  command: string[];
  /** Model id forwarded via PARAKEET_MODEL env (default parakeet-tdt-0.6b-v3). */
  model?: string;
  /** Extra trusted env (device selection etc.). Never secrets. */
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  maxAudioBytes?: number;
  maxLineBytes?: number;
  maxStderrBytes?: number;
  logger?: LogSink;
  /** Opt-in crash diagnostics (default: PARAKEET_DEBUG_ENV in the environment). */
  debug?: boolean;
  /** Existing text sanitizer (SecretSanitizer) applied to diagnostic text. */
  sanitizer?: TextSanitizer;
}

/** True when the opt-in crash-diagnostic switch is enabled in the environment. */
export function parakeetDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[PARAKEET_DEBUG_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Neutralize control characters so a diagnostic is always one bounded log
 * line: a child cannot forge or split log records through its stderr text.
 */
export function sanitizeDiagnosticText(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, " | ")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

interface PendingRequest {
  resolve: (value: { text: string; language?: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function splitWorkerCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (inQuotes) {
      if (ch === '"') inQuotes = false;
      else if (ch === "\\" && command[i + 1] === '"') { current += '"'; i += 1; }
      else current += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === " " || ch === "\t") {
      if (current !== "") { tokens.push(current); current = ""; }
    } else {
      current += ch;
    }
    i += 1;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/** Parse + strictly validate one worker response line (bounded, schema-strict). */
export function parseWorkerLine(line: string, maxLineBytes: number): { id: string; text?: string; language?: string; error?: string } {
  if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
    throw new VoiceProviderError("provider_protocol_failure", "parakeet: response line exceeds bound");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new VoiceProviderError("provider_protocol_failure", "parakeet: malformed worker response");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new VoiceProviderError("provider_protocol_failure", "parakeet: worker response is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== "string") {
    throw new VoiceProviderError("provider_protocol_failure", "parakeet: worker response missing id");
  }
  if (obj.ok === true) {
    if (typeof obj.text !== "string") {
      throw new VoiceProviderError("provider_protocol_failure", "parakeet: worker response missing text");
    }
    const language = typeof obj.language === "string" && obj.language !== "" ? obj.language : undefined;
    return { id: obj.id, text: obj.text, language };
  }
  const error = typeof obj.error === "string" && obj.error !== "" ? obj.error : "transcription_failed";
  return { id: obj.id, error };
}

export class ParakeetSttProvider implements SttProvider {
  private readonly command: string[];
  private readonly model: string;
  private readonly env: Record<string, string>;
  private readonly requestTimeoutMs: number;
  private readonly maxAudioBytes: number;
  private readonly maxLineBytes: number;
  private readonly maxStderrBytes: number;
  private readonly logger?: LogSink;
  private readonly sanitizer?: TextSanitizer;
  private readonly debug: boolean;
  private child: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cancelled = new Set<string>();
  private stderrTail = Buffer.alloc(0);
  private exited = false;
  private exitDiagnosed = false;
  private requestSeq = 0;

  constructor(config: ParakeetWorkerConfig) {
    if (!config.command || config.command.length === 0) {
      throw new Error("parakeet: worker command must be a non-empty argv array");
    }
    this.command = [...config.command];
    this.model = config.model ?? PARAKEET_DEFAULT_MODEL;
    this.env = { ...(config.env ?? {}) };
    this.requestTimeoutMs = config.requestTimeoutMs ?? PARAKEET_TIMEOUT_MS;
    this.maxAudioBytes = config.maxAudioBytes ?? PARAKEET_MAX_AUDIO_BYTES;
    this.maxLineBytes = config.maxLineBytes ?? PARAKEET_MAX_LINE_BYTES;
    this.maxStderrBytes = config.maxStderrBytes ?? 8192;
    this.logger = config.logger;
    this.sanitizer = config.sanitizer;
    this.debug = config.debug ?? parakeetDebugEnabled();
  }

  /** Build a provider from a trusted command LINE (tokenized, no shell). */
  static fromCommandLine(commandLine: string, opts: Omit<ParakeetWorkerConfig, "command"> = {}): ParakeetSttProvider {
    return new ParakeetSttProvider({ ...opts, command: splitWorkerCommand(commandLine) });
  }

  id(): string {
    return PARAKEET_STT_PROVIDER_ID;
  }

  /**
   * Readiness WITHOUT pretending: configured (non-empty command) +
   * worker process responsive. Before first spawn the process state is
   * unknown, so available reports configuration only; failed/crashed
   * workers report unavailable until the next successful request.
   */
  get available(): boolean {
    if (this.command.length === 0) return false;
    if (this.exited) return false;
    return true;
  }

  /** True once the worker process has exited unexpectedly. */
  get workerExited(): boolean {
    return this.exited;
  }

  private ensureWorker(): Promise<void> {
    if (this.child && !this.exited) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const exe = this.command[0] as string;
      const args = this.command.slice(1);
      let child: ChildProcess;
      try {
        child = spawn(exe, args, {
          stdio: ["pipe", "pipe", "pipe"],
          // No shell; fixed trusted argv only. Model travels via env, never CLI.
          env: {
            ...process.env,
            ...this.env,
            PARAKEET_MODEL: this.model,
            // One operator switch enables both sides: Node exit diagnostics and
            // the worker's bounded request/vram/exception diagnostics.
            ...(this.debug ? { [PARAKEET_WORKER_DEBUG_ENV]: "1" } : {}),
          },
          windowsHide: true,
        });
      } catch (err) {
        this.starting = undefined;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let ready: (() => void) | undefined;
      let failed: ((err: Error) => void) | undefined;
      const markReady = (): void => {
        if (ready) {
          const r = ready;
          ready = undefined;
          failed = undefined;
          this.starting = undefined;
          r();
        }
      };
      const markFailed = (err: Error): void => {
        if (failed) {
          const f = failed;
          ready = undefined;
          failed = undefined;
          this.starting = undefined;
          f(err);
        }
      };
      child.on("error", (err: unknown) => {
        // Spawn failure: no exit evidence exists yet. A following 'close'
        // reports it; settlement semantics are unchanged either way.
        this.onWorkerExit(new VoiceProviderError("local_worker_unavailable", "parakeet: worker failed to start"));
        // A failed start must never leave ensureWorker() pending forever.
        markFailed(err instanceof Error ? err : new Error(String(err)));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        this.stderrTail = Buffer.concat([this.stderrTail, chunk]);
        if (this.stderrTail.length > this.maxStderrBytes) {
          this.stderrTail = this.stderrTail.subarray(this.stderrTail.length - this.maxStderrBytes);
        }
      });
      if (child.stdout) {
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line: string) => this.onWorkerLine(line));
        lines.on("close", () => {
          // Stdout EOF with requests still outstanding: those responses can
          // never arrive (the process is dying even if close/exit lags), so
          // settle them deterministically instead of leaving them to timeout.
          if (this.pending.size > 0) {
            this.failAllPending(new VoiceProviderError("local_worker_crashed", "parakeet: worker output ended"));
          }
        });
      }
      // Non-JSON diagnostic stdout lines must never stall a request: the
      // worker speaks strict JSONL, but third-party logging may share fd 1.
      // readline "line" events are therefore non-fatal: unparsable lines
      // (or lines for unknown ids) are ignored with a bounded warn, and the
      // outstanding request keeps waiting for its matching response/timeout.
      child.stdout?.on("error", () => undefined);
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        this.noteWorkerExit("close", code, signal, true);
      });
      child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        // Belt-and-braces: settle every pending request on exit as well as
        // close (exactly once -- failAllPending clears the map first).
        this.noteWorkerExit("exit", code, signal, !this.exited);
      });
      child.stdin?.on("error", () => undefined);
      this.child = child;
      this.exited = false;
      this.exitDiagnosed = false;
      // The worker prints no ready banner; resolve on next tick once spawned.
      ready = resolve;
      failed = reject;
      setImmediate(markReady);
    });
    return this.starting;
  }

  private onWorkerLine(line: string): void {
    let parsed: { id: string; text?: string; language?: string; error?: string };
    try {
      parsed = parseWorkerLine(line, this.maxLineBytes);
    } catch (err) {
      this.logger?.warn("parakeet worker protocol failure", {});
      void err;
      // Malformed line that still carries a matching pending id settles that
      // request deterministically (provider_protocol_failure). Pure noise
      // (non-JSON diagnostics, unknown ids) is ignored non-fatally so a
      // stray log line can never stall an unrelated outstanding request.
      this.failMatchingPendingOnMalformedLine(line);
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) return; // stale/unknown id: ignore (never misattribute).
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    if (parsed.error !== undefined) {
      pending.reject(new VoiceProviderError("transcription_failed", "parakeet: " + parsed.error));
      return;
    }
    pending.resolve({ text: parsed.text ?? "", language: parsed.language });
  }

  /** Extract a bare `"id"` string from a malformed line (bounded, JSON-only). */
  private extractIdFromMalformedLine(line: string): string | undefined {
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const id = (parsed as Record<string, unknown>).id;
    return typeof id === "string" && id !== "" ? id : undefined;
  }

  private failMatchingPendingOnMalformedLine(line: string): void {
    const id = this.extractIdFromMalformedLine(line);
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(new VoiceProviderError("provider_protocol_failure", "parakeet: malformed worker response"));
  }

  /**
   * Single funnel for worker exit evidence ('exit'/'close'). Settlement is
   * exactly-once and unchanged: the pending count is read BEFORE settlement so
   * the opt-in diagnostic reports the requests that were genuinely in flight.
   */
  private noteWorkerExit(source: "exit" | "close", code: number | null, signal: string | null, settle: boolean): void {
    const pendingRequests = this.pending.size;
    if (settle) {
      this.onWorkerExit(new VoiceProviderError("local_worker_crashed", "parakeet: worker exited"));
    }
    if (this.exitDiagnosed) return; // exit + close: one diagnostic per process.
    this.exitDiagnosed = true;
    this.logWorkerExitDiagnostic(source, code, signal, pendingRequests);
  }

  /** Worker is gone (error/close/exit): mark exited and settle all pending exactly once. */
  private onWorkerExit(err: Error): void {
    this.exited = true;
    this.child = undefined;
    this.failAllPending(err);
  }

  /**
   * Opt-in crash diagnostic. Ordinary Python failures already surface as a
   * bounded JSON error; native termination (CUDA fault, abort) cannot, so exit
   * code/signal plus the bounded stderr tail is the only evidence for it.
   * Never throws and never carries audio, transcripts, env dumps, or secrets.
   */
  private logWorkerExitDiagnostic(source: string, code: number | null, signal: string | null, pendingRequests: number): void {
    if (!this.debug) return;
    try {
      this.logger?.warn("parakeet worker exited", {
        source,
        exit_code: code,
        signal,
        pending_requests: pendingRequests,
        stderr_tail: this.diagnosticStderrTail(),
      });
    } catch {
      // Diagnostics must never affect the worker lifecycle or settlement.
    }
  }

  /** Bounded, redacted, single-line stderr tail for diagnostics (<= 4096 bytes). */
  private diagnosticStderrTail(): string {
    try {
      const raw = this.stderrTail.toString("utf8");
      // Reuse the existing secret boundary rather than a second sanitizer.
      const text = sanitizeDiagnosticText(this.sanitizer ? this.sanitizer.sanitizeText(raw) : raw);
      const bytes = Buffer.from(text, "utf8");
      if (bytes.byteLength <= PARAKEET_DIAG_STDERR_BYTES) return text;
      const marker = " (truncated)";
      const keep = PARAKEET_DIAG_STDERR_BYTES - Buffer.byteLength(marker, "utf8");
      return bytes.subarray(bytes.byteLength - keep).toString("utf8") + marker;
    } catch {
      return "";
    }
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(err);
    }
  }

  async *transcribeStream(input: AsyncIterable<PcmFrame>, options: SttOptions): AsyncIterable<SttEvent> {
    const utteranceId = options.utteranceId;
    if (this.cancelled.has(utteranceId)) return;
    // Buffer the complete utterance (bounded, memory-only, temp files never).
    const chunks: Buffer[] = [];
    let total = 0;
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
    if (this.cancelled.has(utteranceId)) return;
    try {
      const text = await this.transcribeAudio(Buffer.concat(chunks), utteranceId);
      if (this.cancelled.has(utteranceId)) return;
      yield { type: "final", text: text.text, language: text.language ?? options.language };
    } catch (err) {
      if (this.cancelled.has(utteranceId)) return;
      if (err instanceof VoiceProviderError && err.category === "local_worker_unavailable") {
        this.logger?.warn("parakeet worker unavailable", {});
      } else if (err instanceof VoiceProviderError && err.category === "local_worker_crashed") {
        this.logger?.warn("parakeet worker crashed", {});
      }
      yield { type: "error", code: "STT_FAILED" };
    } finally {
      this.cancelled.delete(utteranceId);
    }
  }

  /** Single utterance transcription over the persistent JSONL worker. */
  async transcribeAudio(audio: Buffer, utteranceId?: string): Promise<{ text: string; language?: string }> {
    try {
      await this.ensureWorker();
    } catch {
      throw new VoiceProviderError("local_worker_unavailable", "parakeet: worker unavailable");
    }
    const child = this.child;
    if (!child || this.exited || !child.stdin || child.stdin.destroyed) {
      throw new VoiceProviderError("local_worker_unavailable", "parakeet: worker unavailable");
    }
    this.requestSeq += 1;
    const id = "pq-" + String(this.requestSeq);
    // Structured request -> JSON.stringify -> exact line sent (invariant).
    const line = JSON.stringify({ id, audio_b64: audio.toString("base64"), sample_rate_hz: 16000 }) + "\n";
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
      throw new VoiceProviderError("transcription_failed", "parakeet: utterance exceeds worker bound");
    }
    return new Promise<{ text: string; language?: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VoiceProviderError("provider_timeout", "parakeet: transcription timed out"));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void utteranceId;
      child.stdin!.write(line, (err) => {
        if (err) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            reject(new VoiceProviderError("local_worker_crashed", "parakeet: worker write failed"));
          }
        }
      });
    });
  }

  async cancel(utteranceId: string): Promise<void> {
    this.cancelled.add(utteranceId);
    // Drop pending worker requests owned by this utterance is best-effort:
    // request ids are per-call; utterance cancel prevents their delivery.
  }

  /** Bounded stderr tail (diagnostics only, never audio/transcripts). */
  stderrTailText(): string {
    return this.stderrTail.toString("utf8");
  }

  /** Shut the worker down (disable path). */
  async shutdown(): Promise<void> {
    this.failAllPending(new VoiceProviderError("provider_cancelled", "parakeet: shutdown"));
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      try { child.kill(); } catch { /* best effort */ }
    }
  }
}
