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
} from '@qa/schemas';

const dir = join(__dirname, 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const schemas: Record<string, { parse: (v: unknown) => unknown }> = {
  'project.json': ProjectSchema,
  'snapshot.json': ProjectSnapshotSchema,
  'stack-muse.json': AgentStackDefinitionSchema,
  'stack-deepseek.json': AgentStackDefinitionSchema,
  'stack-glm.json': AgentStackDefinitionSchema,
  'stack-future.json': AgentStackDefinitionSchema,
  'qa-run.json': QARunSchema,
  'agent-run-muse.json': AgentRunSchema,
  'agent-run-deepseek.json': AgentRunSchema,
  'agent-run-glm.json': AgentRunSchema,
  'finding.json': FindingSchema,
  'finding-2.json': FindingSchema,
  'evidence.json': EvidenceSchema,
  'evidence-2.json': EvidenceSchema,
  'unified-issue.json': UnifiedIssueSchema,
  'verification.json': VerificationAttemptSchema,
  'fix-proposal.json': FixProposalSchema,
  'cicd-plan.json': CICDPlanSchema,
  'artifact.json': ArtifactSchema,
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
