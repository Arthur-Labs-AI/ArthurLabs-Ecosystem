/**
 * Model Gateway (spec section 6.4).
 *
 * ConversationService depends on `ModelGateway`, not any provider. The gateway
 * delegates to the configured provider and normalizes provider-level errors
 * into typed ArthurErrors so failures "fail closed" at the service boundary.
 */

import { ArthurError } from "../core/errors/errors";
import {
  ModelCapabilities,
  ModelGateway as ModelGatewayInterface,
  ModelProvider,
  ModelRequest,
  ModelResult,
  ModelStreamEvent,
  ProviderAuthError,
  ProviderBadResponseError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  StreamingModelProvider,
} from "./contracts";

function mapProviderError(err: unknown): ArthurError {
  if (err instanceof ArthurError) return err;
  if (err instanceof ProviderTimeoutError) {
    return new ArthurError("MODEL_TIMEOUT", "Model provider timed out", { cause: err });
  }
  if (err instanceof ProviderAuthError) {
    return new ArthurError("MODEL_UNAVAILABLE", "Model provider authentication failed", { cause: err });
  }
  if (err instanceof ProviderUnavailableError) {
    return new ArthurError("MODEL_UNAVAILABLE", "Model provider is unavailable", { cause: err });
  }
  if (err instanceof ProviderBadResponseError) {
    return new ArthurError("MODEL_BAD_RESPONSE", "Model provider returned a malformed response", { cause: err });
  }
  return new ArthurError("MODEL_UNAVAILABLE", "Model provider failed unexpectedly", { cause: err });
}

export class ModelGateway implements ModelGatewayInterface {
  private readonly provider: ModelProvider;

  constructor(provider: ModelProvider) {
    this.provider = provider;
  }

  get id(): string {
    return this.provider.id();
  }

  capabilities(): ModelCapabilities {
    return this.provider.capabilities();
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    try {
      return await this.provider.generate(request);
    } catch (err) {
      throw mapProviderError(err);
    }
  }

  /**
   * Stream a model response (Phase 3 spec section 15). Providers that do not
   * implement streaming are still supported: the gateway buffers one
   * generate() result and replays it as a single stream. Cancellation is
   * honored via the AbortSignal; an aborted call simply stops yielding.
   */
  async *generateStream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const streaming = this.provider as StreamingModelProvider;
    if (typeof streaming.generateStream === "function") {
      try {
        yield* streaming.generateStream(request, signal);
        return;
      } catch (err) {
        if (signal?.aborted) return;
        throw mapProviderError(err);
      }
    }
    // Fallback: non-streaming provider, one buffered result.
    const buffered = await this.generate(request);
    if (signal?.aborted) return;
    if (buffered.assistant_text !== "") {
      yield { type: "text_delta", text: buffered.assistant_text };
    }
    for (const call of buffered.tool_calls) {
      if (signal?.aborted) return;
      yield { type: "tool_call", call };
    }
    if (buffered.usage) {
      yield { type: "usage", usage: buffered.usage };
    }
    yield { type: "done", finish_reason: buffered.finish_reason };
  }
}