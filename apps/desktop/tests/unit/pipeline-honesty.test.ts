import { describe, expect, it } from 'vitest';
import { buildRetestGraph, buildRunGraph } from '../../src/renderer/lib/run-graph.js';

const BASE_RUN = {
  id: 'run_01K7777777777777777777A8W1',
  projectId: 'proj_01K7777777777777777777A8W1',
  mode: 'full',
  status: 'completed',
  executionKind: 'simulation',
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
  it('terminal QARun without MergeResult does NOT complete the merger', () => {
    const graph = buildRunGraph({ run: BASE_RUN, agentRuns: AGENTS, findings: [], evidence: [] });
    const merger = graph.nodes.find((n) => n.kind === 'merger');
    expect(merger?.status).not.toBe('completed');
    expect(['ready', 'waiting']).toContain(merger?.status);
  });

  it('MergeResult without VerificationRun leaves the verifier ready', () => {
    const graph = buildRunGraph({
      run: BASE_RUN,
      agentRuns: AGENTS,
      findings: [],
      evidence: [],
      mergeResults: [{ id: 'merge_01K7777777777777777777A8W1' }],
    });
    const verifier = graph.nodes.find((n) => n.kind === 'verifier');
    expect(verifier?.status).toBe('ready');
    const merger = graph.nodes.find((n) => n.kind === 'merger');
    expect(merger?.status).toBe('completed');
  });

  it('no MergeResult blocks the verifier', () => {
    const graph = buildRunGraph({
      run: { ...BASE_RUN, status: 'agents_running' },
      agentRuns: [],
      findings: [],
      evidence: [],
    });
    expect(graph.nodes.find((n) => n.kind === 'verifier')?.status).toBe('blocked');
    expect(graph.nodes.find((n) => n.kind === 'issues')?.status).toBe('waiting');
  });

  it('merge without ingest leaves issues ready, not completed', () => {
    const graph = buildRunGraph({
      run: BASE_RUN,
      agentRuns: AGENTS,
      findings: [],
      evidence: [],
      mergeResults: [{ id: 'merge_01K7777777777777777777A8W1' }],
    });
    expect(graph.nodes.find((n) => n.kind === 'issues')?.status).toBe('ready');
  });

  it('honest zero-issue ingest completes issues via ingestRan', () => {
    const graph = buildRunGraph({
      run: BASE_RUN,
      agentRuns: AGENTS,
      findings: [],
      evidence: [],
      mergeResults: [{ id: 'merge_01K7777777777777777777A8W1' }],
      issueCount: 0,
      ingestRan: true,
    });
    expect(graph.nodes.find((n) => n.kind === 'issues')?.status).toBe('completed');
  });

  it('assessment result=fixed drives a FIXED assessment node', () => {
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
  });
});
