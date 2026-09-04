/**
 * Bounded structured model payload for completed tool results (TASK-0011B).
 *
 * The model-facing role=tool message for a completed tool is a JSON object
 * that carries the sanitized summary PLUS the validated structured data:
 *
 *   { "summary": "<capped summary>", "data": { ...validated snapshot... } }
 *
 * Invariants:
 * - `data` crossed the ToolExecutionService boundary first: it is already a
 *   fresh, canonical, JSON-safe plain-data snapshot validated against the
 *   tool's output_schema (TASK-0010). The raw executor result never reaches
 *   this module.
 * - The payload is sanitized again here with the existing SecretSanitizer
 *   semantics: the summary through capSummary, the structured data through a
 *   recursive redaction walk. Sanitization rebuilds the graph as fresh plain
 *   objects, so the payload shares no structure with any executor-owned
 *   object and cannot carry getters, functions, or accessors.
 * - The payload is bounded. If the serialized payload exceeds the cap, the
 *   data is omitted WHOLE - the JSON string is never cut mid-payload:
 *
 *   { "summary": "<capped summary>", "data_omitted": true,
 *     "reason": "tool_result_payload_too_large" }
 *
 *   The summary always survives. Future large-result tools should paginate or
 *   produce artifacts instead of relying on unbounded context injection.
 */

import { Buffer } from "node:buffer";

import type { ToolResult } from "./contracts";
import type { SecretSanitizer } from "../security/sanitize";

/**
 * Hard bound for one model-facing tool-result message (TASK-0011B).
 *
 * 16 KiB per completed tool result. This is a module-level bounded constant
 * like TOOL_RESULT_SUMMARY_MAX_CHARS in execution.ts; production overrides
 * can be injected through ToolOrchestratorDeps.modelToolResultMaxBytes.
 */
export const MODEL_TOOL_RESULT_MAX_BYTES = 16 * 1024;

/** Stable omission reason carried by the safe marker payload. */
export const TOOL_RESULT_PAYLOAD_TOO_LARGE = "tool_result_payload_too_large";

/**
 * Build the model-facing tool-result content string for a VALIDATED
 * ToolResult (as returned by ToolExecutionService). The input must already
 * be the boundary-validated snapshot; this function only sanitizes, bounds,
 * and serializes it.
 */
export function buildModelToolResultPayload(
  result: ToolResult,
  sanitizer: SecretSanitizer,
  maxBytes: number = MODEL_TOOL_RESULT_MAX_BYTES,
): string {
  const summary = sanitizer.capSummary(result.summary);

  const payload: Record<string, unknown> = { summary };
  if (result.data !== undefined) {
    // Recursive redaction with the existing sanitizer semantics. The walk
    // rebuilds every object/array it visits, so the serialized payload is
    // plain JSON data detached from the validated snapshot graph.
    payload.data = sanitizer.sanitizeValue(result.data);
  }

  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    // Never cut a JSON string mid-payload: drop the data whole and keep the
    // summary. The omission payload is bounded by the summary cap itself, so
    // it always fits.
    return JSON.stringify({
      summary,
      data_omitted: true,
      reason: TOOL_RESULT_PAYLOAD_TOO_LARGE,
    });
  }
  return json;
}
