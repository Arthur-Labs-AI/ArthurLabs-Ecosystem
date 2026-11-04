import type { SentryDesktopApi } from '../../shared/ipc-contract.js';

declare global {
  interface Window {
    readonly sentry: SentryDesktopApi & { dialogs: { pickDirectory(): Promise<string | null> } };
  }
}

function requireApi(): SentryDesktopApi & {
  dialogs?: { pickDirectory(): Promise<string | null> };
} {
  const api = window.sentry;
  if (api === undefined)
    throw new Error('Sentry desktop bridge is unavailable (window.sentry missing)');
  return api;
}

export function sentryApi(): SentryDesktopApi & {
  dialogs?: { pickDirectory(): Promise<string | null> };
} {
  return requireApi();
}

export async function pickDirectory(): Promise<string | null> {
  const api = requireApi();
  if (api.dialogs === undefined) return null;
  return api.dialogs.pickDirectory();
}
