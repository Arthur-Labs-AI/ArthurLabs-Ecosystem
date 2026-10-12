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
  const currentStacks = ['stack_opencode_main', 'stack_deepseek_main', 'stack_glm_main'];
  const selections = Array.from({ length: 7 }, (_, index) =>
    currentStacks.filter((_, bit) => ((index + 1) & (1 << bit)) !== 0),
  );

  for (const mode of ['full', 'targeted']) {
    it.each(selections.map((selection) => [selection]))(
      mode + ' renders exactly the selected agents before and after execution: %j',
      (agentStackIds) => {
        const selectedRuns = agentStackIds.map((agentStackId, index) => ({
          id: 'selected-agent-' + index,
          qaRunId: BASE_RUN.id,
          agentStackId,
          status: 'completed',
        }));
        for (const agentRuns of [[], selectedRuns]) {
          const graph = buildRunGraph({
            run: {
              ...BASE_RUN,
              mode,
              status: agentRuns.length === 0 ? 'agents_running' : 'completed',
              configuration: { agentStackIds },
            },
            agentRuns,
            findings: [],
            evidence: [],
            targetSpec: { includePaths: ['src/auth'] },
          });
          const nodes = graph.nodes.filter((node) => node.kind === 'agent');
          expect(nodes.map((node) => node.data['agentStackId'])).toEqual(agentStackIds);
          expect(nodes.map((node) => node.status)).toEqual(
            agentStackIds.map(() => (agentRuns.length === 0 ? 'waiting' : 'completed')),
          );
          for (const retired of ['merger', 'verifier', 'issues']) {
            expect(graph.nodes.map((node) => node.kind)).not.toContain(retired);
          }
          expect(graph.edges.filter((edge) => edge.target.startsWith('agent-'))).toEqual(
            nodes.map((node) =>
              expect.objectContaining({
                source: mode === 'targeted' ? 'target' : 'snapshot',
                target: node.id,
                state: agentRuns.length === 0 ? 'pending' : 'completed',
              }),
            ),
          );
        }
      },
    );
  }

  it('does not invent selected agents when historical configuration and AgentRuns are absent', () => {
    const { configuration: _configuration, ...run } = BASE_RUN;
    void _configuration;
    for (const historicalRun of [run, { ...run, configuration: { agentStackIds: [] } }]) {
      const graph = buildRunGraph({
        run: historicalRun,
        agentRuns: [],
        findings: [],
        evidence: [],
      });
      expect(graph.nodes.filter((node) => node.kind === 'agent')).toEqual([]);
    }
  });

  it.each(['failed', 'cancelled', 'partial', 'completed'])(
    'missing workers on terminal %s runs are not still waiting',
    (status) => {
      const graph = buildRunGraph({
        run: { ...BASE_RUN, status },
        agentRuns: [],
        findings: [],
        evidence: [],
      });
      expect(
        graph.nodes.filter((node) => node.kind === 'agent').map((node) => node.status),
      ).toEqual(BASE_RUN.configuration.agentStackIds.map(() => 'not_started'));
    },
  );

  it('reads historical agent identity from AgentRuns when configuration is absent', () => {
    const { configuration: _configuration, ...run } = BASE_RUN;
    void _configuration;
    const graph = buildRunGraph({ run, agentRuns: AGENTS.slice(0, 1), findings: [], evidence: [] });
    expect(
      graph.nodes.filter((node) => node.kind === 'agent').map((node) => node.data['agentStackId']),
    ).toEqual(['stack_muse_main']);
    expect(graph.agents[0]?.agentRunId).toBe(AGENTS[0]?.id);
  });

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
      evidence: [
        { id: 'e1', agentRunId: AGENTS[0]?.id ?? '', type: 'command' },
        { id: 'e2', agentRunId: AGENTS[1]?.id ?? '', type: 'file' },
        { id: 'e3', agentRunId: AGENTS[1]?.id ?? '', type: 'test' },
        { id: 'e-unrelated', agentRunId: 'unrelated-agent', type: 'command' },
      ],
    });
    const counts = Object.fromEntries(graph.agents.map((a) => [a.agentStackId, a.findingsCount]));
    expect(counts['stack_muse_main']).toBe(1);
    expect(counts['stack_deepseek_main']).toBe(1);
    expect(counts['stack_glm_main']).toBe(0);
    expect(graph.agents.map((agent) => agent.evidenceCount)).toEqual([1, 2, 0]);
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
