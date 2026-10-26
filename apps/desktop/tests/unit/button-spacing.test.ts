import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../src/renderer/styles.css', import.meta.url), 'utf8');

describe('button-row spacing', () => {
  it('defines a base .actions rule with flex layout and a gap', () => {
    const base = styles.match(/[^}]*\.actions\s*\{[^}]*\}/g) ?? [];
    expect(base.length).toBeGreaterThan(0);
    const root = base.find(
      (rule) => rule.indexOf('.page-header') === -1 && rule.indexOf('.project-removal-dialog') === -1,
    );
    expect(root).toBeDefined();
    expect(root as string).toMatch(/display\s*:\s*flex/);
    expect(root as string).toMatch(/gap\s*:/);
  });
});