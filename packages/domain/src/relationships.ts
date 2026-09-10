import type {
  AgentInvestigationPlan,
  AgentRun,
  ManagedProjectCopy,
  ProjectContextSnapshot,
  ProjectRevision,
  ProjectSnapshot,
  QARun,
  RunActivity,
  UnifiedIssue,
} from '@qa/schemas';

export function isSnapshotForRevision(
  snapshot: ProjectSnapshot,
  revision: ProjectRevision,
): boolean {
  return snapshot.projectId === revision.projectId && snapshot.projectRevisionId === revision.id;
}

export function isManagedCopyForRevision(
  copy: ManagedProjectCopy,
  revision: ProjectRevision,
): boolean {
  return copy.projectId === revision.projectId && copy.currentRevisionId === revision.id;
}

export function isContextForRevision(
  context: ProjectContextSnapshot,
  revision: ProjectRevision,
): boolean {
  return context.projectId === revision.projectId && context.projectRevisionId === revision.id;
}

export function isQARunForSnapshot(run: QARun, snapshot: ProjectSnapshot): boolean {
  return run.projectId === snapshot.projectId && run.snapshotId === snapshot.id;
}

export function isQARunForContext(run: QARun, context: ProjectContextSnapshot): boolean {
  return run.projectId === context.projectId && run.projectContextSnapshotId === context.id;
}

export function isAgentRunForQARun(agentRun: AgentRun, qaRun: QARun): boolean {
  return agentRun.qaRunId === qaRun.id;
}

export function isPlanForAgentRun(
  plan: AgentInvestigationPlan,
  agentRun: AgentRun,
  qaRun: QARun,
): boolean {
  return (
    plan.agentRunId === agentRun.id &&
    plan.qaRunId === agentRun.qaRunId &&
    plan.qaRunId === qaRun.id &&
    plan.agentStackId === agentRun.agentStackId &&
    plan.projectSnapshotId === qaRun.snapshotId &&
    plan.projectContextSnapshotId === qaRun.projectContextSnapshotId
  );
}

export function isRetestLineageValid(
  retestRun: QARun,
  sourceRun: QARun,
  issue: UnifiedIssue,
): boolean {
  return (
    retestRun.mode === 'retest' &&
    retestRun.retestTarget.sourceQARunId === sourceRun.id &&
    retestRun.retestTarget.unifiedIssueId === issue.id &&
    issue.qaRunId === sourceRun.id &&
    sourceRun.projectId === retestRun.projectId &&
    sourceRun.createdAt < retestRun.createdAt
  );
}

export function isRetestAgainstNewerRevision(
  retestRun: QARun,
  retestSnapshot: ProjectSnapshot,
  retestRevision: ProjectRevision,
  sourceSnapshot: ProjectSnapshot,
  sourceRevision: ProjectRevision,
): boolean {
  return (
    retestRun.mode === 'retest' &&
    isQARunForSnapshot(retestRun, retestSnapshot) &&
    isSnapshotForRevision(retestSnapshot, retestRevision) &&
    isSnapshotForRevision(sourceSnapshot, sourceRevision) &&
    retestRevision.projectId === sourceRevision.projectId &&
    retestRevision.id !== sourceRevision.id &&
    retestRevision.importedAt > sourceRevision.importedAt
  );
}

export function isChildActivityOf(child: RunActivity, parent: RunActivity): boolean {
  return child.parentActivityId === parent.id && child.qaRunId === parent.qaRunId;
}
