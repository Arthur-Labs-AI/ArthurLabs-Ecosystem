/**
 * SC-04 filesystem scope + ScopedPathResolver (spec sections 14-23).
 *
 * A FilesystemScope binds a model-facing root_id to a trusted physical
 * root resolved once at startup. Every access resolves: root_id ->
 * trusted scope -> relative-path validation -> lexical containment ->
 * canonicalization (realpath) -> physical containment -> file-type gate.
 * Fail closed at every step; never normalize-then-execute something the
 * model did not literally request.
 */

import { realpathSync } from "node:fs";
import * as path from "node:path";

import { resourceNotFound, resourceUnsupported, scopeViolation } from "./capability_errors";

/** Canonical scope identifier: lowercase segments, like tool names. */
export const SCOPE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
export const MAX_SCOPE_ID_CHARS = 64;

/** Operations a scope may grant (SC-04 v1 is read-only). */
export type FilesystemPermission = "list" | "stat" | "read" | "search";

export interface FilesystemScope {
  /** Model-facing identifier (e.g. projects). */
  id: string;
  /** Human label shown to the model (never a physical path). */
  label: string;
  /** Trusted physical root, resolved at startup. */
  physical_root: string;
  /** Granted operations. */
  permissions: FilesystemPermission[];
}

export interface SensitivePathPolicy {
  /** Basename blocklist (e.g. .env, id_rsa). Matched case-insensitively. */
  blocked_basenames: string[];
  /** Lowercase suffix allowlist that overrides the block (e.g. .example). */
  allowed_suffixes: string[];
}

export const DEFAULT_SENSITIVE_POLICY: SensitivePathPolicy = {
  blocked_basenames: [
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    ".pem",
    "secrets.json",
    "credentials.json",
    ".npmrc",
    ".pypirc",
  ],
  allowed_suffixes: [".example", ".sample", ".template"],
};

/** Fail-closed startup validation of one filesystem scope. */
export function validateFilesystemScope(scope: unknown): asserts scope is FilesystemScope {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("Invalid filesystem scope: must be a plain object");
  }
  const s = scope as Record<string, unknown>;
  if (typeof s.id !== "string" || s.id.length === 0 || s.id.length > MAX_SCOPE_ID_CHARS) {
    throw new Error("Invalid filesystem scope: id must be 1..64 characters");
  }
  if (!SCOPE_ID_PATTERN.test(s.id)) {
    throw new Error("Invalid filesystem scope id: " + String(s.id));
  }
  if (typeof s.label !== "string" || s.label.trim().length === 0) {
    throw new Error("Invalid filesystem scope: label must be non-empty");
  }
  if (typeof s.physical_root !== "string" || s.physical_root.trim().length === 0) {
    throw new Error("Invalid filesystem scope: physical_root must be non-empty");
  }
  if (!path.isAbsolute(s.physical_root)) {
    throw new Error("Invalid filesystem scope: physical_root must be absolute");
  }
  if (!Array.isArray(s.permissions) || s.permissions.length === 0) {
    throw new Error("Invalid filesystem scope: permissions must be non-empty");
  }
  const allowed: readonly string[] = ["list", "stat", "read", "search"];
  for (const p of s.permissions) {
    if (!allowed.includes(p as string)) {
      throw new Error("Invalid filesystem scope permission: " + String(p));
    }
  }
}

/** Registry of trusted scopes, keyed by root_id. */
export class FilesystemScopeRegistry {
  private readonly scopes = new Map<string, FilesystemScope>();
  private readonly realRoots = new Map<string, string>();

  constructor(scopes: FilesystemScope[]) {
    const seenPhysical = new Set<string>();
    for (const scope of scopes) {
      validateFilesystemScope(scope);
      if (this.scopes.has(scope.id)) {
        throw new Error("Duplicate filesystem scope id: " + scope.id);
      }
      let realRoot: string;
      try {
        realRoot = realpathSync(scope.physical_root);
      } catch {
        throw new Error("Filesystem scope root does not exist: " + scope.id);
      }
      const folded = process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
      if (seenPhysical.has(folded)) {
        throw new Error("Duplicate filesystem physical root for scope: " + scope.id);
      }
      seenPhysical.add(folded);
      this.scopes.set(scope.id, { ...scope, permissions: [...scope.permissions] });
      this.realRoots.set(scope.id, realRoot);
    }
  }

  list(): FilesystemScope[] {
    return [...this.scopes.values()].map((s) => ({ ...s, permissions: [...s.permissions] }));
  }

  get(rootId: string): FilesystemScope {
    const scope = this.scopes.get(rootId);
    if (!scope) {
      throw scopeViolation(String(rootId), "");
    }
    return scope;
  }

  realRoot(rootId: string): string {
    const real = this.realRoots.get(rootId);
    if (!real) throw scopeViolation(String(rootId), "");
    return real;
  }

  requirePermission(rootId: string, op: FilesystemPermission, rel: string): void {
    const scope = this.get(rootId);
    if (!scope.permissions.includes(op)) {
      throw scopeViolation(rootId, rel === "" ? "." : rel);
    }
  }
}

/** Reject NUL bytes early (fail closed). */
export function assertSafeRelativePath(rootId: string, rel: string): void {
  if (typeof rel !== "string") throw scopeViolation(rootId, String(rel));
  for (let i = 0; i < rel.length; i += 1) {
    if (rel.charCodeAt(i) === 0) throw scopeViolation(rootId, rel);
  }
}

/**
 * Lexical resolution: join(scopeRoot, rel) then require containment.
 * Returns the candidate absolute path (not yet canonicalized).
 */
export function resolveLexical(rootId: string, scopeRoot: string, rel: string): string {
  const cleaned = rel === "" || rel === "." ? "" : rel;
  if (cleaned === "") return scopeRoot;
  assertSafeRelativePath(rootId, rel);
  if (path.isAbsolute(cleaned)) throw scopeViolation(rootId, rel);
  if (/^[a-zA-Z]:[\\/]/.test(cleaned)) throw scopeViolation(rootId, rel);
  // Drive-relative form ("C:foo") is still drive-anchored Windows syntax:
  // fail closed rather than resolving it against the server cwd.
  if (/^[a-zA-Z]:/.test(cleaned)) throw scopeViolation(rootId, rel);
  if (/^(\\\\|\/\/)[^\/\\]/.test(cleaned)) throw scopeViolation(rootId, rel);
  const withForward = cleaned.split("\\").join("/");
  for (let i = 0; i < withForward.length; i += 1) {
    if (withForward.charCodeAt(i) === 0) throw scopeViolation(rootId, rel);
  }
  const candidate = path.resolve(scopeRoot, withForward);
  const relative = path.relative(scopeRoot, candidate);
  if (relative === "" || relative === ".") return candidate;
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw scopeViolation(rootId, rel);
  }
  return candidate;
}

/** Physical containment after canonicalization (symlink defense). */
export function assertPhysicalContainment(rootId: string, rel: string, realRoot: string, realTarget: string): void {
  const relative = path.relative(realRoot, realTarget);
  if (relative === "" || relative === ".") return;
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw scopeViolation(rootId, rel);
  }
}

/** Sensitive basename policy (defense in depth; content sanitizer is second line). */
export function assertNotSensitive(rootId: string, rel: string, policy: SensitivePathPolicy = DEFAULT_SENSITIVE_POLICY): void {
  // Split on BOTH separators: a Windows-style "sub\\.env" must hit the same
  // basename block as "sub/.env" (SC-04 F15). Splitting on "/" only would
  // let backslash-separated sensitive basenames bypass the policy.
  const base = rel.split(/[/\\]/).pop() ?? rel;
  const lower = base.toLowerCase();
  for (const suffix of policy.allowed_suffixes) {
    if (lower.endsWith(suffix.toLowerCase())) return;
  }
  for (const blocked of policy.blocked_basenames) {
    if (lower === blocked.toLowerCase()) {
      throw resourceUnsupported("Resource is blocked by sensitive-path policy", rootId, rel);
    }
  }
  if (lower.endsWith(".key") || lower.endsWith(".pem")) {
    throw resourceUnsupported("Resource is blocked by sensitive-path policy", rootId, rel);
  }
}

export interface ResolvedScopedPath {
  scope: FilesystemScope;
  /** Canonical absolute target (realpath of an existing entry, else lexical candidate). */
  absolute: string;
  /** Canonical absolute scope root. */
  realRoot: string;
}

/**
 * Full resolution pipeline for an EXISTING entry (list/stat/read target):
 * lexical gate -> realpath both ends -> physical gate.
 * Missing entries throw TOOL_RESOURCE_NOT_FOUND (never a raw ENOENT).
 */
export function resolveExistingPath(
  registry: FilesystemScopeRegistry,
  rootId: string,
  rel: string,
  op: FilesystemPermission,
  opts?: { sensitive?: SensitivePathPolicy | null },
): ResolvedScopedPath {
  const display = rel === "" ? "." : rel;
  const scope = registry.get(rootId);
  registry.requirePermission(rootId, op, display);
  if (opts?.sensitive !== null) {
    assertNotSensitive(rootId, display, opts?.sensitive ?? DEFAULT_SENSITIVE_POLICY);
  }
  const candidate = resolveLexical(rootId, scope.physical_root, rel);
  const realRoot = registry.realRoot(rootId);
  let realTarget: string;
  try {
    realTarget = realpathSync(candidate);
  } catch {
    throw resourceNotFound(rootId, display);
  }
  assertPhysicalContainment(rootId, display, realRoot, realTarget);
  return { scope: scope, absolute: realTarget, realRoot: realRoot };
}
