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

/** Legacy QARun-mode retest lineage (pre-closure rows only). Production
 *  uses RetestRun + child QARun; this decoder stays for historical reads. */
export function isRetestLineageValid(
  retestRun: QARun,
  sourceRun: QARun,
  issue: UnifiedIssue,
): boolean {
  if (retestRun.mode !== 'retest') return false;
  const target = (
    retestRun as { retestTarget?: { sourceQARunId?: string; unifiedIssueId?: string } }
  ).retestTarget;
  return (
    target?.sourceQARunId === sourceRun.id &&
    target?.unifiedIssueId === issue.id &&
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
  if (retestRun.mode !== 'retest') return false;
  return (
    isQARunForSnapshot(retestRun, retestSnapshot) &&
    isSnapshotForRevision(retestSnapshot, retestRevision) &&
    isSnapshotForRevision(sourceSnapshot, sourceRevision) &&
    retestRevision.projectId === sourceRevision.projectId &&
    retestRevision.id !== sourceRevision.id &&
    retestRevision.importedAt > sourceRevision.importedAt
  );
}

/** Canonical closure lineage: RetestRun (cross-revision workflow) links a
 *  source occurrence to a child target QARun on a newer revision. */
export function isCanonicalRetestLineage(input: {
  readonly retestIssueId: string;
  readonly retestProjectId: string;
  readonly sourceQaRunId: string;
  readonly targetQaRunId?: string;
  readonly sourceRunId: string;
  readonly sourceProjectId: string;
  readonly targetRunProjectId: string;
  readonly sourceCreatedAt: string;
  readonly retestCreatedAt: string;
}): boolean {
  return (
    input.retestIssueId.length > 0 &&
    input.sourceQaRunId === input.sourceRunId &&
    input.sourceProjectId === input.retestProjectId &&
    input.targetRunProjectId === input.retestProjectId &&
    (input.targetQaRunId === undefined || input.targetQaRunId !== input.sourceRunId) &&
    input.sourceCreatedAt < input.retestCreatedAt
  );
}

export function isChildActivityOf(child: RunActivity, parent: RunActivity): boolean {
  return child.parentActivityId === parent.id && child.qaRunId === parent.qaRunId;
}
