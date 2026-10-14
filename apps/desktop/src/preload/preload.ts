import { contextBridge, ipcRenderer } from 'electron';
import type { RunUpdateCallback, SentryDesktopApi } from '../shared/ipc-contract.js';

interface Envelope {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { code: string; message: string };
}

async function invoke(channel: string, payload: unknown): Promise<never> {
  const response = (await ipcRenderer.invoke(channel, payload)) as Envelope;
  if (response.ok) return response.result as never;
  const error = Object.assign(new Error(response.error?.message ?? 'Desktop operation failed'), {
    code: response.error?.code ?? 'DESKTOP_ERROR',
  });
  throw error;
}

async function pickDirectory(): Promise<string | null> {
  const response = (await ipcRenderer.invoke('sentry:dialog:open-directory')) as Envelope;
  if (response.ok) return (response.result ?? null) as string | null;
  throw Object.assign(new Error('Directory picker failed'), { code: 'DIALOG_FAILED' });
}

const api: SentryDesktopApi & { dialogs: { pickDirectory(): Promise<string | null> } } = {
  projects: {
    list: () => invoke('projects:list', {}),
    add: (sourcePath: string) => invoke('projects:add', { sourcePath }),
    get: (projectId: string) => invoke('projects:get', { projectId }),
    revisions: (projectId: string) => invoke('projects:revisions', { projectId }),
    remove: (projectId: string) => invoke('projects:delete', { projectId }),
    update: (projectId: string, sourcePath?: string) =>
      invoke(
        'projects:update',
        sourcePath === undefined ? { projectId } : { projectId, sourcePath },
      ),
    doctor: (projectId: string) => invoke('projects:doctor', { projectId }),
    suggestTargets: (projectId: string) => invoke('projects:suggest-targets', { projectId }),
  },
  runs: {
    list: (projectId: string) => invoke('runs:list', { projectId }),
    get: (runId: string) => invoke('runs:get', { runId }),
    status: (runId: string) => invoke('runs:status', { runId }),
    start: (projectId: string, options) => invoke('runs:start', { projectId, ...options }),
    startProduction: (projectId: string, options) =>
      invoke('runs:start', { projectId, ...options }),
    cancel: (runId: string) => invoke('runs:cancel', { runId }),
    exportRun: (runId: string, format: 'log' | 'json') => invoke('runs:export', { runId, format }),
    exportSave: (runId: string, format: 'log' | 'json') =>
      invoke('runs:export-save', { runId, format }),
    revealExport: (path: string) => invoke('runs:export-reveal', { path }),
  },
  issues: {
    list: (projectId: string) => invoke('issues:list', { projectId }),
    get: (issueId: string) => invoke('issues:get', { issueId }),
    history: (issueId: string) => invoke('issues:history', { issueId }),
  },
  retests: {
    list: (issueId: string) => invoke('retests:list', { issueId }),
    start: (
      issueId: string,
      options?: { revisionId?: string | undefined; agentStackIds?: string[] },
    ) =>
      invoke('retests:start', {
        issueId,
        ...(options?.revisionId === undefined ? {} : { revisionId: options.revisionId }),
        ...(options?.agentStackIds === undefined ? {} : { agentStackIds: options.agentStackIds }),
      }),
    get: (retestRunId: string) => invoke('retests:get', { retestRunId }),
    cancel: (retestRunId: string) => invoke('retests:cancel', { retestRunId }),
  },
  doctors: {
    environment: () => invoke('doctors:environment', {}),
  },
  providers: {
    status: () => invoke('providers:status', {}),
    save: (name: string, value: string) => invoke('providers:save', { name, value }),
    clearKey: (name: string) => invoke('providers:clear', { name }),
    persist: () => invoke('providers:persist', {}),
    forgetFile: () => invoke('providers:forget-file', {}),
    forgetAll: () => invoke('providers:forget-all', {}),
    detectBinaries: () => invoke('providers:detect-binaries', {}),
  },
  production: {
    readiness: (input?: { agentStackIds?: string[] }) =>
      invoke(
        'production:readiness',
        input?.agentStackIds === undefined ? {} : { agentStackIds: input.agentStackIds },
      ),
  },
  system: {
    info: () => invoke('system:info', {}),
    activeRuns: () => invoke('system:active-runs', {}),
  },
  cli: {
    status: () => invoke('cli:status', {}),
  },
  runtime: {
    status: () => invoke('runtime:status', {}),
    distros: () => invoke('runtime:distros', {}),
    selectDistro: (distro: string) => invoke('runtime:select-distro', { distro }),
  },
  subscribe: {
    onRunUpdate: (callback: RunUpdateCallback) => {
      const isRunUpdate = (value: unknown): value is Parameters<RunUpdateCallback>[0] => {
        if (typeof value !== 'object' || value === null) return false;
        const kind = (value as { kind?: unknown }).kind;
        return (
          kind === 'run-created' ||
          kind === 'run-snapshot' ||
          kind === 'retest-created' ||
          kind === 'retest-snapshot'
        );
      };
      const listener = (_event: unknown, payload: unknown) => {
        if (isRunUpdate(payload)) callback(payload);
      };
      ipcRenderer.on('sentry:run-update', listener as never);
      const activeListener = (_event: unknown, payload: unknown) => {
        if (!Array.isArray(payload)) return;
        const activeRuns = (payload as unknown[]).filter(
          (item): item is { runId: string; projectId: string; status: string } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { runId?: unknown }).runId === 'string',
        );
        callback({ kind: 'active-runs', snapshot: { activeRuns } } as never);
      };
      ipcRenderer.on('sentry:active-runs', activeListener as never);
      return () => {
        ipcRenderer.removeListener('sentry:run-update', listener as never);
        ipcRenderer.removeListener('sentry:active-runs', activeListener as never);
      };
    },
  },
  dialogs: { pickDirectory },
};

contextBridge.exposeInMainWorld('sentry', api);

declare global {
  interface Window {
    readonly sentry: typeof api;
  }
}
