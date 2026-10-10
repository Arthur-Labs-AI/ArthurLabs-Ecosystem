import { describe, expect, it } from 'vitest';
import { projectAgentTelemetry } from '../../src/renderer/lib/agent-telemetry.js';
import { makeAgentRun } from '../fixtures.js';

describe('observed stages rather than inferred successful phases', () => {
  it('completed sparse historical worker proves completion, not testing or evidence capture', () => {
    const view = projectAgentTelemetry({
      agentRun: makeAgentRun({ status: 'completed' }),
      events: [],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(view.currentStage).toBe('completed');
    expect(
      view.stages.filter((stage) => stage.state === 'completed').map((stage) => stage.id),
    ).toEqual(['completed']);
  });
  it('a reported finding does not prove successful planning, investigation or tests', () => {
    const view = projectAgentTelemetry({
      agentRun: makeAgentRun({ status: 'running' }),
      events: [],
      activities: [],
      findings: [{ id: 'f', agentRunId: 'a', severity: 'high', title: 'f' }],
      evidence: [],
    });
    expect(view.currentStage).toBe('evidence');
    expect(view.stages.filter((stage) => stage.state === 'completed')).toHaveLength(0);
  });
  it.each(['usage.updated', 'agent.message'])(
    '%s after a finding is not an explicit reporting stage',
    (type) => {
      const view = projectAgentTelemetry({
        agentRun: makeAgentRun({ status: 'running' }),
        events: [{ type, timestamp: '2026-10-10T00:00:00Z', agentRunId: 'a' }],
        activities: [],
        findings: [{ id: 'f', agentRunId: 'a', severity: 'high', title: 'f' }],
        evidence: [],
      });
      expect(view.currentStage).toBe('evidence');
      expect(view.stages.find((stage) => stage.id === 'reporting')?.state).toBe('not_started');
    },
  );
  it.each(['cancelled', 'interrupted'])(
    'durable %s status outranks a recorded completed event',
    (status) => {
      const view = projectAgentTelemetry({
        agentRun: makeAgentRun({ status }),
        events: [{ type: 'run.completed', timestamp: '2026-10-10T00:00:00Z', agentRunId: 'a' }],
        activities: [],
        findings: [],
        evidence: [],
      });
      expect(view.currentStage).not.toBe('completed');
      expect(view.stages.find((stage) => stage.id === 'completed')?.state).toBe('not_started');
    },
  );
});
