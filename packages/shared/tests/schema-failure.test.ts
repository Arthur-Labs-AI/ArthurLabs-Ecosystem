import { describe, expect, it } from 'vitest';
import { describeSchemaIssues } from '../src/index.js';

const zodLike = (issues: unknown[]) =>
  Object.assign(new Error('raw json with agent output'), { issues });

describe('describeSchemaIssues', () => {
  it('names the rejected fields and codes, never values or the raw message', () => {
    const text = describeSchemaIssues(
      zodLike([
        {
          path: ['tool', 'durationMs'],
          code: 'invalid_type',
          message: 'Expected integer, got 1.5',
        },
        { path: [], code: 'unrecognized_keys', message: 'secret-value' },
      ]),
    );
    expect(text).toBe('tool.durationMs [invalid_type]; (root) [unrecognized_keys]');
    expect(text).not.toContain('secret-value');
    expect(text).not.toContain('raw json');
  });

  it('keeps at most the first few issues and tolerates non-schema failures', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ path: ['f' + i], code: 'too_big' }));
    expect(describeSchemaIssues(zodLike(many)).split('; ')).toHaveLength(3);
    expect(describeSchemaIssues(new Error('plain'))).toBe('');
    expect(describeSchemaIssues(undefined)).toBe('');
    expect(describeSchemaIssues({ issues: 'nope' })).toBe('');
  });
});
