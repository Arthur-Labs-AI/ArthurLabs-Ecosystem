/**
 * Canonical JSON for cryptographic hashes/signatures (SC-02 section 11).
 *
 * Approval code must never use ad-hoc `JSON.stringify()` as a security
 * primitive: key order would change the digest of identical arguments.
 * This module implements the deterministic JCS subset (RFC 8785 style) needed
 * for hash/signature use cases over JSON-safe snapshots:
 *
 * - objects: keys sorted by UTF-16 code-unit order, duplicates impossible
 *   (snapshots are plain objects), value order follows sorted keys;
 * - arrays: order preserved;
 * - strings: JSON string escaping (JSON.stringify is already canonical for
 *   the string grammar subset we accept);
 * - numbers: finite only; -0 normalizes to 0; NaN/Infinity are rejected;
 * - primitives: null, booleans;
 * - everything else (undefined, functions, symbols, bigints, non-plain
 *   objects, cycles) is rejected fail-closed.
 *
 * Inputs MUST already be JSON-safe snapshots (see `snapshotJsonSafe`); this
 * layer only guarantees a stable serialization for what crossed the boundary.
 */

import { createHash } from "node:crypto";

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError("canonical JSON rejects non-finite numbers");
      }
      const normalized = Object.is(value, -0) ? 0 : (value as number);
      return JSON.stringify(normalized) as string;
    }
    case "string":
      return JSON.stringify(value) as string;
    case "object": {
      const obj = value as object;
      if (seen.has(obj)) {
        throw new CanonicalJsonError("canonical JSON rejects cyclic structures");
      }
      seen.add(obj);
      try {
        if (Array.isArray(value)) {
          const parts = (value as unknown[]).map((el) => serialize(el, seen));
          return "[" + parts.join(",") + "]";
        }
        if (!isPlainObject(value)) {
          throw new CanonicalJsonError("canonical JSON accepts only plain objects and arrays");
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new CanonicalJsonError("canonical JSON rejects symbol-keyed properties");
        }
        const keys = Object.keys(value).sort();
        const parts = keys.map((key) => {
          const child = (value as Record<string, unknown>)[key];
          if (child === undefined) {
            throw new CanonicalJsonError("canonical JSON rejects undefined values");
          }
          return (JSON.stringify(key) as string) + ":" + serialize(child, seen);
        });
        return "{" + parts.join(",") + "}";
      } finally {
        seen.delete(obj);
      }
    }
    default:
      throw new CanonicalJsonError("canonical JSON rejects values of type " + typeof value);
  }
}

/** Deterministic canonical serialization of a JSON-safe value. */
export function canonicalizeJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

/** SHA-256 (hex) over the canonical serialization. */
export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}
