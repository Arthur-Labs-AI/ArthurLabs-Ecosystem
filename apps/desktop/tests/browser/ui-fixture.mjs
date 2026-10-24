/* global window, structuredClone, URLSearchParams */
// Synthetic bridge for renderer-only browser checks. No Electron profile,
// runtime, provider credentials, or real project data is used.
export function installUiFixture() {
  const stacks = ['stack_opencode_main', 'stack_deepseek_main', 'stack_glm_main'];
  const startedAt = new Date(Date.now() - 93000).toISOString();
  const run = {
    id: 'ui-run',
    projectId: 'ui-project',
    mode: 'full',
    status: 'agents_running',
    snapshotId: 'ui-snapshot',
    projectRevisionId: 'ui-revision',
    executionKind: 'production',
    createdAt: startedAt,
    startedAt,
    configuration: { agentStackIds: stacks },
  };
  const snapshot = {
    run,
    agentRuns: stacks.map((agentStackId, index) => ({
      id: 'ui-agent-' + index,
      qaRunId: run.id,
      agentStackId,
      status: ['running', 'planning', 'completed'][index],
      startedAt,
      runtimeIdentity: { modelId: ['anthropic/claude-opus-4-6', 'deepseek-chat', 'glm-5'][index] },
      usage: { durationMs: 93000 },
    })),
    findings: [
      {
        id: 'ui-finding',
        agentRunId: 'ui-agent-0',
        title: 'Session refresh lacks expiry validation',
        severity: 'high',
        category: 'security',
      },
    ],
    evidence: [
      {
        id: 'ui-evidence',
        agentRunId: 'ui-agent-0',
        type: 'test',
        title: 'Session expiry regression',
      },
    ],
    events: [
      {
        type: 'tool_started',
        agentRunId: 'ui-agent-0',
        timestamp: startedAt,
        tool: { name: 'read_file', inputSummary: 'src/auth/session.ts' },
      },
    ],
    activities: [
      {
        id: 'ui-activity',
        agentRunId: 'ui-agent-0',
        kind: 'tool',
        status: 'running',
        title: 'Inspecting session boundary',
        startedAt,
      },
    ],
    mergeResults: [],
    verificationRuns: [],
    issues: [],
  };
  const projects = [
    {
      projectId: 'ui-project',
      name: 'Sentry workspace',
      state: 'ready',
      sourcePath: '/fixture/sentry',
      runCount: 12,
      currentRevisionId: 'ui-revision',
    },
  ];
  const issue = {
    id: 'ui-issue',
    title: 'Session refresh lacks expiry validation',
    severity: 'high',
    category: 'security',
    currentState: 'open',
  };
  const listeners = new Set();
  const state = new URLSearchParams(window.location.search).get('state');
  const noop = async () => undefined;
  window.__ui = {
    snapshot,
    setStatus(index, status) {
      snapshot.agentRuns[index].status = status;
      for (const listener of listeners)
        listener({ kind: 'run-snapshot', runId: run.id, snapshot: structuredClone(snapshot) });
    },
    empty: state === 'empty',
    offline: state === 'offline',
  };
  const hello = {
    protocolVersion: 1,
    runtimeVersion: '1.0.2',
    platform: 'linux',
    isWsl: true,
    nodeVersion: 'v22.16.0',
    distro: 'Ubuntu',
    dataRoot: '/fixture/sentry',
  };
  window.sentry = {
    projects: {
      list: async () =>
        state === 'loading' ? new Promise(() => {}) : window.__ui.empty ? [] : projects,
      get: async () => ({
        project: { ...projects[0], id: 'ui-project', sourcePath: '/fixture/sentry' },
        revision: { id: 'ui-revision' },
        managedCopy: { state: 'ready' },
      }),
      revisions: async () => [],
      doctor: async () => ({ ready: true, managedCopyState: 'ready' }),
      suggestTargets: async () => [],
    },
    runs: {
      list: async () => [
        { ...run, agentSummary: { completed: 1, configured: 3 }, findingCount: 1 },
      ],
      get: async () => structuredClone(snapshot),
      exportSave: async () => ({ status: 'cancelled' }),
    },
    issues: {
      list: async () => [issue],
      get: async () => issue,
      history: async () => ({
        currentState: 'open',
        events: [],
        occurrences: [],
        retests: [],
        assessments: [],
      }),
    },
    retests: {
      get: async () => ({
        retestRun: {
          id: 'ui-retest',
          status: 'agents_running',
          targetQaRunId: run.id,
          sourceProjectRevisionId: 'revision-a',
          targetProjectRevisionId: 'revision-b',
        },
        targetRun: structuredClone(snapshot),
        assessments: [],
      }),
    },
    runtime: {
      status: async () => ({
        connected: !window.__ui.offline,
        distro: 'Ubuntu',
        hostPlatform: 'win32',
        executionMode: 'wsl',
        hello,
      }),
      distros: async () => ({
        distros: [{ name: 'Ubuntu', state: 'Running', version: 2 }],
        preferred: 'Ubuntu',
        selected: 'Ubuntu',
        hostPlatform: 'win32',
        executionMode: 'wsl',
      }),
    },
    system: {
      activeRuns: async () =>
        window.__ui.empty
          ? []
          : [{ runId: run.id, projectId: run.projectId, status: run.status, mode: run.mode }],
      info: async () => ({ dataRoot: '/fixture/sentry', versions: { sentry: '1.0.2' } }),
    },
    doctors: {
      environment: async () => ({
        runtime: hello,
        agentStacks: stacks.map((id, index) => ({
          id,
          displayName: ['OpenCode', 'DeepSeek', 'GLM'][index],
          modelId: snapshot.agentRuns[index].runtimeIdentity.modelId,
          configured: true,
          binaryAvailable: true,
          runtimeVerified: true,
          readiness: 'ready',
        })),
      }),
    },
    providers: { status: async () => [], detectBinaries: async () => ({}) },
    production: { readiness: async () => ({ ready: true, agentStacks: [] }) },
    cli: { status: async () => ({ started: true, connectedClients: [] }) },
    subscribe: {
      onRunUpdate: (callback) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      onRuntimeStatus: () => noop,
    },
  };
}
