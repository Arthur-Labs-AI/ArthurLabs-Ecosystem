/**
 * Phase 8 typed desktop bridge contract.
 * Renderer sees window.sentry only. Every channel is named, typed, and
 * validated in main with Zod at the boundary. Subscriptions deliver
 * payloads only — never Electron event objects.
 */

export const IPC_CHANNELS = [
  'projects:list',
  'projects:add',
  'projects:get',
  'projects:revisions',
  'projects:update',
  'projects:doctor',
  'projects:suggest-targets',
  'runs:list',
  'runs:get',
  'runs:status',
  'runs:start-simulation',
  'runs:cancel',
  'runs:merge',
  'runs:verify',
  'runs:ingest',
  'runs:export',
  'issues:list',
  'issues:get',
  'issues:history',
  'retests:list',
  'retests:start',
  'retests:get',
  'retests:cancel',
  'doctors:environment',
  'providers:status',
  'providers:set',
  'providers:clear',
  'providers:persist',
  'providers:forget-file',
  'system:info',
  'system:active-runs',
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

export interface DesktopOperation {
  readonly operationId: string;
  readonly runId?: string | undefined;
  readonly retestRunId?: string | undefined;
}

export interface RunSnapshot {
  readonly run: unknown;
  readonly agentRuns: unknown[];
  readonly findings: unknown[];
  readonly evidence: unknown[];
  readonly activities: unknown[];
  readonly events: unknown[];
  readonly mergeResults: unknown[];
  readonly verificationRuns: unknown[];
  readonly issues: unknown[];
  readonly targetSpec?: unknown;
}

export interface RetestSnapshot {
  readonly retestRun: unknown;
  readonly spec?: unknown;
  readonly targetRun?: unknown;
  readonly assessments: unknown[];
}

export type RunUpdateKind = 'run-created' | 'run-snapshot' | 'retest-created' | 'retest-snapshot';

export interface RunUpdatePayload {
  readonly kind: RunUpdateKind;
  readonly runId?: string | undefined;
  readonly retestRunId?: string | undefined;
  readonly operationId?: string | undefined;
  readonly snapshot?: RunSnapshot | RetestSnapshot | undefined;
}

export type RunUpdateCallback = (payload: RunUpdatePayload) => void;

export interface SentryDesktopApi {
  readonly projects: {
    list(): Promise<unknown[]>;
    add(sourcePath: string): Promise<unknown>;
    get(projectId: string): Promise<unknown>;
    revisions(projectId: string): Promise<unknown[]>;
    update(projectId: string, sourcePath?: string): Promise<unknown>;
    doctor(projectId: string): Promise<unknown>;
    suggestTargets(projectId: string): Promise<{ projectId: string; paths: string[] }>;
  };
  readonly runs: {
    list(projectId: string): Promise<unknown[]>;
    get(runId: string): Promise<RunSnapshot>;
    status(runId: string): Promise<unknown>;
    startSimulation(
      projectId: string,
      options: {
        mode: 'full' | 'targeted';
        includePaths?: string[];
        scenario?: string;
        instructions?: string;
        agentStackIds?: string[];
      },
    ): Promise<DesktopOperation>;
    cancel(runId: string): Promise<unknown>;
    merge(runId: string): Promise<unknown>;
    verify(mergeResultId: string): Promise<unknown>;
    ingest(mergeResultId: string): Promise<unknown>;
    exportRun(runId: string, format: 'log' | 'json'): Promise<unknown>;
  };
  readonly issues: {
    list(projectId: string): Promise<unknown[]>;
    get(issueId: string): Promise<unknown>;
    history(issueId: string): Promise<unknown>;
  };
  readonly retests: {
    list(issueId: string): Promise<unknown[]>;
    start(
      issueId: string,
      options?: { revisionId?: string | undefined },
    ): Promise<DesktopOperation>;
    get(retestRunId: string): Promise<RetestSnapshot>;
    cancel(retestRunId: string): Promise<unknown>;
  };
  readonly doctors: {
    environment(): Promise<unknown>;
  };
  readonly providers: {
    status(): Promise<Array<{ name: string; configured: boolean; source: string; hint: string }>>;
    setKey(name: string, value: string): Promise<unknown>;
    clearKey(name: string): Promise<unknown>;
    persist(): Promise<{ path: string; keys: number }>;
    forgetFile(): Promise<{ forgotten: boolean }>;
  };
  readonly system: {
    info(): Promise<{ dataRoot: string; versions: Record<string, string> }>;
    activeRuns(): Promise<Array<{ runId: string; projectId: string; status: string }>>;
  };
  readonly subscribe: {
    onRunUpdate(callback: RunUpdateCallback): () => void;
  };
}
