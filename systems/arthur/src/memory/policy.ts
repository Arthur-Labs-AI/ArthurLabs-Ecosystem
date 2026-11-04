/**
 * Memory write policy (spec sections 18, 20.1, 32).
 *
 * Decides what may be persisted and when. Secret safety is enforced here,
 * before any persistence or embedding: content that the Phase 1 redaction
 * boundary would alter is rejected outright rather than stored "sanitized
 * only" — the raw value must never reach a store or an embedding call.
 */

import { redactText } from "../security/redaction";

/** Credential-shaped content that must never be persisted or embedded. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /sk-[A-Za-z0-9_-]{8,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
];

/** True when free-form text contains credential-like content. */
export function hasSecretLikeContent(text: string): boolean {
  if (!text) return false;
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) return true;
  // Anything the centralized redaction boundary would alter is secret-like.
  return redactText(text, []) !== text;
}

/** Stronger: text that is *primarily* a secret (short credential blob). */
export function isCredentialBlob(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 8 || trimmed.length > 200) return false;
  return /^[A-Za-z0-9_\-]{16,}$/.test(trimmed) || /^Bearer\s+/.test(trimmed);
}

export interface CandidateWritePolicy {
  confidenceThreshold: number;
  importanceThreshold: number;
  minCandidateChars: number;
  maxCandidateChars: number;
}

export const DEFAULT_CANDIDATE_POLICY: CandidateWritePolicy = {
  confidenceThreshold: 0.6,
  importanceThreshold: 0.2,
  minCandidateChars: 12,
  maxCandidateChars: 2000,
};

export type CandidateVerdict =
  | { action: "store" }
  | { action: "reject"; reason: "secret" | "too_short" | "too_long" }
  | { action: "skip"; reason: "low_confidence" | "low_importance" | "should_store_false" | "too_short" };

export interface CandidateLike {
  text: string;
  confidence: number;
  importance: number;
  should_store: boolean;
}

/** Policy gate for extraction candidates (spec section 20.1). */
export function decideCandidate(
  candidate: CandidateLike,
  policy: CandidateWritePolicy = DEFAULT_CANDIDATE_POLICY,
): CandidateVerdict {
  if (!candidate.should_store) return { action: "skip", reason: "should_store_false" };
  const text = candidate.text?.trim() ?? "";
  if (!text) return { action: "skip", reason: "should_store_false" };
  if (hasSecretLikeContent(text) || isCredentialBlob(text)) {
    return { action: "reject", reason: "secret" };
  }
  if (text.length < policy.minCandidateChars) return { action: "skip", reason: "too_short" };
  if (text.length > policy.maxCandidateChars) return { action: "reject", reason: "too_long" };
  if (candidate.confidence < policy.confidenceThreshold) return { action: "skip", reason: "low_confidence" };
  if (candidate.importance < policy.importanceThreshold) return { action: "skip", reason: "low_importance" };
  return { action: "store" };
}

/** TEMPORARY memories get a TTL; others live until superseded/forgotten. */
export function expiryForType(type: string, temporaryTtlSeconds: number, now = new Date()): string | undefined {
  if (type === "TEMPORARY" && temporaryTtlSeconds > 0) {
    return new Date(now.getTime() + temporaryTtlSeconds * 1000).toISOString();
  }
  return undefined;
}