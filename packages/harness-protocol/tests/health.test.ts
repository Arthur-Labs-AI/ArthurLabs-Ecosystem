import { describe, expect, it } from 'vitest';
import { HarnessHealthResultSchema, HarnessMetadataSchema } from '../src/index.js';

describe('metadata + health', () => {
  it('accepts adapter metadata without exact model enumerations', () => {
    const m = HarnessMetadataSchema.parse({
      adapterId: 'future-harness',
      adapterVersion: '9.9.9',
      protocolVersion: 1,
      displayName: 'Future',
      capabilities: {
        streaming: true,
        cancellation: true,
        filesystemRead: true,
        filesystemWrite: false,
        shell: false,
        browser: false,
        sessionResume: false,
        structuredOutput: true,
        usageReporting: true,
      },
    });
    expect(m.adapterId).toBe('future-harness');
  });
  it('health result validates checks', () => {
    expect(
      HarnessHealthResultSchema.safeParse({
        status: 'healthy',
        checks: [{ name: 'bin', status: 'pass' }],
        checkedAt: '2026-09-09T19:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      HarnessHealthResultSchema.safeParse({
        status: 'ok',
        checks: [],
        checkedAt: '2026-09-09T19:00:00.000Z',
      }).success,
    ).toBe(false);
  });
  it('requires capability extensions to use the explicit extensions field', () => {
    const capabilities = {
      streaming: true,
      cancellation: true,
      filesystemRead: true,
      filesystemWrite: false,
      shell: false,
      browser: false,
      sessionResume: false,
      structuredOutput: true,
      usageReporting: true,
    };
    expect(
      HarnessMetadataSchema.shape.capabilities.safeParse({ ...capabilities, vendor: true }).success,
    ).toBe(false);
    expect(
      HarnessMetadataSchema.shape.capabilities.safeParse({
        ...capabilities,
        extensions: { vendorFeature: true },
      }).success,
    ).toBe(true);
  });
});
