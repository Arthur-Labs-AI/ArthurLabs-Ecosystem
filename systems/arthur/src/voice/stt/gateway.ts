/**
 * STT gateway (Phase 3 spec sections 7.3, 35).
 *
 * Controller depends only on this wrapper. Records stt.latency_ms and
 * stt.realtime_factor observability without ever logging raw audio.
 */

import { PcmFrame, SttEvent, SttOptions, SttProvider } from "../contracts";
import { Metrics } from "../../observability/metrics";

export class SttGateway implements SttProvider {
  private readonly metrics: Metrics;

  constructor(private readonly provider: SttProvider, metrics: Metrics) {
    this.metrics = metrics;
  }

  id(): string {
    return this.provider.id();
  }

  get available(): boolean {
    return this.provider.available;
  }

  async *transcribeStream(input: AsyncIterable<PcmFrame>, options: SttOptions): AsyncIterable<SttEvent> {
    const startedAt = Date.now();
    for await (const event of this.provider.transcribeStream(input, options)) {
      if (event.type === "final" || event.type === "error") {
        const latencyMs = Date.now() - startedAt;
        this.metrics.timer("stt.latency_ms", latencyMs, { provider: this.provider.id() });
        const audioMs = options.audioDurationMs ?? 0;
        if (audioMs > 0) {
          this.metrics.timer("stt.realtime_factor", latencyMs / audioMs, { provider: this.provider.id() });
        }
      }
      yield event;
    }
  }

  async cancel(utteranceId: string): Promise<void> {
    await this.provider.cancel(utteranceId);
  }
}
