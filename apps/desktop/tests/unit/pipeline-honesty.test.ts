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
    status: 'completed',
  },
];

describe('pipeline state honesty', () => {
  it('terminal QARun ends at independent agents: no merger/verifier/issues nodes', () => {
    const graph = buildRunGraph({ run: BASE_RUN, agentRuns: AGENTS, findings: [], evidence: [] });
    const kinds = graph.nodes.map((n) => n.kind);
    expect(kinds).not.toContain('merger');
    expect(kinds).not.toContain('verifier');
    expect(kinds).not.toContain('issues');
    expect(graph.nodes).toHaveLength(6);
  });

  it('historical MergeResult input creates no merger node (ignored, still accepted)', () => {
    const graph = buildRunGraph({
      run: BASE_RUN,
      agentRuns: AGENTS,
      findings: [],
      evidence: [],
      mergeResults: [{ id: 'merge_01K7777777777777777777A8W1' }],
    });
    expect(graph.nodes.find((n) => n.kind === 'merger')).toBeUndefined();
    expect(graph.nodes.find((n) => n.kind === 'verifier')).toBeUndefined();
  });

  it('active runs show agents without any downstream pipeline state', () => {
    const graph = buildRunGraph({
      run: { ...BASE_RUN, status: 'agents_running' },
      agentRuns: [],
      findings: [],
      evidence: [],
    });
    expect(graph.nodes.find((n) => n.kind === 'verifier')).toBeUndefined();
    expect(graph.nodes.find((n) => n.kind === 'issues')).toBeUndefined();
  });

  it('targeted runs add TargetSpec but still no downstream nodes', () => {
    const graph = buildRunGraph({
      run: { ...BASE_RUN, mode: 'targeted' },
      agentRuns: AGENTS,
      findings: [],
      evidence: [],
      targetSpec: { includePaths: ['src/auth'] },
    });
    expect(graph.nodes.some((n) => n.kind === 'target')).toBe(true);
    expect(graph.nodes.find((n) => n.kind === 'issues')).toBeUndefined();
  });

  it('assessment result=fixed drives a FIXED assessment node hung off the snapshot', () => {
    const graph = buildRetestGraph({
      run: BASE_RUN,
      agentRuns: AGENTS,
      findings: [],
      evidence: [],
      sourceRevisionId: 'rev_01K7777777777777777777A8W1',
      targetRevisionId: 'rev_01K7777777777777777777A8W2',
      assessment: { result: 'fixed' },
    });
    const node = graph.nodes.find((n) => n.kind === 'retest-assessment');
    expect(node?.status).toBe('fixed');
    expect(node?.data['result']).toBe('fixed');
    const edge = graph.edges.find((e) => e.target === 'retest-assessment');
    expect(edge?.source).toBe('snapshot');
    expect(graph.nodes.find((n) => n.id === edge?.source)).toBeDefined();
  });
});
