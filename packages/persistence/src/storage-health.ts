/** Phase 7 storage health and orphan hygiene (§50–§54, §95).
 *
 *  History (revisions, runs, evidence, artifacts, issues, verifications,
 *  retests) is retained indefinitely until explicit deletion — never
 *  pruned automatically. Only Sentry-owned TEMPORARY directories are
 *  eligible for cleanup, and only when ALL hold:
 *
 *  - the path matches the exact Sentry-owned naming contract,
 *  - no active DB/runtime ownership exists,
 *  - the owning runtime (if any) is stale,
 *  - the directory exceeds the safe age threshold.
 *
 *  Generic temp directories are never scanned. Every cleanup is auditable
 *  (path class, age, reason, operation id, result) without logging project
 *  contents.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isAgentRunId, isVerificationAttemptId } from '@qa/shared';
import type { SentryRepository } from './repository.js';

export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export type OrphanPathClass = 'agent_workspace' | 'verifier_workspace' | 'verifier_staging';

export interface OrphanCandidate {
  readonly pathClass: OrphanPathClass;
  /** Absolute path of the orphan root (the unit removed on apply). */
  readonly path: string;
  readonly ageMs: number;
  readonly reason: string;
}

export interface CleanupAudit extends OrphanCandidate {
  readonly operationId: string;
  readonly removed: boolean;
  readonly detail?: string;
}

export interface StorageHealth {
  readonly dataRoot: string;
  readonly databaseBytes: number;
  readonly artifactFiles: number;
  readonly artifactBytes: number;
  /** Bytes under <dataRoot>/projects (working copies, runs, workspaces). */
  readonly projectsBytes: number;
  readonly projects: number;
  readonly revisions: number;
  readonly runs: number;
  readonly issues: number;
  readonly retests: number;
  readonly orphans: OrphanCandidate[];
}

export interface StorageInspectOptions {
  readonly nowMs?: number;
  readonly minAgeMs?: number;
  readonly isFresh?: (instanceId: string) => boolean;
}

async function directoryBytes(
  root: string,
  capEntries = 100_000,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const stack: string[] = [root];
  let entries = 0;
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      continue;
    }
    for (const name of names) {
      entries += 1;
      if (entries > capEntries) return { files, bytes };
      const absolute = join(current, name);
      let stats;
      try {
        stats = await stat(absolute);
      } catch {
        continue;
      }
      if (stats.isDirectory()) stack.push(absolute);
      else if (stats.isFile()) {
        files += 1;
        bytes += stats.size;
      }
    }
  }
  return { files, bytes };
}

async function mtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

function inside(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + '/');
}

/** Agent workspace orphan root: <dataRoot>/projects/<id>/runs/<run>/agents/<arun>/workspace. */
async function scanAgentWorkspaces(
  dataRoot: string,
  repository: SentryRepository,
  options: Required<Pick<StorageInspectOptions, 'nowMs' | 'minAgeMs'>> &
    Pick<StorageInspectOptions, 'isFresh'>,
  out: OrphanCandidate[],
): Promise<void> {
  let projects: string[];
  try {
    projects = await readdir(join(dataRoot, 'projects'));
  } catch {
    return;
  }
  for (const projectId of projects) {
    let runs: string[];
    try {
      runs = await readdir(join(dataRoot, 'projects', projectId, 'runs'));
    } catch {
      continue;
    }
    for (const runId of runs) {
      let agents: string[];
      try {
        agents = await readdir(join(dataRoot, 'projects', projectId, 'runs', runId, 'agents'));
      } catch {
        continue;
      }
      for (const agentRunId of agents) {
        if (!isAgentRunId(agentRunId)) continue;
        const workspace = join(
          dataRoot,
          'projects',
          projectId,
          'runs',
          runId,
          'agents',
          agentRunId,
          'workspace',
        );
        const mtime = await mtimeMs(workspace);
        if (mtime === undefined) continue;
        const ageMs = options.nowMs - mtime;
        if (ageMs < options.minAgeMs) continue;
        const agentRun = repository.getAgentRun(agentRunId as never);
        if (agentRun !== undefined) {
          const terminal = new Set([
            'completed',
            'failed',
            'cancelled',
            'timed_out',
            'interrupted',
          ]);
          if (!terminal.has(agentRun.status)) {
            const run = repository.getRun(agentRun.qaRunId);
            const owner = run?.runtimeInstanceId;
            if (
              owner !== undefined &&
              (options.isFresh === undefined || options.isFresh(owner as never))
            )
              continue;
            if (owner === undefined) continue;
          }
        }
        out.push({
          pathClass: 'agent_workspace',
          path: workspace,
          ageMs: Math.floor(ageMs),
          reason:
            agentRun === undefined
              ? 'no agent-run row references this workspace'
              : 'agent run is terminal (' + agentRun.status + ') with a stale owner',
        });
      }
    }
  }
}

/** Verifier workspace orphan root: <dataRoot>/projects/<id>/verifier-workspaces/<attempt>. */
async function scanVerifierWorkspaces(
  dataRoot: string,
  repository: SentryRepository,
  options: Required<Pick<StorageInspectOptions, 'nowMs' | 'minAgeMs'>> &
    Pick<StorageInspectOptions, 'isFresh'>,
  out: OrphanCandidate[],
): Promise<void> {
  let projects: string[];
  try {
    projects = await readdir(join(dataRoot, 'projects'));
  } catch {
    return;
  }
  for (const projectId of projects) {
    let attempts: string[];
    try {
      attempts = await readdir(join(dataRoot, 'projects', projectId, 'verifier-workspaces'));
    } catch {
      continue;
    }
    for (const attemptId of attempts) {
      if (!isVerificationAttemptId(attemptId)) continue;
      const root = join(dataRoot, 'projects', projectId, 'verifier-workspaces', attemptId);
      const mtime = await mtimeMs(root);
      if (mtime === undefined) continue;
      const ageMs = options.nowMs - mtime;
      if (ageMs < options.minAgeMs) continue;
      const attempt = repository.getVerificationAttempt(attemptId);
      if (
        attempt !== undefined &&
        attempt.status !== 'completed' &&
        attempt.status !== 'failed' &&
        attempt.status !== 'cancelled' &&
        attempt.status !== 'interrupted'
      ) {
        const run = repository.getVerificationRun(attempt.verificationRunId);
        const owner = run?.runtimeInstanceId;
        if (
          owner !== undefined &&
          (options.isFresh === undefined || options.isFresh(owner as never))
        )
          continue;
        if (owner === undefined) continue;
      }
      out.push({
        pathClass: 'verifier_workspace',
        path: root,
        ageMs: Math.floor(ageMs),
        reason:
          attempt === undefined
            ? 'no verification-attempt row references this workspace'
            : 'attempt is terminal (' + attempt.status + ') with a stale owner',
      });
    }
  }
}

/** Verifier staging orphan root: <stagingParent>/sentry-verify-<attemptId>.
 *  Only this exact Sentry-owned parent is ever listed — never generic
 *  temp contents (§52). */
async function scanVerifierStaging(
  stagingParent: string,
  repository: SentryRepository,
  options: Required<Pick<StorageInspectOptions, 'nowMs' | 'minAgeMs'>> &
    Pick<StorageInspectOptions, 'isFresh'>,
  out: OrphanCandidate[],
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(stagingParent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('sentry-verify-')) continue;
    const attemptId = name.slice('sentry-verify-'.length);
    if (!isVerificationAttemptId(attemptId)) continue;
    const root = join(stagingParent, name);
    const mtime = await mtimeMs(root);
    if (mtime === undefined) continue;
    const ageMs = options.nowMs - mtime;
    if (ageMs < options.minAgeMs) continue;
    const attempt = repository.getVerificationAttempt(attemptId);
    if (
      attempt !== undefined &&
      attempt.status !== 'completed' &&
      attempt.status !== 'failed' &&
      attempt.status !== 'cancelled' &&
      attempt.status !== 'interrupted'
    ) {
      const run = repository.getVerificationRun(attempt.verificationRunId);
      const owner = run?.runtimeInstanceId;
      if (owner !== undefined && (options.isFresh === undefined || options.isFresh(owner as never)))
        continue;
      if (owner === undefined) continue;
    }
    out.push({
      pathClass: 'verifier_staging',
      path: root,
      ageMs: Math.floor(ageMs),
      reason:
        attempt === undefined
          ? 'no verification-attempt row references this staging copy'
          : 'attempt is terminal (' + attempt.status + ') with a stale owner',
    });
  }
}

export async function inspectStorageHealth(
  dataRoot: string,
  repository: SentryRepository,
  stagingParent: string,
  options: StorageInspectOptions = {},
): Promise<StorageHealth> {
  const nowMs = options.nowMs ?? Date.now();
  const minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const resolvedRoot = resolve(dataRoot);
  let databaseBytes = 0;
  for (const name of ['sentry.db', 'sentry.db-wal']) {
    try {
      databaseBytes += (await stat(join(resolvedRoot, name))).size;
    } catch {
      // Absent journal files contribute nothing.
    }
  }
  const artifacts = await directoryBytes(join(resolvedRoot, 'artifacts'));
  let revisionCount = 0;
  for (const project of repository.listProjects()) {
    revisionCount += repository.listRevisions(project.id).length;
  }
  let projectsBytes = 0;
  try {
    projectsBytes = (await directoryBytes(join(resolvedRoot, 'projects'), 20_000)).bytes;
  } catch {
    projectsBytes = 0;
  }
  let runs = 0;
  let issues = 0;
  let retests = 0;
  for (const project of repository.listProjects()) {
    runs += repository.countProjectRuns(project.id);
    issues += repository.listIssues(project.id).length;
    for (const issue of repository.listIssues(project.id)) {
      retests += repository.listRetestRuns(issue.id).length;
    }
  }
  const orphans: OrphanCandidate[] = [];
  const scanOptions = {
    nowMs,
    minAgeMs,
    ...(options.isFresh === undefined ? {} : { isFresh: options.isFresh }),
  };
  await scanAgentWorkspaces(resolvedRoot, repository, scanOptions, orphans);
  await scanVerifierWorkspaces(resolvedRoot, repository, scanOptions, orphans);
  await scanVerifierStaging(resolve(stagingParent), repository, scanOptions, orphans);
  orphans.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    dataRoot: resolvedRoot,
    databaseBytes,
    artifactFiles: artifacts.files,
    artifactBytes: artifacts.bytes,
    projectsBytes,
    projects: repository.listProjects().length,
    revisions: revisionCount,
    runs,
    issues,
    retests,
    orphans,
  };
}

/** Apply orphan removal. Each candidate path is re-validated against its
 *  naming contract and containment before deletion; anything else is
 *  refused, never widened. Returns per-path audit records. */
export async function cleanupOrphans(
  dataRoot: string,
  stagingParent: string,
  candidates: readonly OrphanCandidate[],
  options: { operationId: string },
): Promise<CleanupAudit[]> {
  const resolvedRoot = resolve(dataRoot);
  const resolvedStaging = resolve(stagingParent);
  const audits: CleanupAudit[] = [];
  for (const candidate of candidates) {
    const name = basename(candidate.path);
    const valid =
      candidate.pathClass === 'agent_workspace'
        ? name === 'workspace' &&
          isAgentRunId(basename(dirname(candidate.path))) &&
          inside(join(resolvedRoot, 'projects'), candidate.path)
        : candidate.pathClass === 'verifier_workspace'
          ? isVerificationAttemptId(name) && inside(join(resolvedRoot, 'projects'), candidate.path)
          : candidate.pathClass === 'verifier_staging'
            ? name.startsWith('sentry-verify-') &&
              isVerificationAttemptId(name.slice('sentry-verify-'.length)) &&
              dirname(resolve(candidate.path)) === resolvedStaging
            : false;
    if (!valid) {
      audits.push({
        ...candidate,
        operationId: options.operationId,
        removed: false,
        detail: 'naming contract re-validation failed; refused',
      });
      continue;
    }
    try {
      await rm(resolve(candidate.path), {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 50,
      });
      audits.push({ ...candidate, operationId: options.operationId, removed: true });
    } catch (cause) {
      audits.push({
        ...candidate,
        operationId: options.operationId,
        removed: false,
        detail:
          'removal failed: ' +
          (cause instanceof Error ? cause.message : String(cause)).slice(0, 300),
      });
    }
  }
  return audits;
}
