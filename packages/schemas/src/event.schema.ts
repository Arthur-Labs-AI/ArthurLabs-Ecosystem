/**
 * Harness Event Protocol v1.
 * Versioned discriminated union on `type`. Every event carries
 * schemaVersion: 1, eventId, agentRunId and an ISO UTC timestamp.
 * Zod is the source of truth; NDJSON transport validates line-by-line.
 */
import { z } from 'zod';
import {
  AgentRunIdSchema,
  ArtifactIdSchema,
  HarnessEventIdSchema,
  IsoTimestampSchema,
  RelativePathSchema,
  SchemaVersionSchema,
  NonNegativeIntSchema,
  OperationIdSchema,
} from './primitives.js';
import { FindingSchema } from './finding.schema.js';
import { EvidenceSchema } from './evidence.schema.js';
import { AgentUsageSchema } from './usage.schema.js';
import { AgentInvestigationPlanSchema, EmergentHypothesisSchema } from './investigation.schema.js';
import { FILE_CHANGE_PURPOSES } from './enums.js';

export const HARNESS_PROTOCOL_VERSION = 1 as const;

export const HarnessEventBaseSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  eventId: HarnessEventIdSchema,
  agentRunId: AgentRunIdSchema,
  timestamp: IsoTimestampSchema,
});
export type HarnessEventBase = z.infer<typeof HarnessEventBaseSchema>;

export const StructuredFailureSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2000),
    retryable: z.boolean().default(false),
  })
  .strict();
export type StructuredFailure = z.infer<typeof StructuredFailureSchema>;

export const RunStartedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('run.started'),
}).strict();
export const AgentStatusEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('agent.status'),
  status: z.string().min(1).max(100),
  message: z.string().max(2000).optional(),
}).strict();
export const AgentMessageEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('agent.message'),
  message: z.string().min(1).max(20000),
}).strict();
export const ToolStartedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('tool.started'),
  operationId: OperationIdSchema,
  tool: z
    .object({ name: z.string().min(1).max(100), inputSummary: z.string().max(2000).optional() })
    .strict(),
}).strict();
export const ToolCompletedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('tool.completed'),
  operationId: OperationIdSchema,
  tool: z
    .object({
      name: z.string().min(1).max(100),
      exitCode: z.number().int().optional(),
      durationMs: NonNegativeIntSchema.optional(),
      // Bounded redacted provider/tool diagnostic for failed calls
      // (e.g. permission denial, sandbox refusal). tool_result
      // is_error does NOT imply a shell exit code, so the reason lives
      // here rather than in a fabricated exitCode.
      errorPreview: z.string().min(1).max(1000).optional(),
      // True when the tool result proves sandbox/bootstrap failure
      // before the actual command executed (e.g. bubblewrap could not
      // initialize). Such completions are infrastructure failures, never
      // reproduced-success evidence; exitCode stays undefined.
      infrastructureFailure: z.boolean().optional(),
    })
    .strict(),
}).strict();
export const CommandExecutedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('command.executed'),
  operationId: OperationIdSchema.optional(),
  command: z.string().min(1).max(2000),
  exitCode: z.number().int(),
  durationMs: NonNegativeIntSchema.optional(),
}).strict();
export const FileReadEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('file.read'),
  relativePath: RelativePathSchema,
}).strict();
export const FileChangedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('file.changed'),
  relativePath: RelativePathSchema,
  operation: z.enum(['create', 'modify', 'delete', 'rename']),
  purpose: z.enum(FILE_CHANGE_PURPOSES).optional(),
  artifactId: ArtifactIdSchema.optional(),
}).strict();
export const TestResultEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('test.result'),
  operationId: OperationIdSchema.optional(),
  suite: z.string().min(1).max(300).optional(),
  passed: NonNegativeIntSchema.optional(),
  failed: NonNegativeIntSchema.optional(),
  skipped: NonNegativeIntSchema.optional(),
}).strict();
export const InvestigationPlanCreatedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('investigation.plan.created'),
  plan: AgentInvestigationPlanSchema,
}).strict();
export const InvestigationHypothesisDiscoveredEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('investigation.hypothesis.discovered'),
  hypothesis: EmergentHypothesisSchema,
}).strict();
export const FindingSubmittedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('finding.submitted'),
  finding: FindingSchema,
}).strict();
export const EvidenceSubmittedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('evidence.submitted'),
  evidence: EvidenceSchema,
}).strict();
export const ReportCheckpointEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('report.checkpoint'),
  findings: z.array(FindingSchema).max(500),
  evidence: z.array(EvidenceSchema).max(1000),
}).strict();
export const UsageUpdatedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('usage.updated'),
  usage: AgentUsageSchema,
}).strict();
export const WarningEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('warning'),
  code: z.string().min(1).max(100).optional(),
  message: z.string().min(1).max(2000),
}).strict();
export const RunCompletedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('run.completed'),
  usage: AgentUsageSchema.optional(),
}).strict();
export const RunFailedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('run.failed'),
  failure: StructuredFailureSchema,
}).strict();
export const RunCancelledEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('run.cancelled'),
  reason: z.string().max(2000).optional(),
}).strict();

export const HarnessEventSchema = z.discriminatedUnion('type', [
  RunStartedEventSchema,
  AgentStatusEventSchema,
  AgentMessageEventSchema,
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
  CommandExecutedEventSchema,
  FileReadEventSchema,
  FileChangedEventSchema,
  TestResultEventSchema,
  InvestigationPlanCreatedEventSchema,
  InvestigationHypothesisDiscoveredEventSchema,
  FindingSubmittedEventSchema,
  EvidenceSubmittedEventSchema,
  ReportCheckpointEventSchema,
  UsageUpdatedEventSchema,
  WarningEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
]);
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;

export const HarnessEventTypeSchema = z.enum([
  'run.started',
  'agent.status',
  'agent.message',
  'tool.started',
  'tool.completed',
  'command.executed',
  'file.read',
  'file.changed',
  'test.result',
  'investigation.plan.created',
  'investigation.hypothesis.discovered',
  'finding.submitted',
  'evidence.submitted',
  'report.checkpoint',
  'usage.updated',
  'warning',
  'run.completed',
  'run.failed',
  'run.cancelled',
]);
export type HarnessEventType = z.infer<typeof HarnessEventTypeSchema>;
