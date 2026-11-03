import { describe, it, expect } from 'vitest';
import {
  buildQaCheckInvestigationPrompt,
  buildQaPlanningPrompt,
  buildQaInvestigationPrompt,
  buildQaReportPrompt,
  QA_SESSION_CONTRACT,
} from '../src/stage-prompts.js';
import { composeProfileText, profileContextEntry } from '../src/profile.js';
const request = {
  task: {
    prompt: 'Owner intent',
    context: {
      project: { name: 'Fixture' },
      workspacePreparation: { status: 'limited', reason: 'No cache' },
    },
  },
};
const plan = {
  schemaVersion: 1 as const,
  projectUnderstanding: 'Fixture',
  criticalFlows: [],
  weakPoints: [],
  plannedChecks: ['Boundary'],
};
describe('ordered compact QA stages', () => {
  it('sends safety and mission once, with a strict read-only planning task', () => {
    const text = buildQaPlanningPrompt(request);
    expect(text).toContain(QA_SESSION_CONTRACT);
    expect(text).toContain('UNTRUSTED');
    expect(text).toContain('No tests, builds, lint, typecheck');
    expect(text).toContain('future actions');
    expect(text).toContain('Owner intent');
    expect(text).toContain('No cache');
    expect(text).toContain('at most 8 checks');
    expect(text).toContain('one decidable question');
    expect(text).not.toContain('optional review');
    expect(text.length).toBeLessThan(2800);
  });
  it('does not repeat mission or safety, includes prior outcomes and prevents duplicate work', () => {
    const ops = new Map([
      [
        'op_1',
        {
          operationKey: 'op_1',
          operationId: 'op_1' as never,
          toolName: 'bash',
          commandText: 'pnpm test',
          exitCode: 0,
          isTestOperation: true,
        },
      ],
    ]);
    const text = buildQaInvestigationPrompt(plan, ops);
    expect(text).not.toContain(QA_SESSION_CONTRACT);
    expect(text).not.toContain('Owner intent');
    expect(text).toContain('Do not repeat completed checks');
    expect(text).toContain('pnpm test');
    expect(text).toContain('counterexample');
    // Completion is defined by the frozen checklist, not by the clock:
    // an agent that stops early with unexplored checks (OpenCode in
    // run_01M61FYQ) is not done.
    expect(text).toContain('every planned check has been executed to a conclusion');
    expect(text).toContain('never end while a planned check is merely unexplored');
    expect(text.length).toBeLessThan(2400);
  });
  it('scopes one investigation turn to exactly one frozen check', () => {
    const multi = { ...plan, plannedChecks: ['Boundary', 'Isolation', 'Exports'] };
    const text = buildQaCheckInvestigationPrompt(multi, 1, new Map());
    expect(text).toContain('INVESTIGATE CHECK check_2 (2 of 3)');
    expect(text).toContain('Work ONLY on this check: "Isolation"');
    expect(text).toContain('Other checks get their own turns');
    expect(text).toContain('When this check is decided or concretely blocked, stop');
    expect(text).not.toContain(QA_SESSION_CONTRACT);
    // Hostile-input matrix: the edge categories where real bugs were found.
    expect(text).toContain('hostile inputs');
    expect(text).toContain('backslashes');
    expect(text).toContain('symlinks');
    expect(text).toContain('legacy');
    expect(text).toContain('lifecycle transitions');
    expect(text).toContain('encoded');
    expect(text).toContain('Breaks attempted');
    // Proof commands must be certifiable: single, non-compound, own exit.
    expect(text).toContain('single non-compound commands');
    expect(text).toContain('cannot certify it');
    // Failing runs are triaged, never edited green.
    expect(text).toContain('A failing run is signal');
    // Probes live inside the workspace: the write tool and the shell see different /tmp.
    expect(text).toContain('.qa-tmp/probe.mjs');
    expect(text).toContain('never `/tmp`');
    expect(text).toContain('PRODUCT defect');
    expect(text).toContain('Never loosen');
    // A missing tool is confirmed once, bootstrapped once, then replicated or traced.
    expect(text).toContain('Missing tools: work down this order');
    expect(text).toContain('ONCE');
  });

  it('calibrates report severity so harness-script defects are never critical', () => {
    const text = buildQaReportPrompt(plan, new Map());
    expect(text).toContain('Severity rubric');
    expect(text).toContain('never critical');
  });

  it('keeps reporting tool-free and puts unavailable environment checks in limitations', () => {
    const text = buildQaReportPrompt(plan, new Map());
    expect(text).not.toContain(QA_SESSION_CONTRACT);
    expect(text).toContain('No tools');
    expect(text).toContain('not product findings');
    expect(text).toContain('check_1');
    expect(text).toContain('breaks attempted');
    expect(text).toContain('reproductionSteps');
    expect(text.length).toBeLessThan(6500);
    expect(buildQaReportPrompt(plan, new Map(), ['Invalid strength']).length).toBeLessThan(
      text.length,
    );
  });
});

describe('plan size follows the time budget', () => {
  it('derives the check count from the investigation window', async () => {
    const { maxPlannedChecks, reportableDepthPlan } = await import('../src/index.js');
    const at = (minutes: number) => ({
      qaDepth: { version: 1, deadlineAt: 1_000_000_000 + minutes * 60_000 },
    });
    // 3h run: 168 minutes of investigation / 25 -> 6 checks
    expect(maxPlannedChecks(at(180), 1_000_000_000)).toBe(6);
    expect(maxPlannedChecks(at(60), 1_000_000_000)).toBe(2);
    expect(maxPlannedChecks(at(600), 1_000_000_000)).toBe(8);
    expect(maxPlannedChecks(undefined)).toBe(8);
    expect(maxPlannedChecks({}, 0)).toBe(8);
    const plan = { plannedChecks: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] };
    expect(reportableDepthPlan(plan, true, 5).plannedChecks).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(reportableDepthPlan(plan, true).plannedChecks).toHaveLength(8);
    expect(reportableDepthPlan(plan, false, 5).plannedChecks).toHaveLength(8);
  });

  it('tells the planner the budget-derived ceiling', async () => {
    const { buildQaPlanningPrompt } = await import('../src/index.js');
    const text = buildQaPlanningPrompt({
      task: {
        prompt: 'QA',
        context: { qaDepth: { version: 1, deadlineAt: Date.now() + 180 * 60_000 } },
      },
    });
    expect(text).toContain('at most 6 checks');
  });
});

describe('falsification planning and leads', () => {
  it('asks the planner to falsify properties and cover data-handling code', async () => {
    const { buildQaPlanningPrompt: planning } = await import('../src/index.js');
    const text = planning({ task: { prompt: 'QA', context: {} } });
    expect(text).toContain('FALSIFY');
    expect(text).toContain('transforms or persists data');
    expect(text.length).toBeLessThan(3400);
  });

  it('asks every check turn for a Leads line and follows a lead in its own turn', async () => {
    const { buildLeadPrompt } = await import('../src/index.js');
    const multi = { ...plan, plannedChecks: ['Boundary', 'Isolation'] };
    expect(buildQaCheckInvestigationPrompt(multi, 0, new Map())).toContain('"Leads:"');
    const lead = buildLeadPrompt(multi, 1, 'import fails on symlinks');
    expect(lead).toContain('LEAD FOLLOW-UP');
    expect(lead).toContain('check_2');
    expect(lead).toContain('import fails on symlinks');
    expect(lead).toContain('UNVERIFIED');
  });

  it('tells follow-up turns to probe every input class and not to argue a violation away', async () => {
    const { buildLeadPrompt, buildDeepeningPrompt, buildHazardPrompt } = await import(
      '../src/index.js'
    );
    const prompts = [
      buildLeadPrompt(plan, 0, 'x'),
      buildDeepeningPrompt(plan, 0, '', []),
      buildHazardPrompt('src/a.ts', ['deletes files or directories']),
      buildQaCheckInvestigationPrompt(plan, 0, new Map()),
    ];
    for (const prompt of prompts) expect(prompt).toContain('Do not argue a reproduced violation');
    for (const prompt of prompts.slice(0, 3)) expect(prompt).toContain('the root or container itself');
    expect(prompts[2]).toContain('src/a.ts');
  });
});

describe('project profile prompts', () => {
  const request = { task: { prompt: 'p', context: { profileOnly: true } } };

  it('turns the planning stage into an orientation-only profile turn', () => {
    const prompt = buildQaPlanningPrompt(request);
    expect(prompt).toContain('PROJECT PROFILE — ORIENTATION ONLY');
    expect(prompt).toContain('Do NOT look for bugs');
    expect(prompt).toContain('no findings, no verdicts');
    expect(prompt).not.toContain('FALSIFY');
    expect(buildQaPlanningPrompt({ task: { prompt: 'p', context: {} } })).toContain('FALSIFY');
  });

  it('composes bounded profile text and labels it unverified', () => {
    const long = composeProfileText({ projectUnderstanding: 'x'.repeat(20000), criticalFlows: ['a'] });
    expect(long.length).toBeLessThanOrEqual(8000);
    expect(composeProfileText({ projectUnderstanding: 'Notes.', criticalFlows: ['src/a.ts'] })).toBe(
      'Notes.\n\nEntry points and flows:\n- src/a.ts',
    );
    expect(profileContextEntry('t').note).toContain('UNVERIFIED');
    expect(profileContextEntry('t').note).toContain('never evidence');
  });
});

describe('missing tools ladder', () => {
  const plan = { plannedChecks: ['Check one'] };

  it('tells the investigator to run, then replicate, then trace, and to tag each', () => {
    const prompt = buildQaCheckInvestigationPrompt(plan, 0, new Map());
    expect(prompt).toContain('(1) RUN IT');
    expect(prompt).toContain('(2) REPLICA');
    expect(prompt).toContain('(3) TRACE');
    expect(prompt).toContain('[executed], [replica] or [traced]');
    expect(prompt).not.toContain('stop hunting for package managers');
  });

  it('keeps replicas and traces from certifying a pass in the report', () => {
    const report = buildQaReportPrompt(plan, new Map());
    expect(report).toContain('[replica] or [traced]');
    expect(report).toContain('cannot make a check passed');
  });
});
