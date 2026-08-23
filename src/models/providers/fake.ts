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
} from "../contracts";

export type FakeResponder = (request: ModelRequest) => ModelResult | Promise<ModelResult>;

export interface FakeProviderOptions {
  id?: string;
  modelName?: string;
  responder?: FakeResponder;
}

let callCounter = 0;

export class FakeProvider implements ModelProvider {
  private readonly providerId: string;
  private readonly model: string;
  private readonly responder?: FakeResponder;

  constructor(opts: FakeProviderOptions = {}) {
    this.providerId = opts.id ?? "fake";
    this.model = opts.modelName ?? "fake-model";
    this.responder = opts.responder;
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
}
