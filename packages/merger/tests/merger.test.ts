import { describe, expect, it } from 'vitest';
import type { AgentRun, Evidence, Finding, QARun } from '@qa/schemas';
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
