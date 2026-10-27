import { createRunActivityId, nowIsoTimestamp, type QARunId, type RunActivityId } from '@qa/shared';
import { RunActivitySchema, type HarnessEvent, type RunActivity } from '@qa/schemas';
import type { SentryRepository } from '@qa/persistence';

/**
 * Boundary truncation: model-influenced strings (failure messages, commands,
 * hypothesis/finding titles) flow into fixed-size activity titles. Truncate
 * here so a long model string can never break persistence; schemas stay strict.
 */
function activityTitle(value: string): string {
  return value.slice(0, 300);
}

function eventTitle(event: HarnessEvent): string {
  switch (event.type) {
    case 'run.started':
      return 'Agent started';
    case 'agent.status':
      return event.message ?? 'Agent status: ' + event.status;
    case 'agent.message':
      return 'Agent message';
    case 'tool.started':
      return 'Tool started: ' + event.tool.name;
    case 'tool.completed':
      return 'Tool completed: ' + event.tool.name;
    case 'command.executed':
      return 'Command completed: ' + event.command;
    case 'file.read':
      return 'File read: ' + event.relativePath;
    case 'file.changed':
      return 'File ' + event.operation + ': ' + event.relativePath;
    case 'test.result':
      return 'Test result: ' + (event.suite ?? 'unnamed suite');
    case 'investigation.plan.created':
      return 'Investigation plan created';
    case 'investigation.hypothesis.discovered':
      return 'Hypothesis: ' + event.hypothesis.title;
    case 'finding.submitted':
      return 'Finding: ' + event.finding.title;
    case 'evidence.submitted':
      return 'Evidence submitted';
    case 'usage.updated':
      return 'Usage updated';
    case 'warning':
      return event.message;
    case 'run.completed':
      return 'Agent completed';
    case 'run.failed':
      return 'Agent failed: ' + event.failure.message;
    case 'run.cancelled':
      return 'Agent cancelled';
  }
}

function eventKind(event: HarnessEvent): RunActivity['kind'] {
  switch (event.type) {
    case 'run.started':
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
      return 'agent';
    case 'investigation.plan.created':
    case 'investigation.hypothesis.discovered':
      return 'planning';
    case 'tool.started':
    case 'tool.completed':
      return 'tool';
    case 'command.executed':
      return 'command';
    case 'file.read':
    case 'file.changed':
      return 'file';
    case 'test.result':
      return 'test';
    case 'finding.submitted':
      return 'finding';
    case 'evidence.submitted':
      return 'evidence';
    default:
      return 'runtime';
  }
}

export class RunActivityProjector {
  private readonly agentActivities = new Map<string, RunActivity>();
  private readonly toolActivities = new Map<string, RunActivity>();

  constructor(private readonly repository: SentryRepository) {}

  project(event: HarnessEvent, qaRunId: QARunId, parentActivityId: RunActivityId): RunActivity {
    if (
      event.type === 'run.completed' ||
      event.type === 'run.failed' ||
      event.type === 'run.cancelled'
    ) {
      const current = this.agentActivities.get(event.agentRunId);
      if (current !== undefined) {
        const status =
          event.type === 'run.completed'
            ? 'completed'
            : event.type === 'run.failed'
              ? 'failed'
              : 'cancelled';
        const completed = RunActivitySchema.parse({
          ...current,
          status,
          title: activityTitle(eventTitle(event)),
          completedAt: event.timestamp,
        });
        this.repository.saveActivity(completed);
        this.agentActivities.delete(event.agentRunId);
        return completed;
      }
    }
    if (event.type === 'tool.completed') {
      const current = this.toolActivities.get(event.operationId);
      if (current !== undefined) {
        const completed = RunActivitySchema.parse({
          ...current,
          status: 'completed',
          title: activityTitle(eventTitle(event)),
          completedAt: event.timestamp,
        });
        this.repository.saveActivity(completed);
        this.toolActivities.delete(event.operationId);
        return completed;
      }
    }
    const status: RunActivity['status'] =
      event.type === 'warning'
        ? 'warning'
        : event.type === 'run.failed'
          ? 'failed'
          : event.type === 'run.cancelled'
            ? 'cancelled'
            : event.type === 'run.started' || event.type === 'tool.started'
              ? 'running'
              : 'completed';
    const startedAt = event.timestamp;
    const activity = RunActivitySchema.parse({
      schemaVersion: 1,
      id: createRunActivityId(),
      qaRunId,
      agentRunId: event.agentRunId,
      parentActivityId,
      source: 'agent',
      kind: eventKind(event),
      status,
      title: activityTitle(eventTitle(event)),
      startedAt,
      ...(status === 'running' ? {} : { completedAt: event.timestamp }),
      artifactIds: [],
    });
    this.repository.saveActivity(activity);
    if (event.type === 'run.started') this.agentActivities.set(event.agentRunId, activity);
    if (event.type === 'tool.started') this.toolActivities.set(event.operationId, activity);
    return activity;
  }

  stage(input: {
    readonly qaRunId: RunActivity['qaRunId'];
    readonly agentRunId?: RunActivity['agentRunId'];
    readonly parentActivityId?: RunActivityId;
    readonly source: RunActivity['source'];
    readonly kind: RunActivity['kind'];
    readonly title: string;
    readonly status?: RunActivity['status'];
  }): RunActivity {
    const timestamp = nowIsoTimestamp();
    const status = input.status ?? 'completed';
    const activity = RunActivitySchema.parse({
      schemaVersion: 1,
      id: createRunActivityId(),
      qaRunId: input.qaRunId,
      ...(input.agentRunId === undefined ? {} : { agentRunId: input.agentRunId }),
      ...(input.parentActivityId === undefined ? {} : { parentActivityId: input.parentActivityId }),
      source: input.source,
      kind: input.kind,
      status,
      title: activityTitle(input.title),
      startedAt: timestamp,
      ...(status === 'running' ? {} : { completedAt: timestamp }),
      artifactIds: [],
    });
    this.repository.saveActivity(activity);
    return activity;
  }

  finalizeAgent(
    agentRunId: string,
    status: 'failed' | 'cancelled',
    completedAt: RunActivity['completedAt'],
    title: string,
  ): void {
    const current = this.agentActivities.get(agentRunId);
    if (current === undefined || completedAt === undefined) return;
    this.repository.saveActivity(
      RunActivitySchema.parse({
        ...current,
        status,
        title: activityTitle(title),
        completedAt,
      }),
    );
    this.agentActivities.delete(agentRunId);
  }
}
