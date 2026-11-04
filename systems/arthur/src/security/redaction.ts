/**
 * Secret redaction (spec sections 7, 18).
 *
 * Applied defensively before logs and before outbound payload assembly so that
 * known secrets can never leak into logs, responses, the database, or prompts.
 */

const REDACTED = "[REDACTED]";

// Generic patterns as a safety net, independent of the configured secrets.
const GENERIC_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g, // common "sk-..." API key shape
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub personal/OAuth/app token families
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PATs
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Authorization bearer tokens
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

// JSON-ish quoted assignments ("api_key": "value with spaces"): the whole
// quoted value is redacted, so multi-word secrets inside JSON-shaped text
// cannot leak (audit F1).
const SECRET_JSON_ASSIGNMENT_RE =
  /(["'])([A-Za-z0-9_.-]*?(?:api[_-]?key|apikey|secret|password|passwd|token|authorization|auth)(?![A-Za-z0-9_.-]))\1([ \t]*[:=][ \t]*)(["'])([^"'\n]*?)\4/gi;

// key=value / key: value forms for secret-like keys, so pasted credentials such
// as "DEEPSEEK_API_KEY=..." or "password=hunter2" are redacted even when the
// value itself is not a known secret (audit HIGH 5). The separator tolerates
// optional surrounding quotes and whitespace, so JSON-shaped assignments like
// "api_key": "value" and "api_key" : "value" are caught too (audit F1).
const SECRET_ASSIGNMENT_RE =
  /([A-Za-z0-9_.-]*?(?:api[_-]?key|apikey|secret|password|passwd|token|authorization|auth)(?![A-Za-z0-9_.-]))([ \t]*["']?[ \t]*[:=][ \t]*["']?[ \t]*)([^\s"',;]+)/gi;

export function redactText(text: string, secrets: readonly string[]): string {
  if (!text) return text;
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      // Escape for use in a RegExp, then replace literally.
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(escaped, "g"), REDACTED);
    }
  }
  for (const pattern of GENERIC_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  out = out.replace(SECRET_JSON_ASSIGNMENT_RE, "$1$2$1$3$4[REDACTED]$4");
  out = out.replace(SECRET_ASSIGNMENT_RE, "$1$2[REDACTED]");
  return out;
}

/** Redact string values (and secret-looking keys) recursively. */
export function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, secrets));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const safeKey = redactText(key, secrets);
      out[safeKey] = isSecretLikeKey(key) ? REDACTED : redactDeep(val, secrets);
    }
    return out;
  }
  return value;
}

export function isSecretLikeKey(key: string): boolean {
  const lower = key.toLowerCase();
  const segments = lower.split(/[^a-z0-9]+/).filter(Boolean);
  return (
    /api[_-]?key/.test(lower) ||
    lower.includes("apikey") ||
    /private[_-]?key/.test(lower) ||
    lower.includes("privatekey") ||
    segments.some((segment) =>
      segment === "secret" ||
      segment === "password" ||
      segment === "passwd" ||
      segment === "authorization" ||
      segment === "auth"
    ) ||
    lower.endsWith("secret") ||
    lower.endsWith("password") ||
    lower.endsWith("passwd") ||
    lower.endsWith("token") ||
    lower.endsWith("authorization")
  );
}
