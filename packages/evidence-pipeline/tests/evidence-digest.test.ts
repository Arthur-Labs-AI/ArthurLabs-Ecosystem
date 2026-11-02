import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@qa/schemas';
import {
  ObservedToolNotes,
  buildInvestigationCompactionContext,
  buildRecoveryReportContext,
  compactToolOutput,
  renderCheckConclusions,
  stripToolOutputNoise,
} from '../src/index.js';

const message = (text: string): HarnessEvent =>
  ({ type: 'agent.message', message: text }) as unknown as HarnessEvent;

describe('tool output compaction', () => {
  it('keeps the tail, where the failing assertion is, and a short head', () => {
    const body =
      'HEAD-LINE\n' +
      Array.from({ length: 400 }, (_, i) => 'noise line ' + i + '\n').join('') +
      'AssertionError: expected 1 to be 2\n  at probe.mjs:9';
    const compact = compactToolOutput(body, { limit: 600, head: 120 });
    expect(compact.length).toBeLessThanOrEqual(600);
    expect(compact).toContain('HEAD-LINE');
    expect(compact).toContain('AssertionError: expected 1 to be 2');
    expect(compact).toContain('probe.mjs:9');
    expect(compact).toMatch(/characters omitted/);
  });

  it('returns short output unchanged and strips terminal noise', () => {
    const esc = String.fromCharCode(27);
    expect(compactToolOutput('ok  3 passed')).toBe('ok  3 passed');
    expect(stripToolOutputNoise(esc + '[31mred' + esc + '[0m')).toBe('red');
    const install = [
      'Scope: all 21 workspace projects',
      'Progress: resolved 1009, reused 0, downloaded 8, added 0',
      'Progress: resolved 1009, reused 0, downloaded 44, added 44',
      'Packages: +1009 ++++++++++++++++++++++++++++++++++++++++++++++++',
      'Done in 31s',
    ].join('\n');
    expect(stripToolOutputNoise(install)).toBe('Scope: all 21 workspace projects\nDone in 31s');
  });

  it('collapses repeated lines with a count', () => {
    expect(stripToolOutputNoise('retry\nretry\nretry\nend')).toBe(
      'retry\n  (previous line repeated 2 more times)\nend',
    );
  });
});

describe('observed tool digest', () => {
  it('keeps early failing command output after hundreds of later reads', () => {
    const notes = new ObservedToolNotes();
    notes.add(
      message(
        'observed tool bash output: FAIL probe\nAssertionError: lease taken twice\n[exit code 1]',
      ),
    );
    for (let i = 0; i < 700; i += 1)
      notes.add(message('observed tool read output: ' + 'file body '.repeat(200) + i));
    const rendered = notes.render();
    expect(rendered).toContain('lease taken twice');
    expect(JSON.parse(rendered).truncated).toBe(true);
    expect(rendered.length).toBeLessThan(160_000);
  });

  it('keeps written probe sources ahead of reads, and failures ahead of passing commands', () => {
    const notes = new ObservedToolNotes();
    notes.add(
      message('observed tool write source /ws/p.mjs: assert(lease.acquire() && lease.acquire())'),
    );
    notes.add(message('observed tool bash output: all good ' + 'x'.repeat(3500)));
    notes.add(message('observed tool bash output: Error: boom\n[exit code 2]'));
    for (let i = 0; i < 80; i += 1)
      notes.add(message('observed tool bash output: ok ' + 'y'.repeat(3500) + i));
    for (let i = 0; i < 400; i += 1)
      notes.add(message('observed tool grep output: ' + 'match '.repeat(100) + i));
    const rendered = notes.render();
    expect(rendered).toContain('lease.acquire()');
    expect(rendered).toContain('Error: boom');
  });

  it('trims long passing command output to head and tail before dropping it', () => {
    const notes = new ObservedToolNotes();
    notes.add(message('observed tool bash output: EARLY-VERDICT ' + 'a'.repeat(3800) + ' EARLY-TAIL'));
    for (let i = 0; i < 70; i += 1)
      notes.add(message('observed tool bash output: ok ' + 'b'.repeat(3800) + i));
    const rendered = notes.render();
    expect(rendered).toContain('EARLY-VERDICT');
    expect(rendered).toContain('EARLY-TAIL');
    expect(rendered).toContain('[output trimmed]');
    expect(rendered.length).toBeLessThan(160_000);
  });

  it('bounds a single read note and ignores model reasoning', () => {
    const notes = new ObservedToolNotes();
    notes.add(message('private model reasoning'));
    notes.add(message('observed tool read output: ' + 'z'.repeat(5000)));
    const parsed = JSON.parse(notes.render());
    expect(parsed.outputs).toHaveLength(1);
    expect(parsed.outputs[0].length).toBeLessThanOrEqual(260);
  });
});

describe('check conclusions handoff', () => {
  const plan = { plannedChecks: ['Cancel race', 'Lease', 'Credentials'] };
  const request = { task: { prompt: 'QA this', context: {} } };

  it('renders only concluded checks, labelled as the investigator’s words', () => {
    const block = renderCheckConclusions(plan, [
      'Race is real: reproduced twice.',
      undefined,
      '  ',
    ]);
    const parsed = JSON.parse(block);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      check: 'check_1',
      statement: 'Race is real: reproduced twice.',
    });
    expect(renderCheckConclusions(plan, [])).toBe('');
  });

  it('puts the unverified statements into both fresh-session contexts', () => {
    const block = renderCheckConclusions(plan, ['Race is real.']);
    const compaction = buildInvestigationCompactionContext(
      request,
      plan,
      new Map(),
      '{}',
      1,
      block,
    );
    const recovery = buildRecoveryReportContext(request, '{}', block);
    for (const text of [compaction, recovery]) {
      expect(text).toContain('UNVERIFIED');
      expect(text).toContain('never as evidence');
      expect(text).toContain('Race is real.');
    }
    expect(buildRecoveryReportContext(request, '{}')).not.toContain('UNVERIFIED');
    expect(recovery).not.toContain('stopped at its phase deadline');
    expect(recovery).toContain('may be reported as passed');
  });
});
