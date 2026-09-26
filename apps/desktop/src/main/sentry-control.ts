/**
 * Sentry launcher control arguments (parsed from process.argv, no Electron needed).
 *
 * - `--sentry-control=stop` (or `--sentry-control stop`): graceful shutdown request.
 * - `--sentry-setup-distro[=]<name>`: persist the WSL distro preference, then quit
 *   without opening a window (used by `sentry setup` through the existing
 *   WslRuntimeManager so the preference format stays authoritative).
 * - `--sentry-app`: marker used by the launcher to recognise its own
 *   Electron processes. Ignored here.
 */
export interface SentryControlArgs {
  readonly mode: 'stop' | undefined;
  readonly setupDistro: string | undefined;
}

export function parseSentryControlArgs(argv: readonly string[]): SentryControlArgs {
  let mode: 'stop' | undefined;
  let setupDistro: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--sentry-control=stop' || arg === '--sentry-control:stop') {
      mode = 'stop';
    } else if (arg === '--sentry-control' && argv[i + 1] === 'stop') {
      mode = 'stop';
    } else if (arg.startsWith('--sentry-setup-distro=')) {
      const value = arg.slice('--sentry-setup-distro='.length).trim();
      if (value.length > 0) setupDistro = value;
    } else if (arg === '--sentry-setup-distro' && typeof argv[i + 1] === 'string') {
      const value = (argv[i + 1] ?? '').trim();
      if (value.length > 0 && !value.startsWith('-')) setupDistro = value;
    }
  }
  return { mode, setupDistro };
}
