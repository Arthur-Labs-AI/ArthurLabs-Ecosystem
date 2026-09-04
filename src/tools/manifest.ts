/**
 * Registration-time manifest validation (TASK-0010, task sections 2 and 8).
 *
 * A ToolDefinition is the canonical, model-visible manifest. It is validated
 * as a whole when it is registered, so a malformed tool can never enter the
 * registry (and therefore never the model tool schemas) and can never fail
 * later during a user turn. Registration failures are deterministic
 * INVALID_CONFIG ArthurErrors naming the offending manifest field.
 */

import { ArthurError } from "../core/errors/errors";
import { isArthurMode } from "../core/modes/mode";
import type { ToolDefinition, ToolRisk } from "./contracts";
import { assertJsonSafe, JsonSafeError } from "./json_safe";

/**
 * Canonical dotted tool identity, e.g. `system.echo`, `filesystem.read`,
 * `git.status`. Lowercase segments, at least two segments, no spaces, no
 * shell syntax, no arbitrary Unicode identifiers.
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Strict MAJOR.MINOR.PATCH triplet. No prerelease/build tags, no `v` prefix,
 * no zero padding ("01.0.0"). Invalid versions are rejected, never normalized.
 */
export const TOOL_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Hard bound for the canonical tool name. */
export const MAX_TOOL_NAME_CHARS = 128;

/**
 * Hard bound for the description: it is sent to the LLM on every request,
 * so absurdly large descriptions must fail registration.
 */
export const MAX_TOOL_DESCRIPTION_CHARS = 2000;

const TOOL_RISKS: readonly ToolRisk[] = ["read", "low_write", "approval_required", "high_risk"];

const REQUIRED_FIELDS: readonly string[] = [
  "name",
  "version",
  "description",
  "input_schema",
  "risk",
  "allowed_modes",
];

const MANIFEST_FIELDS: readonly string[] = [...REQUIRED_FIELDS, "output_schema"];

export function toolManifestInvalid(field: string, reason: string): ArthurError {
  return new ArthurError("INVALID_CONFIG", "Invalid tool manifest: " + field + ": " + reason, {
    details: { field },
    exposeDetails: true,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate a tool manifest exactly as given (never normalized, never mutated).
 * Throws a deterministic INVALID_CONFIG ArthurError on the first violation.
 */
export function validateToolDefinition(definition: unknown): void {
  if (!isPlainObject(definition)) {
    throw toolManifestInvalid("definition", "must be a plain object");
  }
  if (Object.getOwnPropertySymbols(definition).length > 0) {
    throw toolManifestInvalid("definition", "contains symbol-keyed properties");
  }
  // Descriptor-level scan of the manifest itself (TASK-0010 follow-up): a
  // getter or non-enumerable field could show one value to validation and
  // another to the runtime; every manifest field must be an ordinary own
  // enumerable data property.
  const allowedFields = new Set<string>(MANIFEST_FIELDS);
  const descriptors = Object.getOwnPropertyDescriptors(definition) as Record<string, PropertyDescriptor>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowedFields.has(key)) {
      throw toolManifestInvalid(key, "unknown manifest field");
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw toolManifestInvalid(key, "must be an ordinary data property (accessors are rejected)");
    }
    if (!descriptor.enumerable) {
      throw toolManifestInvalid(key, "must be an enumerable own property");
    }
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in definition) || definition[field] === undefined) {
      throw toolManifestInvalid(field, "required field is missing");
    }
  }

  const { name, version, description, input_schema, output_schema, risk, allowed_modes } =
    definition as ToolDefinition & Record<string, unknown>;

  if (typeof name !== "string") throw toolManifestInvalid("name", "must be a string");
  if (name.length === 0 || name.length > MAX_TOOL_NAME_CHARS) {
    throw toolManifestInvalid("name", "must be 1.." + MAX_TOOL_NAME_CHARS + " characters");
  }
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw toolManifestInvalid(
      "name",
      'must match ' + TOOL_NAME_PATTERN.source + ' (canonical dotted identifier, e.g. "git.status")',
    );
  }

  if (typeof version !== "string") throw toolManifestInvalid("version", "must be a string");
  if (!TOOL_VERSION_PATTERN.test(version)) {
    throw toolManifestInvalid(
      "version",
      'must be a MAJOR.MINOR.PATCH triplet (e.g. "1.0.0"), got "' + version + '"',
    );
  }

  if (typeof description !== "string") throw toolManifestInvalid("description", "must be a string");
  if (description.trim().length === 0) {
    throw toolManifestInvalid("description", "must not be empty");
  }
  if (description.length > MAX_TOOL_DESCRIPTION_CHARS) {
    throw toolManifestInvalid(
      "description",
      "must not exceed " + MAX_TOOL_DESCRIPTION_CHARS + " characters (it is sent to the model)",
    );
  }

  if (!Array.isArray(allowed_modes) || allowed_modes.length === 0) {
    throw toolManifestInvalid("allowed_modes", "must be a non-empty array");
  }
  const seenModes = new Set<string>();
  for (const mode of allowed_modes as unknown[]) {
    if (!isArthurMode(mode)) {
      throw toolManifestInvalid("allowed_modes", "contains an invalid ArthurMode: " + JSON.stringify(mode));
    }
    if (seenModes.has(mode)) {
      throw toolManifestInvalid("allowed_modes", 'contains duplicate mode "' + mode + '"');
    }
    seenModes.add(mode);
  }

  if (!(TOOL_RISKS as readonly unknown[]).includes(risk)) {
    throw toolManifestInvalid("risk", "must be one of " + TOOL_RISKS.join(", "));
  }

  for (const entry of [
    ["input_schema", input_schema],
    ["output_schema", output_schema],
  ] as const) {
    const field = entry[0];
    const schema = entry[1];
    if (schema === undefined) continue;
    if (!isPlainObject(schema)) {
      throw toolManifestInvalid(field, "must be a JSON-schema object");
    }
    try {
      assertJsonSafe(schema, field);
    } catch (err) {
      if (err instanceof JsonSafeError) {
        throw toolManifestInvalid(field, err.message);
      }
      throw err;
    }
  }
}
