/** Phase 7 issue ingest (§31, §74–§75). Deterministically creates Issue +
 *  IssueOccurrence rows from Merger v2 output. Idempotent: one
 *  (mergeResultId, clusterId) pair always maps to the same occurrence —
 *  repeated ingest returns the originals. Ingest consumes merger output;
 *  it never modifies clusters. Conservative by design (§32): every cluster
 *  becomes its own Issue; no cross-run fuzzy merging, no LLM deduper.
 */
import {
  createIssueEventId,
  createIssueId,
  createIssueOccurrenceId,
  nowIsoTimestamp,
} from '@qa/shared';
import { IssueEventSchema, IssueOccurrenceSchema, IssueSchema, issueIngestKey } from '@qa/schemas';
import type { SentryRepository } from '@qa/persistence';
import { RunEngineError } from './errors.js';

export interface IngestedIssue {
  readonly issueId: string;
  readonly occurrenceId: string;
  readonly created: boolean;
}

export function ingestMergeIssues(
  repository: SentryRepository,
  mergeResultId: string,
): { mergeResultId: string; issues: IngestedIssue[] } {
  const merge = repository.getMergeResult(mergeResultId);
  if (merge === undefined)
    throw new RunEngineError('RUN_NOT_FOUND', 'MergeResult not found: ' + mergeResultId);
  const qaRun = repository.getRun(merge.qaRunId);
  if (qaRun === undefined)
    throw new RunEngineError('RUN_NOT_FOUND', 'QARun not found: ' + merge.qaRunId);
  const snapshot = repository.getSnapshot(merge.projectSnapshotId as never);
  if (snapshot === undefined)
    throw new RunEngineError('RUN_NOT_FOUND', 'Snapshot not found: ' + merge.projectSnapshotId);
  const findingsById = new Map(
    repository.listFindings(merge.qaRunId).map((finding) => [finding.id, finding]),
  );
  // Latest verification linkage per cluster (additive context only).
  const verifiedCluster = new Map<string, string>();
  for (const verificationRun of repository.listVerificationRuns(merge.id)) {
    for (const attempt of repository.listVerificationAttempts(verificationRun.id)) {
      if (attempt.status === 'completed' && !verifiedCluster.has(attempt.findingClusterId)) {
        verifiedCluster.set(attempt.findingClusterId, verificationRun.id);
      }
    }
  }
  const issues: IngestedIssue[] = [];
  for (const cluster of repository.listClusters(merge.id)) {
    const key = issueIngestKey({ mergeResultId: merge.id, findingClusterId: cluster.id });
    const existing = repository.getIngestKey(key);
    if (existing !== undefined) {
      issues.push({
        issueId: existing.issueId,
        occurrenceId: existing.occurrenceId,
        created: false,
      });
      continue;
    }
    const representative = findingsById.get(cluster.representativeFindingId);
    if (representative === undefined)
      throw new RunEngineError(
        'RUN_EXECUTION_FAILED',
        'Representative finding not found: ' + cluster.representativeFindingId,
      );
    const createdAt = nowIsoTimestamp();
    const issueId = createIssueId();
    const occurrenceId = createIssueOccurrenceId();
    repository.transaction(() => {
      repository.saveIssue(
        IssueSchema.parse({
          schemaVersion: 1,
          id: issueId,
          projectId: qaRun.projectId,
          title: representative.title.slice(0, 200),
          category: representative.category,
          severity: representative.severity,
          createdAt,
          updatedAt: createdAt,
        }),
      );
      repository.saveIssueOccurrence(
        IssueOccurrenceSchema.parse({
          schemaVersion: 1,
          id: occurrenceId,
          issueId,
          projectId: qaRun.projectId,
          projectRevisionId: snapshot.projectRevisionId,
          projectSnapshotId: snapshot.id,
          qaRunId: qaRun.id,
          mergeResultId: merge.id,
          findingClusterId: cluster.id,
          ...(verifiedCluster.get(cluster.id) === undefined
            ? {}
            : { verificationRunId: verifiedCluster.get(cluster.id) }),
          createdAt,
        }),
      );
      repository.saveIngestKey(key, issueId, occurrenceId);
      repository.appendIssueEvent(
        IssueEventSchema.parse({
          schemaVersion: 1,
          id: createIssueEventId(),
          issueId,
          projectId: qaRun.projectId,
          kind: 'created',
          toState: 'open',
          occurrenceId,
          message: 'First occurrence ingested from merge ' + merge.id + ' cluster ' + cluster.id,
          createdAt,
        }),
      );
    });
    issues.push({ issueId, occurrenceId, created: true });
  }
  return { mergeResultId: merge.id, issues };
}
