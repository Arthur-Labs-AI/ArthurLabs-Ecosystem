/**
 * SC-04 browser URL policy (spec sections 53-55, 58).
 *
 * browser.open_url is a user-visible navigation action, not an HTTP
 * client: ARTHUR never fetches the URL server-side. Only http/https
 * survive validation; credentials, control characters, and oversized
 * inputs fail closed. Localhost URLs stay allowed (dev workflows).
 */

export const MAX_URL_CHARS = 4096;

/** Validate a model-proposed URL; return its canonical form. */
export function validateBrowserUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("URL must be a string");
  if (raw.length === 0) throw new Error("URL must not be empty");
  if (raw.length > MAX_URL_CHARS) throw new Error("URL exceeds 4096 characters");
  if (/[\u0000-\u001F\u007F]/.test(raw)) throw new Error("URL contains control characters");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Malformed URL");
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    throw new Error("Only http and https URLs may be opened");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("URLs with embedded credentials may not be opened");
  }
  return parsed.toString();
}
