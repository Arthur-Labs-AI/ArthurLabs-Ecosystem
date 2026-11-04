import { describe, expect, it } from 'vitest';
import { RUNTIME_EXPORT_MAX_RAW_BYTES } from '@qa/runtime-protocol';
import { assertExportTransportSize } from '../src/runtime.js';

// The runtime NDJSON transport caps response lines, so canonical exports
// above the proven inline ceiling fail here deterministically instead of
// vanishing into framing and surfacing as an ambiguous RUNTIME_TIMEOUT.
describe('export transport gate', () => {
  it('allows exports at or below the proven ceiling', () => {
    expect(() => assertExportTransportSize(0, 'run_x')).not.toThrow();
    expect(() => assertExportTransportSize(353161, 'run_x')).not.toThrow();
    expect(() => assertExportTransportSize(RUNTIME_EXPORT_MAX_RAW_BYTES, 'run_x')).not.toThrow();
  });

  it('rejects oversized exports with a stable public code', () => {
    try {
      assertExportTransportSize(RUNTIME_EXPORT_MAX_RAW_BYTES + 1, 'run_01K7777777777777777777A8W3');
      expect.unreachable('oversized export must fail');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('EXPORT_TOO_LARGE');
      expect((error as Error).message).toContain(String(RUNTIME_EXPORT_MAX_RAW_BYTES));
    }
  });
});
