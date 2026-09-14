import { computeInputDigest, mergeFindings, MERGER_VERSION, type MergeResult } from '@qa/merger';
import type { SentryRepository } from '@qa/persistence';
import type { AgentStackId, QARunId } from '@qa/shared';

export class MergeServiceError extends Error {
  constructor(
    readonly code: 'RUN_NOT_FOUND' | 'RUN_NOT_TERMINAL' | 'NO_USABLE_AGENT_RUNS',
    message: string,
  ) {
    super(message);
    this.name = 'MergeServiceError';
  }
}

export interface MergeRunOptions {
  readonly expectedAgentStackIds?: readonly AgentStackId[];
  readonly now?: import('@qa/shared').IsoTimestamp;
}

/**
 * Explicit post-run merge (never auto-run inside the coordinator).
 * Loads immutable canonical inputs, computes deterministically OUTSIDE
 * any write lock, then persists atomically. Idempotent: an existing
 * MergeResult for (qaRunId, mergerVersion, inputDigest) is reused.
 * Merger failure never changes QARun status.
 */
export function mergeRun(
  repository: SentryRepository,
  runId: QARunId,
  options: MergeRunOptions = {},
): { result: MergeResult; reused: boolean } {
  const qaRun = repository.getRun(runId);
  if (qaRun === undefined) {
    throw new MergeServiceError('RUN_NOT_FOUND', 'QA run not found: ' + runId);
  }
  if (qaRun.status !== 'completed' && qaRun.status !== 'partial') {
    throw new MergeServiceError(
      'RUN_NOT_TERMINAL',
      'QA run is not terminal (status=' + qaRun.status + '); merge requires a finished run.',
    );
  }
  const agentRuns = repository.listAgentRuns(runId);
  const usable = agentRuns.filter((run) => run.status === 'completed');
  if (usable.length === 0) {
    throw new MergeServiceError('NO_USABLE_AGENT_RUNS', 'No completed agent runs to merge.');
  }
  const findings = repository.listFindings(runId);
  const evidence = repository.listEvidence(runId);
  const expected =
    options.expectedAgentStackIds ?? [...new Set(agentRuns.map((run) => run.agentStackId))].sort();
  // Idempotency probe BEFORE computing: same digest + version reuses.
  const digest = computeInputDigest(
    qaRun.id,
    qaRun.snapshotId,
    findings.filter((f) => usable.some((u) => u.id === f.agentRunId)).map((f) => f.id),
    evidence.map((e) => e.id),
  );
  const existing = repository.findMergeResultByDigest(runId, digest);
  if (existing !== undefined && existing.mergerVersion === MERGER_VERSION) {
    return { result: existing, reused: true };
  }
  const startedAt = Date.now();
  const { result, clusterMemberIds } = mergeFindings({
    qaRun,
    agentRuns,
    findings,
    evidence,
    expectedAgentStackIds: expected,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const timed: MergeResult = { ...result, durationMs: Math.max(0, Date.now() - startedAt) };
  const members = new Map<string, readonly string[]>(
    timed.clusters.map((cluster, index: number) => [cluster.id, clusterMemberIds[index] ?? []]),
  );
  repository.saveMergeResult(timed, members);
  return { result: timed, reused: false };
}
