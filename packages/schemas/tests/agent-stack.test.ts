import { describe, expect, it } from 'vitest';
import { AgentStackDefinitionSchema } from '../src/index.js';

const muse = {
  schemaVersion: 1,
  id: 'stack_muse_main',
  displayName: 'Muse QA Agent',
  enabled: true,
  model: { provider: 'meta', modelId: 'muse-1.3-contributor' },
  harness: { adapterId: 'muse-code', expectedProtocolVersion: 1 },
  execution: {},
  policy: { id: 'qa-standard', version: 1 },
};

describe('AgentStackDefinitionSchema', () => {
  it('keeps model independent from harness', () => {
    const s = AgentStackDefinitionSchema.parse({
      ...muse,
      harness: { adapterId: 'other', expectedProtocolVersion: 1 },
    });
    expect(s.model.modelId).toBe('muse-1.3-contributor');
    expect(s.harness.adapterId).toBe('other');
  });
  it('accepts the three initial stacks', () => {
    const mk = (id: string, provider: string, modelId: string, adapterId: string) => ({
      ...muse,
      id,
      model: { provider, modelId },
      harness: { adapterId, expectedProtocolVersion: 1 },
    });
    expect(
      AgentStackDefinitionSchema.safeParse(
        mk('stack_muse_main', 'meta', 'muse-1.3-contributor', 'muse-code'),
      ).success,
    ).toBe(true);
    expect(
      AgentStackDefinitionSchema.safeParse(
        mk('stack_deepseek_main', 'deepseek', 'deepseek-v4-flash', 'deepseek-harness'),
      ).success,
    ).toBe(true);
    expect(
      AgentStackDefinitionSchema.safeParse(
        mk('stack_glm_main', 'zai', 'glm-5.3-flash', 'claude-code'),
      ).success,
    ).toBe(true);
  });
  it('accepts an unknown future model and harness without schema changes', () => {
    const future = {
      schemaVersion: 1,
      id: 'stack_future_main',
      displayName: 'Future QA Agent',
      enabled: true,
      model: { provider: 'future-provider', modelId: 'future-model-9' },
      harness: { adapterId: 'future-harness', expectedProtocolVersion: 1 },
      execution: { operatingSystem: 'any' },
      policy: { id: 'qa-standard', version: 1 },
    };
    expect(AgentStackDefinitionSchema.safeParse(future).success).toBe(true);
  });
  it('rejects invalid limits', () => {
    expect(
      AgentStackDefinitionSchema.safeParse({ ...muse, limits: { maxTurns: -1 } }).success,
    ).toBe(false);
    expect(
      AgentStackDefinitionSchema.safeParse({ ...muse, limits: { maxTurns: 1.5 } }).success,
    ).toBe(false);
  });
  it('accepts configuration extensions', () => {
    const s = AgentStackDefinitionSchema.parse({
      ...muse,
      model: { provider: 'x', modelId: 'y', configuration: { temperature: 0.2 } },
    });
    expect(s.model.configuration).toEqual({ temperature: 0.2 });
  });
});
