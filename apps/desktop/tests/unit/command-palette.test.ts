import { describe, expect, it } from 'vitest';
import { buildPaletteEntries, filterPaletteEntries } from '../../src/renderer/lib/palette.js';

describe('command palette (§117)', () => {
  it('offers navigation, QA start, and environment actions', () => {
    const seen: string[] = [];
    const entries = buildPaletteEntries(
      [{ projectId: 'proj_01K7777777777777777777A8W1', name: 'AutoPulse' }],
      (to) => seen.push(to),
    );
    const labels = entries.map((e) => e.label);
    expect(labels).toContain('Open Projects');
    expect(labels).toContain('Open Runs');
    expect(labels).toContain('Open Issues (Legacy)');
    expect(labels).toContain('Open History');
    expect(labels).toContain('Open Environment');
    expect(labels).toContain('Start Full QA — AutoPulse');
    expect(labels).toContain('Start Targeted QA — AutoPulse');
    entries.find((e) => e.label === 'Open Environment')?.run();
    expect(seen).toEqual(['/environment']);
  });

  it('filters by label without shell commands', () => {
    const entries = buildPaletteEntries([], () => undefined);
    expect(filterPaletteEntries(entries, 'env').map((e) => e.label)).toEqual(['Open Environment']);
    expect(filterPaletteEntries(entries, '').length).toBe(entries.length);
    expect(JSON.stringify(entries)).not.toContain('shell');
  });
});
