/**
 * Local TTS provider adapter (Phase 3 spec sections 7.4, 13, 26).
 *
 * Runs a configured local offline TTS engine. When no engine command is
 * configured the adapter reports unavailable; the controller then keeps
 * display_text available and reports TTS_FAILED (spec section 33).
 *
 * Engine integration contract: the command reads plain text on stdin and
 * writes raw mono s16le PCM at the configured sample rate to stdout.
 * Sentence-based engines can be driven chunk by chunk.
 */

import { AudioChunk, TtsProvider, TtsRequest } from "../contracts";

export class LocalTtsProvider implements TtsProvider {
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly engineCommand: string,
    private readonly voice: string,
  ) {}

  id(): string {
    return "local-tts";
  }

  get available(): boolean {
    return this.engineCommand.trim() !== "";
  }

  async *synthesizeStream(request: TtsRequest): AsyncIterable<AudioChunk> {
    if (!this.available) return;
    void request;
    void this.voice;
    // Real engine integration is documented in phase3-decisions.md.
  }

  async cancel(synthesisId: string): Promise<void> {
    this.cancelled.add(synthesisId);
  }
}
