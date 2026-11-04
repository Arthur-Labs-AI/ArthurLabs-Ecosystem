import type { AgentNodeView, AgentRunLike } from '../src/renderer/lib/types.js';

let counter = 0;

function padId(prefix: string, width: number): string {
  counter += 1;
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let suffix = '';
  let n = counter;
  for (let i = 0; i < width; i += 1) {
    suffix = alphabet[n % alphabet.length] + suffix;
    n = Math.floor(n / alphabet.length);
  }
  return prefix + suffix;
}

export function makeAgentRun(overrides: Partial<AgentRunLike> = {}): AgentRunLike {
  return {
    id: padId('arun_', 26),
    qaRunId: padId('run_', 26),
    agentStackId: 'stack_muse_main',
    status: 'running',
    startedAt: '2026-09-18T22:14:08.000Z',
    runtimeIdentity: { modelId: 'muse-spark-1.3-contributor' },
    usage: { inputTokens: 43120, outputTokens: 12904, cachedInputTokens: 8010, turns: 3 },
    ...overrides,
  };
}

export function makeAgentNodeView(overrides: Partial<AgentNodeView> = {}): AgentNodeView {
  const agentRun = makeAgentRun();
  return {
    agentRunId: agentRun.id,
    agentStackId: agentRun.agentStackId,
    displayName: 'Muse',
    model: 'muse-spark-1.3-contributor',
    status: 'running',
    elapsedMs: 102000,
    stages: [
      { id: 'preparation', label: 'Preparation', state: 'completed' },
      { id: 'planning', label: 'Planning', state: 'completed' },
      { id: 'investigation', label: 'Investigation', state: 'active' },
      { id: 'runtime', label: 'Runtime Validation', state: 'not_started' },
      { id: 'evidence', label: 'Evidence', state: 'not_started' },
      { id: 'reporting', label: 'Reporting', state: 'not_started' },
      { id: 'completed', label: 'Completed', state: 'not_started' },
    ],
    currentStage: 'investigation',
    telemetry: { operations: 6, filesInspected: 2, commands: 1, tests: 1 },
    currentOperation: {
      kind: 'file',
      title: 'Read src/auth/session.ts',
      timestamp: '2026-09-18T22:14:19.000Z',
    },
    recentActivity: [
      { kind: 'file', title: 'Read src/auth/session.ts', timestamp: '2026-09-18T22:14:19.000Z' },
      {
        kind: 'command',
        title: 'Tool started: shell',
        detail: 'npm test',
        timestamp: '2026-09-18T22:14:42.000Z',
      },
    ],
    findingsCount: 1,
    evidenceCount: 4,
    turns: 3,
    inputTokens: 43120,
    outputTokens: 12904,
    cachedInputTokens: 8010,
    totalTokens: 56024,
    severityCounts: { high: 1 },
    ...overrides,
  };
}

export function resetFixtureCounter(): void {
  counter = 0;
}
