/**
 * SC-05 repository validation (spec sections 13-23, F06-F14).
 *
 * Before a repository becomes AVAILABLE, ARTHUR proves the trust boundary:
 * configured path exists and stays inside the SC-04 filesystem scope,
 * configured path IS the canonical repository root (no silent parent
 * discovery), .git is a real directory (no worktree gitfile, no submodule
 * indirection), non-bare standalone work tree, no external alternates,
 * no graft overrides, partial/promisor clones rejected (network invariant),
 * safe.directory protections preserved (never auto-added), shallow marked
 * degraded-but-readable with history_complete=false.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";

import { assertPhysicalContainment, resolveLexical, type FilesystemScopeRegistry } from "../scoped_path";
import type { GitRepositoryEntry } from "./repository_catalog";

export interface ValidatedRepository {
  entry: GitRepositoryEntry;
  /** Canonical absolute repository root (realpath). */
  absoluteRoot: string;
  shallow: boolean;
}

export type ValidationFailureCode =
  | "GIT_REPOSITORY_NOT_FOUND"
  | "GIT_REPOSITORY_UNSAFE"
  | "GIT_REPOSITORY_UNSUPPORTED";

export class GitRepositoryValidationError extends Error {
  readonly gitCode: ValidationFailureCode;
  constructor(code: ValidationFailureCode, message: string) {
    super(message);
    this.name = "GitRepositoryValidationError";
    this.gitCode = code;
    (this as { code?: string }).code = code;
  }
}

function fail(code: ValidationFailureCode, repoId: string, reason: string): never {
  throw new GitRepositoryValidationError(code, 'Repository "' + repoId + '" is unavailable: ' + reason + ".");
}

export interface RepositoryValidationDeps {
  scopes: FilesystemScopeRegistry;
  /** Run a fixed validation git command; tests inject a fake. */
  runGit?: (executable: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr?: string; exitCode: number }>;
  gitExecutable?: string;
}

function defaultRunGit(executable: string, args: string[], cwd: string): Promise<{ stdout: string; stderr?: string; exitCode: number }> {
  // Production validation path delegates to HardenedGitRunner via the
  // adapter; this fallback exists only so the validator is usable without
  // injection in narrow unit tests. It never uses shell.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    const res = spawnSync(executable, args, { shell: false, cwd, encoding: "utf8", timeout: 10000 });
    return Promise.resolve({ stdout: String(res.stdout ?? ""), exitCode: res.status ?? 1 });
  } catch {
    return Promise.resolve({ stdout: "", exitCode: 1 });
  }
}

/**
 * Validate one catalog entry against the live filesystem + git semantics.
 * Throws GitRepositoryValidationError (fail closed); never returns a path.
 */
export async function validateRepository(entry: GitRepositoryEntry, deps: RepositoryValidationDeps): Promise<ValidatedRepository> {
  const { scopes } = deps;
  const runGit = deps.runGit ?? defaultRunGit;
  const exe = deps.gitExecutable ?? "git";
  const scope = scopes.get(entry.root_id);
  const display = entry.path === "" ? "." : entry.path;
  const candidate = resolveLexical(entry.root_id, scope.physical_root, entry.path);
  const realRoot = scopes.realRoot(entry.root_id);
  let realTarget = "";
  try {
    realTarget = realpathSync(candidate);
  } catch {
    fail("GIT_REPOSITORY_NOT_FOUND", entry.id, "configured path does not exist");
  }
  assertPhysicalContainment(entry.root_id, display, realRoot, realTarget);
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(realTarget);
  } catch {
    fail("GIT_REPOSITORY_NOT_FOUND", entry.id, "configured path does not exist");
  }
  if (st === null || !st.isDirectory() || st.isSymbolicLink()) {
    fail("GIT_REPOSITORY_UNSAFE", entry.id, "repository root is not a directory");
  }
  // .git must be a real directory: gitfile (worktree/submodule) rejected (F09).
  const dotGit = path.join(realTarget, ".git");
  let dotGitStat: ReturnType<typeof lstatSync> | null = null;
  try {
    dotGitStat = lstatSync(dotGit);
  } catch {
    fail("GIT_REPOSITORY_UNSUPPORTED", entry.id, "not a git repository");
  }
  if (dotGitStat === null || !dotGitStat.isDirectory()) {
    fail("GIT_REPOSITORY_UNSUPPORTED", entry.id, "linked worktrees and submodule indirection are unsupported");
  }
  // No silent parent discovery (F07): top-level must equal the root.
  const top = await runGit(exe, ["--no-pager", "--no-replace-objects", "--literal-pathspecs", "rev-parse", "--show-toplevel"], realTarget);
  if (top.exitCode !== 0) {
    // Git reports dubious-ownership diagnostics on stderr, not stdout:
    // both streams must be consulted or the UNSAFE case degrades to a
    // generic UNSUPPORTED classification (fail-closed either way).
    const out = (top.stdout + "\n" + (top.stderr ?? "")).toLowerCase();
    if (/dubious ownership|safe.directory|detected dubious/i.test(out)) {
      fail("GIT_REPOSITORY_UNSAFE", entry.id, "git ownership protection rejected the repository");
    }
    fail("GIT_REPOSITORY_UNSUPPORTED", entry.id, "not a git repository");
  }
  const topLevel = top.stdout.trim().split("\n")[0]?.trim() ?? "";
  let realTop = "";
  try {
    realTop = realpathSync(topLevel);
  } catch {
    fail("GIT_REPOSITORY_UNSUPPORTED", entry.id, "cannot resolve the repository root");
  }
  const foldedTarget = process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
  const foldedTop = process.platform === "win32" ? realTop.toLowerCase() : realTop;
  if (foldedTop !== foldedTarget) {
    fail("GIT_REPOSITORY_UNSUPPORTED", entry.id, "configured path is not the repository root");
  }
  // Bare repositories rejected (F08).
  const bare = await runGit(exe, ["--no-pager", "--no-replace-objects", "--literal-pathspecs", "rev-parse", "--is-bare-repository"], realTarget);
  if (bare.exitCode === 0 && bare.stdout.trim() === "true") {
    fail("GIT_REPOSITORY_UNSUPPORTED", entry.id, "bare repositories are unsupported");
  }
  // External object alternates rejected (F11): object DB must stay inside.
  let alternates = "";
  try {
    alternates = readFileSync(path.join(dotGit, "objects", "info", "alternates"), "utf8");
  } catch {
    alternates = "";
  }
  if (alternates.trim().length > 0) {
    fail("GIT_REPOSITORY_UNSUPPORTED", entry.id, "external object alternates are unsupported");
  }
  // Grafts (legacy hidden history rewrite) unsupported (section 20).
  let graftContent = "";
  try {
    graftContent = readFileSync(path.join(dotGit, "info", "grafts"), "utf8");
  } catch {
    graftContent = "";
  }
  if (graftContent.split("\n").some((l) => l.trim().length > 0 && !l.trim().startsWith("#"))) {
    fail("GIT_REPOSITORY_UNSUPPORTED", entry.id, "grafted history is unsupported");
  }
  // Partial/promisor clones cannot guarantee local-only operation (F13/F30).
  const promisor = await runGit(exe, ["--no-pager", "--no-replace-objects", "--literal-pathspecs", "rev-parse", "--is-shallow-repository"], realTarget);
  void promisor;
  const promisorFile = path.join(dotGit, "objects", "info", "promisor");
  try {
    const content = readFileSync(promisorFile, "utf8");
    if (content.trim().length > 0) {
      fail("GIT_REPOSITORY_UNSUPPORTED", entry.id, "partial clones cannot guarantee local-only operation");
    }
  } catch {
    /* absent: not a promisor clone */
  }
  const partial = await runGit(exe, ["--no-pager", "--no-replace-objects", "--literal-pathspecs", "config", "--local", "--get", "extensions.partialClone"], realTarget);
  if (partial.exitCode === 0 && partial.stdout.trim().length > 0) {
    fail("GIT_REPOSITORY_UNSUPPORTED", entry.id, "partial clones cannot guarantee local-only operation");
  }
  // Shallow: readable but history_complete=false (F42).
  let shallow = false;
  try {
    const shallowStat = lstatSync(path.join(dotGit, "shallow"));
    shallow = shallowStat.isFile();
  } catch {
    shallow = false;
  }
  return { entry: { ...entry, allowed_modes: [...entry.allowed_modes] }, absoluteRoot: realTarget, shallow };
}

/** Classify a validation error into the model-safe unavailable message. */
export function validationErrorMessage(repoId: string): string {
  return 'Repository "' + repoId + '" is unavailable.';
}
