import { ipcMain, shell } from 'electron';
import { z } from 'zod';
import type { DesktopApplicationService } from './services/desktop-service.js';
import {
  revealSavedExport,
  saveExportRun,
  type SaveDialogOptions,
} from './services/export-save.js';

function ok(result: unknown): { ok: true; result: unknown } {
  return { ok: true, result };
}

function fail(error: unknown): { ok: false; error: { code: string; message: string } } {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const typed = error as { code?: unknown; message?: unknown };
    return {
      ok: false,
      error: {
        code: typeof typed.code === 'string' ? typed.code : 'DESKTOP_ERROR',
        message:
          typed.message instanceof Error
            ? typed.message.message
            : String(typed.message ?? 'Desktop operation failed').slice(0, 1000),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'DESKTOP_ERROR',
      message: error instanceof Error ? error.message.slice(0, 1000) : 'Desktop operation failed',
    },
  };
}

function handle(channel: string, listener: (payload: unknown) => Promise<unknown> | unknown): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      return ok(await listener(payload));
    } catch (error) {
      return fail(error);
    }
  });
}

const PayloadSchemas: Record<string, z.ZodTypeAny> = {
  'projects:list': z.object({}).strict(),
  'projects:add': z.object({ sourcePath: z.string().min(1).max(2000) }).strict(),
  'projects:get': z.object({ projectId: z.string().min(1).max(200) }).strict(),
  'projects:revisions': z.object({ projectId: z.string().min(1).max(200) }).strict(),
  'projects:update': z
    .object({
      projectId: z.string().min(1).max(200),
      sourcePath: z.string().min(1).max(2000).optional(),
    })
    .strict(),
  'projects:doctor': z.object({ projectId: z.string().min(1).max(200) }).strict(),
  'projects:suggest-targets': z.object({ projectId: z.string().min(1).max(200) }).strict(),
  'runs:list': z.object({ projectId: z.string().min(1).max(200) }).strict(),
  'runs:get': z.object({ runId: z.string().min(1).max(100) }).strict(),
  'runs:status': z.object({ runId: z.string().min(1).max(100) }).strict(),
  'runs:start': z
    .object({
      projectId: z.string().min(1).max(200),
      mode: z.enum(['full', 'targeted']),
      includePaths: z.array(z.string().min(1).max(500)).max(100).optional(),
      instructions: z.string().min(1).max(5000).optional(),
      agentStackIds: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
    })
    .strict(),
  'runs:start-production': z
    .object({
      projectId: z.string().min(1).max(200),
      mode: z.enum(['full', 'targeted']),
      includePaths: z.array(z.string().min(1).max(500)).max(100).optional(),
      instructions: z.string().min(1).max(5000).optional(),
      agentStackIds: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
    })
    .strict(),
  'runs:cancel': z.object({ runId: z.string().min(1).max(100) }).strict(),
  'runs:export': z
    .object({ runId: z.string().min(1).max(100), format: z.enum(['log', 'json']) })
    .strict(),
  // Renderer controls runId + format ONLY. The save destination always
  // originates from the main-process native dialog (see requestSavePath).
  'runs:export-save': z
    .object({ runId: z.string().min(1).max(100), format: z.enum(['log', 'json']) })
    .strict(),
  // Show in folder: the path must be a destination this session saved
  // via Export (guarded in export-save.ts) — never an arbitrary path.
  'runs:export-reveal': z.object({ path: z.string().min(1).max(2000) }).strict(),
  'issues:list': z.object({ projectId: z.string().min(1).max(200) }).strict(),
  'issues:get': z.object({ issueId: z.string().min(1).max(100) }).strict(),
  'issues:history': z.object({ issueId: z.string().min(1).max(100) }).strict(),
  'retests:list': z.object({ issueId: z.string().min(1).max(100) }).strict(),
  'retests:start': z
    .object({
      issueId: z.string().min(1).max(100),
      revisionId: z.string().min(1).max(100).optional(),
      agentStackIds: z.array(z.string().min(1).max(200)).max(10).optional(),
    })
    .strict(),
  'retests:get': z.object({ retestRunId: z.string().min(1).max(100) }).strict(),
  'retests:cancel': z.object({ retestRunId: z.string().min(1).max(100) }).strict(),
  'doctors:environment': z.object({}).strict(),
  'providers:status': z.object({}).strict(),
  'providers:save': z
    .object({ name: z.string().min(1).max(200), value: z.string().min(1).max(5000) })
    .strict(),
  'providers:clear': z.object({ name: z.string().min(1).max(200) }).strict(),
  'providers:persist': z.object({}).strict(),
  'providers:forget-file': z.object({}).strict(),
  'providers:forget-all': z.object({}).strict(),
  'providers:detect-binaries': z.object({}).strict(),
  'production:readiness': z
    .object({ agentStackIds: z.array(z.string().min(1).max(200)).max(10).optional() })
    .strict(),
  'system:info': z.object({}).strict(),
  'system:active-runs': z.object({}).strict(),
  'runtime:status': z.object({}).strict(),
  'runtime:distros': z.object({}).strict(),
  'runtime:select-distro': z.object({ distro: z.string().min(1).max(200) }).strict(),
};

export interface DesktopIpcHooks {
  readonly onRunCreated?: (runId: string, operationId?: string) => void;
  readonly onRetestCreated?: (retestRunId: string, operationId?: string) => void;
  /** Native Save As dialog owned by the main process. Null = cancelled. */
  readonly requestSavePath?: (options: SaveDialogOptions) => Promise<string | null>;
}

export function registerDesktopIpc(
  service: DesktopApplicationService,
  hooks: DesktopIpcHooks = {},
): void {
  for (const [channel, schema] of Object.entries(PayloadSchemas)) {
    handle(channel, async (payload: unknown) => {
      const parsed = schema.parse(payload ?? {}) as Record<string, unknown>;
      switch (channel) {
        case 'projects:list':
          return service.listProjects();
        case 'projects:add':
          return service.addProject(parsed['sourcePath'] as string);
        case 'projects:get':
          return service.getProject(parsed['projectId'] as string);
        case 'projects:revisions':
          return service.listRevisions(parsed['projectId'] as string);
        case 'projects:update':
          return service.updateProject(
            parsed['projectId'] as string,
            parsed['sourcePath'] as string | undefined,
          );
        case 'projects:doctor':
          return service.projectDoctor(parsed['projectId'] as string);
        case 'projects:suggest-targets':
          return service.suggestTargets(parsed['projectId'] as string);
        case 'runs:list':
          return service.listRuns(parsed['projectId'] as string);
        case 'runs:get':
          return service.runSnapshot(parsed['runId'] as string);
        case 'runs:status':
          return service.runStatus(parsed['runId'] as string);
        case 'runs:start':
        case 'runs:start-production': {
          const gate = await service.preRunGate(
            parsed['agentStackIds'] === undefined
              ? undefined
              : (parsed['agentStackIds'] as string[]),
          );
          if (!gate.ready) {
            const blocking = gate.stacks
              .filter((s) => !s.ready)
              .map((s) => s.id + ': ' + s.reasons.join('; '))
              .join(' | ');
            throw Object.assign(new Error('Cannot start QA — provider not ready: ' + blocking), {
              code: 'PROVIDER_NOT_READY',
            });
          }
          const operation = await service.startRun(parsed['projectId'] as string, {
            mode: parsed['mode'],
            includePaths: parsed['includePaths'],
            instructions: parsed['instructions'],
            agentStackIds: parsed['agentStackIds'],
          });
          if (operation.runId !== undefined)
            hooks.onRunCreated?.(operation.runId, operation.operationId);
          return operation;
        }
        case 'runs:cancel':
          return service.requestRunCancellation(parsed['runId'] as string);
        case 'runs:export':
          return service.exportRun(parsed['runId'] as string, parsed['format'] as 'log' | 'json');
        case 'runs:export-save': {
          const requestSavePath = hooks.requestSavePath;
          if (requestSavePath === undefined) {
            throw Object.assign(new Error('Save dialog unavailable'), {
              code: 'DIALOG_UNAVAILABLE',
            });
          }
          return saveExportRun(parsed['runId'] as string, parsed['format'] as 'log' | 'json', {
            requestSavePath,
            fetchContent: (runId, format) => service.exportContent(runId, format),
          });
        }
        case 'runs:export-reveal': {
          return revealSavedExport(parsed['path'] as string, {
            showInFolder: (path) => shell.showItemInFolder(path),
          });
        }
        case 'issues:list':
          return service.listIssues(parsed['projectId'] as string);
        case 'issues:get':
          return service.getIssue(parsed['issueId'] as string);
        case 'issues:history':
          return service.issueHistory(parsed['issueId'] as string);
        case 'retests:list':
          return service.listRetests(parsed['issueId'] as string);
        case 'retests:start': {
          const operation = await service.startRetest(parsed['issueId'] as string, {
            ...(parsed['revisionId'] === undefined
              ? {}
              : { revisionId: parsed['revisionId'] as string }),
            ...(parsed['agentStackIds'] === undefined
              ? {}
              : { agentStackIds: parsed['agentStackIds'] as string[] }),
          });
          if (operation.retestRunId !== undefined)
            hooks.onRetestCreated?.(operation.retestRunId, operation.operationId);
          return operation;
        }
        case 'retests:get':
          return service.retestSnapshot(parsed['retestRunId'] as string);
        case 'retests:cancel':
          return service.cancelRetest(parsed['retestRunId'] as string);
        case 'doctors:environment':
          return service.environmentDoctors();
        case 'providers:status':
          return service.providerStatuses();
        case 'providers:save':
          return service.providerSaveKey(parsed['name'] as string, parsed['value'] as string);
        case 'providers:clear':
          return service.providerClearKey(parsed['name'] as string);
        case 'providers:persist':
          return service.providerPersist();
        case 'providers:forget-file':
          return service.providerForgetFile();
        case 'providers:forget-all':
          return service.providerForgetAll();
        case 'providers:detect-binaries':
          return service.detectHarnessBinaries();
        case 'production:readiness':
          return service.productionReadiness(
            parsed['agentStackIds'] === undefined
              ? undefined
              : { agentStackIds: parsed['agentStackIds'] as string[] },
          );
        case 'system:info':
          return service.systemInfo();
        case 'system:active-runs':
          return service.activeRuns();
        case 'runtime:status':
          return service.runtimeStatus();
        case 'runtime:distros':
          return service.runtimeDistros();
        case 'runtime:select-distro':
          return service.runtimeSelectDistro(parsed['distro'] as string);
        default:
          throw Object.assign(new Error('Unknown IPC channel: ' + channel), {
            code: 'IPC_UNKNOWN_CHANNEL',
          });
      }
    });
  }
}
