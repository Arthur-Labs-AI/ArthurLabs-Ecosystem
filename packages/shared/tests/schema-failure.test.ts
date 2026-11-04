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

describe('describePlanRejection', () => {
  it('names rejected fields, bounds other messages and flags empty answers', async () => {
    const { describePlanRejection } = await import('../src/schema-failure.js');
    expect(describePlanRejection(undefined, true)).toBe('empty response');
    expect(
      describePlanRejection({ issues: [{ path: ['plannedChecks', 0], code: 'too_small' }] }),
    ).toBe('plannedChecks.0 [too_small]');
    const long = describePlanRejection(new Error('planning response\nwas not   JSON ' + 'x'.repeat(400)));
    expect(long).toHaveLength(160);
    expect(long).not.toContain('\n');
    expect(describePlanRejection('boom')).toBe('unknown');
  });
});
