import { describe, expect, it } from 'vitest';
import { projectAgentTelemetry } from '../../src/renderer/lib/agent-telemetry.js';
import { makeAgentRun } from '../fixtures.js';

describe('agent stage truth', () => {
  it('queued + no events marks no future stage completed', () => {
    const agentRun = makeAgentRun({ status: 'queued' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(view.currentStage).toBe('working');
    expect(view.stages.filter((s) => s.state === 'completed')).toHaveLength(0);
  });

  it('starting + no events activates Preparation without completing futures', () => {
    const agentRun = makeAgentRun({ status: 'starting' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(view.currentStage).toBe('preparation');
    const byId = new Map(view.stages.map((s) => [s.id, s.state]));
    expect(byId.get('preparation')).toBe('active');
    for (const id of ['planning', 'investigation', 'runtime', 'evidence', 'reporting']) {
      expect(byId.get(id)).toBe('not_started');
    }
  });

  it('agent.status planning activates Planning', () => {
    const agentRun = makeAgentRun({ status: 'planning' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [
        {
          type: 'agent.status',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:10.000Z',
          status: 'planning',
        },
      ],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(view.currentStage).toBe('planning');
  });

  it('file.read activates Investigation', () => {
    const agentRun = makeAgentRun({ status: 'running' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [
        {
          type: 'file.read',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:19.000Z',
          relativePath: 'src/a.ts',
        },
      ],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(view.currentStage).toBe('investigation');
  });

  it('tool.started activates Runtime Validation', () => {
    const agentRun = makeAgentRun({ status: 'running' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [
        {
          type: 'tool.started',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:42.000Z',
          operationId: 'op_1',
          tool: { name: 'shell' },
        },
      ],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(view.currentStage).toBe('runtime');
  });

  it('finding.submitted activates Evidence', () => {
    const agentRun = makeAgentRun({ status: 'running' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [
        {
          type: 'finding.submitted',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:15:03.000Z',
          finding: { title: 't', severity: 'high' },
        } as never,
      ],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(view.currentStage).toBe('evidence');
  });

  it('agent.message after evidence activates Reporting without leaking content', () => {
    const agentRun = makeAgentRun({ status: 'running' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [
        {
          type: 'finding.submitted',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:15:03.000Z',
          finding: { title: 't', severity: 'high' },
        } as never,
        {
          type: 'agent.message',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:16:00.000Z',
          message: 'Summary of findings for review',
        } as never,
      ],
      activities: [],
      findings: [{ id: 'f1', agentRunId: agentRun.id, severity: 'high', title: 't' }],
      evidence: [],
    });
    expect(view.currentStage).toBe('reporting');
    expect(view.currentOperation.title).toBe('Preparing report');
  });

  it('usage.updated after evidence activates Reporting', () => {
    const agentRun = makeAgentRun({ status: 'running' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [
        {
          type: 'evidence.submitted',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:15:03.000Z',
          evidence: { id: 'e1', type: 'test' },
        } as never,
        {
          type: 'usage.updated',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:16:00.000Z',
          usage: { inputTokens: 10 },
        } as never,
      ],
      activities: [],
      findings: [],
      evidence: [{ id: 'e1', agentRunId: agentRun.id, type: 'test' }],
    });
    expect(view.currentStage).toBe('reporting');
  });

  it('run.completed completes all stages', () => {
    const agentRun = makeAgentRun({ status: 'completed' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [
        { type: 'run.completed', agentRunId: agentRun.id, timestamp: '2026-09-18T22:17:20.000Z' },
      ],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(view.currentStage).toBe('completed');
    expect(view.stages.every((s) => s.state === 'completed')).toBe(true);
  });

  it('failure never completes future stages', () => {
    const agentRun = makeAgentRun({ status: 'failed' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [
        {
          type: 'file.read',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:19.000Z',
          relativePath: 'a.ts',
        },
      ],
      activities: [],
      findings: [],
      evidence: [],
    });
    const byId = new Map(view.stages.map((s) => [s.id, s.state]));
    expect(byId.get('investigation')).toBe('failed');
    for (const id of ['runtime', 'evidence', 'reporting', 'completed']) {
      expect(byId.get(id)).toBe('not_started');
    }
  });
});
