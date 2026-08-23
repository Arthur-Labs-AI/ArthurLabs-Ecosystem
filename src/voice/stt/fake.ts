/**
 * Deterministic scripted STT for tests (Phase 3 spec sections 7.3, 38).
 *
 * A script declares partial transcripts, the final transcript, and an
 * optional error code. transcribeStream replays the script with real
 * async semantics so cancellation and stale-event behaviour are exercised
 * deterministically.
 */

import { PcmFrame, SttEvent, SttOptions, SttProvider } from "../contracts";

export interface FakeSttScript {
  partials?: string[];
  final?: string;
  /** When set, the stream ends with this error instead of a final. */
  error?: string;
  /** Simulated processing latency before the final event. */
  latencyMs?: number;
  language?: string;
  confidence?: number;
  /** If true, consume the frame stream and emit nothing (provider hang). */
  consumeWithoutResult?: boolean;
}

export class FakeSttProvider implements SttProvider {
  private readonly providerId: string;
  private readonly scripts = new Map<string, FakeSttScript>();
  private defaultScript: FakeSttScript | undefined;
  private readonly cancelled = new Set<string>();
  readonly startedUtterances: string[] = [];
  cancelCount = 0;
  framesConsumed = 0;

  constructor(opts: { id?: string } = {}) {
    this.providerId = opts.id ?? "fake-stt";
  }

  id(): string {
    return this.providerId;
  }

  get available(): boolean {
    return true;
  }

  /** Register a script for an utterance id before transcribeStream runs. */
  setScript(utteranceId: string, script: FakeSttScript): void {
    this.scripts.set(utteranceId, script);
  }

  /** Script applied to any utterance without an exact id (test convenience). */
  setDefaultScript(script: FakeSttScript): void {
    this.defaultScript = script;
  }

  isCancelled(utteranceId: string): boolean {
    return this.cancelled.has(utteranceId);
  }

  async *transcribeStream(input: AsyncIterable<PcmFrame>, options: SttOptions): AsyncIterable<SttEvent> {
    this.startedUtterances.push(options.utteranceId);
    const script = this.scripts.get(options.utteranceId) ?? this.defaultScript ?? { partials: [], final: "" };

    // Consume the frame stream so capture stops can unblock the producer.
    let frames = 0;
    for await (const frame of input) {
      void frame;
      frames += 1;
      this.framesConsumed += 1;
      if (this.cancelled.has(options.utteranceId)) return;
    }

    if (this.cancelled.has(options.utteranceId)) return;
    if (script.consumeWithoutResult) return;

    for (const partial of script.partials ?? []) {
      if (this.cancelled.has(options.utteranceId)) return;
      yield { type: "partial", text: partial, stability: 0.8 };
      // Small deterministic yield so consumers process partials in order.
      await new Promise((resolve) => setImmediate(resolve));
    }

    if (script.error) {
      yield { type: "error", code: script.error };
      return;
    }

    if (script.latencyMs && script.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, script.latencyMs));
    }
    if (this.cancelled.has(options.utteranceId)) return;
    yield {
      type: "final",
      text: script.final ?? "",
      language: script.language ?? options.language,
      confidence: script.confidence ?? 0.95,
    };
  }

  async cancel(utteranceId: string): Promise<void> {
    this.cancelCount += 1;
    this.cancelled.add(utteranceId);
  }
}