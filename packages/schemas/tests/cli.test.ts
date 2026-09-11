import { describe, expect, it } from 'vitest';
import {
  CapabilitiesResultSchema,
  CliEnvelopeSchema,
  CliErrorEnvelopeSchema,
  CliResultSchemas,
} from '../src/index.js';

describe('machine CLI schemas', () => {
  it('accepts a strict versioned capability response', () => {
    const data = CapabilitiesResultSchema.parse({
      cliContractVersion: 1,
      features: {
        projectLifecycle: true,
        runInspection: true,
        fakeRunSimulation: true,
        realAgentExecution: true,
        retestExecution: false,
        runCancellation: false,
      },
    });
    expect(
      CliEnvelopeSchema.parse({
        schemaVersion: 1,
        command: 'capabilities',
        ok: true,
        data,
      }),
    ).toBeDefined();
  });

  it('rejects untyped result data and unknown envelope fields', () => {
    expect(CliResultSchemas['project.delete'].safeParse({ arbitrary: true }).success).toBe(false);
    expect(
      CliErrorEnvelopeSchema.safeParse({
        schemaVersion: 1,
        command: 'project.update',
        ok: false,
        error: { code: 'PROJECT_LOCKED', message: 'Locked', retryable: true },
        stack: 'secret',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown contract versions and error codes', () => {
    expect(
      CliErrorEnvelopeSchema.safeParse({
        schemaVersion: 2,
        command: 'unknown',
        ok: false,
        error: { code: 'RAW_SQLITE_FAILURE', message: 'x', retryable: false },
      }).success,
    ).toBe(false);
  });
});
