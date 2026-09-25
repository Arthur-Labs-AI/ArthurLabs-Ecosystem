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
  'runs:start',
  'runs:start-production',
  'runs:cancel',
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
  'providers:save',
  'providers:session',
  'providers:clear',
  'providers:persist',
  'providers:forget-file',
  'providers:forget-all',
  'providers:detect-binaries',
  'production:readiness',
  'system:info',
  'system:active-runs',
  'runtime:status',
  'runtime:distros',
  'runtime:select-distro',
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

export interface DesktopOperation {
  readonly operationId: string;
  readonly runId?: string | undefined;
  readonly retestRunId?: string | undefined;
}

export interface DesktopRunSnapshot {
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

export type RunSnapshot = DesktopRunSnapshot;

export interface DesktopRetestSnapshot {
  readonly retestRun: unknown;
  readonly spec?: unknown;
  readonly targetRun?: DesktopRunSnapshot | undefined;
  readonly assessments: unknown[];
}

export type RetestSnapshot = DesktopRetestSnapshot;

export type RunUpdateKind =
  'run-created' | 'run-snapshot' | 'retest-created' | 'retest-snapshot' | 'active-runs';

export interface ActiveRunsPayload {
  readonly activeRuns: Array<{ runId: string; projectId: string; status: string }>;
}

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
    /**
     * Start a production QA run (the only execution mode). Consumes provider
     * budget. Requires configured credentials; backend stays authoritative
     * and surfaces structured errors.
     */
    start(
      projectId: string,
      options: {
        mode: 'full' | 'targeted';
        includePaths?: string[];
        instructions?: string;
        agentStackIds?: string[];
      },
    ): Promise<DesktopOperation>;
    /** Back-compat alias for start. */
    startProduction(
      projectId: string,
      options: {
        mode: 'full' | 'targeted';
        includePaths?: string[];
        instructions?: string;
        agentStackIds?: string[];
      },
    ): Promise<DesktopOperation>;
    cancel(runId: string): Promise<unknown>;
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
      options?: { revisionId?: string | undefined; agentStackIds?: string[] },
    ): Promise<DesktopOperation>;
    get(retestRunId: string): Promise<RetestSnapshot>;
    cancel(retestRunId: string): Promise<unknown>;
  };
  readonly doctors: {
    environment(): Promise<unknown>;
  };
  readonly providers: {
    status(): Promise<
      Array<{
        name: string;
        configured: boolean;
        persistence: string;
        source: string;
        hint: string;
      }>
    >;
    /** Secure default: encrypt + persist + load into runtime. */
    save(name: string, value: string): Promise<unknown>;
    /** Explicit session-only (no persistence). */
    session(name: string, value: string): Promise<unknown>;
    /** Back-compat session set. */
    setKey(name: string, value: string): Promise<unknown>;
    clearKey(name: string): Promise<unknown>;
    persist(): Promise<{ path: string; keys: number }>;
    forgetFile(): Promise<{ forgotten: boolean }>;
    forgetAll(): Promise<{ forgotten: boolean }>;
    detectBinaries(): Promise<{
      deepseek: { detected: string | null; configured: string | null; effective: string };
    }>;
  };
  readonly production: {
    readiness(input?: {
      agentStackIds?: string[];
    }): Promise<{ ready: boolean; reasons: string[]; productionWired: boolean }>;
  };
  readonly runtime: {
    status(): Promise<{
      connected: boolean;
      distro: string | undefined;
      hello:
        | {
            protocolVersion: number;
            runtimeVersion: string;
            platform: string;
            isWsl: boolean;
            nodeVersion: string;
            processExecPath: string;
            distro?: string;
            dataRoot: string;
          }
        | undefined;
      lastError: string | undefined;
    }>;
    distros(): Promise<{
      distros: Array<{ name: string; state: string; version: number }>;
      preferred: string | null;
      selected: string | null;
    }>;
    selectDistro(distro: string): Promise<{ saved: string; restartRequired: boolean }>;
  };
  readonly system: {
    info(): Promise<{ dataRoot: string; versions: Record<string, string> }>;
    activeRuns(): Promise<Array<{ runId: string; projectId: string; status: string }>>;
  };
  readonly subscribe: {
    onRunUpdate(callback: RunUpdateCallback): () => void;
  };
}
