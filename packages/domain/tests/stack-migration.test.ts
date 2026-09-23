import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRunSchema, AgentStackDefinitionSchema } from '@qa/schemas';
import { INITIAL_AGENT_STACKS, OPENCODE_QA_STACK } from '../src/index.js';

const dir = join(__dirname, 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

/**
 * Muse → OpenCode migration regression: the active catalog changed, but
 * historical Muse rows must stay decodable and must never be rewritten to
 * the new stack id.
 */
describe('agent stack migration (muse → opencode)', () => {
  it('offers exactly OpenCode, DeepSeek, and GLM as runnable stacks', () => {
    expect(INITIAL_AGENT_STACKS.map((stack) => stack.id)).toEqual([
      'stack_opencode_main',
      'stack_deepseek_main',
      'stack_glm_main',
    ]);
  });

  it('separates harness, provider, and model on the OpenCode stack', () => {
    expect(OPENCODE_QA_STACK.harness.adapterId).toBe('opencode');
    expect(OPENCODE_QA_STACK.model.provider).toBe('openrouter');
  });

  it('historical Muse stack definition still parses', () => {
    const stack = AgentStackDefinitionSchema.parse(load('stack-muse.json'));
    expect(stack.id).toBe('stack_muse_main');
    expect(INITIAL_AGENT_STACKS.some((active) => active.id === stack.id)).toBe(false);
  });

  it('historical Muse agent run still parses and keeps its identity', () => {
    const run = AgentRunSchema.parse(load('agent-run-muse.json'));
    expect(run.agentStackId).toBe('stack_muse_main');
    // Never silently remapped to the new stack.
    expect(run.agentStackId).not.toBe('stack_opencode_main');
  });
});
