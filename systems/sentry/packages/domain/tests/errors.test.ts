import { describe, expect, it } from 'vitest';
import { ProjectSchema } from '@qa/schemas';
import { DomainError, InvalidStateTransitionError, parseDomain } from '../src/index.js';
import { AgentStackNotFoundError, UnsupportedSchemaVersionError } from '../src/index.js';

describe('domain errors', () => {
  it('carries code + serializes safely', () => {
    const e = new AgentStackNotFoundError('stack_x');
    expect(e.code).toBe('AGENT_STACK_NOT_FOUND');
    expect(JSON.parse(JSON.stringify(e.toJSON())).code).toBe('AGENT_STACK_NOT_FOUND');
  });
  it('parse boundary wraps Zod failures as VALIDATION_ERROR', () => {
    expect(() => parseDomain(ProjectSchema, { nope: true }, 'Project')).toThrow(DomainError);
    try {
      parseDomain(ProjectSchema, { nope: true }, 'Project');
    } catch (e) {
      expect((e as DomainError).code).toBe('VALIDATION_ERROR');
    }
  });
  it('unsupported schemaVersion surfaces explicitly', () => {
    expect(() => parseDomain(ProjectSchema, { schemaVersion: 99 }, 'Project')).toThrow(
      UnsupportedSchemaVersionError,
    );
    expect(() => new InvalidStateTransitionError('a', 'b').toJSON()).not.toThrow();
  });
});
