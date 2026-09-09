import { z } from 'zod';
import {
  AgentRunIdSchema,
  ArtifactIdSchema,
  EvidenceIdSchema,
  IsoTimestampSchema,
  RelativePathSchema,
  SchemaVersionSchema,
  NonNegativeIntSchema,
} from './primitives.js';
import { EVIDENCE_STRENGTHS, EVIDENCE_TYPES } from './enums.js';

export const CommandEvidenceSchema = z
  .object({
    command: z.string().min(1).max(2000),
    cwdRelative: RelativePathSchema.optional(),
    exitCode: z.number().int(),
    durationMs: NonNegativeIntSchema.optional(),
    stdoutArtifactId: ArtifactIdSchema.optional(),
    stderrArtifactId: ArtifactIdSchema.optional(),
  })
  .strict();
export type CommandEvidence = z.infer<typeof CommandEvidenceSchema>;

export const RuntimeEvidenceSchema = z
  .object({
    process: z.string().min(1).max(300).optional(),
    exitCode: z.number().int().optional(),
    logArtifactId: ArtifactIdSchema.optional(),
    summary: z.string().min(1).max(5000).optional(),
  })
  .strict()
  .refine((r) => r.summary !== undefined || r.logArtifactId !== undefined, {
    message: 'Runtime evidence needs a summary or a log artifact reference',
  });
export type RuntimeEvidence = z.infer<typeof RuntimeEvidenceSchema>;

export const BrowserEvidenceSchema = z
  .object({
    url: z.string().url().max(2000).optional(),
    actionSummary: z.string().min(1).max(5000).optional(),
    screenshotArtifactId: ArtifactIdSchema.optional(),
    consoleArtifactId: ArtifactIdSchema.optional(),
    networkArtifactId: ArtifactIdSchema.optional(),
  })
  .strict();
export type BrowserEvidence = z.infer<typeof BrowserEvidenceSchema>;

export const StaticAnalysisEvidenceSchema = z
  .object({
    tool: z.string().min(1).max(100),
    ruleId: z.string().min(1).max(200).optional(),
    message: z.string().min(1).max(5000),
    locations: z
      .array(
        z
          .object({
            relativePath: RelativePathSchema,
            startLine: z.number().int().min(1).optional(),
            endLine: z.number().int().min(1).optional(),
            symbol: z.string().min(1).max(300).optional(),
            message: z.string().min(1).max(2000).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type StaticAnalysisEvidence = z.infer<typeof StaticAnalysisEvidenceSchema>;

export const CodeReferenceEvidenceSchema = z
  .object({
    relativePath: RelativePathSchema,
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    excerptArtifactId: ArtifactIdSchema.optional(),
  })
  .strict();
export type CodeReferenceEvidence = z.infer<typeof CodeReferenceEvidenceSchema>;

export const EvidenceSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: EvidenceIdSchema,
    qaRunId: z.string().refine((v) => /^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid QARunId',
    }),
    agentRunId: AgentRunIdSchema.optional(),
    type: z.enum(EVIDENCE_TYPES),
    strength: z.enum(EVIDENCE_STRENGTHS),
    description: z.string().min(1).max(5000).optional(),
    command: CommandEvidenceSchema.optional(),
    runtime: RuntimeEvidenceSchema.optional(),
    browser: BrowserEvidenceSchema.optional(),
    staticAnalysis: StaticAnalysisEvidenceSchema.optional(),
    codeReference: CodeReferenceEvidenceSchema.optional(),
    artifactIds: z.array(ArtifactIdSchema).default([]),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;
