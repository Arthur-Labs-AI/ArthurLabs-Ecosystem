/**
 * SC-05 GitRepositoryCatalog (spec sections 8-14, 106-109).
 *
 * Trusted startup configuration: repo_id -> { label, filesystem scope,
 * relative path, allowed_modes }. The model sees repo_id only; physical
 * paths never cross to the model. Invalid security config fails startup
 * (INVALID_CONFIG); a merely-missing git binary degrades the capability
 * instead (handled by the adapter, not here).
 */

import * as path from "node:path";

import type { ArthurMode } from "../../core/modes/mode";
import { isArthurMode } from "../../core/modes/mode";

export const REPO_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
export const MAX_REPO_ID_CHARS = 64;

export interface GitRepositoryEntry {
  id: string;
  label: string;
  /** Model-facing filesystem scope id (SC-04 root_id). */
  root_id: string;
  /** Repository-relative path inside the scope (repository root itself). */
  path: string;
  allowed_modes: ArthurMode[];
}

export interface GitCapabilityConfig {
  /** Trusted git executable override; default resolved from PATH ("git"). */
  git_executable?: string;
  repositories: GitRepositoryEntry[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Fail-closed validation of one repository entry (INVALID_CONFIG). */
export function validateGitRepositoryEntry(entry: unknown): asserts entry is GitRepositoryEntry {
  if (!isPlainRecord(entry)) throw new Error("Invalid git repository entry: must be a plain object");
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id.length === 0 || e.id.length > MAX_REPO_ID_CHARS) {
    throw new Error("Invalid git repository entry: id must be 1..64 characters");
  }
  if (!REPO_ID_PATTERN.test(e.id)) throw new Error("Invalid git repository id: " + String(e.id));
  if (typeof e.label !== "string" || e.label.trim().length === 0) {
    throw new Error("Invalid git repository entry: label must be non-empty");
  }
  if (e.label.length > 128) throw new Error("Invalid git repository entry: label too long");
  if (typeof e.root_id !== "string" || !REPO_ID_PATTERN.test(e.root_id)) {
    throw new Error("Invalid git repository entry: root_id must be a scope identifier");
  }
  if (typeof e.path !== "string" || e.path.length === 0 || e.path.length > 4096) {
    throw new Error("Invalid git repository entry: path must be 1..4096 characters");
  }
  for (let i = 0; i < e.path.length; i += 1) {
    if (e.path.charCodeAt(i) === 0) throw new Error("Invalid git repository entry: path contains NUL");
  }
  if (path.isAbsolute(e.path)) throw new Error("Invalid git repository entry: path must be repository-relative");
  if (/^[a-zA-Z]:/.test(e.path)) throw new Error("Invalid git repository entry: path must be repository-relative");
  if (!Array.isArray(e.allowed_modes) || e.allowed_modes.length === 0) {
    throw new Error("Invalid git repository entry: allowed_modes must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const m of e.allowed_modes) {
    if (!isArthurMode(m)) throw new Error("Invalid git repository entry: unknown mode " + String(m));
    if (seen.has(m)) throw new Error("Invalid git repository entry: duplicate mode " + String(m));
    seen.add(m);
  }
}

/** Fail-closed validation of the whole git capability config. */
export function validateGitCapabilityConfig(config: unknown): asserts config is GitCapabilityConfig {
  if (!isPlainRecord(config)) throw new Error("Invalid git capability config: must be a plain object");
  const c = config as Record<string, unknown>;
  if (c.git_executable !== undefined) {
    if (typeof c.git_executable !== "string" || c.git_executable.trim().length === 0) {
      throw new Error("Invalid git capability config: git_executable must be a non-empty string");
    }
    if (c.git_executable.includes("\0")) throw new Error("Invalid git capability config: git_executable contains NUL");
    if (!path.isAbsolute(c.git_executable)) {
      throw new Error("Invalid git capability config: git_executable must be an absolute trusted path");
    }
  }
  if (!Array.isArray(c.repositories)) throw new Error("Invalid git capability config: repositories must be an array");
  if (c.repositories.length > 64) throw new Error("Invalid git capability config: too many repositories");
  const ids = new Set<string>();
  for (const entry of c.repositories as unknown[]) {
    validateGitRepositoryEntry(entry);
    const id = (entry as GitRepositoryEntry).id;
    if (ids.has(id)) throw new Error("Duplicate git repository id: " + id);
    ids.add(id);
  }
  // SC-05 section 108: two repo_ids must never alias the same canonical
  // physical repository unless aliases are explicitly supported (they are
  // not in v1). Compared lexically on root_id + normalized relative path
  // (case-insensitive on Windows); the live canonical check happens at
  // validation time via realpath, but config-level aliases fail at startup.
  const seenPhysical = new Set<string>();
  for (const entry of c.repositories as GitRepositoryEntry[]) {
    const normPath = entry.path.split("/").filter((s) => s.length > 0 && s !== ".").join("/");
    const key = entry.root_id + "\0" + (process.platform === "win32" ? normPath.toLowerCase() : normPath);
    if (seenPhysical.has(key)) throw new Error("Duplicate git repository physical path for repo: " + entry.id);
    seenPhysical.add(key);
  }
}

/** Trusted catalog: lookup by repo_id + mode gate. No filesystem access here. */
export class GitRepositoryCatalog {
  private readonly entries = new Map<string, GitRepositoryEntry>();

  constructor(config: GitCapabilityConfig) {
    validateGitCapabilityConfig(config);
    for (const entry of config.repositories) {
      this.entries.set(entry.id, {
        id: entry.id,
        label: entry.label,
        root_id: entry.root_id,
        path: entry.path,
        allowed_modes: [...entry.allowed_modes],
      });
    }
  }

  get(repoId: string): GitRepositoryEntry | undefined {
    return this.entries.get(repoId);
  }

  list(): GitRepositoryEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e, allowed_modes: [...e.allowed_modes] }));
  }

  listForMode(mode: ArthurMode): GitRepositoryEntry[] {
    return this.list().filter((e) => e.allowed_modes.includes(mode));
  }

  /** Mode gate: TOOL_PERMISSION_DENIED-shaped Error when the mode may not use the repo. */
  requireForMode(repoId: string, mode: ArthurMode): GitRepositoryEntry {
    const entry = this.entries.get(repoId);
    if (!entry) {
      const err = new Error('Unknown repository: "' + repoId + '"');
      (err as { code?: string }).code = "GIT_REPOSITORY_NOT_FOUND";
      throw err;
    }
    if (!entry.allowed_modes.includes(mode)) {
      const err = new Error('Repository "' + repoId + '" is not permitted in ' + mode + " mode");
      (err as { code?: string }).code = "GIT_REPOSITORY_NOT_FOUND";
      throw err;
    }
    return { ...entry, allowed_modes: [...entry.allowed_modes] };
  }
}
