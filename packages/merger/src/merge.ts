import type { AgentRun, Evidence, Finding, QARun } from '@qa/schemas';
import { nowIsoTimestamp, type IsoTimestamp } from '@qa/shared';
import { buildClusters } from './cluster.js';
import {
  MERGER_VERSION,
  NORMALIZER_VERSION,
  type FindingCluster,
  type MergeResult,
} from './schemas.js';
import { sha256Hex } from './normalize.js';

export class MergerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergerInputError';
  }
}

export interface MergeInput {
  readonly qaRun: QARun;
  readonly agentRuns: readonly AgentRun[];
  readonly findings: readonly Finding[];
  readonly evidence: readonly Evidence[];
  readonly expectedAgentStackIds: readonly string[];
  readonly now?: IsoTimestamp;
}

export interface MergeOutput {
  readonly result: MergeResult;
  readonly clusterMemberIds: ReadonlyArray<readonly string[]>;
}

/** Canonical input digest: merger version + run + snapshot + sorted
 *  source finding/evidence IDs. Identical input always digests equal. */
export function computeInputDigest(
  qaRunId: string,
  snapshotId: string,
  findingIds: readonly string[],
  evidenceIds: readonly string[],
): string {
  const canonical = JSON.stringify({
    mergerVersion: MERGER_VERSION,
    qaRunId,
    snapshotId,
    findings: [...findingIds].sort(),
    evidence: [...evidenceIds].sort(),
  });
  return 'sha256:' + sha256Hex(canonical);
}

function ulidLike(prefix: string, seed: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const hex = sha256Hex(prefix + '|' + seed);
  let out = '';
  for (let index = 0; out.length < 26; index += 1) {
    const byte = parseInt(hex.slice((index * 2) % hex.length, ((index * 2) % hex.length) + 2), 16);
    out += alphabet[byte % 32];
  }
  return prefix + '_' + out;
}

export function mergeFindings(input: MergeInput): MergeOutput {
  // Snapshot consistency: every finding must belong to the same run and
  // snapshot under comparison. Fail closed on mixed input.
  for (const finding of input.findings) {
    if (finding.qaRunId !== input.qaRun.id) {
      throw new MergerInputError('Finding ' + finding.id + ' belongs to a different QARun');
    }
  }
  const usableRuns = input.agentRuns.filter(
    (run) => run.status === 'completed' && run.qaRunId === input.qaRun.id,
  );
  const usableRunIds = new Set(usableRuns.map((run) => run.id));
  const usableFindings = input.findings.filter((finding) => usableRunIds.has(finding.agentRunId));
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  const clusters = buildClusters({
    qaRunId: input.qaRun.id,
    projectSnapshotId: input.qaRun.snapshotId,
    findings: usableFindings,
    evidenceById,
    expectedAgentStackIds: input.expectedAgentStackIds,
    usableAgentRuns: usableRuns.map((run) => ({
      agentRunId: run.id,
      agentStackId: run.agentStackId,
    })),
  });
  const now = input.now ?? nowIsoTimestamp();
  const digest = computeInputDigest(
    input.qaRun.id,
    input.qaRun.snapshotId,
    usableFindings.map((f) => f.id),
    input.evidence.map((e) => e.id),
  );
  const unavailable = [...input.expectedAgentStackIds]
    .filter((stack) => !usableRuns.some((run) => run.agentStackId === stack))
    .sort();
  const result: MergeResult = {
    schemaVersion: 1,
    id: ulidLike('merge', digest + '|' + now) as MergeResult['id'],
    qaRunId: input.qaRun.id,
    projectSnapshotId: input.qaRun.snapshotId,
    ...(input.qaRun.projectContextSnapshotId === undefined
      ? {}
      : { projectContextSnapshotId: input.qaRun.projectContextSnapshotId }),
    mergerVersion: MERGER_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    inputDigest: digest,
    expectedAgentStackIds: [
      ...input.expectedAgentStackIds,
    ].sort() as MergeResult['expectedAgentStackIds'],
    usableAgentRunIds: usableRuns.map((run) => run.id).sort() as MergeResult['usableAgentRunIds'],
    unavailableAgentStackIds: unavailable as MergeResult['unavailableAgentStackIds'],
    sourceFindingCount: usableFindings.length,
    clusterCount: clusters.length,
    singleSourceCount: clusters.filter((c) => c.agreementState === 'single_source').length,
    multiSourceCount: clusters.filter((c) => c.agreementState === 'multi_source').length,
    allAvailableCount: clusters.filter((c) => c.agreementState === 'all_available_sources').length,
    clusters: clusters.map((cluster): FindingCluster => {
      const byId = new Map<string, Finding>(usableFindings.map((f) => [f.id, f] as const));
      return {
        schemaVersion: 1 as const,
        id: cluster.clusterId as FindingCluster['id'],
        qaRunId: input.qaRun.id,
        projectSnapshotId: input.qaRun.snapshotId,
        mergerVersion: MERGER_VERSION,
        normalizerVersion: NORMALIZER_VERSION,
        sourceFindingIds: [...cluster.memberFindingIds] as FindingCluster['sourceFindingIds'],
        // Explicit sort: usableRuns follows repository retrieval order,
        // which must never leak into persisted MergeResult semantics (§18).
        sourceAgentRunIds: usableRuns
          .filter((run) =>
            cluster.memberFindingIds.some((id) => byId.get(id)?.agentRunId === run.id),
          )
          .map((run) => run.id)
          .sort() as FindingCluster['sourceAgentRunIds'],
        sourceAgentStackIds: [
          ...cluster.memberAgentStackIds,
        ] as FindingCluster['sourceAgentStackIds'],
        representativeFindingId:
          cluster.representativeFindingId as FindingCluster['representativeFindingId'],
        agreementState: cluster.agreementState,
        expectedAgentCount: cluster.expectedAgentCount,
        usableAgentCount: cluster.usableAgentCount,
        supportingAgentCount: cluster.supportingAgentCount,
        unavailableAgentStackIds: [
          ...cluster.unavailableAgentStackIds,
        ] as FindingCluster['unavailableAgentStackIds'],
        severityValues: [...cluster.severityValues] as FindingCluster['severityValues'],
        confidenceValues: [...cluster.confidenceValues] as FindingCluster['confidenceValues'],
        categoryValues: [...cluster.categoryValues] as FindingCluster['categoryValues'],
        evidenceIds: [...cluster.evidenceIds] as FindingCluster['evidenceIds'],
        fieldDisagreements: cluster.fieldDisagreements.map((d) => ({
          field: d.field,
          valuesByAgentStackId: { ...d.valuesByAgentStackId },
        })),
        hasReproducedEvidence: cluster.hasReproducedEvidence,
        hasOperationEvidence: cluster.hasOperationEvidence,
        hasSourceEvidence: cluster.hasSourceEvidence,
        hasOnlyModelReasoning: cluster.hasOnlyModelReasoning,
        createdAt: now,
      };
    }),
    durationMs: 0,
    createdAt: now,
  };
  return { result, clusterMemberIds: clusters.map((c) => c.memberFindingIds) };
}
