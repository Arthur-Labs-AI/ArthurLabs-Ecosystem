/** Phase 7 TargetSpec (§9-§10). Immutable first-class target specification
 *  for TARGETED QA. Persisted at QARun start, exported, machine-readable,
 *  and part of run identity/audit (§77).
 *
 *  Scope defines the QA objective, not a workspace prison (§11): agents may
 *  inspect dependencies outside the target, but reported findings should
 *  normally relate to the target or a necessary dependency/consequence.
 */
import { z } from 'zod';
import {
  IsoTimestampSchema,
  QARunIdSchema,
  RelativePathSchema,
  SchemaVersionSchema,
  SnapshotIdSchema,
  UnifiedIssueIdSchema,
} from './primitives.js';
import { createHash } from 'node:crypto';

export const TargetSpecSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    qaRunId: QARunIdSchema,
    snapshotId: SnapshotIdSchema,
    includePaths: z.array(RelativePathSchema).min(1).max(100),
    issueIds: z.array(UnifiedIssueIdSchema).max(100).default([]),
    userInstructions: z.string().min(1).max(5000).optional(),
    createdAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((spec, ctx) => {
    const seen = new Set(spec.includePaths);
    if (seen.size !== spec.includePaths.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['includePaths'],
        message: 'includePaths must not contain duplicates',
      });
    }
    const issueSeen = new Set(spec.issueIds);
    if (issueSeen.size !== spec.issueIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issueIds'],
        message: 'issueIds must not contain duplicates',
      });
    }
  });
export type TargetSpec = z.infer<typeof TargetSpecSchema>;

/** Deterministic input digest over the target/audit dimensions (§77):
 *  selected paths, issue targets, instructions, agents, snapshot, policy. */
export function targetSpecDigest(input: {
  readonly includePaths: readonly string[];
  readonly issueIds: readonly string[];
  readonly userInstructions?: string;
  readonly agentStackIds: readonly string[];
  readonly snapshotId: string;
  readonly policyId: string;
  readonly policyVersion: number;
}): string {
  const canonical = JSON.stringify({
    includePaths: [...input.includePaths].sort(),
    issueIds: [...input.issueIds].sort(),
    userInstructions: input.userInstructions ?? null,
    agentStackIds: [...input.agentStackIds].sort(),
    snapshotId: input.snapshotId,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
  });
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export const TargetSpecInputDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export type TargetSpecInputDigest = z.infer<typeof TargetSpecInputDigestSchema>;
