import { z } from 'zod';
import { IsoTimestampSchema } from '@qa/schemas';
import { HARNESS_CHECK_STATUSES, HARNESS_HEALTH_STATUSES } from '@qa/schemas';

export const HarnessCapabilitiesSchema = z
  .object({
    streaming: z.boolean(),
    cancellation: z.boolean(),
    filesystemRead: z.boolean(),
    filesystemWrite: z.boolean(),
    shell: z.boolean(),
    browser: z.boolean(),
    sessionResume: z.boolean(),
    structuredOutput: z.boolean(),
    usageReporting: z.boolean(),
    extensions: z.record(z.unknown()).optional(),
  })
  .strict();
export type HarnessCapabilities = z.infer<typeof HarnessCapabilitiesSchema>;

export const HarnessMetadataSchema = z
  .object({
    adapterId: z.string().min(1).max(100),
    adapterVersion: z.string().min(1).max(100),
    protocolVersion: z.number().int().min(1),
    displayName: z.string().min(1).max(200),
    capabilities: HarnessCapabilitiesSchema,
    supportedModelPatterns: z.array(z.string().min(1).max(200)).optional(),
    supportedOperatingSystems: z.array(z.string().min(1).max(50)).optional(),
  })
  .strict();
export type HarnessMetadata = z.infer<typeof HarnessMetadataSchema>;

export const HarnessHealthCheckSchema = z
  .object({
    name: z.string().min(1).max(200),
    status: z.enum(HARNESS_CHECK_STATUSES),
    message: z.string().max(2000).optional(),
  })
  .strict();
export type HarnessHealthCheck = z.infer<typeof HarnessHealthCheckSchema>;

export const HarnessHealthResultSchema = z
  .object({
    status: z.enum(HARNESS_HEALTH_STATUSES),
    checks: z.array(HarnessHealthCheckSchema).default([]),
    checkedAt: IsoTimestampSchema,
  })
  .strict();
export type HarnessHealthResult = z.infer<typeof HarnessHealthResultSchema>;

export { HARNESS_PROTOCOL_VERSION } from '@qa/schemas';
