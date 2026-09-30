import { describe, expect, it } from 'vitest';
import type { AgentRun, Evidence, Finding, QARun } from '@qa/schemas';
import { MERGER_VERSION } from '@qa/schemas';
import { compareFindings } from '../src/match.js';
import { normalizeFinding } from '../src/normalize.js';
import { selectCurrentMergeResult } from '../src/cluster.js';
import { mergeFindings } from '../src/index.js';

const RUN = 'run_01K7777777777777777777A8W1' as never;
const SNAP = 'snap_01K7777777777777777777A8W1' as never;

function qaRun(): QARun {
  return {
    schemaVersion: 1,
    id: RUN,
    projectId: 'proj_01K7777777777777777777A8W1' as never,
    snapshotId: SNAP,
    projectContextSnapshotId: 'ctx_01K7777777777777777777A8W1' as never,
    status: 'completed',
    executionKind: 'production',
    createdAt: '2026-09-14T00:00:00.000Z',
  } as unknown as QARun;
}

function agentRun(id: string, stack: string, status = 'completed'): AgentRun {
  return {
    schemaVersion: 1,
    id,
    qaRunId: RUN,
    agentStackId: stack,
    status,
  } as unknown as AgentRun;
}

function codeEvidence(id: string, path: string, startLine?: number, endLine?: number): Evidence {
  return {
    schemaVersion: 1,
    id,
    qaRunId: RUN,
    agentRunId: 'arun_01K7777777777777777777A8W1',
    type: 'code_reference',
    strength: 'strong_code_evidence',
    environmentState: 'baseline',
    description: 'source',
    codeReference: {
      relativePath: path,
      ...(startLine === undefined ? {} : { startLine }),
      ...(endLine === undefined ? {} : { endLine }),
    },
    artifactIds: [],
    groundingOperationIds: [],
    createdAt: '2026-09-14T00:00:00.000Z',
  } as unknown as Evidence;
}

function finding(partial: {
  id: string;
  agentRunId: string;
  stack: string;
  title: string;
  category?: Finding['category'];
  severity?: Finding['severity'];
  confidence?: Finding['confidence'];
  description?: string;
  locations?: Finding['locations'];
  evidenceIds?: string[];
}): Finding {
  return {
    schemaVersion: 1,
    id: partial.id,
    qaRunId: RUN,
    agentRunId: partial.agentRunId,
    sourceAgentStackId: partial.stack,
    title: partial.title,
    category: partial.category ?? 'logic',
    severity: partial.severity ?? 'medium',
    confidence: partial.confidence ?? 'strong',
    description: partial.description ?? partial.title,
    locations: partial.locations ?? [{ relativePath: 'src/math.ts' }],
    evidenceIds: partial.evidenceIds ?? [],
    reproductionSteps: [],
    createdAt: '2026-09-14T00:00:00.000Z',
  } as unknown as Finding;
}

const STACKS = ['stack_muse_main', 'stack_deepseek_main', 'stack_glm_main'];
const RUNS = [
  agentRun('arun_01K7777777777777777777A8W1', 'stack_muse_main'),
  agentRun('arun_01K7777777777777777777A8W2', 'stack_deepseek_main'),
  agentRun('arun_01K7777777777777777777A8W3', 'stack_glm_main'),
];

function mergeSetup(findings: Finding[], evidence: Evidence[] = []) {
  return mergeFindings({
    qaRun: qaRun(),
    agentRuns: RUNS,
    findings,
    evidence,
    expectedAgentStackIds: STACKS,
    now: '2026-09-14T01:00:00.000Z' as never,
  });
}

describe('deterministic merger', () => {
  it('merges the same issue with different wording (§61)', () => {
    const ev1 = codeEvidence('ev_01K7777777777777777777A8W1', 'src/math.ts', 40, 44);
    const ev2 = codeEvidence('ev_01K7777777777777777777A8W2', 'src/math.ts', 42, 42);
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Division by zero crashes the request handler',
      locations: [{ relativePath: 'src/math.ts', startLine: 42 }],
      evidenceIds: [ev1.id],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[1]?.id as string,
      stack: 'stack_deepseek_main',
      title: 'Zero denominator causes uncaught runtime error',
      locations: [{ relativePath: 'src/math.ts', startLine: 40, endLine: 44 }],
      evidenceIds: [ev2.id],
    });
    const { result } = mergeSetup([a, b], [ev1, ev2]);
    expect(result.clusterCount).toBe(1);
    expect(result.clusters[0]?.supportingAgentCount).toBe(2);
  });

  it('keeps the same title in different files apart (§62)', () => {
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Missing null validation',
      locations: [{ relativePath: 'src/users.ts' }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[1]?.id as string,
      stack: 'stack_deepseek_main',
      title: 'Missing null validation',
      locations: [{ relativePath: 'src/payments.ts' }],
    });
    const { result } = mergeSetup([a, b]);
    expect(result.clusterCount).toBe(2);
  });

  it('keeps different bugs in the same file apart (§63)', () => {
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'SQL injection in query builder',
      category: 'security',
      locations: [{ relativePath: 'src/api.ts', startLine: 20 }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[1]?.id as string,
      stack: 'stack_deepseek_main',
      title: 'Incorrect pagination offset',
      category: 'logic',
      locations: [{ relativePath: 'src/api.ts', startLine: 180 }],
    });
    const { result } = mergeSetup([a, b]);
    expect(result.clusterCount).toBe(2);
  });

  it('merges across categories with anchors and records disagreement (§64)', () => {
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Auth bypass via missing check',
      category: 'security',
      description: 'Missing authorization check allows auth bypass',
      locations: [{ relativePath: 'src/auth.ts', startLine: 10, endLine: 20 }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[1]?.id as string,
      stack: 'stack_deepseek_main',
      title: 'Missing authorization check enables bypass',
      category: 'authorization',
      description: 'Authorization check missing, bypass possible',
      locations: [{ relativePath: 'src/auth.ts', startLine: 12, endLine: 18 }],
    });
    const { result } = mergeSetup([a, b]);
    expect(result.clusterCount).toBe(1);
    const cluster = result.clusters[0];
    expect(cluster?.fieldDisagreements.some((d) => d.field === 'category')).toBe(true);
  });

  it('treats silence as not_reported, never contradiction (§65)', () => {
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Race condition in cache',
      locations: [{ relativePath: 'src/cache.ts', startLine: 5 }],
    });
    const { result } = mergeSetup([a]);
    expect(result.clusterCount).toBe(1);
    expect(result.clusters[0]?.agreementState).toBe('single_source');
    expect(result.clusters[0]?.supportingAgentCount).toBe(1);
    expect(result.clusters[0]?.fieldDisagreements).toHaveLength(0);
  });

  it('represents partial runs honestly (§66)', () => {
    const runs = [
      RUNS[0] as AgentRun,
      RUNS[1] as AgentRun,
      agentRun('arun_01K7777777777777777777A8W9', 'stack_glm_main', 'failed'),
    ];
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Shared defect in math helper',
      locations: [{ relativePath: 'src/math.ts', startLine: 7 }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[1]?.id as string,
      stack: 'stack_deepseek_main',
      title: 'Shared defect in math helper',
      locations: [{ relativePath: 'src/math.ts', startLine: 7 }],
    });
    const { result } = mergeFindings({
      qaRun: qaRun(),
      agentRuns: runs,
      findings: [a, b],
      evidence: [],
      expectedAgentStackIds: STACKS,
      now: '2026-09-14T01:00:00.000Z' as never,
    });
    expect(result.clusters[0]?.agreementState).toBe('all_available_sources');
    expect(result.clusters[0]?.supportingAgentCount).toBe(2);
    expect(result.clusters[0]?.usableAgentCount).toBe(2);
    expect(result.clusters[0]?.expectedAgentCount).toBe(3);
    expect(result.clusters[0]?.unavailableAgentStackIds).toEqual(['stack_glm_main']);
  });

  it('counts duplicate findings from one agent as one source (§67)', () => {
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Duplicated defect report',
      locations: [{ relativePath: 'src/dup.ts', startLine: 3 }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Duplicated defect report',
      locations: [{ relativePath: 'src/dup.ts', startLine: 3 }],
    });
    const { result } = mergeSetup([a, b]);
    expect(result.clusterCount).toBe(1);
    expect(result.clusters[0]?.supportingAgentCount).toBe(1);
    expect(result.clusters[0]?.sourceFindingIds).toHaveLength(2);
  });

  it('keeps same-agent identical titles at different locations apart', () => {
    // Guards the exact-duplicate case: identical titles alone never merge
    // without the same file and an overlapping location.
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Duplicated defect report',
      locations: [{ relativePath: 'src/dup-a.ts', startLine: 3 }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Duplicated defect report',
      locations: [{ relativePath: 'src/dup-b.ts', startLine: 7 }],
    });
    const { result } = mergeSetup([a, b]);
    expect(result.clusterCount).toBe(2);
  });

  it('keeps nearby same-category findings without a shared distinctive token apart', () => {
    // Guards the structural-identity case: location precision plus the
    // same category is not enough without a shared non-generic token.
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Scheduler drops delayed jobs',
      description: 'Timer wheel discards postponed tasks silently',
      locations: [{ relativePath: 'src/near.ts', startLine: 50 }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[1]?.id as string,
      stack: 'stack_deepseek_main',
      title: 'Renderer flickers on resize',
      description: 'Viewport repaints tear during window resize',
      locations: [{ relativePath: 'src/near.ts', startLine: 55 }],
    });
    const { result } = mergeSetup([a, b]);
    expect(result.clusterCount).toBe(2);
  });

  it('is order-invariant across permutations (§68)', () => {
    const mk = (n: number, stack: number, file: string, line: number, title: string) =>
      finding({
        id: `find_01K7777777777777777777A8W${n}`,
        agentRunId: (RUNS[stack] as AgentRun).id as string,
        stack: STACKS[stack] as string,
        title,
        locations: [{ relativePath: file, startLine: line }],
      });
    const findings = [
      mk(1, 0, 'src/a.ts', 10, 'Null dereference in handler'),
      mk(2, 1, 'src/a.ts', 11, 'Null dereference crashes handler'),
      mk(3, 2, 'src/b.ts', 50, 'Unrelated timeout issue'),
    ];
    const first = mergeSetup(findings);
    const reversed = mergeSetup([...findings].reverse());
    const shuffled = mergeSetup([
      findings[2] as Finding,
      findings[0] as Finding,
      findings[1] as Finding,
    ]);
    expect(JSON.stringify(reversed.result)).toBe(JSON.stringify(first.result));
    expect(JSON.stringify(shuffled.result)).toBe(JSON.stringify(first.result));
  });

  it('avoids transitive chain-merging (§70)', () => {
    // A≈B (same file, overlapping lines, shared topic). B≈C (same file,
    // overlapping lines, shared topic). A≉C (lines far apart, no shared
    // topic with each other... constructed so complete-link refuses C).
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Alpha defect in parser',
      description: 'Parser alpha defect mishandles input',
      locations: [{ relativePath: 'src/chain.ts', startLine: 10, endLine: 20 }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[1]?.id as string,
      stack: 'stack_deepseek_main',
      title: 'Beta defect in parser bridge',
      description: 'Parser bridge beta defect mishandles input',
      locations: [{ relativePath: 'src/chain.ts', startLine: 18, endLine: 30 }],
    });
    const c = finding({
      id: 'find_01K7777777777777777777A8W3',
      agentRunId: RUNS[2]?.id as string,
      stack: 'stack_glm_main',
      title: 'Gamma defect in renderer',
      description: 'Renderer gamma defect drops frames',
      locations: [{ relativePath: 'src/chain.ts', startLine: 200, endLine: 210 }],
    });
    const { result } = mergeSetup([a, b, c]);
    // A and B share the file with overlapping lines and the parser/input
    // topic; C is distant with disjoint vocabulary: complete-link must
    // refuse C even though a naive chain would connect through B.
    const ab = result.clusters.find((cluster) => cluster.sourceFindingIds.includes(a.id as never));
    expect(ab?.sourceFindingIds).toContain(b.id);
    expect(ab?.sourceFindingIds).not.toContain(c.id);
  });

  it('records severity disagreement without rewriting (§71)', () => {
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Shared defect with disputed severity',
      severity: 'high',
      locations: [{ relativePath: 'src/s.ts', startLine: 1 }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[1]?.id as string,
      stack: 'stack_deepseek_main',
      title: 'Shared defect with disputed severity',
      severity: 'medium',
      locations: [{ relativePath: 'src/s.ts', startLine: 1 }],
    });
    const c = finding({
      id: 'find_01K7777777777777777777A8W3',
      agentRunId: RUNS[2]?.id as string,
      stack: 'stack_glm_main',
      title: 'Shared defect with disputed severity',
      severity: 'high',
      locations: [{ relativePath: 'src/s.ts', startLine: 1 }],
    });
    const { result } = mergeSetup([a, b, c]);
    expect(result.clusterCount).toBe(1);
    const cluster = result.clusters[0];
    expect(cluster?.severityValues).toEqual(['high', 'medium']);
    expect(cluster?.fieldDisagreements.some((d) => d.field === 'severity')).toBe(true);
  });

  it('keeps same-symbol different-bug findings apart (§12)', () => {
    // The v1 false-positive: same file + same symbol + shared generic
    // topic tokens (request/handler) merged two different defects.
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Null dereference in request handler',
      description: 'Missing null validation crashes request processing',
      locations: [{ relativePath: 'src/api.ts', symbol: 'handleRequest', startLine: 20 }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[1]?.id as string,
      stack: 'stack_deepseek_main',
      title: 'Request cancellation timeout in handler',
      description: 'Request handler never cancels timed-out operation',
      locations: [{ relativePath: 'src/api.ts', symbol: 'handleRequest', startLine: 80 }],
    });
    const { result } = mergeSetup([a, b]);
    expect(result.clusterCount).toBe(2);
  });

  it('still merges same-symbol same-bug findings (§13)', () => {
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Null dereference in request handler',
      description: 'Missing null guard crashes handleRequest on empty payload',
      locations: [{ relativePath: 'src/api.ts', symbol: 'handleRequest', startLine: 20 }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[1]?.id as string,
      stack: 'stack_deepseek_main',
      title: 'Missing null guard crashes handleRequest',
      description: 'Null dereference in request handler when payload is empty',
      locations: [{ relativePath: 'src/api.ts', symbol: 'handleRequest', startLine: 22 }],
    });
    const { result } = mergeSetup([a, b]);
    expect(result.clusterCount).toBe(1);
    expect(result.clusters[0]?.supportingAgentCount).toBe(2);
  });

  it('keeps same-line clearly different bugs apart (§14)', () => {
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Parser throws on empty input',
      description: 'parseAndCache rejects empty input with uncaught exception',
      locations: [{ relativePath: 'src/cache.ts', startLine: 42 }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[1]?.id as string,
      stack: 'stack_deepseek_main',
      title: 'Cache race causes stale data',
      description: 'concurrent writes race, readers observe stale entries',
      locations: [{ relativePath: 'src/cache.ts', startLine: 42 }],
    });
    const { result } = mergeSetup([a, b]);
    expect(result.clusterCount).toBe(2);
  });

  it('refuses equivalence from generic vocabulary alone (§15)', () => {
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'API request handler returns stale cache',
      description: 'API request handler serves stale cache entries after invalidation',
      locations: [{ relativePath: 'src/api.ts', symbol: 'handleRequest', startLine: 30 }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: RUNS[1]?.id as string,
      stack: 'stack_deepseek_main',
      title: 'API request handler leaks memory',
      description: 'API request handler accumulates response buffers without release',
      locations: [{ relativePath: 'src/api.ts', symbol: 'handleRequest', startLine: 90 }],
    });
    const { result } = mergeSetup([a, b]);
    expect(result.clusterCount).toBe(2);
  });

  it('is invariant under agent-run permutation (§19)', () => {
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: 'arun_01K7777777777777777777A8W1',
      stack: 'stack_muse_main',
      title: 'Shared defect with disputed severity',
      severity: 'high',
      locations: [{ relativePath: 'src/s.ts', startLine: 1 }],
    });
    const b = finding({
      id: 'find_01K7777777777777777777A8W2',
      agentRunId: 'arun_01K7777777777777777777A8W3',
      stack: 'stack_glm_main',
      title: 'Shared defect with disputed severity',
      severity: 'medium',
      locations: [{ relativePath: 'src/s.ts', startLine: 1 }],
    });
    const run = (order: AgentRun[]) =>
      mergeFindings({
        qaRun: qaRun(),
        agentRuns: order,
        findings: [a, b],
        evidence: [],
        expectedAgentStackIds: STACKS,
        now: '2026-09-14T01:00:00.000Z' as never,
      });
    const base = run(RUNS);
    const permuted = run([RUNS[2] as AgentRun, RUNS[0] as AgentRun, RUNS[1] as AgentRun]);
    expect(permuted.result.inputDigest).toBe(base.result.inputDigest);
    expect(permuted.result.clusters.map((c) => c.id)).toEqual(
      base.result.clusters.map((c) => c.id),
    );
    expect(permuted.result.clusters[0]?.sourceAgentRunIds).toEqual(
      base.result.clusters[0]?.sourceAgentRunIds,
    );
    expect(permuted.result.clusters[0]?.representativeFindingId).toBe(
      base.result.clusters[0]?.representativeFindingId,
    );
    expect(JSON.stringify(permuted.result.clusters)).toBe(JSON.stringify(base.result.clusters));
  });

  it('is invariant under evidence permutation (§20)', () => {
    const ev1 = codeEvidence('ev_01K7777777777777777777A8W1', 'src/math.ts', 40, 44);
    const ev2 = codeEvidence('ev_01K7777777777777777777A8W2', 'src/math.ts', 42, 42);
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Division by zero crashes the request handler',
      locations: [{ relativePath: 'src/math.ts', startLine: 42 }],
      evidenceIds: [ev1.id, ev2.id],
    });
    const mk = (evidence: Evidence[]) =>
      mergeFindings({
        qaRun: qaRun(),
        agentRuns: RUNS,
        findings: [a],
        evidence,
        expectedAgentStackIds: STACKS,
        now: '2026-09-14T01:00:00.000Z' as never,
      });
    const first = mk([ev1, ev2]);
    const swapped = mk([ev2, ev1]);
    expect(swapped.result.inputDigest).toBe(first.result.inputDigest);
    expect(JSON.stringify(swapped.result.clusters)).toBe(JSON.stringify(first.result.clusters));
  });

  it('stamps merger v3 and selects the highest supported version (§3, §12)', () => {
    expect(MERGER_VERSION).toBe(3);
    const a = finding({
      id: 'find_01K7777777777777777777A8W1',
      agentRunId: RUNS[0]?.id as string,
      stack: 'stack_muse_main',
      title: 'Version stamp probe',
      locations: [{ relativePath: 'src/v.ts', startLine: 1 }],
    });
    const { result } = mergeSetup([a]);
    expect(result.mergerVersion).toBe(3);
    expect(result.normalizerVersion).toBe(1);
    expect(result.clusters[0]?.mergerVersion).toBe(3);
    const current = selectCurrentMergeResult([
      { mergerVersion: 2, inputDigest: 'sha256:' + 'a'.repeat(64) },
      { mergerVersion: 3, inputDigest: 'sha256:' + 'b'.repeat(64) },
    ]);
    expect(current?.mergerVersion).toBe(3);
    const legacy = selectCurrentMergeResult([
      { mergerVersion: 2, inputDigest: 'sha256:' + 'a'.repeat(64) },
    ]);
    expect(legacy?.mergerVersion).toBe(2);
  });

  describe('merger v3 production trust fix', () => {
    function richFinding(partial: {
      id: string;
      agentRunId: string;
      stack: string;
      title: string;
      category?: Finding['category'];
      description?: string;
      actualBehavior?: string;
      expectedBehavior?: string;
      rootCause?: string;
      locations?: Finding['locations'];
      evidenceIds?: string[];
    }): Finding {
      const base = finding({
        id: partial.id,
        agentRunId: partial.agentRunId,
        stack: partial.stack,
        title: partial.title,
        category: partial.category,
        description: partial.description,
        locations: partial.locations,
        evidenceIds: partial.evidenceIds,
      });
      return {
        ...base,
        ...(partial.actualBehavior === undefined ? {} : { actualBehavior: partial.actualBehavior }),
        ...(partial.expectedBehavior === undefined
          ? {}
          : { expectedBehavior: partial.expectedBehavior }),
        ...(partial.rootCause === undefined ? {} : { rootCause: partial.rootCause }),
      } as Finding;
    }

    // Single-agent DeepSeek run: same file, overlapping lines, PostgreSQL-adjacent
    // vocabulary — but sequence-reset vs divide-by-zero are different defects.
    function transferPair() {
      const runId = RUNS[1]?.id as string;
      const stack = 'stack_deepseek_main';
      const a = richFinding({
        id: 'find_01K7777777777777777777A8WA1',
        agentRunId: runId,
        stack,
        title:
          'SQLite to PostgreSQL transfer copies explicit primary keys without resetting sequences',
        category: 'database',
        description:
          'Bulk copy preserves explicit primary key values; PostgreSQL sequences stay behind',
        actualBehavior:
          'Inserted rows reuse key values while the sequence generator still points at the old value',
        rootCause: 'Sequence generator state not reset after explicit key copy',
        locations: [{ relativePath: 'transfer_sqlite.py', startLine: 40, endLine: 60 }],
      });
      const b = richFinding({
        id: 'find_01K7777777777777777777A8WB1',
        agentRunId: runId,
        stack,
        title: 'Pricing recomputation raises DivisionByZero when native quantity is zero',
        category: 'logic',
        description: 'Price recompute divides by native quantity without a zero guard',
        actualBehavior:
          'DivisionByZero raised when native_quantity equals zero during pricing recomputation',
        rootCause: 'Missing zero guard before division in pricing path',
        locations: [{ relativePath: 'transfer_sqlite.py', startLine: 52, endLine: 70 }],
      });
      return [a, b] as const;
    }

    it('keeps transfer_sqlite.py sequence-reset and divide-by-zero apart (false merge 1)', () => {
      const [a, b] = transferPair();
      const { result } = mergeSetup([a, b]);
      expect(result.clusterCount).toBe(2);
    });

    it('keeps data.py CSV-guard crash and concurrency inconsistency apart (false merge 2)', () => {
      const runId = RUNS[1]?.id as string;
      const stack = 'stack_deepseek_main';
      const a = richFinding({
        id: 'find_01K7777777777777777777A8WA2',
        agentRunId: runId,
        stack,
        title: 'CSV formula mitigation crashes export on non-string values',
        category: 'logic',
        description: 'CSV export guard assumes string cells and throws on numbers or nulls',
        actualBehavior: 'Export raises TypeError when a cell value is not a string',
        rootCause: 'Missing type check before string prefix inspection in CSV guard',
        locations: [{ relativePath: 'data.py', startLine: 100, endLine: 120, symbol: 'exportCsv' }],
      });
      const b = richFinding({
        id: 'find_01K7777777777777777777A8WB2',
        agentRunId: runId,
        stack,
        title: 'Backup export snapshot can go inconsistent under concurrent writes',
        category: 'concurrency',
        description: 'Backup reads files while writers mutate them; no snapshot isolation',
        actualBehavior: 'Concurrent writes during backup produce a mixed-revision export archive',
        rootCause: 'No snapshot or lock around multi-file backup read path',
        locations: [{ relativePath: 'data.py', startLine: 108, endLine: 130, symbol: 'exportCsv' }],
      });
      const { result } = mergeSetup([a, b]);
      expect(result.clusterCount).toBe(2);
    });

    it('keeps manage.py CRLF env failure and pnpm fallback apart (false merge 3)', () => {
      const runId = RUNS[1]?.id as string;
      const stack = 'stack_deepseek_main';
      const a = richFinding({
        id: 'find_01K7777777777777777777A8WA3',
        agentRunId: runId,
        stack,
        title: 'Env file generation fails with CRLF line endings and missing final newline',
        category: 'configuration',
        description: 'Secret replacement assumes LF endings and a trailing newline',
        actualBehavior: 'Generated .env keeps carriage returns and drops the last variable',
        rootCause: 'Line splitting does not normalize CRLF or enforce a final newline',
        locations: [{ relativePath: 'manage.py', startLine: 30, endLine: 50 }],
      });
      const b = richFinding({
        id: 'find_01K7777777777777777777A8WB3',
        agentRunId: runId,
        stack,
        title: 'pnpm fallback throws KeyError and FileNotFoundError on malformed package.json',
        category: 'dependency',
        description: 'Fallback path indexes package.json fields without validation',
        actualBehavior: 'Malformed or missing package.json raises KeyError or FileNotFoundError',
        rootCause: 'Unvalidated field access in pnpm fallback for missing package metadata',
        locations: [{ relativePath: 'manage.py', startLine: 38, endLine: 55 }],
      });
      const { result } = mergeSetup([a, b]);
      expect(result.clusterCount).toBe(2);
    });

    it('keeps same-symbol SQL injection and null dereference apart (same-line different defect)', () => {
      const a = richFinding({
        id: 'find_01K7777777777777777777A8WA4',
        agentRunId: RUNS[0]?.id as string,
        stack: 'stack_muse_main',
        title: 'SQL injection in saveUser query construction',
        category: 'security',
        description: 'User input is concatenated into SQL without parameterization',
        actualBehavior: 'Crafted username input alters the executed SQL statement',
        rootCause: 'String-concatenated SQL in saveUser without bound parameters',
        locations: [
          { relativePath: 'src/users.ts', symbol: 'saveUser', startLine: 50, endLine: 60 },
        ],
      });
      const b = richFinding({
        id: 'find_01K7777777777777777777A8WB4',
        agentRunId: RUNS[1]?.id as string,
        stack: 'stack_deepseek_main',
        title: 'Null dereference in saveUser on missing profile',
        category: 'runtime',
        description: 'saveUser dereferences an optional profile without a null check',
        actualBehavior: 'Missing profile triggers a null dereference crash in saveUser',
        rootCause: 'Unchecked optional profile access in saveUser',
        locations: [
          { relativePath: 'src/users.ts', symbol: 'saveUser', startLine: 52, endLine: 62 },
        ],
      });
      const { result } = mergeSetup([a, b]);
      expect(result.clusterCount).toBe(2);
    });

    it('merges cross-agent refresh-token duplicates (positive)', () => {
      const a = richFinding({
        id: 'find_01K7777777777777777777A8WA5',
        agentRunId: RUNS[0]?.id as string,
        stack: 'stack_muse_main',
        title: 'Refresh token remains reusable after rotation',
        category: 'authentication',
        description: 'Old refresh token still accepted after rotation at the session endpoint',
        actualBehavior: 'Old refresh token can be used again after refresh at the session endpoint',
        rootCause: 'Rotated refresh token not invalidated at the session endpoint',
        locations: [{ relativePath: 'src/session.ts', startLine: 80, endLine: 95 }],
      });
      const b = richFinding({
        id: 'find_01K7777777777777777777A8WB5',
        agentRunId: RUNS[1]?.id as string,
        stack: 'stack_deepseek_main',
        title: 'Old refresh token can be used again after refresh',
        category: 'authentication',
        description: 'Session endpoint accepts the previous refresh token after rotation',
        actualBehavior:
          'Previous refresh token remains valid after refresh at the session endpoint',
        rootCause: 'Previous refresh token never revoked at the session endpoint',
        locations: [{ relativePath: 'src/session.ts', startLine: 82, endLine: 97 }],
      });
      const { result } = mergeSetup([a, b]);
      expect(result.clusterCount).toBe(1);
      expect(result.clusters[0]?.supportingAgentCount).toBe(2);
      const byId = new Map<string, Evidence>();
      const na = normalizeFinding(a as Finding, byId);
      const nb = normalizeFinding(b as Finding, byId);
      expect(compareFindings(na, nb).matchCase).toBe('cross_agent_behavior_rootcause');
    });

    it('merges cross-agent null-export duplicates with evidence (positive)', () => {
      const ev1 = codeEvidence('ev_01K7777777777777777777A8WA6', 'src/export.ts', 20, 30);
      const ev2 = codeEvidence('ev_01K7777777777777777777A8WB6', 'src/export.ts', 22, 28);
      const a = richFinding({
        id: 'find_01K7777777777777777777A8WA6',
        agentRunId: RUNS[1]?.id as string,
        stack: 'stack_deepseek_main',
        title: 'None input crashes export with AttributeError',
        category: 'runtime',
        description: 'Export dereferences a null model name during serialization',
        actualBehavior: 'Export raises AttributeError when the model name is null',
        rootCause: 'Missing null guard before model name access in export',
        locations: [{ relativePath: 'src/export.ts', startLine: 20, endLine: 30 }],
        evidenceIds: [ev1.id],
      });
      const b = richFinding({
        id: 'find_01K7777777777777777777A8WB6',
        agentRunId: RUNS[2]?.id as string,
        stack: 'stack_glm_main',
        title: 'Export raises AttributeError when model name is null',
        category: 'runtime',
        description: 'Null model name crashes export serialization path',
        actualBehavior: 'Export raises AttributeError when the model name is null',
        rootCause: 'Export accesses model name without a null check',
        locations: [{ relativePath: 'src/export.ts', startLine: 22, endLine: 28 }],
        evidenceIds: [ev2.id],
      });
      const { result } = mergeSetup([a, b], [ev1, ev2]);
      expect(result.clusterCount).toBe(1);
    });

    it('merges same-agent accidental duplicates under strong evidence (positive)', () => {
      const runId = RUNS[1]?.id as string;
      const stack = 'stack_deepseek_main';
      const a = richFinding({
        id: 'find_01K7777777777777777777A8WA7',
        agentRunId: runId,
        stack,
        title: 'Division by zero crashes pricing when quantity is zero',
        category: 'logic',
        description: 'Pricing divides by quantity without guarding against zero',
        actualBehavior:
          'Pricing throws DivisionByZero when quantity equals zero in the pricing path',
        rootCause: 'Missing zero guard before division in the pricing path',
        locations: [{ relativePath: 'src/pricing.ts', startLine: 44, endLine: 52 }],
      });
      const b = richFinding({
        id: 'find_01K7777777777777777777A8WB7',
        agentRunId: runId,
        stack,
        title: 'Pricing throws DivisionByZero for zero quantity',
        category: 'logic',
        description: 'Zero quantity reaches the pricing divisor unchecked',
        actualBehavior:
          'Pricing throws DivisionByZero when quantity equals zero in the pricing path',
        rootCause: 'Pricing path divides without a zero guard',
        locations: [{ relativePath: 'src/pricing.ts', startLine: 44, endLine: 52 }],
      });
      const { result } = mergeSetup([a, b]);
      expect(result.clusterCount).toBe(1);
    });

    it('exposes sameSourceAgent and matchCase deterministically', () => {
      const [a, b] = transferPair();
      const byId = new Map([
        [a.id, a],
        [b.id, b],
      ]);
      void byId;
      const empty = new Map<string, Evidence>();
      const na = normalizeFinding(a as Finding, empty);
      const nb = normalizeFinding(b as Finding, empty);
      const first = compareFindings(na, nb);
      const swapped = compareFindings(nb, na);
      expect(first.equivalent).toBe(false);
      expect(first.matchCase).toBe('none');
      expect(first.reasons.sameSourceAgent).toBe(true);
      expect(first.reasons.sharedDistinctiveToken).toBe(true);
      // Debug signal only: shared token must not flip equivalence.
      expect(swapped.equivalent).toBe(first.equivalent);
      expect(swapped.matchCase).toBe(first.matchCase);
    });

    it('keeps complete-link protection with v3 semantics', () => {
      const a = richFinding({
        id: 'find_01K7777777777777777777A8WA9',
        agentRunId: RUNS[0]?.id as string,
        stack: 'stack_muse_main',
        title: 'Refresh token remains reusable after rotation',
        category: 'authentication',
        description: 'Old refresh token still accepted after rotation at the session endpoint',
        actualBehavior: 'Old refresh token can be used again after refresh at the session endpoint',
        rootCause: 'Rotated refresh token not invalidated at the session endpoint',
        locations: [{ relativePath: 'src/session.ts', startLine: 80, endLine: 95 }],
      });
      const b = richFinding({
        id: 'find_01K7777777777777777777A8WB9',
        agentRunId: RUNS[1]?.id as string,
        stack: 'stack_deepseek_main',
        title: 'Old refresh token can be used again after refresh',
        category: 'authentication',
        description: 'Session endpoint accepts the previous refresh token after rotation',
        actualBehavior:
          'Previous refresh token remains valid after refresh at the session endpoint',
        rootCause: 'Previous refresh token never revoked at the session endpoint',
        locations: [{ relativePath: 'src/session.ts', startLine: 82, endLine: 97 }],
      });
      const c = richFinding({
        id: 'find_01K7777777777777777777A8WC9',
        agentRunId: RUNS[2]?.id as string,
        stack: 'stack_glm_main',
        title: 'Unrelated password expiry notice missing',
        category: 'authentication',
        description: 'Password expiry notice never rendered on the profile page',
        actualBehavior: 'Profile page shows no password expiry notice before expiry',
        rootCause: 'Missing expiry banner in profile rendering',
        locations: [{ relativePath: 'src/session.ts', startLine: 400, endLine: 410 }],
      });
      const { result } = mergeSetup([a, b, c]);
      expect(result.clusterCount).toBe(2);
      const ab = result.clusters.find((cluster) =>
        cluster.sourceFindingIds.includes(a.id as never),
      );
      expect(ab?.sourceFindingIds).toContain(b.id);
      expect(ab?.sourceFindingIds).not.toContain(c.id);
    });
  });

  it('never upgrades confidence from agreement (§72)', () => {
    const mkProbable = (n: number, stack: number) =>
      finding({
        id: `find_01K7777777777777777777A8W${n}`,
        agentRunId: (RUNS[stack] as AgentRun).id as string,
        stack: STACKS[stack] as string,
        title: 'Probably shared defect',
        confidence: 'probable',
        locations: [{ relativePath: 'src/p.ts', startLine: 4 }],
      });
    const { result } = mergeSetup([mkProbable(1, 0), mkProbable(2, 1), mkProbable(3, 2)]);
    expect(result.clusterCount).toBe(1);
    expect(result.clusters[0]?.agreementState).toBe('all_available_sources');
    expect(result.clusters[0]?.confidenceValues).toEqual(['probable']);
  });
});
