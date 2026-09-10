import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentRunSchema,
  AgentStackDefinitionSchema,
  ArtifactSchema,
  CICDPlanSchema,
  EvidenceSchema,
  FindingSchema,
  HarnessRunRequestSchema,
  ProjectSchema,
  ProjectSnapshotSchema,
  QARunSchema,
  UnifiedIssueSchema,
  VerificationAttemptSchema,
  FixProposalSchema,
  ProjectRevisionSchema,
  ManagedProjectCopySchema,
  ProjectContextSnapshotSchema,
  AgentInvestigationPlanSchema,
  EmergentHypothesisSchema,
  RunActivitySchema,
} from '@qa/schemas';
import {
  isAgentRunForQARun,
  isContextForRevision,
  isManagedCopyForRevision,
  isPlanForAgentRun,
  isQARunForSnapshot,
  isQARunForContext,
  isRetestAgainstNewerRevision,
  isRetestLineageValid,
  isSnapshotForRevision,
} from '../src/index.js';

const dir = join(__dirname, 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const schemas: Record<string, { parse: (v: unknown) => unknown }> = {
  'project.json': ProjectSchema,
  'managed-project-copy.json': ManagedProjectCopySchema,
  'project-revision.json': ProjectRevisionSchema,
  'project-revision-2.json': ProjectRevisionSchema,
  'snapshot.json': ProjectSnapshotSchema,
  'snapshot-2.json': ProjectSnapshotSchema,
  'project-context.json': ProjectContextSnapshotSchema,
  'project-context-2.json': ProjectContextSnapshotSchema,
  'stack-muse.json': AgentStackDefinitionSchema,
  'stack-deepseek.json': AgentStackDefinitionSchema,
  'stack-glm.json': AgentStackDefinitionSchema,
  'stack-future.json': AgentStackDefinitionSchema,
  'qa-run.json': QARunSchema,
  'agent-run-muse.json': AgentRunSchema,
  'agent-run-deepseek.json': AgentRunSchema,
  'agent-run-glm.json': AgentRunSchema,
  'investigation-plan.json': AgentInvestigationPlanSchema,
  'emergent-hypothesis.json': EmergentHypothesisSchema,
  'finding.json': FindingSchema,
  'finding-2.json': FindingSchema,
  'evidence.json': EvidenceSchema,
  'evidence-2.json': EvidenceSchema,
  'unified-issue.json': UnifiedIssueSchema,
  'verification.json': VerificationAttemptSchema,
  'fix-proposal.json': FixProposalSchema,
  'cicd-plan.json': CICDPlanSchema,
  'artifact.json': ArtifactSchema,
  'run-activity.json': RunActivitySchema,
  'retest-qa-run.json': QARunSchema,
};
void HarnessRunRequestSchema;

describe('contract fixtures', () => {
  for (const [file, schema] of Object.entries(schemas)) {
    it(file + ' parses through its real schema', () => {
      expect(() => schema.parse(load(file))).not.toThrow();
    });
  }
  it('relationship fixture references connect by ID', () => {
    const rel = load('relationship.json') as { agentRuns: string[]; findings: string[] };
    expect(rel.agentRuns).toHaveLength(3);
    expect(rel.findings).toHaveLength(2);
    const run = QARunSchema.parse(load('qa-run.json'));
    const issue = UnifiedIssueSchema.parse(load('unified-issue.json'));
    const f1 = FindingSchema.parse(load('finding.json'));
    expect(f1.qaRunId).toBe(run.id);
    expect(issue.qaRunId).toBe(run.id);
    expect(issue.findingIds).toContain(f1.id);
    expect(run.configuration.agentStackIds).toContain(f1.sourceAgentStackId);

    const revision = ProjectRevisionSchema.parse(load('project-revision.json'));
    const managedCopy = ManagedProjectCopySchema.parse(load('managed-project-copy.json'));
    const snapshot = ProjectSnapshotSchema.parse(load('snapshot.json'));
    const context = ProjectContextSnapshotSchema.parse(load('project-context.json'));
    const agentRun = AgentRunSchema.parse(load('agent-run-muse.json'));
    const plan = AgentInvestigationPlanSchema.parse(load('investigation-plan.json'));
    expect(isSnapshotForRevision(snapshot, revision)).toBe(true);
    expect(isManagedCopyForRevision(managedCopy, revision)).toBe(true);
    expect(isContextForRevision(context, revision)).toBe(true);
    expect(isQARunForSnapshot(run, snapshot)).toBe(true);
    expect(isQARunForContext(run, context)).toBe(true);
    expect(isAgentRunForQARun(agentRun, run)).toBe(true);
    expect(isPlanForAgentRun(plan, agentRun, run)).toBe(true);

    const retest = QARunSchema.parse(load('retest-qa-run.json'));
    expect(isRetestLineageValid(retest, run, issue)).toBe(true);
    const retestRevision = ProjectRevisionSchema.parse(load('project-revision-2.json'));
    const retestSnapshot = ProjectSnapshotSchema.parse(load('snapshot-2.json'));
    const retestContext = ProjectContextSnapshotSchema.parse(load('project-context-2.json'));
    expect(isContextForRevision(retestContext, retestRevision)).toBe(true);
    expect(
      isRetestAgainstNewerRevision(retest, retestSnapshot, retestRevision, snapshot, revision),
    ).toBe(true);
  });
  it('no fixture leaks absolute machine paths', () => {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = readFileSync(join(dir, f), 'utf8');
      expect(raw).not.toMatch(/[A-Za-z]:\\\\/);
      expect(raw).not.toMatch(/\/home\//);
      expect(raw).not.toMatch(/sk-/);
    }
  });
});
