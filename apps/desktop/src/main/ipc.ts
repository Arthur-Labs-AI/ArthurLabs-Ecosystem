import { ipcMain, shell } from 'electron';
import type { DesktopApplicationService } from './services/desktop-service.js';
import {
  DesktopChannelSchemas,
  dispatchDesktopCommand,
  toRouterError,
  toSafeError,
  type CommandRouterHooks,
} from './desktop-command-router.js';

export type { CommandRouterHooks };
export type DesktopIpcHooks = CommandRouterHooks;

function ok(result: unknown): { ok: true; result: unknown } {
  return { ok: true, result };
}

function fail(
  error: unknown,
  redactSecrets?: (text: string) => string,
): { ok: false; error: { code: string; message: string } } {
  return {
    ok: false,
    error:
      redactSecrets === undefined ? toRouterError(error) : toSafeError(error, { redactSecrets }),
  };
}

function handle(
  channel: string,
  listener: (payload: unknown) => Promise<unknown> | unknown,
  redactSecrets?: (text: string) => string,
): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      return ok(await listener(payload));
    } catch (error) {
      return fail(error, redactSecrets);
    }
  });
}

// Renderer IPC is a transport over the shared desktop command router:
// validation, readiness gates, and error mapping live in one place.
export function registerDesktopIpc(
  service: DesktopApplicationService,
  hooks: CommandRouterHooks = {},
): void {
  for (const channel of Object.keys(DesktopChannelSchemas)) {
    if (channel === 'cli:status') continue;
    handle(
      channel,
      (payload: unknown) =>
        dispatchDesktopCommand(service, channel, payload, {
          ...hooks,
          showInFolder: (path) => shell.showItemInFolder(path),
        }),
      hooks.redactErrorText,
    );
  }
  handle(
    'cli:status',
    (payload: unknown) => dispatchDesktopCommand(service, 'cli:status', payload, hooks),
    hooks.redactErrorText,
  );
}
