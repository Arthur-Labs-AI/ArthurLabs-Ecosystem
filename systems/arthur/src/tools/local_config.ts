/**
 * SC-04 local capability configuration (spec section 64).
 *
 * Trusted startup configuration: filesystem scopes, application
 * catalog, and hard resource bounds. Invalid security config fails
 * startup (INVALID_CONFIG); a merely-missing optional app only flips
 * app.available to false (spec section 65).
 */

import * as path from "node:path";

import { validateFilesystemScope, type FilesystemScope } from "./scoped_path";

export const APP_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
export const MAX_APP_ID_CHARS = 64;

export interface ApplicationEntry {
  id: string;
  display_name: string;
  executable: string;
  args: string[];
  /** Windows-only shell verb (e.g. open); empty means direct spawn. */
  windows_verb?: string;
}

export interface LocalCapabilityConfig {
  filesystem_roots: FilesystemScope[];
  applications: ApplicationEntry[];
  filesystem_bounds: {
    list_limit_max: number;
    read_max_lines: number;
    read_max_bytes: number;
    search_max_results: number;
    search_max_files: number;
    search_max_bytes_per_file: number;
    search_max_total_bytes: number;
  };
}

export const DEFAULT_FILESYSTEM_BOUNDS: LocalCapabilityConfig["filesystem_bounds"] = {
  list_limit_max: 200,
  read_max_lines: 200,
  read_max_bytes: 12 * 1024,
  search_max_results: 50,
  search_max_files: 5000,
  search_max_bytes_per_file: 1024 * 1024,
  search_max_total_bytes: 50 * 1024 * 1024,
};

/** Validate one application catalog entry (fail closed). */
export function validateApplicationEntry(entry: unknown): asserts entry is ApplicationEntry {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Invalid application entry: must be a plain object");
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id.length === 0 || e.id.length > MAX_APP_ID_CHARS) {
    throw new Error("Invalid application entry: id must be 1..64 characters");
  }
  if (!APP_ID_PATTERN.test(e.id)) {
    throw new Error("Invalid application id: " + String(e.id));
  }
  if (typeof e.display_name !== "string" || e.display_name.trim().length === 0) {
    throw new Error("Invalid application entry: display_name must be non-empty");
  }
  if (typeof e.executable !== "string" || e.executable.trim().length === 0) {
    throw new Error("Invalid application entry: executable must be non-empty");
  }
  // SC-04 section 64: the executable is trusted startup config, never model
  // input. A relative executable would resolve against the server cwd and
  // invite path-confusion launches, so fail closed unless absolute.
  if (!path.isAbsolute(e.executable)) {
    throw new Error("Invalid application entry: executable must be an absolute trusted path");
  }
  if (e.executable.includes("\0")) throw new Error("Invalid application entry: executable contains NUL");
  if (!Array.isArray(e.args) || !e.args.every((a) => typeof a === "string")) {
    throw new Error("Invalid application entry: args must be a string array");
  }
  for (const a of e.args as string[]) {
    if (a.length === 0 || a.length > 4096) {
      throw new Error("Invalid application entry: fixed arg out of bounds");
    }
    if (a.includes("\0")) throw new Error("Invalid application entry: arg contains NUL");
  }
  if (e.windows_verb !== undefined && (typeof e.windows_verb !== "string" || e.windows_verb.length === 0)) {
    throw new Error("Invalid application entry: windows_verb must be a non-empty string");
  }
  // SC-04 section 64: no application entry may enable shell semantics.
  // Reject both a `shell` field of any value (including shell:true) and
  // legacy alias fields that would imply command-line launching.
  for (const banned of ["shell", "exec", "command", "cmdline"]) {
    if (banned in e) {
      throw new Error("Invalid application entry: forbidden field " + banned);
    }
  }
}

/** Fail-closed validation of the whole local capability config. */
export function validateLocalCapabilityConfig(config: unknown): asserts config is LocalCapabilityConfig {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Invalid local capability config: must be a plain object");
  }
  const c = config as Record<string, unknown>;
  if (!Array.isArray(c.filesystem_roots)) throw new Error("Invalid local config: filesystem_roots must be an array");
  if (!Array.isArray(c.applications)) throw new Error("Invalid local config: applications must be an array");
  const ids = new Set<string>();
  for (const scope of c.filesystem_roots as unknown[]) {
    validateFilesystemScope(scope);
    const id = (scope as FilesystemScope).id;
    if (ids.has(id)) throw new Error("Duplicate filesystem scope id: " + id);
    ids.add(id);
  }
  const appIds = new Set<string>();
  for (const entry of c.applications as unknown[]) {
    validateApplicationEntry(entry);
    const id = (entry as ApplicationEntry).id;
    if (appIds.has(id)) throw new Error("Duplicate application id: " + id);
    appIds.add(id);
  }
  // Duplicate physical roots are rejected where inappropriate (spec 64): two
  // scope ids must never alias the same canonical directory (case-insensitive
  // on Windows), otherwise scope separation is theater.
  const seenPhysical = new Set<string>();
  for (const scope of c.filesystem_roots as FilesystemScope[]) {
    const folded = process.platform === "win32" ? scope.physical_root.toLowerCase() : scope.physical_root;
    if (seenPhysical.has(folded)) throw new Error("Duplicate filesystem physical root for scope: " + scope.id);
    seenPhysical.add(folded);
  }
  if (c.filesystem_bounds !== undefined) {
    const b = c.filesystem_bounds as Record<string, unknown>;
    for (const [key, value] of Object.entries(DEFAULT_FILESYSTEM_BOUNDS)) {
      const v = b[key];
      if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > (value as number) * 16) {
        throw new Error("Invalid local config: filesystem_bounds." + key);
      }
    }
    for (const key of Object.keys(b)) {
      if (!(key in DEFAULT_FILESYSTEM_BOUNDS)) throw new Error("Invalid local config: unknown filesystem_bounds." + key);
    }
  }
}

/** Resolve a default config rooted at the given workspace directory. */
export function defaultLocalCapabilityConfig(workspaceRoot: string): LocalCapabilityConfig {
  const root = path.isAbsolute(workspaceRoot) ? workspaceRoot : path.resolve(workspaceRoot);
  return {
    filesystem_roots: [
      { id: "workspace", label: "Workspace", physical_root: root, permissions: ["list", "stat", "read", "search"] },
    ],
    applications: [],
    filesystem_bounds: { ...DEFAULT_FILESYSTEM_BOUNDS },
  };
}
