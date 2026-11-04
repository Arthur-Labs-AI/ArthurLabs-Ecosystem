/**
 * SC-05 LocalGitAdapter (spec sections 6, 110-111).
 *
 * Capability implementation behind the git.* tools. Public surface is
 * semantic only: listRepositories/getStatus/getDiff/getLog/getBranches/
 * showCommit. There is deliberately NO executeRawGit/runCommand/runArgs in
 * the public interface (SC05-F01): fixed command templates are built
 * privately and dispatched through the private HardenedGitRunner.
 */

import { lstatSync } from "node:fs";

import type { ArthurMode } from "../../core/modes/mode";
import { ArthurError } from "../../core/errors/errors";
import type { FilesystemScopeRegistry } from "../scoped_path";
import { assertNotSensitive } from "../scoped_path";
import { buildGitChildEnv, HardenedGitRunner } from "../git/command_runner";
import { deterministicDiffFlags, deterministicNumstatFlags, boundPatch, parseNumstatZ } from "../git/parsers/diff";
import { forEachRefFormat, parseBranches } from "../git/parsers/refs";
import { logFormatString, parseLogOutput, parseShowMetadata } from "../git/parsers/log";
import { operationStateFromMarkers, parsePorcelainV2, splitNulRecords } from "../git/parsers/status";
import { resolveOptionalRef, resolveRefToOid } from "../git/ref_resolver";
import { GitRepositoryCatalog, type GitCapabilityConfig } from "../git/repository_catalog";
import { validateRepository, type ValidatedRepository } from "../git/repository_validator";
import type {
  GitBranchesResult,
  GitDiffResult,
  GitDiffScope,
  GitLogResult,
  GitRepositoriesResult,
  GitShowResult,
  GitStatusResult,
} from "../git/contracts";

export const GIT_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
export const GIT_MAX_STDERR_BYTES = 256 * 1024;
export const GIT_MAX_PATCH_CHARS = 24 * 1024;

function gitError(code: string, repoId: string, detail?: string): ArthurError {
  const mapping: Record<string, ArthurError["code"]> = {
    GIT_UNAVAILABLE: "TOOL_CAPABILITY_UNAVAILABLE",
    GIT_REPOSITORY_NOT_FOUND: "TOOL_RESOURCE_NOT_FOUND",
    GIT_REPOSITORY_UNSAFE: "TOOL_RESOURCE_UNSUPPORTED",
    GIT_REPOSITORY_UNSUPPORTED: "TOOL_RESOURCE_UNSUPPORTED",
    GIT_REF_INVALID: "TOOL_ARGUMENT_INVALID",
    GIT_OUTPUT_LIMIT_EXCEEDED: "TOOL_OUTPUT_INVALID",
    GIT_COMMAND_FAILED: "TOOL_EXECUTION_FAILED",
  };
  const publicCode = mapping[code] ?? "TOOL_EXECUTION_FAILED";
  const message =
    code === "GIT_REF_INVALID"
      ? "Invalid git ref" + (detail ? ": " + detail : "") + "."
      : 'Repository "' + repoId + '" is unavailable.';
  return new ArthurError(publicCode, message, {
    details: { repository: repoId, git_code: code },
    exposeDetails: true,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ArthurError("TOOL_CANCELLED", "Git operation was cancelled");
  }
}

function validatedPathOrThrow(repoId: string, rawPath: unknown): string | undefined {
  if (rawPath === undefined) return undefined;
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 4096) {
    const err = new Error("Invalid git path: must be 1..4096 characters");
    (err as { code?: string }).code = "GIT_REF_INVALID";
    throw err;
  }
  for (let i = 0; i < rawPath.length; i += 1) {
    if (rawPath.charCodeAt(i) === 0) {
      const err = new Error("Invalid git path: contains NUL");
      (err as { code?: string }).code = "GIT_REF_INVALID";
      throw err;
    }
  }
  // Literal repository-relative path only (F17): absolute/drive/UNC/..
  // rejected. Backslashes are literal filename characters here (git uses
  // --literal-pathspecs), so only "/" separates segments for the ".." gate.
  void repoId;
  if (rawPath.startsWith("/") || /^[a-zA-Z]:/.test(rawPath) || rawPath.startsWith("\\")) {
    const err = new Error("Invalid git path: must be repository-relative");
    (err as { code?: string }).code = "GIT_REF_INVALID";
    throw err;
  }
  const segments = rawPath.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      const err = new Error("Invalid git path: must be repository-relative");
      (err as { code?: string }).code = "GIT_REF_INVALID";
      throw err;
    }
  }
  return rawPath;
}

export interface LocalGitAdapterOptions {
  gitExecutable?: string;
  runner?: HardenedGitRunner;
  /** Override availability probing (tests control git missing). */
  probeAvailability?: () => Promise<boolean>;
}

export class LocalGitAdapter {
  private readonly catalog: GitRepositoryCatalog;
  private readonly scopes: FilesystemScopeRegistry;
  private readonly runner: HardenedGitRunner;
  private readonly gitExecutable: string;
  private readonly probeAvailability?: () => Promise<boolean>;
  private availabilityCache: boolean | null = null;

  constructor(scopes: FilesystemScopeRegistry, config: GitCapabilityConfig, opts: LocalGitAdapterOptions = {}) {
    this.catalog = new GitRepositoryCatalog(config);
    this.scopes = scopes;
    this.runner = opts.runner ?? new HardenedGitRunner();
    this.gitExecutable = opts.gitExecutable ?? config.git_executable ?? "git";
    this.probeAvailability = opts.probeAvailability;
  }

  /** Test seam: deterministic git child env without spawning. */
  static childEnvForTests(source: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return buildGitChildEnv(source, extra);
  }

  async isAvailable(): Promise<boolean> {
    if (this.availabilityCache !== null) return this.availabilityCache;
    try {
      if (this.probeAvailability) {
        this.availabilityCache = await this.probeAvailability();
      } else {
        const res = await this.runner.run({
          executable: this.gitExecutable,
          args: ["--version"],
          cwd: this.scopes.list()[0]?.physical_root ?? process.cwd(),
          timeoutMs: 10000,
          maxStdoutBytes: 64 * 1024,
          maxStderrBytes: 64 * 1024,
        });
        this.availabilityCache = res.exitCode === 0;
      }
    } catch {
      this.availabilityCache = false;
    }
    return this.availabilityCache;
  }

  private async requireAvailable(repoId: string): Promise<void> {
    if (!(await this.isAvailable())) {
      throw gitError("GIT_UNAVAILABLE", repoId);
    }
  }

  private async validatedRepo(repoId: string, mode: ArthurMode): Promise<ValidatedRepository> {
    let entry;
    try {
      entry = this.catalog.requireForMode(repoId, mode);
    } catch (err) {
      throw gitError("GIT_REPOSITORY_NOT_FOUND", repoId);
    }
    try {
      return await validateRepository(entry, {
        scopes: this.scopes,
        gitExecutable: this.gitExecutable,
        runGit: async (exe, args, cwd) => {
          const res = await this.runner.run({
            executable: exe,
            args,
            cwd,
            timeoutMs: 10000,
            maxStdoutBytes: 256 * 1024,
            maxStderrBytes: 256 * 1024,
          });
          return { stdout: res.stdout.toString("utf8"), stderr: res.stderr, exitCode: res.exitCode };
        },
      });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "GIT_REPOSITORY_UNSUPPORTED";
      throw gitError(code, repoId);
    }
  }

  private async runGit(repo: ValidatedRepository, args: string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<{ stdout: Buffer; stderr: string; exitCode: number }> {
    throwIfAborted(signal);
    try {
      return await this.runner.run({
        executable: this.gitExecutable,
        args,
        cwd: repo.absoluteRoot,
        signal,
        timeoutMs,
        maxStdoutBytes: GIT_MAX_STDOUT_BYTES,
        maxStderrBytes: GIT_MAX_STDERR_BYTES,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "TOOL_CANCELLED" || code === "TOOL_TIMEOUT" || code === "GIT_OUTPUT_LIMIT_EXCEEDED" || code === "GIT_UNAVAILABLE") throw err;
      const wrapped = new Error("Git command failed");
      (wrapped as { code?: string }).code = "GIT_COMMAND_FAILED";
      throw wrapped;
    }
  }

  private checkExit(repoId: string, res: { exitCode: number; stderr: string }): void {
    if (res.exitCode !== 0) {
      const out = res.stderr.toLowerCase();
      if (/dubious ownership|safe.directory/.test(out)) throw gitError("GIT_REPOSITORY_UNSAFE", repoId);
      throw gitError("GIT_COMMAND_FAILED", repoId);
    }
  }

  async listRepositories(mode: ArthurMode): Promise<GitRepositoriesResult> {
    const entries = this.catalog.listForMode(mode);
    const available = await this.isAvailable();
    const repositories: GitRepositoriesResult["repositories"] = [];
    for (const entry of entries) {
      let ok = false;
      if (available) {
        try {
          await this.validatedRepo(entry.id, mode);
          ok = true;
        } catch {
          ok = false;
        }
      }
      repositories.push({ id: entry.id, label: entry.label, available: ok });
    }
    return { repositories };
  }

  async getStatus(repoId: string, mode: ArthurMode, signal?: AbortSignal, timeoutMs = 5000): Promise<GitStatusResult> {
    await this.requireAvailable(repoId);
    const repo = await this.validatedRepo(repoId, mode);
    const res = await this.runGit(
      repo,
      ["--no-pager", "--no-replace-objects", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal"],
      signal,
      timeoutMs,
    );
    this.checkExit(repoId, res);
    const exists = (name: string): boolean => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const gitPath = require("node:path") as typeof import("node:path");
        lstatSync(gitPath.join(repo.absoluteRoot, ".git", name));
        return true;
      } catch {
        return false;
      }
    };
    const opState = operationStateFromMarkers(exists);
    const parsed = parsePorcelainV2(splitNulRecords(res.stdout), opState);
    const clean = parsed.staged.length === 0 && parsed.unstaged.length === 0 && parsed.untracked.length === 0 && parsed.conflicted.length === 0;
    return {
      repository: repoId,
      branch: parsed.branch,
      clean,
      staged: parsed.staged,
      unstaged: parsed.unstaged,
      untracked: parsed.untracked,
      conflicted: parsed.conflicted,
      truncated: parsed.truncated,
      observed_at: new Date().toISOString(),
      shallow: repo.shallow,
      history_complete: !repo.shallow,
      operation_state: parsed.operationState,
    };
  }

  async getDiff(
    repoId: string,
    mode: ArthurMode,
    scope: GitDiffScope,
    opts: { path?: string; base_ref?: string; target_ref?: string },
    signal?: AbortSignal,
    timeoutMs = 10000,
  ): Promise<GitDiffResult> {
    await this.requireAvailable(repoId);
    const repo = await this.validatedRepo(repoId, mode);
    const relPath = validatedPathOrThrow(repoId, opts.path);
    if (relPath !== undefined) assertNotSensitive(repo.entry.root_id, relPath);
    const run = (args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
      this.runner
        .run({ executable: this.gitExecutable, args: this.prefix(args), cwd, signal, timeoutMs, maxStdoutBytes: GIT_MAX_STDOUT_BYTES, maxStderrBytes: GIT_MAX_STDERR_BYTES })
        .then((r) => ({ stdout: r.stdout.toString("utf8"), stderr: r.stderr, exitCode: r.exitCode }));

    let baseOid: string | null = null;
    let targetOid: string | null = null;
    let numstatArgs: string[];
    let patchArgs: string[];
    const flags = deterministicDiffFlags();
    const numstatFlags = deterministicNumstatFlags();
    try {
      // PASS 1 numstat: --numstat -z with NO patch-producing flag. Verified
      // on Git 2.55: --unified implies --patch and appends the full patch
      // after the stats records, so numstat runs use numstatFlags (no
      // --unified) and no --format. With -z git emits literal NUL-framed
      // paths (never C-quoted), satisfying the F16 NUL-safe contract.
      if (scope === "unstaged") {
        numstatArgs = this.prefix(["diff", "--numstat", "-z", ...numstatFlags, "--"]);
        patchArgs = this.prefix(["diff", ...flags, "--"]);
      } else if (scope === "staged") {
        numstatArgs = this.prefix(["diff", "--cached", "--numstat", "-z", ...numstatFlags, "--"]);
        patchArgs = this.prefix(["diff", "--cached", ...flags, "--"]);
      } else if (scope === "working_tree") {
        // HEAD <-> tracked working tree (HEAD/empty-tree <-> worktree for
        // unborn). Single numstat + single patch; unborn falls back to
        // unstaged-only semantics.
        const headOid = await this.headOid(repo, signal, timeoutMs);
        baseOid = headOid;
        const headArg = headOid === null ? [] : [headOid];
        numstatArgs = this.prefix(["diff", "--numstat", "-z", ...numstatFlags, ...headArg, "--", ...(relPath ? [relPath] : [])]);
        patchArgs = this.prefix(["diff", ...flags, ...headArg, "--", ...(relPath ? [relPath] : [])]);
      } else {
        // commits scope: resolve both refs to OIDs first (snapshot semantics).
        if (typeof opts.base_ref !== "string" || typeof opts.target_ref !== "string") {
          const err = new Error("Invalid git ref: base_ref and target_ref are required for commits scope");
          (err as { code?: string }).code = "GIT_REF_INVALID";
          throw err;
        }
        try {
          baseOid = await resolveRefToOid(opts.base_ref, repo.absoluteRoot, { runGit: run });
          targetOid = await resolveRefToOid(opts.target_ref, repo.absoluteRoot, { runGit: run });
        } catch (err) {
          throw gitError("GIT_REF_INVALID", repoId, err instanceof Error ? err.message : undefined);
        }
        numstatArgs = this.prefix(["diff", "--numstat", "-z", ...numstatFlags, baseOid, targetOid, "--", ...(relPath ? [relPath] : [])]);
        patchArgs = this.prefix(["diff", ...flags, baseOid, targetOid, "--", ...(relPath ? [relPath] : [])]);
      }
      const numstat = await this.runGit(repo, [...numstatArgs, ...(relPath && scope !== "commits" ? [relPath] : [])], signal, timeoutMs);
      this.checkExit(repoId, numstat);
      const parsed = parseNumstatZ(numstat.stdout);
      const patchRes = await this.runGit(repo, [...patchArgs, ...(relPath && scope !== "commits" ? [relPath] : [])], signal, timeoutMs);
      this.checkExit(repoId, patchRes);
      const bounded = boundPatch(patchRes.stdout.toString("utf8"), GIT_MAX_PATCH_CHARS);
      return {
        repository: repoId,
        scope,
        base_oid: baseOid,
        target_oid: targetOid,
        files: parsed.files,
        patch_available: bounded.available,
        patch_truncated: bounded.truncated,
        patch: bounded.patch,
        truncated: parsed.truncated,
        observed_at: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof ArthurError) throw err;
      const code = (err as { code?: string }).code;
      if (code === "GIT_REF_INVALID") throw gitError("GIT_REF_INVALID", repoId, err instanceof Error ? err.message : undefined);
      if (code === "TOOL_CANCELLED" || code === "TOOL_TIMEOUT" || code === "GIT_OUTPUT_LIMIT_EXCEEDED" || code === "GIT_UNAVAILABLE" || code === "GIT_COMMAND_FAILED") throw err;
      throw gitError("GIT_COMMAND_FAILED", repoId);
    }
  }

  private prefix(rest: string[]): string[] {
    return ["--no-pager", "--no-replace-objects", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", ...rest];
  }

  private async headOid(repo: ValidatedRepository, signal: AbortSignal | undefined, timeoutMs: number): Promise<string | null> {
    const res = await this.runGit(repo, this.prefix(["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"]), signal, timeoutMs);
    if (res.exitCode !== 0) return null;
    const oid = res.stdout.toString("utf8").trim();
    return /^[0-9a-f]{40}$/.test(oid) ? oid : null;
  }

  async getLog(
    repoId: string,
    mode: ArthurMode,
    opts: { ref?: string; limit?: number; path?: string; since?: string; until?: string },
    signal?: AbortSignal,
    timeoutMs = 5000,
  ): Promise<GitLogResult> {
    await this.requireAvailable(repoId);
    const repo = await this.validatedRepo(repoId, mode);
    const relPath = validatedPathOrThrow(repoId, opts.path);
    if (relPath !== undefined) assertNotSensitive(repo.entry.root_id, relPath);
    const limit = opts.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw gitError("GIT_REF_INVALID", repoId, "limit must be 1..50");
    }
    const run = (args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
      this.runner
        .run({ executable: this.gitExecutable, args: this.prefix(args), cwd, signal, timeoutMs, maxStdoutBytes: GIT_MAX_STDOUT_BYTES, maxStderrBytes: GIT_MAX_STDERR_BYTES })
        .then((r) => ({ stdout: r.stdout.toString("utf8"), stderr: r.stderr, exitCode: r.exitCode }));
    let resolved: string | null = null;
    try {
      const refName = typeof opts.ref === "string" ? opts.ref : "HEAD";
      resolved = await resolveRefToOid(refName, repo.absoluteRoot, { runGit: run });
    } catch (err) {
      throw gitError("GIT_REF_INVALID", repoId, err instanceof Error ? err.message : undefined);
    }
    const since = this.canonicalTimestamp(opts.since, repoId);
    const until = this.canonicalTimestamp(opts.until, repoId);
    const args = this.prefix([
      "log",
      "--no-notes",
      "--no-color",
      "--format=" + logFormatString(),
      "--max-count=" + String(limit),
      ...(since ? ["--since=" + since] : []),
      ...(until ? ["--until=" + until] : []),
      resolved as string,
      "--",
      ...(relPath ? [relPath] : []),
    ]);
    const res = await this.runGit(repo, args, signal, timeoutMs);
    this.checkExit(repoId, res);
    const parsed = parseLogOutput(res.stdout.toString("utf8"));
    return {
      repository: repoId,
      ref: typeof opts.ref === "string" ? opts.ref : "HEAD",
      resolved_oid: resolved,
      commits: parsed.commits,
      truncated: parsed.truncated,
      history_complete: !repo.shallow,
      observed_at: new Date().toISOString(),
    };
  }

  private canonicalTimestamp(value: unknown, repoId: string): string | null {
    if (value === undefined) return null;
    if (typeof value !== "string" || value.length === 0 || value.length > 64) {
      throw gitError("GIT_REF_INVALID", repoId, "since/until must be strict timestamps");
    }
    // Strict: ISO-8601 or epoch seconds only; never arbitrary git date exprs.
    const epoch = /^[0-9]{1,12}$/.exec(value.trim());
    if (epoch) {
      const n = Number.parseInt(epoch[0], 10);
      if (!Number.isSafeInteger(n) || n < 0) throw gitError("GIT_REF_INVALID", repoId, "since/until must be strict timestamps");
      return "@" + String(n);
    }
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw gitError("GIT_REF_INVALID", repoId, "since/until must be strict timestamps");
    return new Date(ms).toISOString();
  }

  async getBranches(repoId: string, mode: ArthurMode, signal?: AbortSignal, timeoutMs = 5000): Promise<GitBranchesResult> {
    await this.requireAvailable(repoId);
    const repo = await this.validatedRepo(repoId, mode);
    const format = forEachRefFormat();
    const [heads, remotes, headName] = await Promise.all([
      this.runGit(repo, this.prefix(["for-each-ref", "--format=" + format, "--sort=refname", "refs/heads/"]), signal, timeoutMs),
      this.runGit(repo, this.prefix(["for-each-ref", "--format=" + format, "--sort=refname", "refs/remotes/"]), signal, timeoutMs),
      this.runGit(repo, this.prefix(["symbolic-ref", "--quiet", "--short", "HEAD"]), signal, timeoutMs),
    ]);
    this.checkExit(repoId, heads);
    this.checkExit(repoId, remotes);
    const parsed = parseBranches(
      heads.stdout.toString("utf8").split("\n").filter((l) => l.length > 0),
      remotes.stdout.toString("utf8").split("\n").filter((l) => l.length > 0),
    );
    const current = headName.exitCode === 0 ? headName.stdout.toString("utf8").trim() || null : null;
    return {
      repository: repoId,
      current,
      detached: current === null,
      local: parsed.local,
      remote_tracking: parsed.remote_tracking,
      truncated: parsed.truncated,
      observed_at: new Date().toISOString(),
    };
  }

  async showCommit(
    repoId: string,
    mode: ArthurMode,
    opts: { ref?: string; include_patch?: boolean; path?: string },
    signal?: AbortSignal,
    timeoutMs = 10000,
  ): Promise<GitShowResult> {
    await this.requireAvailable(repoId);
    const repo = await this.validatedRepo(repoId, mode);
    if (opts.path !== undefined) {
      const err = new Error("Invalid git ref: git.show resolves commits only");
      (err as { code?: string }).code = "GIT_REF_INVALID";
      throw gitError("GIT_REF_INVALID", repoId, err.message);
    }
    const run = (args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
      this.runner
        .run({ executable: this.gitExecutable, args: this.prefix(args), cwd, signal, timeoutMs, maxStdoutBytes: GIT_MAX_STDOUT_BYTES, maxStderrBytes: GIT_MAX_STDERR_BYTES })
        .then((r) => ({ stdout: r.stdout.toString("utf8"), stderr: r.stderr, exitCode: r.exitCode }));
    let oid: string;
    try {
      oid = await resolveRefToOid(typeof opts.ref === "string" ? opts.ref : "HEAD", repo.absoluteRoot, { runGit: run });
    } catch (err) {
      throw gitError("GIT_REF_INVALID", repoId, err instanceof Error ? err.message : undefined);
    }
    void resolveOptionalRef;
    const meta = await this.runGit(repo, this.prefix(["show", "--no-notes", "--no-color", "--no-ext-diff", "--no-textconv", "-s", "--format=" + logFormatString(), oid, "--"]), signal, timeoutMs);
    this.checkExit(repoId, meta);
    const parsed = parseShowMetadata(meta.stdout.toString("utf8"));
    const flags = deterministicDiffFlags();
    const numstat = await this.runGit(repo, this.prefix(["diff-tree", "--numstat", "-z", "--no-commit-id", ...deterministicNumstatFlags(), oid, "--"]), signal, timeoutMs);
    this.checkExit(repoId, numstat);
    const files = parseNumstatZ(numstat.stdout).files;
    let patch: string | null = null;
    let patch_available = false;
    let patch_truncated = false;
    if (opts.include_patch === true) {
      const patchRes = await this.runGit(repo, this.prefix(["show", "--no-notes", "--no-color", "--no-ext-diff", "--no-textconv", "--pretty=format:", ...flags, oid, "--"]), signal, timeoutMs);
      this.checkExit(repoId, patchRes);
      const bounded = boundPatch(patchRes.stdout.toString("utf8"), GIT_MAX_PATCH_CHARS);
      patch = bounded.patch;
      patch_available = bounded.available;
      patch_truncated = bounded.truncated;
    }
    return {
      repository: repoId,
      ref: typeof opts.ref === "string" ? opts.ref : "HEAD",
      oid: parsed.oid,
      parents: parsed.parents,
      author_name: parsed.author_name,
      authored_at: parsed.authored_at,
      committed_at: parsed.committed_at,
      subject: parsed.subject,
      body: parsed.body,
      body_truncated: parsed.body_truncated,
      files,
      patch_available,
      patch_truncated,
      patch,
      observed_at: new Date().toISOString(),
    };
  }
}
