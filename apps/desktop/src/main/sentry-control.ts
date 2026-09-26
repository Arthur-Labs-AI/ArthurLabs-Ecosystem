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
/**
 * Non-secret provider binary override keys the launcher may persist.
 * Secret keys are NEVER accepted here: this helper only stores executable
 * paths through the existing plain-prefs mechanism.
 */
export const SENTRY_SETUP_BINARY_KEYS = [
  'SENTRY_DEEPSEEK_BINARY',
  'SENTRY_GLM_BINARY',
  'SENTRY_OPENCODE_BINARY',
] as const;

export type SentrySetupBinaryKey = (typeof SENTRY_SETUP_BINARY_KEYS)[number];

export interface SentryControlArgs {
  readonly mode: 'stop' | undefined;
  readonly setupDistro: string | undefined;
  readonly providerBinary:
    { readonly key: SentrySetupBinaryKey; readonly value: string } | undefined;
  readonly credentialStatus: boolean;
}

export function parseSentryControlArgs(argv: readonly string[]): SentryControlArgs {
  let mode: 'stop' | undefined;
  let setupDistro: string | undefined;
  let providerBinary: SentryControlArgs['providerBinary'] = undefined;
  let credentialStatus = false;
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
    } else if (arg === '--sentry-setup-provider-binary') {
      const key = (argv[i + 1] ?? '').trim();
      const value = (argv[i + 2] ?? '').trim();
      if (
        (SENTRY_SETUP_BINARY_KEYS as readonly string[]).includes(key) &&
        value.length > 0 &&
        value.startsWith('/') &&
        !value.includes('\n')
      ) {
        providerBinary = { key: key as SentrySetupBinaryKey, value };
      }
    } else if (arg === '--sentry-credential-status') {
      credentialStatus = true;
    }
  }
  return { mode, setupDistro, providerBinary, credentialStatus };
}
