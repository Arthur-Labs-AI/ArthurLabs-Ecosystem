import { z } from 'zod';
import {
  AgentRunIdSchema,
  ArtifactIdSchema,
  EvidenceIdSchema,
  IsoTimestampSchema,
  OperationIdSchema,
  QARunIdSchema,
  RelativePathSchema,
  SchemaVersionSchema,
  NonNegativeIntSchema,
} from './primitives.js';
import { EVIDENCE_ENVIRONMENT_STATES, EVIDENCE_STRENGTHS } from './enums.js';
import { CodeLocationSchema, extendCodeLocationSchema } from './code-location.schema.js';

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
  .strict()
  .refine(
    (evidence) =>
      evidence.url !== undefined ||
      evidence.actionSummary !== undefined ||
      evidence.screenshotArtifactId !== undefined ||
      evidence.consoleArtifactId !== undefined ||
      evidence.networkArtifactId !== undefined,
    { message: 'Browser evidence needs a URL, summary, or artifact reference' },
  );
export type BrowserEvidence = z.infer<typeof BrowserEvidenceSchema>;

export const StaticAnalysisEvidenceSchema = z
  .object({
    tool: z.string().min(1).max(100),
    ruleId: z.string().min(1).max(200).optional(),
    message: z.string().min(1).max(5000),
    locations: z.array(CodeLocationSchema).optional(),
  })
  .strict();
export type StaticAnalysisEvidence = z.infer<typeof StaticAnalysisEvidenceSchema>;

export const CodeReferenceEvidenceSchema = extendCodeLocationSchema({
  excerptArtifactId: ArtifactIdSchema.optional(),
  sourceState: z.enum(EVIDENCE_ENVIRONMENT_STATES).optional(),
  contentHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  excerpt: z.string().min(1).max(4_000).optional(),
});
export type CodeReferenceEvidence = z.infer<typeof CodeReferenceEvidenceSchema>;

export const TestEvidenceSchema = z
  .object({
    framework: z.string().min(1).max(100),
    name: z.string().min(1).max(500),
    status: z.enum(['passed', 'failed']),
    artifactId: ArtifactIdSchema.optional(),
    summary: z.string().min(1).max(5000).optional(),
  })
  .strict();
export type TestEvidence = z.infer<typeof TestEvidenceSchema>;

export const LogEvidenceSchema = z
  .object({
    source: z.string().min(1).max(200),
    summary: z.string().min(1).max(5000).optional(),
    artifactId: ArtifactIdSchema.optional(),
  })
  .strict()
  .refine((evidence) => evidence.summary !== undefined || evidence.artifactId !== undefined, {
    message: 'Log evidence needs a summary or an artifact reference',
  });
export type LogEvidence = z.infer<typeof LogEvidenceSchema>;

export const ManualEvidenceSchema = z
  .object({
    summary: z.string().min(1).max(5000),
    author: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ManualEvidence = z.infer<typeof ManualEvidenceSchema>;

export const BaseEvidenceSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: EvidenceIdSchema,
    qaRunId: QARunIdSchema,
    agentRunId: AgentRunIdSchema.optional(),
    strength: z.enum(EVIDENCE_STRENGTHS),
    environmentState: z.enum(EVIDENCE_ENVIRONMENT_STATES),
    description: z.string().min(1).max(5000).optional(),
    artifactIds: z.array(ArtifactIdSchema).default([]),
    /**
     * Durable operation provenance: canonical OperationIds (`op_<ULID>`)
     * of the observed harness operations that verified this evidence.
     * Temporary model-facing keys (`op_1`) must never appear here; the
     * schema's OperationId format rejects them. Empty when no observed
     * operation backs the item (code references, manual reasoning).
     * Additive and backwards-compatible (defaults to []).
     */
    groundingOperationIds: z.array(OperationIdSchema).default([]),
    createdAt: IsoTimestampSchema,
  })
  .strict();

export const EvidenceSchema = z.discriminatedUnion('type', [
  BaseEvidenceSchema.extend({
    type: z.literal('command'),
    command: CommandEvidenceSchema,
  }).strict(),
  BaseEvidenceSchema.extend({
    type: z.literal('runtime'),
    runtime: RuntimeEvidenceSchema,
  }).strict(),
  BaseEvidenceSchema.extend({
    type: z.literal('browser'),
    browser: BrowserEvidenceSchema,
  }).strict(),
  BaseEvidenceSchema.extend({
    type: z.literal('static_analysis'),
    staticAnalysis: StaticAnalysisEvidenceSchema,
  }).strict(),
  BaseEvidenceSchema.extend({
    type: z.literal('code_reference'),
    codeReference: CodeReferenceEvidenceSchema,
  }).strict(),
  BaseEvidenceSchema.extend({ type: z.literal('test'), test: TestEvidenceSchema }).strict(),
  BaseEvidenceSchema.extend({ type: z.literal('log'), log: LogEvidenceSchema }).strict(),
  BaseEvidenceSchema.extend({ type: z.literal('manual'), manual: ManualEvidenceSchema }).strict(),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;
