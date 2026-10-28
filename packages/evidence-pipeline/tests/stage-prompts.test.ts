import { describe, it, expect } from 'vitest';
import {
  buildQaPlanningPrompt,
  buildQaInvestigationPrompt,
  buildQaReportPrompt,
  QA_SESSION_CONTRACT,
} from '../src/stage-prompts.js';
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
    expect(text.length).toBeLessThan(2200);
  });
  it('keeps reporting tool-free and puts unavailable environment checks in limitations', () => {
    const text = buildQaReportPrompt(plan, new Map());
    expect(text).not.toContain(QA_SESSION_CONTRACT);
    expect(text).toContain('No tools');
    expect(text).toContain('not product findings');
    expect(text).toContain('check_1');
    expect(text).toContain('reproductionSteps');
    expect(text.length).toBeLessThan(6500);
    expect(buildQaReportPrompt(plan, new Map(), ['Invalid strength']).length).toBeLessThan(
      text.length,
    );
  });
});
