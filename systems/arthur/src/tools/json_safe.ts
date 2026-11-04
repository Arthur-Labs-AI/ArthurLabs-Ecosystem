/**
 * JSON-safety boundary for tool contracts (TASK-0010; hardened by the
 * TASK-0010 follow-up "Close ToolResult Descriptor/TOCTOU Boundary").
 *
 * Tool manifests (schemas) and tool results (`ToolResult.data`) must be
 * plain, JSON-serializable data. Anything that JSON.stringify would silently
 * drop, coerce, or throw on is rejected here instead - fail closed, with a
 * reason that names only the TYPE and PATH, never the value itself.
 *
 * Descriptor-level rules (the TOCTOU fix): every object is inspected through
 * its OWN PROPERTY DESCRIPTORS, and each accepted property value is read
 * exactly once (from the captured descriptor). Rejected outright:
 * - accessor descriptors (get/set) - a getter can never show one value to
 *   the validator and a different value to a later consumer
 * - non-enumerable own properties - JSON silently omits them
 * - symbol-keyed properties - JSON silently omits them
 * - arrays with exotic own properties (anything beyond canonical indices and
 *   `length`), accessor indices, non-enumerable indices, indices beyond
 *   `length`, or holes (sparse arrays - JSON silently emits null)
 * - class-derived arrays / non-plain prototypes
 *
 * The snapshot produced by `snapshotJsonSafe` is a fresh, canonical
 * (key-sorted) plain-data copy built exclusively from the values captured
 * during validation, so later mutation of the executor-owned object graph
 * can never change what crossed the boundary.
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

function isCanonicalArrayIndex(key: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  return Number(key) <= 4294967294; // 2^32 - 2
}

function assertDataDescriptor(label: string, path: string, key: string, descriptor: PropertyDescriptor): void {
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new JsonSafeError(label + " at " + path + "." + key + " is an accessor property (get/set are rejected)");
  }
  if (!descriptor.enumerable) {
    throw new JsonSafeError(label + " at " + path + "." + key + " is a non-enumerable own property");
  }
}

function snapshotArray(
  value: unknown[],
  label: string,
  path: string,
  seen: Set<object>,
): unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new JsonSafeError(label + " at " + path + " is a class-derived array (non-plain prototype)");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new JsonSafeError(label + " at " + path + " contains symbol-keyed properties");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || lengthDescriptor.get !== undefined || lengthDescriptor.set !== undefined) {
    throw new JsonSafeError(label + " at " + path + " has an invalid length property");
  }
  const length = lengthDescriptor.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new JsonSafeError(label + " at " + path + " has an invalid array length");
  }
  seen.add(value);
  const out: unknown[] = [];
  const filled = new Array<boolean>(length).fill(false);
  // getOwnPropertyDescriptors exposes EVERY own property name (including
  // non-enumerable ones), so exotic extras cannot hide behind enumerability.
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length") continue;
    if (!isCanonicalArrayIndex(key)) {
      throw new JsonSafeError(label + " at " + path + " has an exotic own property (" + key + " is not an array index)");
    }
    assertDataDescriptor(label, path, key, descriptor);
    const index = Number(key);
    if (index >= length) {
      throw new JsonSafeError(label + " at " + path + " has an index beyond its length");
    }
    const element = descriptor.value;
    if (element === undefined) {
      throw new JsonSafeError(label + " contains an undefined array element at " + path + "[" + index + "]");
    }
    out[index] = snapshotJsonSafe(element, label, path + "[" + index + "]", seen);
    filled[index] = true;
  }
  for (let i = 0; i < length; i += 1) {
    if (!filled[i]) {
      throw new JsonSafeError(label + " is a sparse array (missing element " + i + " at " + path + ")");
    }
  }
  seen.delete(value);
  return out;
}

/**
 * Validate `value` and return a canonical plain-data snapshot in ONE pass.
 * Each accepted property is read exactly once (via its captured descriptor),
 * so a getter can never produce different values for validation and
 * consumption - and the returned graph shares no structure with the input.
 * Throws JsonSafeError (with type/path-only details) on any violation.
 */
export function snapshotJsonSafe(value: unknown, label: string, path = "$", seen?: Set<object>): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new JsonSafeError(label + " at " + path + " is not a finite JSON number");
      }
      return value;
    case "object": {
      const obj = value as object;
      if (seen?.has(obj)) {
        throw new JsonSafeError(label + " contains a cyclic structure at " + path);
      }
      const ancestors = seen ?? new Set<object>();
      if (Array.isArray(value)) {
        return snapshotArray(value, label, path, ancestors);
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new JsonSafeError(
          label + " at " + path + " is not a plain JSON object (got " + (value.constructor?.name ?? typeName(value)) + ")",
        );
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new JsonSafeError(label + " at " + path + " contains symbol-keyed properties");
      }
      ancestors.add(obj);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const out: Record<string, unknown> = {};
      // Canonical snapshot: keys visited in sorted order. Symbol keys were
      // rejected above; entries() covers every own string key, enumerable or not.
      const sortedEntries = Object.entries(descriptors).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [key, descriptor] of sortedEntries) {
        assertDataDescriptor(label, path, key, descriptor);
        const child = descriptor.value;
        if (child === undefined) {
          throw new JsonSafeError(label + " contains an undefined value at " + path + "." + key);
        }
        out[key] = snapshotJsonSafe(child, label, path + "." + key, ancestors);
      }
      ancestors.delete(obj);
      return out;
    }
    default:
      // function, symbol, bigint, undefined, and any other exotic type.
      throw new JsonSafeError(label + " at " + path + " is not JSON-safe (type " + typeName(value) + ")");
  }
}

/**
 * Validate-only variant used for tool manifest schemas: same fail-closed
 * descriptor-level rules, snapshot discarded.
 */
export function assertJsonSafe(value: unknown, label: string): void {
  snapshotJsonSafe(value, label);
}
