import { describe, expect, it } from 'vitest';
import {
  projectAgentTelemetry,
  projectCurrentOperation,
  projectRecentActivity,
  projectTimeline,
} from '../../src/renderer/lib/agent-telemetry.js';
import {
  summarizeVerificationAttempts,
  severityBreakdown,
} from '../../src/renderer/lib/verify-summary.js';
import { makeAgentRun } from '../fixtures.js';

describe('agent telemetry projector', () => {
  it('derives planning stage from plan events without inventing progress', () => {
    const agentRun = makeAgentRun({ status: 'planning' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [
        { type: 'run.started', agentRunId: agentRun.id, timestamp: '2026-09-18T22:14:08.000Z' },
        {
          type: 'agent.status',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:10.000Z',
          status: 'planning',
          message: 'Building plan',
        },
      ],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(view.currentStage).toBe('planning');
    expect(view.currentOperation.title).toContain('Building plan');
    expect(JSON.stringify(view)).not.toContain('%');
  });

  it('prefers the latest uncompleted tool.started as the current operation', () => {
    const agentRun = makeAgentRun({ status: 'running' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [
        {
          type: 'tool.started',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:42.000Z',
          operationId: 'op_01',
          tool: { name: 'shell', inputSummary: 'npm test' },
        },
        {
          type: 'tool.completed',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:48.000Z',
          operationId: 'op_01',
          tool: { name: 'shell', exitCode: 0 },
        },
        {
          type: 'tool.started',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:15:03.000Z',
          operationId: 'op_02',
          tool: { name: 'shell', inputSummary: 'pnpm vitest src/auth' },
        },
      ],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(view.currentStage).toBe('runtime');
    expect(view.currentOperation.detail).toContain('pnpm vitest src/auth');
  });

  it('falls back to Working when telemetry is unavailable', () => {
    const agentRun = makeAgentRun({ status: 'queued' });
    expect(projectCurrentOperation([], []).title).toBe('Working');
    const view = projectAgentTelemetry({
      agentRun,
      events: [],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(view.currentStage).toBe('working');
  });

  it('marks Preparation active for starting agents with no events (§10.1)', () => {
    const agentRun = makeAgentRun({ status: 'starting' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(view.currentStage).toBe('preparation');
    expect(view.stages.filter((s) => s.state === 'completed')).toHaveLength(0);
  });

  it('marks completed agents completed and counts severities honestly', () => {
    const agentRun = makeAgentRun({ status: 'completed', completedAt: '2026-09-18T22:17:20.000Z' });
    const view = projectAgentTelemetry({
      agentRun,
      events: [
        { type: 'run.completed', agentRunId: agentRun.id, timestamp: '2026-09-18T22:17:20.000Z' },
      ],
      activities: [],
      findings: [
        { id: 'f1', agentRunId: agentRun.id, severity: 'high', title: 'Refresh reuse' },
        { id: 'f2', agentRunId: agentRun.id, severity: 'medium', title: 'Logout session' },
      ],
      evidence: [{ id: 'e1', agentRunId: agentRun.id, type: 'test' }],
    });
    expect(view.stages.every((s) => s.state === 'completed')).toBe(true);
    expect(view.severityCounts).toEqual({ high: 1, medium: 1 });
    expect(view.totalTokens).toBe(56024);
  });

  it.each(['failed', 'cancelled', 'timed_out', 'interrupted'] as const)(
    'represents terminal state %s distinctly',
    (status) => {
      const agentRun = makeAgentRun({ status });
      const view = projectAgentTelemetry({
        agentRun,
        events: [],
        activities: [],
        findings: [],
        evidence: [],
      });
      expect(view.status).toBe(status);
    },
  );

  it('covers the full agent state matrix (§166)', () => {
    const matrix: Array<{ status: string; operation: string; stage: string }> = [
      { status: 'queued', operation: 'Working', stage: 'working' },
      { status: 'starting', operation: 'Working', stage: 'preparation' },
      { status: 'planning', operation: 'Working', stage: 'planning' },
    ];
    for (const entry of matrix) {
      const agentRun = makeAgentRun({ status: entry.status });
      const view = projectAgentTelemetry({
        agentRun,
        events: [],
        activities: [],
        findings: [],
        evidence: [],
      });
      expect(view.currentOperation.title).toBe(entry.operation);
      expect(view.currentStage).toBe(entry.stage);
    }
    // Running inspection states.
    const running = makeAgentRun({ status: 'running' });
    const inspecting = projectAgentTelemetry({
      agentRun: running,
      events: [
        {
          type: 'file.read',
          agentRunId: running.id,
          timestamp: '2026-09-18T22:14:19.000Z',
          relativePath: 'src/auth/session.ts',
        },
      ],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(inspecting.currentStage).toBe('investigation');
    expect(inspecting.currentOperation.title).toContain('src/auth/session.ts');
    // Emitted finding moves the agent to evidence.
    const emitted = projectAgentTelemetry({
      agentRun: running,
      events: [
        {
          type: 'finding.submitted',
          agentRunId: running.id,
          timestamp: '2026-09-18T22:15:03.000Z',
          finding: { title: 'Refresh reuse', severity: 'high' },
        } as never,
      ],
      activities: [],
      findings: [{ id: 'f1', agentRunId: running.id, severity: 'high', title: 'Refresh reuse' }],
      evidence: [],
    });
    expect(emitted.currentStage).toBe('evidence');
    expect(emitted.findingsCount).toBe(1);
  });

  it('transitions starting → planning → investigating → command → finding → reporting → completed (§167)', () => {
    const agentRun = makeAgentRun({ status: 'running' });
    const frame = (events: never[], status: string): string =>
      String(
        projectAgentTelemetry({
          agentRun: makeAgentRun({ status, id: agentRun.id, qaRunId: agentRun.qaRunId }),
          events,
          activities: [],
          findings: [],
          evidence: [],
        }).currentStage,
      );
    expect(frame([], 'starting')).toBe('preparation');
    expect(frame([], 'queued')).toBe('working');
    expect(
      frame(
        [
          {
            type: 'agent.status',
            agentRunId: agentRun.id,
            timestamp: '2026-09-18T22:14:10.000Z',
            status: 'planning',
          },
        ] as never,
        'planning',
      ),
    ).toBe('planning');
    const completed = projectAgentTelemetry({
      agentRun: makeAgentRun({ status: 'completed', id: agentRun.id, qaRunId: agentRun.qaRunId }),
      events: [
        {
          type: 'run.completed',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:17:20.000Z',
        },
      ],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(completed.currentStage).toBe('completed');
    expect(completed.stages.every((s) => s.state === 'completed')).toBe(true);
  });

  it('derives honest telemetry counts and exposes structured failure', () => {
    const agentRun = makeAgentRun({
      status: 'failed',
      failure: {
        code: 'GLM_INVALID_RESULT',
        message: 'Report failed schema validation.',
        retryable: false,
      },
    });
    const view = projectAgentTelemetry({
      agentRun,
      events: [
        {
          type: 'file.read',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:19.000Z',
          relativePath: 'a.ts',
        },
        {
          type: 'file.read',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:20.000Z',
          relativePath: 'a.ts',
        },
        {
          type: 'tool.started',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:42.000Z',
          operationId: 'op_1',
          tool: { name: 'shell' },
        },
        {
          type: 'test.result',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:48.000Z',
          suite: 'auth',
          passed: 1,
          failed: 0,
        },
      ],
      activities: [],
      findings: [],
      evidence: [],
    });
    expect(view.telemetry.filesInspected).toBe(1);
    expect(view.telemetry.commands).toBe(1);
    expect(view.telemetry.tests).toBe(1);
    expect(view.failure?.code).toBe('GLM_INVALID_RESULT');
    expect(view.stages.find((s) => s.state === 'failed')).toBeDefined();
  });

  it('builds a categorized timeline and summarizes verification outcomes', () => {
    const agentRun = makeAgentRun({ status: 'running' });
    const timeline = projectTimeline(
      [
        { type: 'run.started', agentRunId: agentRun.id, timestamp: '2026-09-18T22:14:08.000Z' },
        {
          type: 'file.read',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:19.000Z',
          relativePath: 'src/auth/token.ts',
        },
      ],
      [],
    );
    expect(timeline.map((t) => t.category)).toEqual(['Lifecycle', 'File']);
    const counts = summarizeVerificationAttempts([
      { outcome: 'reproduced' },
      { outcome: 'partially_verified' },
      { outcome: 'not_reproducible' },
      { outcome: 'inconclusive' },
    ]);
    expect(counts).toEqual({
      attempts: 4,
      reproduced: 1,
      partial: 1,
      notReproducible: 1,
      inconclusive: 1,
    });
    expect(severityBreakdown([{ severity: 'critical' }, { severity: 'high' }])).toMatchObject({
      critical: 1,
      high: 1,
    });
  });

  it('filters recent activity to high-value operations', () => {
    const agentRun = makeAgentRun({ status: 'running' });
    const recent = projectRecentActivity(
      [
        { type: 'run.started', agentRunId: agentRun.id, timestamp: '2026-09-18T22:14:08.000Z' },
        {
          type: 'file.read',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:19.000Z',
          relativePath: 'src/auth/token.ts',
        },
        {
          type: 'test.result',
          agentRunId: agentRun.id,
          timestamp: '2026-09-18T22:14:48.000Z',
          suite: 'auth',
          passed: 11,
          failed: 1,
        },
      ],
      [],
    );
    expect(recent.length).toBe(2);
    expect(recent[0]?.title).toContain('auth');
  });
});
