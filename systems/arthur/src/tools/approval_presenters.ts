/**
 * Trusted server-side approval presentations (SC-02 sections 15-18).
 *
 * Model-generated text is NEVER the approval prompt. Each approval_required
 * tool must provide a bounded trusted presenter that renders only the
 * significant action data; the exact presentation the user saw is persisted
 * and its digest enters ApprovalIntentV2 (what-will-execute + what-user-saw).
 *
 * Presentations pass through JSON-safe validation, secret sanitization, and
 * size bounds. They never contain API keys/tokens/passwords/raw environment,
 * huge payloads, or arbitrary model-generated prose.
 */

import { JsonSafeError, snapshotJsonSafe } from "./json_safe";
import type { SecretSanitizer } from "../security/sanitize";
import type { ApprovalPresentation, ApprovalPresenter } from "./approval_intent";

export const PRESENTATION_ACTION_MAX_CHARS = 200;
export const PRESENTATION_DETAILS_MAX = 12;
export const PRESENTATION_LABEL_MAX_CHARS = 80;
export const PRESENTATION_VALUE_MAX_CHARS = 500;
export const PRESENTATION_WARNING_MAX_CHARS = 300;

export function presentationInvalid(reason: string): Error {
  return new Error("Invalid approval presentation: " + reason);
}

function requirePlainRecord(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw presentationInvalid("presentation must be a plain object");
  }
}

/** Validate + bound a presenter-produced presentation; returns a fresh snapshot. */
export function validatePresentation(raw: unknown, sanitizer: SecretSanitizer): ApprovalPresentation {
  let snapshot: unknown;
  try {
    snapshot = snapshotJsonSafe(raw, "ApprovalPresentation");
  } catch (err) {
    if (err instanceof JsonSafeError) throw presentationInvalid(err.message);
    throw err;
  }
  requirePlainRecord(snapshot);
  const { action, details, warning } = snapshot as Record<string, unknown>;
  if (typeof action !== "string" || action.trim().length === 0) {
    throw presentationInvalid("action must be a non-empty string");
  }
  if (action.length > PRESENTATION_ACTION_MAX_CHARS) {
    throw presentationInvalid("action exceeds " + PRESENTATION_ACTION_MAX_CHARS + " characters");
  }
  if (!Array.isArray(details)) throw presentationInvalid("details must be an array");
  if (details.length > PRESENTATION_DETAILS_MAX) {
    throw presentationInvalid("details exceeds " + PRESENTATION_DETAILS_MAX + " entries");
  }
  const safeDetails = details.map((entry) => {
    requirePlainRecord(entry);
    const { label, value } = entry as Record<string, unknown>;
    if (typeof label !== "string" || label.trim().length === 0) throw presentationInvalid("detail label must be non-empty");
    if (typeof value !== "string") throw presentationInvalid("detail value must be a string");
    if (label.length > PRESENTATION_LABEL_MAX_CHARS) throw presentationInvalid("detail label too long");
    if (value.length > PRESENTATION_VALUE_MAX_CHARS) throw presentationInvalid("detail value too long");
    return { label: sanitizer.sanitizeText(label), value: sanitizer.sanitizeText(value) };
  });
  const safeAction = sanitizer.sanitizeText(action);
  let safeWarning: string | undefined;
  if (warning !== undefined) {
    if (typeof warning !== "string" || warning.length === 0) throw presentationInvalid("warning must be a non-empty string when present");
    if (warning.length > PRESENTATION_WARNING_MAX_CHARS) throw presentationInvalid("warning too long");
    safeWarning = sanitizer.sanitizeText(warning);
  }
  const presentation: ApprovalPresentation = { action: safeAction, details: safeDetails };
  if (safeWarning !== undefined) presentation.warning = safeWarning;
  return presentation;
}

function summarizeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 120 ? value.slice(0, 120) + "\u2026(truncated)" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[" + value.length + " items]";
  return "{object}";
}

export function genericPresenter(action: string, warning?: string): ApprovalPresenter {
  return (args) => {
    const details = Object.keys(args)
      .sort()
      .slice(0, PRESENTATION_DETAILS_MAX)
      .map((key) => ({ label: key, value: summarizeValue(args[key]) }));
    return warning ? { action, details, warning } : { action, details };
  };
}

export function harnessCreateJobPresenter(): ApprovalPresenter {
  return (args) => ({
    action: "Create AI Harness job",
    details: [{ label: "Job type", value: summarizeValue(args["kind"]) }],
    warning: "This will create a new Harness job.",
  });
}
