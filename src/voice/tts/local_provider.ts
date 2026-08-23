/**
 * Local TTS provider adapter (Phase 3 spec sections 7.4, 17, 18, 33).
 *
 * Runs a configured local offline TTS engine. The command reads plain
 * speech text on stdin and writes raw mono s16le PCM to stdout at the
 * configured sample rate. PCM is chunked into bounded AudioChunk values
 * and yielded incrementally as it arrives; the final chunk carries the
 * final flag. Cancellation terminates the engine process promptly.
 * Non-zero exit, timeout, spawn failure, or an unbounded/oversized output
 * stream surface as TTS_FAILED via the controller playback path.
 *
 * Voice/sample-rate selection travels through the environment, never the
 * command line, so engine text can never alter the executable or argv.
 */

import { AudioChunk, TtsProvider, TtsRequest } from "../contracts";
import type { ChildProcess } from "node:child_process";
import {
  BoundedTail,
  awaitSpawn,
  killChild,
  spawnEngine,
  terminateChild,
  noOutput,
  waitForClose,
} from "../process_util";
import type { LogSink, TextSanitizer } from "../process_util";

export interface LocalTtsOptions {
  /** Duration of each yielded AudioChunk in ms (default 100 ms). */
  chunkDurationMs?: number;
  /** Overall engine deadline in ms (default 120 s). */
  ttsTimeoutMs?: number;
  /** Cap on stdout bytes before TTS_FAILED (default 64 MiB). */
  maxStdoutBytes?: number;
  /** Cap on stderr bytes kept for logging (default 8 KiB). */
  maxStderrBytes?: number;
  /** Grace window for terminating the engine (default 300 ms). */
  killGraceMs?: number;
  /** Secret-safe logger (app Logger redacts known secrets). */
  logger?: LogSink;
  /** Optional text sanitizer applied to stderr tails before logging. */
  sanitizer?: TextSanitizer;
  /** Extra environment passed to the engine command. */
  env?: Record<string, string>;
}

export class LocalTtsProvider implements TtsProvider {
  private readonly cancelled = new Set<string>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly chunkDurationMs: number;
  private readonly ttsTimeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly killGraceMs: number;
  private readonly logger: LogSink | undefined;
  private readonly sanitizer: TextSanitizer | undefined;
  private readonly extraEnv: Record<string, string>;

  constructor(
    private readonly engineCommand: string,
    private readonly voice: string,
    opts: LocalTtsOptions = {},
  ) {
    this.chunkDurationMs = opts.chunkDurationMs ?? 100;
    this.ttsTimeoutMs = opts.ttsTimeoutMs ?? 120_000;
    this.maxStdoutBytes = opts.maxStdoutBytes ?? 64 * 1024 * 1024;
    this.maxStderrBytes = opts.maxStderrBytes ?? 8192;
    this.killGraceMs = opts.killGraceMs ?? 300;
    this.logger = opts.logger;
    this.sanitizer = opts.sanitizer;
    this.extraEnv = opts.env ?? {};
  }

  id(): string {
    return "local-tts";
  }

  get available(): boolean {
    return this.engineCommand.trim() !== "";
  }

  async *synthesizeStream(request: TtsRequest): AsyncIterable<AudioChunk> {
    const synthesisId = request.synthesisId;
    if (!this.available || this.cancelled.has(synthesisId)) return;
    let child: ChildProcess;
    try {
      child = spawnEngine(this.engineCommand, {
        ...this.extraEnv,
        ARTHUR_TTS_VOICE: this.voice,
        ARTHUR_TTS_SAMPLE_RATE_HZ: String(request.sampleRateHz),
      });
    } catch (err) {
      this.logger?.error("TTS engine spawn failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      throw new Error("TTS engine failed to start");
    }
    child.on("error", () => undefined);
    child.stdin?.on("error", () => undefined);
    this.children.set(synthesisId, child);
    const stderrTail = new BoundedTail(this.maxStderrBytes);
    child.stderr?.on("data", (chunk: Buffer) => stderrTail.push(chunk));
    let timedOut = false;
    try {
      await awaitSpawn(child);
    } catch (err) {
      this.children.delete(synthesisId);
      await terminateChild(child, 300).catch(() => undefined);
      this.logger?.error("TTS engine failed to start", {
        message: err instanceof Error ? err.message : String(err),
      });
      throw new Error("TTS engine failed to start");
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, this.ttsTimeoutMs);
    try {
      child.stdin?.write(request.text, "utf8");
      child.stdin?.end();

      const bytesPerChunk = Math.max(2, Math.floor((request.sampleRateHz * this.chunkDurationMs) / 1000) * 2);
      let pending = Buffer.alloc(0);
      let total = 0;
      let seq = 0;
      const startTs = Date.now();
      // One-chunk lookahead so the final flag lands on the last audio chunk.
      let held: { data: Uint8Array; sequence: number; timestamp_ms: number } | undefined;
      for await (const chunk of child.stdout ?? noOutput()) {
        if (this.cancelled.has(synthesisId)) return;
        if (timedOut) break;
        total += chunk.length;
        if (total > this.maxStdoutBytes) {
          killChild(child);
          throw new Error("TTS output exceeded the bounded buffer");
        }
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= bytesPerChunk) {
          const raw = pending.subarray(0, bytesPerChunk);
          pending = pending.subarray(bytesPerChunk);
          const data = new Uint8Array(bytesPerChunk);
          data.set(raw);
          if (held !== undefined) {
            yield {
              synthesisId,
              sequence: held.sequence,
              timestamp_ms: held.timestamp_ms,
              sample_rate_hz: request.sampleRateHz,
              channels: 1,
              sample_format: "s16le",
              duration_ms: this.chunkDurationMs,
              data: held.data,
            };
          }
          held = { data, sequence: seq, timestamp_ms: startTs + seq * this.chunkDurationMs };
          seq += 1;
        }
      }
      if (this.cancelled.has(synthesisId)) return;
      if (timedOut) {
        throw new Error("TTS engine timed out");
      }
      // Trailing partial PCM (< one chunk) is emitted as a short final chunk;
      // a lone odd trailing byte is malformed and dropped.
      if (held !== undefined) {
        yield {
          synthesisId,
          sequence: held.sequence,
          timestamp_ms: held.timestamp_ms,
          sample_rate_hz: request.sampleRateHz,
          channels: 1,
          sample_format: "s16le",
          duration_ms: this.chunkDurationMs,
          data: held.data,
          final: pending.length < 2,
        };
      }
      if (pending.length >= 2) {
        const durationMs = Math.max(1, Math.round((pending.length / 2 / request.sampleRateHz) * 1000));
        const data = new Uint8Array(pending.length);
        data.set(pending);
        yield {
          synthesisId,
          sequence: seq,
          timestamp_ms: startTs + seq * this.chunkDurationMs,
          sample_rate_hz: request.sampleRateHz,
          channels: 1,
          sample_format: "s16le",
          duration_ms: durationMs,
          data,
          final: true,
        };
      }
      // Strict contract: a non-zero exit is a failure even after audio.
      if (this.cancelled.has(synthesisId)) return;
      let code = await waitForClose(child, this.killGraceMs);
      if (this.cancelled.has(synthesisId)) return;
      if (code === null) {
        await terminateChild(child, this.killGraceMs).catch(() => undefined);
        code = child.exitCode;
      }
      if (code !== 0) {
        this.logger?.warn("TTS engine exited abnormally", {
          code,
          stderr_tail: this.sanitizeTail(stderrTail.text),
        });
        throw new Error("TTS engine exited with code " + String(code));
      }
    } finally {
      clearTimeout(timer);
      this.children.delete(synthesisId);
      await terminateChild(child, this.killGraceMs).catch(() => undefined);
    }
  }

  async cancel(synthesisId: string): Promise<void> {
    this.cancelled.add(synthesisId);
    const child = this.children.get(synthesisId);
    if (child) {
      killChild(child);
    }
  }

  private sanitizeTail(text: string): string {
    if (text === "") return "";
    const sanitized = this.sanitizer ? this.sanitizer.sanitizeText(text) : text;
    return sanitized.length > 2000 ? sanitized.slice(-2000) + " (truncated)" : sanitized;
  }
}