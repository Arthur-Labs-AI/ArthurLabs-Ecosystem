import { describe, expect, it } from 'vitest';
import {
  createFindingId,
  createInvestigationHypothesisId,
  createInvestigationPlanId,
  createOperationId,
  createProjectContextSnapshotId,
  createProjectId,
  createProjectRevisionId,
  createRunActivityId,
  isFindingId,
  isInvestigationHypothesisId,
  isInvestigationPlanId,
  isOperationId,
  isProjectContextSnapshotId,
  isProjectId,
  isProjectRevisionId,
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
