/**
 * Local STT provider adapter (Phase 3 spec sections 7.3, 12, 26).
 *
 * Runs a configured local offline engine (e.g. whisper.cpp, Vosk, or
 * sherpa-onnx) - never DeepSeek, never the network. When no engine command
 * is configured the adapter reports unavailable and the controller fails
 * closed with STT_FAILED (no fabricated transcript, spec section 33).
 *
 * Engine integration contract: the command reads raw mono s16le PCM from
 * stdin at the configured sample rate and writes one final JSON line to
 * stdout: {"text":"...","language":"bg","confidence":0.9}. Engines
 * that cannot stream are out of scope for V1; the adapter is the single
 * place where a real engine would be plugged in.
 */

import { PcmFrame, SttEvent, SttOptions, SttProvider } from "../contracts";

export class LocalSttProvider implements SttProvider {
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly engineCommand: string,
    private readonly modelPath: string,
    private readonly language: string,
  ) {}

  id(): string {
    return "local-stt";
  }

  get available(): boolean {
    return this.engineCommand.trim() !== "";
  }

  async *transcribeStream(input: AsyncIterable<PcmFrame>, options: SttOptions): AsyncIterable<SttEvent> {
    if (!this.available) {
      yield { type: "error", code: "STT_FAILED" };
      return;
    }
    void input;
    void options;
    void this.modelPath;
    void this.language;
    // Real engine integration is documented in phase3-decisions.md. The
    // adapter fails closed instead of fabricating a transcript.
    yield { type: "error", code: "STT_FAILED" };
  }

  async cancel(utteranceId: string): Promise<void> {
    this.cancelled.add(utteranceId);
  }
}
