import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOpenCodeTurn } from '../src/index.js';

const dir = join(__dirname, 'fixtures');
const load = (name: string): string => readFileSync(join(dir, name), 'utf8');

describe('real OpenCode wire parsing', () => {
  it('parses a planning turn to the exact plan text', () => {
    const parsed = parseOpenCodeTurn(load('planning-output.jsonl'));
    expect(parsed.sessionId).toBe('ses_f2fdd169effe7iRV77I1zxPY89');
    expect(parsed.envelopes).toBe(3);
    expect(parsed.skippedLines).toBe(0);
    expect(parsed.tools).toEqual([]);
    const plan = JSON.parse(parsed.text);
    expect(plan).toMatchObject({
      schemaVersion: 1,
      projectUnderstanding: 'Small fixture',
      plannedChecks: ['Inspect README'],
    });
    expect(parsed.usage).toMatchObject({ inputTokens: 11, outputTokens: 6 });
    expect(parsed.steps).toBe(1);
  });

  it('parses a completed read tool with input but no invented exit code', () => {
    const parsed = parseOpenCodeTurn(load('tool-read.jsonl'));
    expect(parsed.tools).toHaveLength(1);
    const tool = parsed.tools[0];
    expect(tool?.tool).toBe('read');
    expect(tool?.callID).toBe('call_read_1');
    expect(tool?.status).toBe('completed');
    expect(tool?.input).toMatchObject({ filePath: 'README.md' });
    expect(tool?.output).toContain('# stub workspace');
    expect(tool?.exitCode).toBeUndefined();
    expect(tool?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('parses a tool error without inventing an exit code', () => {
    const parsed = parseOpenCodeTurn(load('tool-error.jsonl'));
    expect(parsed.tools).toHaveLength(1);
    const tool = parsed.tools[0];
    expect(tool?.status).toBe('error');
    expect(tool?.error).toContain('File not found');
    expect(tool?.exitCode).toBeUndefined();
    expect(tool?.output).toBeUndefined();
  });

  it('parses the subagent task tool for blocking', () => {
    const parsed = parseOpenCodeTurn(load('task-subagent.jsonl'));
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0]?.tool).toBe('task');
    expect(parsed.tools[0]?.status).toBe('completed');
  });

  it('takes the exact exit code from bash metadata', () => {
    const parsed = parseOpenCodeTurn(load('bash-exit.jsonl'));
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0]?.tool).toBe('bash');
    expect(parsed.tools[0]?.exitCode).toBe(0);
    expect(parsed.tools[0]?.title).toBeDefined();
  });

  it('parses a permission-denied bash call as error without exit code', () => {
    const parsed = parseOpenCodeTurn(load('bash-denied.jsonl'));
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0]?.status).toBe('error');
    expect(parsed.tools[0]?.error).toContain('rejected permission');
    expect(parsed.tools[0]?.exitCode).toBeUndefined();
  });

  it('parses the unknown-tool envelope without crashing', () => {
    const parsed = parseOpenCodeTurn(load('invalid-tool.jsonl'));
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0]?.tool).toBe('invalid');
  });

  it('surfaces top-level error envelopes', () => {
    const parsed = parseOpenCodeTurn(load('error-output.jsonl'));
    expect(parsed.sessionId).toBe('ses_f30282150ffeIikEXxQ4RDw2Va');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain('Unable to connect');
    expect(parsed.text).toBe('');
  });

  it('always drops reasoning parts', () => {
    const parsed = parseOpenCodeTurn(load('reasoning.jsonl'));
    expect(parsed.text).toBe('');
    expect(parsed.tools).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain('scratch');
  });

  it('skips garbage and unknown future envelopes fail-closed', () => {
    const parsed = parseOpenCodeTurn(load('malformed-mixed.jsonl'));
    expect(parsed.skippedLines).toBe(1);
    // The future envelope is counted but contributes nothing.
    expect(parsed.envelopes).toBe(4);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0]?.tool).toBe('read');
  });

  it('falls back to raw text when nothing parses', () => {
    const parsed = parseOpenCodeTurn('plain terminal prose');
    expect(parsed.text).toBe('plain terminal prose');
    expect(parsed.tools).toEqual([]);
  });
});
