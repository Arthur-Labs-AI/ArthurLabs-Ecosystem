/**
 * Text normalization (spec sections 24, 25).
 *
 * Canonical text is normalized before hashing, chunking, and deduplication so
 * re-ingestion and equivalence checks are stable.
 */

export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Deterministic equality key used for dedupe/collapse. */
export function normalizeForCompare(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
