/**
 * FTS keyword search (spec section 14).
 *
 * FTS query generation is defensive: user text is never inserted as raw SQL
 * or raw FTS syntax. Only unicode letters/digits survive; every term is quoted
 * and prefixed, and the full cleaned phrase is tried as an exact phrase.
 */

/**
 * Build a safe FTS5 MATCH expression from free-form user text.
 * Returns "" when there is nothing searchable (no tokens).
 *
 * The conjunction is OR-based (recall-first): a user query rarely contains
 * only terms present verbatim in one memory, and RRF + the reranker restore
 * precision afterwards. The full cleaned phrase is always tried first.
 */
export function buildFtsQuery(text: string): string {
  const cleaned = (text ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return "";
  const terms = cleaned.split(" ");
  if (terms.length === 1) {
    return `"${terms[0]}"*`;
  }
  const phrase = `"${cleaned}"`;
  const disjunction = terms.map((term) => `"${term}"*`).join(" OR ");
  return `(${phrase} OR ${disjunction})`;
}
