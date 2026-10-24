// Shared desktop command router: single validated dispatch path for Renderer IPC
// and the external CLI broker. One behavior, one backend per command.
import { z } from 'zod';
import { CLI_BROKER_COMMANDS, RUN_TIMEOUT_MS_MAX, RUN_TIMEOUT_MS_MIN } from '@qa/shared';
import type { DesktopApplicationService } from './services/desktop-service.js';
import type { SaveDialogOptions } from './services/export-save.js';
import { revealSavedExport, saveExportRun } from './services/export-save.js';

export const DesktopChannelSchemas: Record<string, z.ZodTypeAny> = {
  'projects:list': z.object({}).strict(),
  'projects:add': z.object({ sourcePath: z.string().min(1).max(2000) }).strict(),
  'projects:cancel-add': z.object({}).strict(),
  'app:set-language': z.object({ language: z.enum(['en', 'bg']) }).strict(),
  'projects:get': z.object({ projectId: z.string().min(1).max(200) }).strict(),
  'projects:revisions': z.object({ projectId: z.string().min(1).max(200) }).strict(),
  'projects:delete': z.object({ projectId: z.string().min(1).max(200) }).strict(),
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
      runTimeoutMs: z.number().int().min(RUN_TIMEOUT_MS_MIN).max(RUN_TIMEOUT_MS_MAX).optional(),
    })
    .strict(),
  'runs:start-production': z
    .object({
      projectId: z.string().min(1).max(200),
      mode: z.enum(['full', 'targeted']),
      includePaths: z.array(z.string().min(1).max(500)).max(100).optional(),
      instructions: z.string().min(1).max(5000).optional(),
      agentStackIds: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
      runTimeoutMs: z.number().int().min(RUN_TIMEOUT_MS_MIN).max(RUN_TIMEOUT_MS_MAX).optional(),
    })
    .strict(),
  'runs:cancel': z.object({ runId: z.string().min(1).max(100) }).strict(),
  'runs:export': z
    .object({ runId: z.string().min(1).max(100), format: z.enum(['log', 'json']) })
    .strict(),
  'runs:export-save': z
    .object({ runId: z.string().min(1).max(100), format: z.enum(['log', 'json']) })
    .strict(),
  'runs:export-reveal': z.object({ path: z.string().min(1).max(2000) }).strict(),
  'runs:export-content': z
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
  'runtime:reclaim-space': z.object({}).strict(),
  'cli:status': z.object({}).strict(),
  'cli:set-enabled': z.object({ enabled: z.boolean() }).strict(),
};
export type DesktopChannel = keyof typeof DesktopChannelSchemas;

// External CLI allowlist: operational commands only. Derived from the
// shared CLI_BROKER_COMMANDS vocabulary so broker and frontend agree by
// construction. Provider-secret mutation and admin/distro selection stay
// renderer-only. Native-dialog flows are meaningless over a pipe; CLI file
// output uses export-content.
export const CLI_ALLOWED_CHANNELS: ReadonlySet<string> = new Set(CLI_BROKER_COMMANDS);

export function isCliAllowed(channel: string): boolean {
  return CLI_ALLOWED_CHANNELS.has(channel);
}

export interface CommandRouterHooks {
  readonly maintenanceActive?: () => boolean;
  readonly reclaimSpace?: () => Promise<unknown>;
  readonly onRunCreated?: (runId: string, operationId?: string) => void;
  readonly onRetestCreated?: (retestRunId: string, operationId?: string) => void;
  readonly requestSavePath?: (options: SaveDialogOptions) => Promise<string | null>;
  readonly cliStatus?: () => unknown;
  readonly cliSetEnabled?: (enabled: boolean) => Promise<unknown>;
  readonly showInFolder?: (path: string) => void;
  readonly redactErrorText?: (text: string) => string;
  /** Persist the renderer-selected interface language for main-process UI. Best-effort. */
  readonly persistAppLanguage?: (language: 'en' | 'bg') => void;
}

export interface SafeErrorOptions {
  readonly redactSecrets?: (text: string) => string;
}

const SAFE_ERROR_CODE = /^[A-Za-z0-9_]{1,100}$/;
const SAFE_ERROR_MESSAGE_CAP = 1000;

function safeErrorCode(code: unknown): string {
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : 'DESKTOP_ERROR';
}
function safeErrorMessage(value: unknown, redactSecrets?: (text: string) => string): string {
  const raw = value instanceof Error ? value.message : value;
  const nested = raw instanceof Error ? raw.message : raw;
  const text = typeof nested === 'string' ? nested : 'Desktop operation failed';
  if (redactSecrets === undefined) return text.slice(0, SAFE_ERROR_MESSAGE_CAP);
  // Fail closed: a throwing or misbehaving scrubber must not let the
  // original (potentially secret-bearing) text reach the response, and
  // mapping itself must never throw. Fall back to a fixed safe message.
  let scrubbed: unknown;
  try {
    scrubbed = redactSecrets(text);
  } catch {
    scrubbed = undefined;
  }
  if (typeof scrubbed !== 'string') return 'Desktop operation failed';
  return scrubbed.slice(0, SAFE_ERROR_MESSAGE_CAP);
}

export function toSafeError(
  error: unknown,
  options: SafeErrorOptions = {},
): { code: string; message: string } {
  let code = 'DESKTOP_ERROR';
  try {
    // Property reads, `in`, and instanceof can all invoke untrusted getters
    // or Proxy traps. Guard the whole mapping, retaining a code only after
    // it has been read and validated successfully.
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const typed = error as { code?: unknown; message?: unknown };
      code = safeErrorCode(typed.code);
      return { code, message: safeErrorMessage(typed.message, options.redactSecrets) };
    }
    return { code, message: safeErrorMessage(error, options.redactSecrets) };
  } catch {
    return { code, message: 'Desktop operation failed' };
  }
}
export function toRouterError(error: unknown): { code: string; message: string } {
  return toSafeError(error);
}
// Validate + dispatch one desktop command. Shared by Renderer IPC and the
// external CLI broker. external:true enforces the CLI allowlist.
export async function dispatchDesktopCommand(
  service: DesktopApplicationService,
  channel: string,
  payload: unknown,
  hooks: CommandRouterHooks = {},
  options: { external?: boolean } = {},
): Promise<unknown> {
  const schema = DesktopChannelSchemas[channel];
  if (schema === undefined) {
    throw Object.assign(new Error('Unknown command: ' + channel.slice(0, 120)), {
      code: 'IPC_UNKNOWN_CHANNEL',
    });
  }
  if (options.external === true && !isCliAllowed(channel)) {
    throw Object.assign(new Error('Command not available to external CLI clients: ' + channel), {
      code: 'CLI_COMMAND_FORBIDDEN',
    });
  }
  const parsed = schema.parse(payload ?? {}) as Record<string, unknown>;
  if (
    hooks.maintenanceActive?.() &&
    channel !== 'runtime:status' &&
    channel !== 'cli:status' &&
    channel !== 'app:set-language'
  ) {
    throw Object.assign(new Error('Windows disk reclamation is running. Wait for it to finish.'), {
      code: 'RUNTIME_MAINTENANCE',
    });
  }
  switch (channel) {
    case 'runtime:reclaim-space':
      if (hooks.reclaimSpace === undefined) {
        throw Object.assign(new Error('Windows disk reclamation is unavailable.'), {
          code: 'HOST_UNSUPPORTED',
        });
      }
      return hooks.reclaimSpace();
    case 'projects:list':
      return service.listProjects();
    case 'projects:add':
      return service.addProject(parsed['sourcePath'] as string);
    case 'projects:cancel-add':
      return service.cancelAddProject();
    case 'projects:get':
      return service.getProject(parsed['projectId'] as string);
    case 'projects:revisions':
      return service.listRevisions(parsed['projectId'] as string);
    case 'projects:delete':
      return service.deleteProject(parsed['projectId'] as string);
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
        parsed['agentStackIds'] === undefined ? undefined : (parsed['agentStackIds'] as string[]),
      );
      if (!gate.ready) {
        const blocking = gate.stacks
          .filter((s) => !s.ready)
          .map((s) => s.id + ': ' + s.reasons.join('; '))
          .join(' | ');
        throw Object.assign(new Error('Cannot start QA - provider not ready: ' + blocking), {
          code: 'PROVIDER_NOT_READY',
        });
      }
      const operation = await service.startRun(parsed['projectId'] as string, {
        mode: parsed['mode'],
        includePaths: parsed['includePaths'],
        instructions: parsed['instructions'],
        agentStackIds: parsed['agentStackIds'],
        runTimeoutMs: parsed['runTimeoutMs'],
      });
      if (operation.runId !== undefined)
        hooks.onRunCreated?.(operation.runId, operation.operationId);
      return operation;
    }
    case 'runs:cancel':
      return service.requestRunCancellation(parsed['runId'] as string);
    case 'runs:export':
      return service.exportRun(parsed['runId'] as string, parsed['format'] as 'log' | 'json');
    case 'runs:export-content':
      return service.exportContent(parsed['runId'] as string, parsed['format'] as 'log' | 'json');
    case 'runs:export-save': {
      const requestSavePath = hooks.requestSavePath;
      if (requestSavePath === undefined)
        throw Object.assign(new Error('Save dialog unavailable'), { code: 'DIALOG_UNAVAILABLE' });
      return saveExportRun(parsed['runId'] as string, parsed['format'] as 'log' | 'json', {
        requestSavePath,
        fetchContent: (runId, format) => service.exportContent(runId, format),
      });
    }
    case 'runs:export-reveal': {
      if (hooks.showInFolder === undefined)
        throw Object.assign(new Error('Shell reveal unavailable'), { code: 'DIALOG_UNAVAILABLE' });
      const show = hooks.showInFolder;
      return revealSavedExport(parsed['path'] as string, { showInFolder: (path) => show(path) });
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
    case 'cli:status': {
      if (hooks.cliStatus === undefined)
        throw Object.assign(new Error('CLI broker unavailable'), { code: 'CLI_UNAVAILABLE' });
      return hooks.cliStatus();
    }
    case 'app:set-language': {
      // Renderer owns the selection; main only mirrors it for native UI.
      // Persistence is best-effort and never fails the call.
      try {
        hooks.persistAppLanguage?.(parsed['language'] as 'en' | 'bg');
      } catch {
        /* selection already applied in the renderer */
      }
      return { saved: true, language: parsed['language'] };
    }
    case 'cli:set-enabled': {
      if (hooks.cliSetEnabled === undefined)
        throw Object.assign(new Error('CLI broker toggle unavailable'), {
          code: 'CLI_UNAVAILABLE',
        });
      return hooks.cliSetEnabled(parsed['enabled'] as boolean);
    }
    default:
      throw Object.assign(new Error('Unknown command: ' + channel), {
        code: 'IPC_UNKNOWN_CHANNEL',
      });
  }
}
