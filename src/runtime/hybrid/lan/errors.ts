/**
 * HR-03D: server error classification (typed cause, never message text)
 * and client wire-code mapping. UNAUTHORIZED maps to a dedicated
 * non-retryable LAN auth error; only PROVIDER_TIMEOUT/UNAVAILABLE feed
 * HR-03C fallback. All messages are generic; tokens/prompts never appear.
 */

export const LAN_AUTH_ERROR_MESSAGE = "lan authentication failed";

export const LAN_PROTOCOL_ERROR_MESSAGE = "lan protocol error";

import { ArthurError } from "../../../core/errors/errors";
import {
  ProviderAuthError,
  ProviderBadResponseError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "../../../models/contracts";
import type { WireErrorCode } from "./protocol";

export function classifyServerError(err: unknown): WireErrorCode {
  if (err instanceof ProviderTimeoutError) return "PROVIDER_TIMEOUT";
  if (err instanceof ProviderUnavailableError) return "PROVIDER_UNAVAILABLE";
  if (err instanceof ProviderAuthError) return "PROVIDER_AUTH_FAILED";
  if (err instanceof ProviderBadResponseError) return "PROVIDER_BAD_RESPONSE";
  if (err instanceof ArthurError) {
    if (err.code === "MODEL_TIMEOUT" && err.cause instanceof ProviderTimeoutError) return "PROVIDER_TIMEOUT";
    if (err.code === "MODEL_UNAVAILABLE" && err.cause instanceof ProviderUnavailableError) return "PROVIDER_UNAVAILABLE";
    if (err.code === "MODEL_UNAVAILABLE" && err.cause instanceof ProviderAuthError) return "PROVIDER_AUTH_FAILED";
    if (err.code === "MODEL_BAD_RESPONSE" && err.cause instanceof ProviderBadResponseError) return "PROVIDER_BAD_RESPONSE";
  }
  return "INTERNAL_ERROR";
}

export class LanAuthenticationError extends Error {
  constructor() {
    super(LAN_AUTH_ERROR_MESSAGE);
    this.name = "LanAuthenticationError";
  }
}

export class LanProtocolError extends Error {
  readonly code: WireErrorCode | "PROTOCOL";
  constructor(code: WireErrorCode | "PROTOCOL", detail: string) {
    super(LAN_PROTOCOL_ERROR_MESSAGE + ": " + detail);
    this.name = "LanProtocolError";
    this.code = code;
  }
}

export function throwForWireCode(code: WireErrorCode): never {
  if (code === "PROVIDER_TIMEOUT") throw new ProviderTimeoutError("lan provider timed out");
  if (code === "PROVIDER_UNAVAILABLE") throw new ProviderUnavailableError("lan provider is unavailable");
  if (code === "PROVIDER_AUTH_FAILED") throw new ProviderAuthError("lan provider rejected authentication");
  if (code === "PROVIDER_BAD_RESPONSE") throw new ProviderBadResponseError("lan provider returned a malformed response");
  if (code === "UNAUTHORIZED") throw new LanAuthenticationError();
  throw new LanProtocolError(code, "lan request failed");
}
