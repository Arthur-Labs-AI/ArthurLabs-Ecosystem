import { describe, expect, it } from 'vitest';
import { buildRetestGraph, buildRunGraph } from '../../src/renderer/lib/run-graph.js';

const BASE_RUN = {
  id: 'run_01K7777777777777777777A8W1',
  projectId: 'proj_01K7777777777777777777A8W1',
  mode: 'full',
  status: 'completed',
  executionKind: 'production',
  snapshotId: 'snap_01K7777777777777777777A8W1',
  createdAt: '2026-09-18T22:14:08.000Z',
  configuration: { agentStackIds: ['stack_muse_main', 'stack_deepseek_main', 'stack_glm_main'] },
};

const AGENTS = [
  {
    id: 'arun_01K7777777777777777777A8W1',
    qaRunId: BASE_RUN.id,
    agentStackId: 'stack_muse_main',
    status: 'completed',
  },
  {
    id: 'arun_01K7777777777777777777A8W2',
    qaRunId: BASE_RUN.id,
    agentStackId: 'stack_deepseek_main',
    status: 'completed',
  },
  {
    id: 'arun_01K7777777777777777777A8W3',
    qaRunId: BASE_RUN.id,
    agentStackId: 'stack_glm_main',
    status: 'failed',
  },
];

describe('run graph builder', () => {
  it('builds the canonical FULL topology deterministically', () => {
    const input = { run: BASE_RUN, agentRuns: AGENTS, findings: [], evidence: [] };
    const first = buildRunGraph(input);
    const second = buildRunGraph(input);
    expect(first).toEqual(second);
    const kinds = first.nodes.map((n) => n.kind);
    expect(kinds).toContain('project');
    expect(kinds).toContain('revision');
    expect(kinds).toContain('snapshot');
    expect(kinds.filter((k) => k === 'agent')).toHaveLength(3);
    expect(kinds).not.toContain('target');
    // Retired pipeline: no automatic merge / verify / issues nodes.
    expect(kinds).not.toContain('merger');
    expect(kinds).not.toContain('verifier');
    expect(kinds).not.toContain('issues');
    expect(first.nodes).toHaveLength(6);
    expect(first.edges).toHaveLength(5);
  });

  it('terminalizes from AgentRuns alone: failed agents stay visible, no downstream nodes', () => {
    const graph = buildRunGraph({
      run: { ...BASE_RUN, status: 'partial' },
      agentRuns: AGENTS,
      findings: [],
      evidence: [],
    });
    const failed = graph.nodes.find((n) => n.id === 'agent-stack_glm_main');
    expect(failed?.status).toBe('failed');
    expect(graph.nodes).toHaveLength(6);
    const kinds = graph.nodes.map((n) => n.kind);
    expect(kinds).not.toContain('merger');
    expect(kinds).not.toContain('verifier');
    expect(kinds).not.toContain('issues');
  });

  it('adds the TargetSpec node for TARGETED runs', () => {
    const graph = buildRunGraph({
      run: { ...BASE_RUN, mode: 'targeted' },
      agentRuns: AGENTS,
      findings: [],
      evidence: [],
      targetSpec: { includePaths: ['src/auth'], userInstructions: 'Focus refresh tokens' },
    });
    expect(graph.nodes.some((n) => n.kind === 'target')).toBe(true);
    const target = graph.nodes.find((n) => n.kind === 'target');
    expect(target?.data['includePaths'] as string[]).toEqual(['src/auth']);
  });

  it('keeps findings independently associated with their agentRunId', () => {
    const graph = buildRunGraph({
      run: BASE_RUN,
      agentRuns: AGENTS,
      findings: [
        { id: 'f1', agentRunId: AGENTS[0]?.id ?? '', severity: 'critical', title: 't' },
        { id: 'f2', agentRunId: AGENTS[1]?.id ?? '', severity: 'high', title: 't' },
      ],
      evidence: [],
    });
    const counts = Object.fromEntries(graph.agents.map((a) => [a.agentStackId, a.findingsCount]));
    expect(counts['stack_muse_main']).toBe(1);
    expect(counts['stack_deepseek_main']).toBe(1);
    expect(counts['stack_glm_main']).toBe(0);
  });

  it('renders waiting placeholders before AgentRuns exist', () => {
    const graph = buildRunGraph({
      run: { ...BASE_RUN, status: 'agents_running' },
      agentRuns: [],
      findings: [],
      evidence: [],
    });
    expect(graph.nodes.filter((n) => n.kind === 'agent').every((n) => n.status === 'waiting')).toBe(
      true,
    );
  });

  it('ignores historical merger/verifier payloads without creating pipeline nodes', () => {
    const graph = buildRunGraph({
      run: BASE_RUN,
      agentRuns: AGENTS,
      findings: [],
      evidence: [],
      mergeResults: [
        {
          id: 'merge_01K7777777777777777777A8W1',
          mergerVersion: 2,
          usableAgentRunIds: [AGENTS[0]?.id ?? '', AGENTS[1]?.id ?? ''],
          expectedAgentStackIds: ['stack_muse_main', 'stack_deepseek_main', 'stack_glm_main'],
          unavailableAgentStackIds: ['stack_glm_main'],
          clusters: [
            {
              id: 'cluster_01K7777777777777777777A8W1',
              agreementState: 'multi_source',
              supportingAgentCount: 2,
              usableAgentCount: 2,
            },
          ],
        },
      ],
      verificationRuns: [
        {
          id: 'vrun_01K7777777777777777777A8W1',
          status: 'completed',
          verifierVersion: 3,
          attempts: [{ outcome: 'reproduced' }, { outcome: 'inconclusive' }],
        },
      ],
      issueCount: 3,
    });
    const kinds = graph.nodes.map((n) => n.kind);
    expect(kinds).not.toContain('merger');
    expect(kinds).not.toContain('verifier');
    expect(kinds).not.toContain('issues');
    expect(graph.nodes).toHaveLength(6);
  });

  it('renders retest cancelled/failed runs with preserved lineage (§171)', () => {
    for (const status of ['cancelled', 'failed']) {
      const graph = buildRetestGraph({
        run: { ...BASE_RUN, status },
        agentRuns: AGENTS,
        findings: [],
        evidence: [],
        sourceRevisionId: 'rev_01K7777777777777777777A8W1',
        targetRevisionId: 'rev_01K7777777777777777777A8W2',
        assessment: undefined,
      });
      expect(graph.nodes.some((n) => n.kind === 'retest-source')).toBe(true);
      expect(graph.nodes.some((n) => n.kind === 'retest-spec')).toBe(true);
    }
  });

  it('builds the A→B retest lineage for every assessment outcome', () => {
    for (const outcome of ['fixed', 'still_reproducible', 'partially_fixed', 'inconclusive']) {
      const graph = buildRetestGraph({
        run: BASE_RUN,
        agentRuns: AGENTS,
        findings: [],
        evidence: [],
        sourceRevisionId: 'rev_01K7777777777777777777A8W1',
        targetRevisionId: 'rev_01K7777777777777777777A8W2',
        assessment: { outcome },
      });
      expect(graph.nodes.some((n) => n.kind === 'retest-source')).toBe(true);
      expect(graph.nodes.some((n) => n.kind === 'retest-spec')).toBe(true);
      expect(graph.nodes.some((n) => n.kind === 'retest-assessment')).toBe(true);
      const assessment = graph.nodes.find((n) => n.kind === 'retest-assessment');
      expect(assessment?.data['outcome']).toBe(outcome);
    }
  });
});
