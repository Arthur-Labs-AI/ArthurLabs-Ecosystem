/**
 * Deterministic FakeProvider (spec section 4, 6.4).
 *
 * Used for offline tests and demos. Its responder can be replaced to script
 * tool-call proposals or injected failures without touching ConversationService.
 */

import {
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelResult,
  ModelStreamEvent,
  StreamingModelProvider,
} from "../contracts";

export type FakeResponder = (request: ModelRequest) => ModelResult | Promise<ModelResult>;

export interface FakeProviderOptions {
  id?: string;
  modelName?: string;
  responder?: FakeResponder;
  /** Streaming responder; falls back to a buffered responder stream. */
  streamResponder?: (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>;
}

let callCounter = 0;

export class FakeProvider implements StreamingModelProvider {
  private readonly providerId: string;
  private readonly model: string;
  private readonly responder?: FakeResponder;
  private readonly streamResponder?: (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>;

  constructor(opts: FakeProviderOptions = {}) {
    this.providerId = opts.id ?? "fake";
    this.model = opts.modelName ?? "fake-model";
    this.responder = opts.responder;
    this.streamResponder = opts.streamResponder;
  }

  id(): string {
    return this.providerId;
  }

  capabilities(): ModelCapabilities {
    return {
      id: this.providerId,
      modelName: this.model,
      supportsTools: true,
      supportsReasoning: true,
      maxContextTokens: 32000,
      online: false,
    };
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    if (this.responder) {
      return await this.responder(request);
    }
    callCounter += 1;
    return {
      assistant_text: `fake:${request.userMessage}`,
      tool_calls: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      finish_reason: "stop",
      raw_provider_id: `fake-${callCounter}`,
    };
  }

  /**
   * Streaming mode (Phase 3 spec section 15). Uses the scripted
   * streamResponder when provided; otherwise replays the buffered response
   * as a single stream, honoring cancellation.
   */
  async *generateStream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    if (this.streamResponder) {
      yield* this.streamResponder(request, signal);
      return;
    }
    const result = await this.generate(request);
    if (signal?.aborted) return;
    if (result.assistant_text !== "") {
      yield { type: "text_delta", text: result.assistant_text };
    }
    for (const call of result.tool_calls) {
      if (signal?.aborted) return;
      yield { type: "tool_call", call };
    }
    if (result.usage) {
      yield { type: "usage", usage: result.usage };
    }
    yield { type: "done", finish_reason: result.finish_reason };
  }
}