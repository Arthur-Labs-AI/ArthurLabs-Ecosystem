/**
 * HR-03D: bearer-token extraction + constant-time comparison.
 *
 * Tokens travel ONLY in the Authorization header (never query/body/logs).
 * Both sides hash to fixed-size digests before timingSafeEqual so token
 * length does not leak through the compare path. No default token.
 */

export const LAN_AUTH_HEADER = "authorization";

export const LAN_BEARER_PREFIX = "Bearer ";

import { createHash, timingSafeEqual } from "node:crypto";

function sha256Hex(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

export function extractBearerToken(headerValue: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== "string" || !raw.startsWith(LAN_BEARER_PREFIX)) return undefined;
  const token = raw.slice(LAN_BEARER_PREFIX.length);
  if (token === "" || token.length > 4096) return undefined;
  return token;
}

export function tokensEqualConstantTime(supplied: string, expected: string): boolean {
  if (typeof supplied !== "string" || typeof expected !== "string") return false;
  if (supplied === "" || expected === "") return false;
  const left = sha256Hex(supplied);
  const right = sha256Hex(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
