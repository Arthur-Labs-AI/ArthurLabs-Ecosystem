/**
 * Agent telemetry projector: persisted Sentry truth → AgentNodeView.
 * Observable execution only. Never invents chain-of-thought, progress
 * percentages, or ETAs. Unknown telemetry → "Working".
 */
import type {
  ActivityLike,
  AgentNodeView,
  AgentRunLike,
  AgentStageId,
  EvidenceLike,
  FindingLike,
  HarnessEventLike,
  OperationView,
  StageState,
  TimelineItem,
} from './types.js';

export const AGENT_DISPLAY_NAMES: Record<string, string> = {
  stack_muse_main: 'Muse',
  stack_deepseek_main: 'DeepSeek',
  stack_glm_main: 'GLM',
};

const STAGE_LABELS: Record<AgentStageId, string> = {
  preparation: 'Preparation',
  planning: 'Planning',
  investigation: 'Investigation',
  runtime: 'Runtime Validation',
  evidence: 'Evidence',
  reporting: 'Reporting',
  completed: 'Completed',
};

const STAGE_ORDER: readonly AgentStageId[] = [
  'preparation',
  'planning',
  'investigation',
  'runtime',
  'evidence',
  'reporting',
  'completed',
];

function elapsedMs(
  startedAt?: string,
  completedAt?: string | null,
  now: number = Date.now(),
): number | undefined {
  if (startedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return undefined;
  const end = completedAt == null ? now : Date.parse(completedAt);
  if (end === undefined || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

function eventCategory(event: HarnessEventLike): string {
  switch (event.type) {
    case 'run.started':
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
    case 'agent.status':
      return 'Lifecycle';
    case 'file.read':
    case 'file.changed':
      return 'File';
    case 'tool.started':
    case 'tool.completed':
      return 'Command';
    case 'command.executed':
      return 'Command';
    case 'test.result':
      return 'Test';
    case 'investigation.plan.created':
    case 'investigation.hypothesis.discovered':
      return 'Planning';
    case 'finding.submitted':
      return 'Finding';
    case 'evidence.submitted':
      return 'Evidence';
    case 'warning':
      return 'Warning';
    default:
      return 'Runtime';
  }
}

function eventToOperation(event: HarnessEventLike): OperationView | undefined {
  switch (event.type) {
    case 'tool.started':
      return {
        kind: 'command',
        title: 'Tool started: ' + (event.tool?.name ?? 'unknown'),
        detail: event.tool?.inputSummary,
        timestamp: event.timestamp,
      };
    case 'tool.completed':
      return {
        kind: 'command',
        title: 'Tool completed: ' + (event.tool?.name ?? 'unknown'),
        detail:
          event.tool?.exitCode === undefined ? undefined : 'exit ' + String(event.tool.exitCode),
        timestamp: event.timestamp,
      };
    case 'command.executed':
      return {
        kind: 'command',
        title: event.command ?? 'Command completed',
        detail: 'exit ' + String(event.exitCode),
        timestamp: event.timestamp,
      };
    case 'file.read':
      return {
        kind: 'file',
        title: 'Read ' + (event.relativePath ?? 'unknown file'),
        timestamp: event.timestamp,
      };
    case 'file.changed':
      return {
        kind: 'file',
        title: 'File ' + (event.relativePath ?? 'unknown'),
        timestamp: event.timestamp,
      };
    case 'test.result':
      return {
        kind: 'test',
        title: 'Test: ' + (event.suite ?? 'unnamed suite'),
        detail:
          event.passed !== undefined || event.failed !== undefined
            ? String(event.passed ?? 0) + ' passed, ' + String(event.failed ?? 0) + ' failed'
            : undefined,
        timestamp: event.timestamp,
      };
    case 'finding.submitted':
      return {
        kind: 'finding',
        title: 'Finding: ' + (event.finding?.title ?? 'submitted'),
        detail: event.finding?.severity,
        timestamp: event.timestamp,
      };
    case 'evidence.submitted':
      return { kind: 'evidence', title: 'Evidence submitted', timestamp: event.timestamp };
    case 'investigation.plan.created':
      return { kind: 'lifecycle', title: 'Investigation plan created', timestamp: event.timestamp };
    case 'investigation.hypothesis.discovered':
      return { kind: 'lifecycle', title: 'Hypothesis discovered', timestamp: event.timestamp };
    case 'agent.status':
      return {
        kind: 'lifecycle',
        title: event.message ?? 'Agent status: ' + (event.status ?? ''),
        timestamp: event.timestamp,
      };
    case 'run.started':
      return { kind: 'lifecycle', title: 'Agent started', timestamp: event.timestamp };
    case 'run.completed':
      return { kind: 'lifecycle', title: 'Agent completed', timestamp: event.timestamp };
    case 'run.failed':
      return {
        kind: 'lifecycle',
        title: 'Agent failed',
        detail: event.message,
        timestamp: event.timestamp,
      };
    case 'run.cancelled':
      return { kind: 'lifecycle', title: 'Agent cancelled', timestamp: event.timestamp };
    case 'warning':
      return { kind: 'lifecycle', title: event.message ?? 'Warning', timestamp: event.timestamp };
    default:
      return undefined;
  }
}

function activityToOperation(activity: ActivityLike): OperationView {
  let kind: OperationView['kind'] = 'working';
  if (activity.kind === 'command' || activity.kind === 'tool') kind = 'command';
  else if (activity.kind === 'file') kind = 'file';
  else if (activity.kind === 'test') kind = 'test';
  else if (activity.kind === 'finding') kind = 'finding';
  else if (activity.kind === 'evidence') kind = 'evidence';
  else if (activity.kind === 'agent' || activity.kind === 'planning') kind = 'lifecycle';
  return { kind, title: activity.title, timestamp: activity.startedAt };
}

/**
 * Current operation: latest active tool.started without tool.completed,
 * else latest running RunActivity, else latest useful event, else Working.
 */
export function projectCurrentOperation(
  events: readonly HarnessEventLike[],
  activities: readonly ActivityLike[],
): OperationView {
  const completedOps = new Set(
    events
      .filter((e) => e.type === 'tool.completed' && e.operationId !== undefined)
      .map((e) => e.operationId as string),
  );
  const activeTools = events.filter(
    (e) =>
      e.type === 'tool.started' &&
      e.operationId !== undefined &&
      !completedOps.has(e.operationId as string),
  );
  const latestActive = activeTools[activeTools.length - 1];
  if (latestActive !== undefined) {
    return (
      eventToOperation(latestActive) ?? {
        kind: 'working',
        title: 'Working',
        timestamp: latestActive.timestamp,
      }
    );
  }
  const runningActivity = [...activities]
    .reverse()
    .find((a) => a.status === 'running' || a.status === 'waiting');
  if (runningActivity !== undefined) return activityToOperation(runningActivity);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    const operation = eventToOperation(event);
    if (operation !== undefined) return operation;
  }
  return { kind: 'working', title: 'Working' };
}

/** Recent activity: prioritize command/file/search/test/HTTP/finding/evidence/warning/failure. */
export function projectRecentActivity(
  events: readonly HarnessEventLike[],
  activities: readonly ActivityLike[],
  limit = 4,
): readonly OperationView[] {
  const prioritized = new Set([
    'tool.started',
    'tool.completed',
    'command.executed',
    'file.read',
    'file.changed',
    'test.result',
    'finding.submitted',
    'evidence.submitted',
    'warning',
    'run.failed',
    'run.cancelled',
  ]);
  const fromEvents: OperationView[] = [];
  for (let index = events.length - 1; index >= 0 && fromEvents.length < limit; index -= 1) {
    const event = events[index];
    if (event === undefined || !prioritized.has(event.type)) continue;
    const operation = eventToOperation(event);
    if (operation !== undefined) fromEvents.push(operation);
  }
  if (fromEvents.length > 0) return fromEvents;
  return [...activities].reverse().slice(0, limit).map(activityToOperation);
}

function deriveStageStates(
  agentRun: AgentRunLike,
  events: readonly HarnessEventLike[],
  findings: readonly FindingLike[],
  evidence: readonly EvidenceLike[],
): { states: Map<AgentStageId, StageState>; current: AgentStageId | 'working' } {
  const states = new Map<AgentStageId, StageState>(STAGE_ORDER.map((id) => [id, 'not_started']));
  const terminal = agentRun.status;
  if (['failed', 'timed_out'].includes(terminal)) {
    // Failure: mark the furthest reached stage failed; earlier ones completed.
    const reached = furthestStage(events, findings, evidence);
    let failed = false;
    for (const stage of STAGE_ORDER) {
      if (stage === 'completed') {
        states.set(stage, 'not_started');
        continue;
      }
      if (stage === reached) {
        states.set(stage, 'failed');
        failed = true;
      } else if (!failed) {
        states.set(stage, 'completed');
      }
    }
    return { states, current: reached };
  }
  if (terminal === 'cancelled' || terminal === 'interrupted') {
    const reached = furthestStage(events, findings, evidence);
    let cancelled = false;
    for (const stage of STAGE_ORDER) {
      if (stage === 'completed') {
        states.set(stage, 'not_started');
        continue;
      }
      if (stage === reached) {
        states.set(stage, 'cancelled');
        cancelled = true;
      } else if (!cancelled) {
        states.set(stage, 'completed');
      }
    }
    return { states, current: reached };
  }
  if (terminal === 'completed') {
    for (const stage of STAGE_ORDER) states.set(stage, 'completed');
    return { states, current: 'completed' };
  }
  const reached = furthestStage(events, findings, evidence);
  let seen = false;
  for (const stage of STAGE_ORDER) {
    if (stage === 'completed') {
      states.set(stage, 'not_started');
      continue;
    }
    if (stage === reached) {
      states.set(stage, events.some((e) => e.type === 'warning') ? 'warning' : 'active');
      seen = true;
    } else if (!seen) {
      states.set(stage, 'completed');
    }
  }
  // Preparation is trivially complete once the agent started.
  if (['starting', 'planning', 'running', 'queued'].includes(terminal)) {
    if (states.get('preparation') === 'not_started') states.set('preparation', 'completed');
  }
  return { states, current: reached };
}

function furthestStage(
  events: readonly HarnessEventLike[],
  findings: readonly FindingLike[],
  evidence: readonly EvidenceLike[],
): AgentStageId | 'working' {
  const types = new Set(events.map((e) => e.type));
  if (types.has('run.completed')) return 'completed';
  if (
    findings.length > 0 ||
    evidence.length > 0 ||
    types.has('finding.submitted') ||
    types.has('evidence.submitted')
  )
    return 'evidence';
  if (
    types.has('tool.started') ||
    types.has('tool.completed') ||
    types.has('command.executed') ||
    types.has('test.result')
  )
    return 'runtime';
  if (types.has('investigation.plan.created') || types.has('file.read')) return 'investigation';
  if (types.has('agent.status')) {
    const lastStatus = [...events].reverse().find((e) => e.type === 'agent.status');
    if (
      lastStatus !== undefined &&
      lastStatus.type === 'agent.status' &&
      lastStatus.status === 'planning'
    )
      return 'planning';
    return 'investigation';
  }
  if (events.length === 0) return 'working';
  return 'planning';
}

export function projectAgentTelemetry(input: {
  agentRun: AgentRunLike;
  displayName?: string;
  events: readonly HarnessEventLike[];
  activities: readonly ActivityLike[];
  findings: readonly FindingLike[];
  evidence: readonly EvidenceLike[];
  now?: number;
}): AgentNodeView {
  const { agentRun, events, activities, findings, evidence } = input;
  const displayName =
    input.displayName ?? AGENT_DISPLAY_NAMES[agentRun.agentStackId] ?? agentRun.agentStackId;
  const { states, current } = deriveStageStates(agentRun, events, findings, evidence);
  const stages = STAGE_ORDER.map((id) => ({
    id,
    label: STAGE_LABELS[id] as string,
    state: (states.get(id) ?? 'not_started') as StageState,
  }));
  const usage = agentRun.usage;
  const totalTokens =
    usage?.inputTokens !== undefined && usage?.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : undefined;
  const severityCounts: Record<string, number> = {};
  for (const finding of findings) {
    severityCounts[finding.severity] = (severityCounts[finding.severity] ?? 0) + 1;
  }
  // Honest operation counts (§56): derived from persisted events/activities only.
  const filesInspected = new Set(
    events.flatMap((e) =>
      e.type === 'file.read' || e.type === 'file.changed' ? [e.relativePath ?? ''] : [],
    ),
  );
  for (const activity of activities) {
    if (activity.kind === 'file') filesInspected.add(activity.title);
  }
  filesInspected.delete('');
  const commands = events.filter(
    (e) =>
      e.type === 'tool.started' || e.type === 'tool.completed' || e.type === 'command.executed',
  ).length;
  const tests = events.filter((e) => e.type === 'test.result').length;
  return {
    agentRunId: agentRun.id,
    agentStackId: agentRun.agentStackId,
    displayName,
    model: agentRun.runtimeIdentity?.modelId ?? 'Model pending',
    status: agentRun.status,
    ...(agentRun.failure === undefined ? {} : { failure: agentRun.failure }),
    elapsedMs: elapsedMs(agentRun.startedAt, agentRun.completedAt ?? undefined, input.now),
    telemetry: {
      operations: events.length + activities.length,
      filesInspected: filesInspected.size,
      commands,
      tests,
    },
    stages,
    currentStage: current,
    currentOperation: projectCurrentOperation(events, activities),
    recentActivity: projectRecentActivity(events, activities),
    findingsCount: findings.length,
    evidenceCount: evidence.length,
    turns: usage?.turns,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    totalTokens,
    severityCounts,
  };
}

export function projectTimeline(
  events: readonly HarnessEventLike[],
  activities: readonly ActivityLike[],
): readonly TimelineItem[] {
  const items: TimelineItem[] = events.flatMap((e) => {
    const operation = eventToOperation(e);
    if (operation === undefined) return [];
    const item: TimelineItem = {
      timestamp: e.timestamp,
      category: eventCategory(e),
      title:
        operation.detail !== undefined
          ? operation.title + ' — ' + operation.detail
          : operation.title,
      status: e.type,
    };
    return [item];
  });
  if (items.length === 0) {
    return [...activities].map((a) => ({
      timestamp: a.startedAt,
      category: a.kind,
      title: a.title,
      status: a.status,
    }));
  }
  return items;
}

export function formatElapsed(elapsedMsValue?: number | undefined): string {
  if (elapsedMsValue === undefined) return '--:--';
  const totalSeconds = Math.floor(elapsedMsValue / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0) return hours + 'h ' + pad(minutes) + 'm';
  return pad(minutes) + ':' + pad(seconds);
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function truncateMiddle(value: string, maxLength = 48): string {
  if (value.length <= maxLength) return value;
  const keep = Math.floor((maxLength - 3) / 2);
  return value.slice(0, keep) + '...' + value.slice(value.length - keep);
}
