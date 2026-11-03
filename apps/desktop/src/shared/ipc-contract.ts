/**
 * Phase 8 typed desktop bridge contract.
 * Renderer sees window.sentry only. Every channel is named, typed, and
 * validated in main with Zod at the boundary. Subscriptions deliver
 * payloads only — never Electron event objects.
 */

export const IPC_CHANNELS = [
  'projects:list',
  'projects:add',
  'projects:cancel-add',
  'projects:cancel-update',
  'projects:get',
  'projects:revisions',
  'projects:update',
  'projects:delete',
  'projects:doctor',
  'projects:suggest-targets',
  'projects:profile',
  'projects:build-profile',
  'runs:list',
  'runs:get',
  'runs:status',
  'runs:start',
  'runs:start-production',
  'runs:cancel',
  'runs:export',
  'runs:export-save',
  'runs:export-reveal',
  'doctors:environment',
  'providers:status',
  'providers:save',
  'providers:clear',
  'providers:persist',
  'providers:forget-file',
  'providers:forget-all',
  'providers:detect-binaries',
  'production:readiness',
  'system:info',
  'toolchains:status',
  'toolchains:install',
  'toolchains:remove',
  'system:active-runs',
  'runtime:status',
  'runtime:distros',
  'runtime:select-distro',
  'runtime:reclaim-space',
  'cli:status',
  'cli:set-enabled',
  'app:set-language',
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

export interface WslSpaceResult {
  readonly distro: string;
  readonly diskBytesBefore: number;
  readonly diskBytesAfter: number;
  readonly windowsFreeBytesBefore: number;
  readonly windowsFreeBytesAfter: number;
  readonly reconnected: boolean;
}

export interface DesktopOperation {
  readonly operationId: string;
  readonly runId?: string | undefined;
  // Persisted initial status for async starts (e.g. agents_running): lets
  // CLI callers return the created runId without a follow-up status request.
  readonly status?: string | undefined;
}

export interface DesktopRunSnapshot {
  readonly run: unknown;
  readonly agentRuns: unknown[];
  readonly findings: unknown[];
  readonly evidence: unknown[];
  readonly activities: unknown[];
  readonly events: unknown[];
  readonly targetSpec?: unknown;
}

export type RunSnapshot = DesktopRunSnapshot;

export type RunUpdateKind = 'run-created' | 'run-snapshot' | 'active-runs';

export interface ActiveRunsPayload {
  readonly activeRuns: Array<{ runId: string; projectId: string; status: string }>;
}

export interface RunUpdatePayload {
  readonly kind: RunUpdateKind;
  readonly runId?: string | undefined;
  readonly operationId?: string | undefined;
  readonly snapshot?: RunSnapshot | undefined;
}

export type RunUpdateCallback = (payload: RunUpdatePayload) => void;

export interface ProjectProfileAgent {
  readonly agentStackId: string;
  readonly state: 'none' | 'fresh' | 'stale';
  readonly createdAt?: string;
  readonly text?: string;
  readonly building: boolean;
  readonly error?: string;
}

export interface ProjectProfileStatus {
  readonly projectId: string;
  readonly agents: readonly ProjectProfileAgent[];
}

export interface ToolchainVersionStatus {
  readonly version: string;
  readonly installed: boolean;
  readonly installing: boolean;
  readonly sizeMb?: number;
  readonly error?: string;
}

export interface ToolchainPackStatus {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly approxSizeMb: number;
  readonly defaultVersion: string;
  readonly note?: string;
  readonly versions: readonly ToolchainVersionStatus[];
}

export interface SentryDesktopApi {
  readonly projects: {
    list(): Promise<unknown[]>;
    add(sourcePath: string): Promise<unknown>;
    cancelAdd?(): Promise<{ cancelled: boolean; count?: number }>;
    cancelUpdate?(): Promise<{ cancelled: boolean; count?: number }>;
    get(projectId: string): Promise<unknown>;
    revisions(projectId: string): Promise<unknown[]>;
    update(projectId: string, sourcePath?: string): Promise<unknown>;
    /** Permanently remove Sentry's stored materials and history; preserve the original source. */
    remove(projectId: string): Promise<{ projectId: string; deleted: true }>;
    doctor(projectId: string): Promise<unknown>;
    suggestTargets(projectId: string): Promise<{ projectId: string; paths: string[] }>;
    /** Each agent's own orientation notes for the project: none, fresh, or stale after an update. */
    profile(projectId: string): Promise<ProjectProfileStatus>;
    /** Starts the agents writing their notes (all, or the listed stacks); returns at once. */
    buildProfile(
      projectId: string,
      agentStackIds?: string[],
    ): Promise<{ projectId: string; started: string[] }>;
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
        revisionId?: string;
        webAccess?: boolean;
        useProfile?: boolean;
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
        revisionId?: string;
        webAccess?: boolean;
        useProfile?: boolean;
      },
    ): Promise<DesktopOperation>;
    cancel(runId: string): Promise<unknown>;
    exportRun(runId: string, format: 'log' | 'json'): Promise<unknown>;
    /**
     * Native Save As: main shows the dialog, streams the canonical
     * export bytes, and writes the chosen destination atomically.
     * Cancelled dialogs resolve { status: 'cancelled' } — never an error.
     */
    exportSave(
      runId: string,
      format: 'log' | 'json',
    ): Promise<{ status: 'saved'; path: string } | { status: 'cancelled' }>;
    /**
     * Show in folder: reveals a destination this session saved via
     * Export in the OS file manager. Unknown paths are rejected.
     */
    revealExport(path: string): Promise<{ status: 'shown' }>;
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
    /** Encrypt + persist + load into runtime. The only write mode. */
    save(name: string, value: string): Promise<unknown>;
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
    reclaimSpace(): Promise<WslSpaceResult>;
  };
  readonly toolchains: {
    status(): Promise<ToolchainPackStatus[]>;
    install(packId: string, version: string): Promise<{ started: boolean }>;
    remove(packId: string, version: string): Promise<{ removed: true }>;
  };
  readonly system: {
    info(): Promise<{ dataRoot: string; versions: Record<string, string> }>;
    activeRuns(): Promise<Array<{ runId: string; projectId: string; status: string }>>;
  };
  readonly cli: {
    status(): Promise<{
      started: boolean;
      pipePath: string;
      error?: string;
      connectedClients: Array<{ id: string; name: string; version?: string; connectedAt: string }>;
    }>;
    setEnabled?(enabled: boolean): Promise<{
      started: boolean;
      pipePath: string;
      error?: string;
      connectedClients: Array<{ id: string; name: string; version?: string; connectedAt: string }>;
    }>;
  };
  readonly subscribe: {
    onRunUpdate(callback: RunUpdateCallback): () => void;
  };
  readonly app: {
    /**
     * Mirror the renderer-selected interface language to the main-process
     * store so native dialogs and the fatal boot screen can translate.
     * Best-effort: the renderer selection applies regardless of the write.
     */
    setLanguage(language: 'en' | 'bg'): Promise<{ saved: boolean; language: 'en' | 'bg' }>;
  };
}
