import { describe, expect, it } from 'vitest';
import {
  createFindingId,
  createInvestigationHypothesisId,
  createInvestigationPlanId,
  createIssueEventId,
  createIssueId,
  createIssueOccurrenceId,
  createOperationId,
  createProjectContextSnapshotId,
  createProjectId,
  createProjectRevisionId,
  createRetestAssessmentId,
  createRetestRunId,
  createRunActivityId,
  isFindingId,
  isInvestigationHypothesisId,
  isInvestigationPlanId,
  isIssueEventId,
  isIssueId,
  isIssueOccurrenceId,
  isOperationId,
  isProjectContextSnapshotId,
  isProjectId,
  isProjectRevisionId,
  isRetestAssessmentId,
  isRetestRunId,
  isRunActivityId,
} from '../src/index.js';

describe('ids', () => {
  it('generates prefixed opaque ids', () => {
    expect(isProjectId(createProjectId())).toBe(true);
    expect(isFindingId(createFindingId())).toBe(true);
  });
  it('brands prevent cross-use', () => {
    expect(isProjectId(createFindingId())).toBe(false);
  });
  it('centralizes the Phase 7 issue and retest ID families', () => {
    expect(isIssueId(createIssueId())).toBe(true);
    expect(isIssueOccurrenceId(createIssueOccurrenceId())).toBe(true);
    expect(isIssueEventId(createIssueEventId())).toBe(true);
    expect(isRetestRunId(createRetestRunId())).toBe(true);
    expect(isRetestAssessmentId(createRetestAssessmentId())).toBe(true);
    expect(isIssueId(createFindingId())).toBe(false);
    expect(isRetestRunId(createIssueId())).toBe(false);
  });
  it('centralizes every Phase 1.1 opaque ID family', () => {
    expect(isProjectRevisionId(createProjectRevisionId())).toBe(true);
    expect(isProjectContextSnapshotId(createProjectContextSnapshotId())).toBe(true);
    expect(isInvestigationPlanId(createInvestigationPlanId())).toBe(true);
    expect(isInvestigationHypothesisId(createInvestigationHypothesisId())).toBe(true);
    expect(isRunActivityId(createRunActivityId())).toBe(true);
    expect(isOperationId(createOperationId())).toBe(true);
    expect(isOperationId(createRunActivityId())).toBe(false);
  });
});
