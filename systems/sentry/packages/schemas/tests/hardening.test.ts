import { describe, expect, it } from 'vitest';
import {
  AgentRunSchema,
  ArtifactSchema,
  CICDFileProposalSchema,
  ProjectSchema,
  QARunSummarySchema,
} from '../src/index.js';

const T = '2026-09-09T19:00:00.000Z';

describe('Phase 1 contract hardening', () => {
  it('requires schemaVersion on persisted Project, AgentRun and Artifact DTOs', () => {
    expect(
      ProjectSchema.safeParse({
        id: 'proj_01K7777777777777777777A8W1',
        name: 'Example',
        sourcePath: 'D:/Projects/Example',
        createdAt: T,
        updatedAt: T,
      }).success,
    ).toBe(false);
    expect(
      ProjectSchema.safeParse({
        schemaVersion: 99,
        id: 'proj_01K7777777777777777777A8W1',
        name: 'Example',
        sourcePath: 'D:/Projects/Example',
        createdAt: T,
        updatedAt: T,
      }).success,
    ).toBe(false);
    expect(
      AgentRunSchema.safeParse({
        id: 'arun_01K7777777777777777777A8W4',
        qaRunId: 'run_01K7777777777777777777A8W3',
        agentStackId: 'stack_muse_main',
        taskType: 'qa',
        status: 'queued',
      }).success,
    ).toBe(false);
    expect(
      AgentRunSchema.safeParse({
        schemaVersion: 99,
        id: 'arun_01K7777777777777777777A8W4',
        qaRunId: 'run_01K7777777777777777777A8W3',
        agentStackId: 'stack_muse_main',
        taskType: 'qa',
        status: 'queued',
      }).success,
    ).toBe(false);
    expect(
      ArtifactSchema.safeParse({
        id: 'artifact_01K7777777777777777777A8WF',
        type: 'log',
        relativeStoragePath: 'artifacts/log.txt',
        createdAt: T,
      }).success,
    ).toBe(false);
    expect(
      ArtifactSchema.safeParse({
        schemaVersion: 99,
        id: 'artifact_01K7777777777777777777A8WF',
        type: 'log',
        relativeStoragePath: 'artifacts/log.txt',
        createdAt: T,
      }).success,
    ).toBe(false);
  });

  it('requires a centralized ArtifactId in CI/CD file proposals', () => {
    expect(
      CICDFileProposalSchema.safeParse({
        relativePath: '.github/workflows/ci.yml',
        mode: 'create',
        contentArtifactId: 'artifact_01K7777777777777777777A8WF',
      }).success,
    ).toBe(true);
    expect(
      CICDFileProposalSchema.safeParse({
        relativePath: '.github/workflows/ci.yml',
        mode: 'create',
        contentArtifactId: 'banana',
      }).success,
    ).toBe(false);
  });

  it('uses an explicit strict QA run summary shape', () => {
    expect(
      QARunSummarySchema.safeParse({
        agentRuns: { configured: 3, completed: 2, failed: 1 },
        findings: { total: 4 },
        issues: { critical: 0, high: 1, medium: 2, low: 1, info: 0 },
      }).success,
    ).toBe(true);
    expect(QARunSummarySchema.safeParse({ surprise: true }).success).toBe(false);
  });
});
