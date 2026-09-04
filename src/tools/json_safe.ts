/**
 * JSON-safety boundary for tool contracts (TASK-0010).
 *
 * Tool manifests (schemas) and tool results (`ToolResult.data`) must be
 * plain, JSON-serializable data. Anything that JSON.stringify would silently
 * drop, coerce, or throw on is rejected here instead - fail closed, with a
 * reason that names only the TYPE and PATH, never the value itself.
 */

export class JsonSafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonSafeError";
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Assert that `value` is JSON-safe: plain objects/arrays/strings/booleans,
 * finite numbers, and null only.
 *
 * Rejected (each would be silently dropped, coerced, or thrown on by
 * JSON.stringify):
 * - functions, symbols, BigInt, undefined
 * - non-finite numbers (NaN / Infinity become null on JSON.stringify)
 * - non-plain objects (Date, Map, Set, RegExp, class instances, boxed
 *   primitives) - arbitrary native objects never cross the boundary
 * - symbol-keyed properties and cyclic structures
 */
export function assertJsonSafe(value: unknown, label: string, path = "$", ancestors?: Set<object>): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new JsonSafeError(label + " at " + path + " is not a finite JSON number");
      }
      return;
    case "object": {
      const obj = value as object;
      if (ancestors?.has(obj)) {
        throw new JsonSafeError(label + " contains a cyclic structure at " + path);
      }
      const seen = ancestors ?? new Set<object>();
      if (Array.isArray(value)) {
        seen.add(obj);
        for (let i = 0; i < value.length; i += 1) {
          const element = value[i];
          if (element === undefined) {
            throw new JsonSafeError(label + " contains an undefined array element at " + path + "[" + i + "]");
          }
          assertJsonSafe(element, label, path + "[" + i + "]", seen);
        }
        seen.delete(obj);
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new JsonSafeError(
          label + " at " + path + " is not a plain JSON object (got " + (value.constructor?.name ?? typeName(value)) + ")",
        );
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new JsonSafeError(label + " contains symbol-keyed properties at " + path);
      }
      seen.add(obj);
      for (const [key, element] of Object.entries(value as Record<string, unknown>)) {
        if (element === undefined) {
          throw new JsonSafeError(label + " contains an undefined value at " + path + "." + key);
        }
        assertJsonSafe(element, label, path + "." + key, seen);
      }
      seen.delete(obj);
      return;
    }
    default:
      // function, symbol, bigint, undefined, and any other exotic type.
      throw new JsonSafeError(label + " at " + path + " is not JSON-safe (type " + typeName(value) + ")");
  }
}
