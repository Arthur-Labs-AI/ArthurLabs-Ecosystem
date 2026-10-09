/**
 * SC-04 typed capability errors (spec sections 61-63).
 *
 * Capability adapters throw these stable codes; tool executors let them
 * pass through the secured execution boundary unchanged (they are
 * ArthurErrors, so both execution services rethrow them verbatim).
 * Raw OS errors never cross to the model, client, or persistent result.
 */

import { ArthurError } from "../core/errors/errors";

/** Logical filesystem identity only: never a physical absolute path. */
function pathDetails(rootId: string, path: string): { details: Record<string, unknown>; exposeDetails: true } {
  return { details: { root_id: rootId, path: path }, exposeDetails: true };
}

export function scopeViolation(rootId: string, path: string): ArthurError {
  return new ArthurError(
    "TOOL_SCOPE_VIOLATION",
    "Path is outside the permitted scope (root_id: " + rootId + ", path: " + path + ")",
    pathDetails(rootId, path),
  );
}

export function resourceNotFound(rootId: string, path: string): ArthurError {
  return new ArthurError(
    "TOOL_RESOURCE_NOT_FOUND",
    "Resource not found (root_id: " + rootId + ", path: " + path + ")",
    pathDetails(rootId, path),
  );
}

export function resourceUnsupported(reason: string, rootId?: string, path?: string): ArthurError {
  const details: Record<string, unknown> =
    rootId !== undefined && path !== undefined ? { root_id: rootId, path: path } : {};
  return new ArthurError("TOOL_RESOURCE_UNSUPPORTED", reason, { details: details, exposeDetails: true });
}

export function capabilityUnavailable(capability: string, reason?: string): ArthurError {
  const message = reason ? capability + " is unavailable: " + reason : capability + " is unavailable";
  return new ArthurError("TOOL_CAPABILITY_UNAVAILABLE", message, {
    details: { capability: capability },
    exposeDetails: true,
  });
}

export function launchFailed(target: string): ArthurError {
  return new ArthurError("TOOL_EXECUTION_FAILED", "Launch failed: " + target, {
    details: { target: target },
    exposeDetails: true,
  });
}
