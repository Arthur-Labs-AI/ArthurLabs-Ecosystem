import { ipcMain } from 'electron';
import { z } from 'zod';
import type { DesktopApplicationService } from './services/desktop-service.js';

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
  'runs:list': z.object({ projectId: z.string().min(1).max(200) }).strict(),
  'runs:get': z.object({ runId: z.string().min(1).max(100) }).strict(),
  'runs:status': z.object({ runId: z.string().min(1).max(100) }).strict(),
  'runs:start-simulation': z
    .object({
      projectId: z.string().min(1).max(200),
      mode: z.enum(['full', 'targeted']),
      includePaths: z.array(z.string().min(1).max(500)).max(100).optional(),
      scenario: z
        .enum(['success', 'partial', 'all-fail', 'transport-loss', 'timeout', 'protocol-error'])
        .optional(),
      instructions: z.string().min(1).max(5000).optional(),
      agentStackIds: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
    })
    .strict(),
  'runs:cancel': z.object({ runId: z.string().min(1).max(100) }).strict(),
  'runs:merge': z.object({ runId: z.string().min(1).max(100) }).strict(),
  'runs:verify': z.object({ mergeResultId: z.string().min(1).max(100) }).strict(),
  'runs:ingest': z.object({ mergeResultId: z.string().min(1).max(100) }).strict(),
  'runs:export': z
    .object({ runId: z.string().min(1).max(100), format: z.enum(['log', 'json']) })
    .strict(),
  'issues:list': z.object({ projectId: z.string().min(1).max(200) }).strict(),
  'issues:get': z.object({ issueId: z.string().min(1).max(100) }).strict(),
  'issues:history': z.object({ issueId: z.string().min(1).max(100) }).strict(),
  'retests:list': z.object({ issueId: z.string().min(1).max(100) }).strict(),
  'retests:start': z
    .object({
      issueId: z.string().min(1).max(100),
      revisionId: z.string().min(1).max(100).optional(),
    })
    .strict(),
  'retests:get': z.object({ retestRunId: z.string().min(1).max(100) }).strict(),
  'retests:cancel': z.object({ retestRunId: z.string().min(1).max(100) }).strict(),
  'doctors:environment': z.object({}).strict(),
  'providers:status': z.object({}).strict(),
  'providers:set': z
    .object({ name: z.string().min(1).max(200), value: z.string().min(1).max(5000) })
    .strict(),
  'providers:clear': z.object({ name: z.string().min(1).max(200) }).strict(),
  'providers:persist': z.object({}).strict(),
  'providers:forget-file': z.object({}).strict(),
  'system:info': z.object({}).strict(),
  'system:active-runs': z.object({}).strict(),
};

export interface DesktopIpcHooks {
  readonly onRunCreated?: (runId: string, operationId?: string) => void;
  readonly onRetestCreated?: (retestRunId: string, operationId?: string) => void;
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
        case 'runs:list':
          return service.listRuns(parsed['projectId'] as string);
        case 'runs:get':
          return service.runSnapshot(parsed['runId'] as string);
        case 'runs:status':
          return service.runStatus(parsed['runId'] as string);
        case 'runs:start-simulation': {
          const operation = await service.startSimulation(parsed['projectId'] as string, {
            mode: parsed['mode'],
            includePaths: parsed['includePaths'],
            scenario: parsed['scenario'],
            instructions: parsed['instructions'],
            agentStackIds: parsed['agentStackIds'],
          });
          if (operation.runId !== undefined)
            hooks.onRunCreated?.(operation.runId, operation.operationId);
          return operation;
        }
        case 'runs:cancel':
          return service.requestRunCancellation(parsed['runId'] as string);
        case 'runs:merge':
          return service.mergeRun(parsed['runId'] as string);
        case 'runs:verify':
          return service.verifyMerge(parsed['mergeResultId'] as string);
        case 'runs:ingest':
          return service.ingestIssues(parsed['mergeResultId'] as string);
        case 'runs:export':
          return service.exportRun(parsed['runId'] as string, parsed['format'] as 'log' | 'json');
        case 'issues:list':
          return service.listIssues(parsed['projectId'] as string);
        case 'issues:get':
          return service.getIssue(parsed['issueId'] as string);
        case 'issues:history':
          return service.issueHistory(parsed['issueId'] as string);
        case 'retests:list':
          return service.listRetests(parsed['issueId'] as string);
        case 'retests:start': {
          const operation = await service.startRetest(
            parsed['issueId'] as string,
            parsed['revisionId'] === undefined
              ? undefined
              : { revisionId: parsed['revisionId'] as string },
          );
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
        case 'providers:set':
          return service.providerSetKey(parsed['name'] as string, parsed['value'] as string);
        case 'providers:clear':
          return service.providerClearKey(parsed['name'] as string);
        case 'providers:persist':
          return service.providerPersist();
        case 'providers:forget-file':
          return service.providerForgetFile();
        case 'system:info':
          return service.systemInfo();
        case 'system:active-runs':
          return service.activeRuns();
        default:
          throw Object.assign(new Error('Unknown IPC channel: ' + channel), {
            code: 'IPC_UNKNOWN_CHANNEL',
          });
      }
    });
  }
}
