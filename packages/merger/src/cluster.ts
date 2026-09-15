import type { Evidence, Finding } from '@qa/schemas';
import { groundingOfEvidence } from '@qa/domain';
import { MERGER_VERSION, type AgreementState } from './schemas.js';
import { compareFindings } from './match.js';
import { normalizeFinding, sha256Hex, type NormalizedFinding } from './normalize.js';

/**
 * Deterministic complete-link clustering (merger v2). A finding joins a
 * cluster only when compatible with EVERY existing member — this
 * prevents transitive chain-merging (A≈B, B≈C, A≉C never collapse).
 * Insertion order is the canonical finding-ID sort, so output is
 * order-invariant regardless of input permutation. Every derived list
 * (stacks, severities, evidence, disagreements) is explicitly sorted;
 * nothing depends on repository retrieval order.
 */

export interface ClusterInput {
  readonly qaRunId: string;
  readonly projectSnapshotId: string;
  readonly findings: readonly Finding[];
  readonly evidenceById: ReadonlyMap<string, Evidence>;
  readonly expectedAgentStackIds: readonly string[];
  readonly usableAgentRuns: ReadonlyArray<{ agentRunId: string; agentStackId: string }>;
  readonly mergerVersion?: number;
}

export interface BuiltCluster {
  readonly memberFindingIds: readonly string[];
  readonly memberAgentStackIds: readonly string[];
  readonly representativeFindingId: string;
  readonly agreementState: AgreementState;
  readonly expectedAgentCount: number;
  readonly usableAgentCount: number;
  readonly supportingAgentCount: number;
  readonly unavailableAgentStackIds: readonly string[];
  readonly severityValues: readonly string[];
  readonly confidenceValues: readonly string[];
  readonly categoryValues: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly fieldDisagreements: ReadonlyArray<{
    field: 'severity' | 'confidence' | 'category' | 'location' | 'rootCause';
    valuesByAgentStackId: Record<string, string>;
  }>;
  readonly hasReproducedEvidence: boolean;
  readonly hasOperationEvidence: boolean;
  readonly hasSourceEvidence: boolean;
  readonly hasOnlyModelReasoning: boolean;
  readonly clusterId: string;
}

function crockfordFromHash(hex: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let index = 0; out.length < 26; index += 1) {
    const byte = parseInt(hex.slice((index * 2) % hex.length, ((index * 2) % hex.length) + 2), 16);
    out += alphabet[byte % 32];
  }
  return out;
}

export function deterministicClusterId(
  projectSnapshotId: string,
  sortedFindingIds: readonly string[],
): string {
  const seed = [MERGER_VERSION, projectSnapshotId, ...sortedFindingIds].join('|');
  return 'cluster_' + crockfordFromHash(sha256Hex(seed));
}

function distinctSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Representative selection (documented rule): strongest canonical
 *  grounding present, then highest severity rank, then highest
 *  confidence rank, then smallest FindingId. Agreement count never
 *  boosts anything. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const CONFIDENCE_RANK: Record<string, number> = {
  confirmed: 0,
  strong: 1,
  probable: 2,
  speculative: 3,
};
const GROUNDING_RANK: Record<string, number> = {
  reproduced: 0,
  operation_observed: 1,
  source_verified: 2,
  model_reported: 3,
};

function bestGroundingRank(finding: Finding, evidenceById: ReadonlyMap<string, Evidence>): number {
  let best = 99;
  for (const id of finding.evidenceIds) {
    const evidence = evidenceById.get(id);
    if (evidence === undefined) continue;
    const rank = GROUNDING_RANK[groundingOfEvidence(evidence)] ?? 99;
    if (rank < best) best = rank;
  }
  return best;
}

export function selectRepresentative(
  members: readonly Finding[],
  evidenceById: ReadonlyMap<string, Evidence>,
): string {
  const ranked = [...members].sort((a, b) => {
    const grounding = bestGroundingRank(a, evidenceById) - bestGroundingRank(b, evidenceById);
    if (grounding !== 0) return grounding;
    const severity = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (severity !== 0) return severity;
    const confidence = (CONFIDENCE_RANK[a.confidence] ?? 9) - (CONFIDENCE_RANK[b.confidence] ?? 9);
    if (confidence !== 0) return confidence;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const winner = ranked[0];
  if (winner === undefined) throw new Error('Cannot select a representative of zero members');
  return winner.id;
}

function fieldDisagreement(
  field: 'severity' | 'confidence' | 'category' | 'location' | 'rootCause',
  members: readonly Finding[],
  pick: (finding: Finding) => string | undefined,
): { field: typeof field; valuesByAgentStackId: Record<string, string> } | undefined {
  const valuesByAgentStackId: Record<string, string> = {};
  for (const member of [...members].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const value = pick(member);
    if (value !== undefined) valuesByAgentStackId[member.sourceAgentStackId] = value;
  }
  const distinct = new Set(Object.values(valuesByAgentStackId));
  if (distinct.size <= 1) return undefined;
  return { field, valuesByAgentStackId };
}

function locationSummary(finding: Finding): string | undefined {
  const first = finding.locations[0];
  if (first === undefined) return undefined;
  return (
    first.relativePath +
    ':' +
    (first.startLine ?? '') +
    '-' +
    (first.endLine ?? '') +
    ':' +
    (first.symbol ?? '')
  );
}

export function buildClusters(input: ClusterInput): BuiltCluster[] {
  const normalized = new Map<string, NormalizedFinding>();
  const byId = new Map<string, Finding>();
  for (const finding of input.findings) {
    byId.set(finding.id, finding);
    normalized.set(finding.id, normalizeFinding(finding, input.evidenceById));
  }
  // Stable sorted insertion order → order-invariant output.
  const ordered = [...input.findings].sort((a, b) => (a.id < b.id ? -1 : 1));
  const clusters: string[][] = [];
  for (const finding of ordered) {
    const candidate = normalized.get(finding.id);
    if (candidate === undefined) continue;
    let placed = false;
    for (const cluster of clusters) {
      // Complete-link: compatible with EVERY existing member.
      const compatible = cluster.every((memberId) => {
        const member = normalized.get(memberId);
        if (member === undefined) return false;
        return compareFindings(candidate, member).equivalent;
      });
      if (compatible) {
        cluster.push(finding.id);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([finding.id]);
  }
  const usableStackIds = distinctSorted(input.usableAgentRuns.map((run) => run.agentStackId));
  const unavailable = distinctSorted(
    input.expectedAgentStackIds.filter((stack) => !usableStackIds.includes(stack)),
  );
  return clusters.map((memberIds) => {
    const sortedIds = [...memberIds].sort();
    const members = sortedIds
      .map((id) => byId.get(id))
      .filter((f): f is Finding => f !== undefined);
    const memberStacks = distinctSorted(members.map((m) => m.sourceAgentStackId));
    const uniqueStacks = memberStacks.length;
    const agreementState: AgreementState =
      uniqueStacks >= usableStackIds.length && usableStackIds.length > 0
        ? 'all_available_sources'
        : uniqueStacks > 1
          ? 'multi_source'
          : 'single_source';
    const evidenceIds = distinctSorted(members.flatMap((m) => m.evidenceIds));
    const evidenceItems = evidenceIds
      .map((id) => input.evidenceById.get(id))
      .filter((e): e is Evidence => e !== undefined);
    const groundings = new Set(evidenceItems.map((e) => groundingOfEvidence(e)));
    const disagreements = [
      fieldDisagreement('severity', members, (f) => f.severity),
      fieldDisagreement('confidence', members, (f) => f.confidence),
      fieldDisagreement('category', members, (f) => f.category),
      fieldDisagreement('location', members, locationSummary),
      fieldDisagreement('rootCause', members, (f) => f.rootCause),
    ].filter((d): d is NonNullable<typeof d> => d !== undefined);
    return {
      memberFindingIds: sortedIds,
      memberAgentStackIds: memberStacks,
      representativeFindingId: selectRepresentative(members, input.evidenceById),
      agreementState,
      expectedAgentCount: input.expectedAgentStackIds.length,
      usableAgentCount: usableStackIds.length,
      supportingAgentCount: uniqueStacks,
      unavailableAgentStackIds: unavailable,
      severityValues: distinctSorted(members.map((m) => m.severity)),
      confidenceValues: distinctSorted(members.map((m) => m.confidence)),
      categoryValues: distinctSorted(members.map((m) => m.category)),
      evidenceIds,
      fieldDisagreements: disagreements,
      hasReproducedEvidence: groundings.has('reproduced'),
      hasOperationEvidence: groundings.has('operation_observed') || groundings.has('reproduced'),
      hasSourceEvidence: groundings.has('source_verified'),
      hasOnlyModelReasoning:
        groundings.size > 0 && groundings.has('model_reported') && groundings.size === 1,
      clusterId: deterministicClusterId(input.projectSnapshotId, sortedIds),
    };
  });
}

export function mergerVersion(): number {
  return MERGER_VERSION;
}
