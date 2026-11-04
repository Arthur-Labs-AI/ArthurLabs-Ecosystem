/**
 * TTS gateway (Phase 3 spec sections 7.4, 35).
 *
 * Controller depends only on this wrapper. Records tts.first_audio_ms and
 * keeps availability reporting for /status.
 */

import { AudioChunk, TtsProvider, TtsRequest } from "../contracts";
import { Metrics } from "../../observability/metrics";

export class TtsGateway implements TtsProvider {
  private readonly metrics: Metrics;

  constructor(private readonly provider: TtsProvider, metrics: Metrics) {
    this.metrics = metrics;
  }

  id(): string {
    return this.provider.id();
  }

  get available(): boolean {
    return this.provider.available;
  }

  async *synthesizeStream(request: TtsRequest): AsyncIterable<AudioChunk> {
    const startedAt = Date.now();
    let first = true;
    for await (const chunk of this.provider.synthesizeStream(request)) {
      if (first) {
        first = false;
        this.metrics.timer("tts.first_audio_ms", Date.now() - startedAt, { provider: this.provider.id() });
      }
      yield chunk;
    }
  }

  async cancel(synthesisId: string): Promise<void> {
    await this.provider.cancel(synthesisId);
  }
}
