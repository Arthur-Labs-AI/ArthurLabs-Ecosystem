/**
 * Local STT provider adapter (Phase 3 spec sections 7.3, 12, 26, 33).
 *
 * Runs a configured local offline engine (e.g. whisper.cpp, Vosk, or
 * sherpa-onnx) - never DeepSeek, never the network. When no engine command
 * is configured the adapter reports unavailable and the controller fails
 * closed with STT_FAILED (no fabricated transcript).
 *
 * Engine integration contract: the command reads raw mono s16le PCM from
 * stdin at the configured sample rate and writes exactly one final JSON
 * line to stdout: {"text":"...","language":"bg","confidence":0.9}
 * (language and confidence are optional: engines that cannot report a
 * value honestly omit the field - wrappers must never fabricate one).
 * The line is parsed and strictly validated; malformed JSON, non-zero exit,
 * timeout, oversized output, or invalid fields all surface as STT_FAILED.
 * Cancellation terminates the engine process promptly. Raw audio never
 * leaves this process and is never sent to any model provider.
 */

import { PcmFrame, SttEvent, SttOptions, SttProvider } from "../contracts";
import type { ChildProcess } from "node:child_process";
import {
  BoundedTail,
  awaitSpawn,
  drainOrClose,
  killChild,
  noOutput,
  spawnEngine,
  terminateChild,
  waitForClose,
} from "../process_util";
import type { LogSink, TextSanitizer } from "../process_util";

export interface LocalSttOptions {
  /** Overall engine deadline in ms (default 60 s). */
  sttTimeoutMs?: number;
  /** Cap on stdout bytes before STT_FAILED (default 1 MiB). */
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
  /**
   * Optional domain-vocabulary initial prompt (STT Quality v2, TASK-0008).
   * Forwarded to the engine via the ARTHUR_STT_INITIAL_PROMPT environment
   * variable and always set (possibly empty) so provider configuration is
   * authoritative over any inherited process environment. The prompt is
   * engine data only: never logged, never placed on a command line here.
   */
  initialPrompt?: string;
}

export interface SttParseResult {
  text: string;
  language?: string;
  confidence?: number;
}

/** Strict validator for the engine's single JSON output line. */
export function parseSttJsonLine(line: string): SttParseResult {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("STT output is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.text !== "string") {
    throw new Error("STT output missing string field text");
  }
  const text: string = obj.text;
  let language: string | undefined;
  if (obj.language !== undefined && obj.language !== null) {
    if (typeof obj.language !== "string" || obj.language === "") {
      throw new Error("STT output field language must be a non-empty string");
    }
    language = obj.language;
  }
  let confidence: number | undefined;
  if (obj.confidence !== undefined && obj.confidence !== null) {
    if (
      typeof obj.confidence !== "number" ||
      !Number.isFinite(obj.confidence) ||
      obj.confidence < 0 ||
      obj.confidence > 1
    ) {
      throw new Error("STT output field confidence must be a number in [0, 1]");
    }
    confidence = obj.confidence;
  }
  return { text, language, confidence };
}

export class LocalSttProvider implements SttProvider {
  private readonly cancelled = new Set<string>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly sttTimeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly killGraceMs: number;
  private readonly logger: LogSink | undefined;
  private readonly sanitizer: TextSanitizer | undefined;
  private readonly extraEnv: Record<string, string>;
  private readonly initialPrompt: string;

  constructor(
    private readonly engineCommand: string,
    private readonly modelPath: string,
    private readonly language: string,
    opts: LocalSttOptions = {},
  ) {
    this.sttTimeoutMs = opts.sttTimeoutMs ?? 60_000;
    this.maxStdoutBytes = opts.maxStdoutBytes ?? 1024 * 1024;
    this.maxStderrBytes = opts.maxStderrBytes ?? 8192;
    this.killGraceMs = opts.killGraceMs ?? 300;
    this.logger = opts.logger;
    this.sanitizer = opts.sanitizer;
    this.extraEnv = opts.env ?? {};
    this.initialPrompt = opts.initialPrompt ?? "";
  }

  id(): string {
    return "local-stt";
  }

  get available(): boolean {
    return this.engineCommand.trim() !== "";
  }

  async *transcribeStream(input: AsyncIterable<PcmFrame>, options: SttOptions): AsyncIterable<SttEvent> {
    const utteranceId = options.utteranceId;
    if (!this.available || this.cancelled.has(utteranceId)) {
      yield { type: "error", code: "STT_FAILED" };
      return;
    }
    let child: ChildProcess;
    try {
      child = spawnEngine(this.engineCommand, {
        ...this.extraEnv,
        ARTHUR_STT_MODEL_PATH: this.modelPath,
        ARTHUR_STT_LANGUAGE: this.language === "auto" ? "" : this.language,
        // Always present (possibly "") so an inherited ARTHUR_STT_INITIAL_PROMPT
        // cannot leak into the engine; empty means no initial prompt.
        ARTHUR_STT_INITIAL_PROMPT: this.initialPrompt,
      });
    } catch (err) {
      this.logger?.error("STT engine spawn failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      yield { type: "error", code: "STT_FAILED" };
      return;
    }
    child.on("error", () => undefined);
    child.stdin?.on("error", () => undefined);
    this.children.set(utteranceId, child);
    const stderrTail = new BoundedTail(this.maxStderrBytes);
    child.stderr?.on("data", (chunk: Buffer) => stderrTail.push(chunk));
    let result: SttParseResult | undefined;
    let failure: string | undefined;
    let code: number | null = null;
    try {
      await awaitSpawn(child);
      const timer = setTimeout(() => {
        failure = "STT engine timed out";
        killChild(child);
      }, this.sttTimeoutMs);
      try {
        await Promise.all([
          this.readStdout(child, utteranceId, (parsed, fail) => {
            result = parsed;
            failure = fail;
          }),
          this.feedInput(
            child,
            input,
            () => result !== undefined || failure !== undefined,
            () => this.cancelled.has(utteranceId),
          ),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      failure = "STT engine failed (" + (err instanceof Error ? err.message : String(err)) + ")";
    } finally {
      if (failure === undefined && result !== undefined) {
        // Engine wrote a valid line: wait for its natural exit (bounded).
        code = await waitForClose(child, this.killGraceMs).catch(() => null);
      }
      // The timer above already killed the child on timeout; otherwise give a
      // valid engine a bounded window to exit 0 naturally before reaping it.
      if (code === null) {
        await terminateChild(child, this.killGraceMs).catch(() => undefined);
      }
      this.children.delete(utteranceId);
    }
    if (this.cancelled.has(utteranceId)) {
      this.cancelled.delete(utteranceId);
      return;
    }
    if (failure !== undefined) {
      this.logger?.warn("STT engine failure", {
        failure,
        stderr_tail: this.sanitizeTail(stderrTail.text),
      });
      yield { type: "error", code: "STT_FAILED" };
      return;
    }
    if (result === undefined) {
      this.logger?.warn("STT engine produced no transcript", {
        stderr_tail: this.sanitizeTail(stderrTail.text),
      });
      yield { type: "error", code: "STT_FAILED" };
      return;
    }
    // Strict contract: a non-zero exit is a failure even if JSON was parsed.
    if (code !== 0) {
      this.logger?.warn("STT engine exited abnormally", {
        code,
        stderr_tail: this.sanitizeTail(stderrTail.text),
      });
      yield { type: "error", code: "STT_FAILED" };
      return;
    }
    const maxChars = options.maxTranscriptChars;
    const text = result.text.length > maxChars ? result.text.slice(0, maxChars) : result.text;
    yield { type: "final", text, language: result.language, confidence: result.confidence };
  }

  async cancel(utteranceId: string): Promise<void> {
    this.cancelled.add(utteranceId);
    const child = this.children.get(utteranceId);
    if (child) {
      killChild(child);
    }
  }

  private async readStdout(
    child: ChildProcess,
    utteranceId: string,
    report: (parsed: SttParseResult | undefined, failure: string | undefined) => void,
  ): Promise<void> {
    let pending = Buffer.alloc(0);
    let stdoutBytes = 0;
    let done = false;
    const finish = (parsed: SttParseResult | undefined, failure: string | undefined): void => {
      if (done) return;
      done = true;
      report(parsed, failure);
    };
    try {
      for await (const chunk of child.stdout ?? noOutput()) {
        if (this.cancelled.has(utteranceId)) {
          finish(undefined, undefined);
          return;
        }
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxStdoutBytes) {
          finish(undefined, "STT output exceeded the bounded buffer");
          killChild(child);
          return;
        }
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
          const nl = pending.indexOf(0x0a);
          if (nl < 0) break;
          const line = pending.subarray(0, nl).toString("utf8").trim();
          pending = pending.subarray(nl + 1);
          if (line === "") continue;
          try {
            finish(parseSttJsonLine(line), undefined);
          } catch (err) {
            finish(undefined, "STT output is invalid (" + (err instanceof Error ? err.message : String(err)) + ")");
          }
          return;
        }
      }
      // stdout closed without a JSON line (or with only whitespace).
      finish(undefined, undefined);
    } catch (err) {
      finish(undefined, "STT stdout stream failed (" + (err instanceof Error ? err.message : String(err)) + ")");
    }
  }

  private async feedInput(
    child: ChildProcess,
    input: AsyncIterable<PcmFrame>,
    answered: () => boolean,
    cancelled: () => boolean,
  ): Promise<void> {
    const stdin = child.stdin;
    if (!stdin) return;
    try {
      for await (const frame of input) {
        if (answered() || cancelled()) break;
        if (!stdin.write(frame.data)) {
          await drainOrClose(stdin, child);
          if (answered() || cancelled()) break;
        }
      }
      stdin.end();
    } catch {
      // The child died or its stdin closed; the stdout path reports the
      // actual failure.
    }
  }

  private sanitizeTail(text: string): string {
    if (text === "") return "";
    const sanitized = this.sanitizer ? this.sanitizer.sanitizeText(text) : text;
    return sanitized.length > 2000 ? sanitized.slice(-2000) + " (truncated)" : sanitized;
  }
}