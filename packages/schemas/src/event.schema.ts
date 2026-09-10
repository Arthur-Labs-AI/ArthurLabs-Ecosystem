/**
 * Harness Event Protocol v1.
 * Versioned discriminated union on `type`. Every event carries
 * schemaVersion: 1, eventId, agentRunId and an ISO UTC timestamp.
 * Zod is the source of truth; NDJSON transport validates line-by-line.
 */
import { z } from 'zod';
import {
  AgentRunIdSchema,
  HarnessEventIdSchema,
  IsoTimestampSchema,
  RelativePathSchema,
  SchemaVersionSchema,
  NonNegativeIntSchema,
} from './primitives.js';
import { FindingSchema } from './finding.schema.js';
import { EvidenceSchema } from './evidence.schema.js';
import { AgentUsageSchema } from './usage.schema.js';

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
  tool: z
    .object({ name: z.string().min(1).max(100), inputSummary: z.string().max(2000).optional() })
    .strict(),
}).strict();
export const ToolCompletedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('tool.completed'),
  tool: z
    .object({
      name: z.string().min(1).max(100),
      exitCode: z.number().int().optional(),
      durationMs: NonNegativeIntSchema.optional(),
    })
    .strict(),
}).strict();
export const CommandExecutedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('command.executed'),
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
}).strict();
export const TestResultEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('test.result'),
  suite: z.string().min(1).max(300).optional(),
  passed: NonNegativeIntSchema.optional(),
  failed: NonNegativeIntSchema.optional(),
  skipped: NonNegativeIntSchema.optional(),
}).strict();
export const FindingSubmittedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('finding.submitted'),
  finding: FindingSchema,
}).strict();
export const EvidenceSubmittedEventSchema = HarnessEventBaseSchema.extend({
  type: z.literal('evidence.submitted'),
  evidence: EvidenceSchema,
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
  FindingSubmittedEventSchema,
  EvidenceSubmittedEventSchema,
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
  'finding.submitted',
  'evidence.submitted',
  'usage.updated',
  'warning',
  'run.completed',
  'run.failed',
  'run.cancelled',
]);
export type HarnessEventType = z.infer<typeof HarnessEventTypeSchema>;
