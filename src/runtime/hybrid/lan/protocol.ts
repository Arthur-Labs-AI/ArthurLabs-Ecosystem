/**
 * HR-03D: versioned LAN model transport protocol (MODEL TRANSPORT ONLY).
 *
 * One host may serve multiple explicit gateways; the URL provider id
 * selects the exact server-side gateway (never request.model, prompt, or
 * body metadata). Envelopes carry protocol_version (no silent downgrade)
 * and an opaque per-attempt request_id echoed by the server. Auth is a
 * pre-shared bearer token, constant-time compared, never in bodies/logs.
 */

export const ARTHUR_LAN_PROTOCOL_VERSION = 1;
export const LAN_INFO_PATH = "/v1/runtime/info";
export const LAN_NDJSON_CONTENT_TYPE = "application/x-ndjson";
export const LAN_JSON_CONTENT_TYPE = "application/json";

export const WIRE_ERROR_CODES = [
  "UNAUTHORIZED",
  "INVALID_REQUEST",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "PROVIDER_NOT_FOUND",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_BAD_RESPONSE",
  "INTERNAL_ERROR",
] as const;

export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];

export function isWireErrorCode(value: unknown): value is WireErrorCode {
  return typeof value === "string" && (WIRE_ERROR_CODES as readonly string[]).includes(value);
}

export interface LanRequestEnvelope {
  protocol_version: number;
  request_id: string;
  request: unknown;
}

export interface LanResultEnvelope {
  protocol_version: number;
  request_id: string;
  result: unknown;
}

export interface LanErrorBody {
  protocol_version: number;
  request_id: string;
  error: { code: WireErrorCode };
}

export type LanStreamFrame =
  | { type: "event"; request_id: string; event: unknown }
  | { type: "error"; request_id: string; error: { code: WireErrorCode } };

export function lanGeneratePath(providerId: string): string {
  return "/v1/runtime/models/" + encodeURIComponent(providerId) + "/generate";
}

export function lanStreamPath(providerId: string): string {
  return "/v1/runtime/models/" + encodeURIComponent(providerId) + "/stream";
}

export function isLanStreamFrame(value: unknown): value is LanStreamFrame {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw["type"] === "event") return typeof raw["request_id"] === "string" && raw["event"] !== undefined;
  if (raw["type"] === "error") {
    const err = raw["error"] as Record<string, unknown> | undefined;
    return typeof raw["request_id"] === "string" && err !== undefined && isWireErrorCode(err["code"]);
  }
  return false;
}
