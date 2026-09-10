import { homedir, platform } from 'node:os';
import { isAbsolute, resolve, posix, win32 } from 'node:path';

export interface DataRootOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
}

export function resolveSentryDataRoot(options: DataRootOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env['SENTRY_DATA_ROOT']?.trim();
  if (override !== undefined && override.length > 0) return resolve(override);

  const os = options.platform ?? platform();
  const home = options.homeDirectory ?? homedir();
  const pathApi = os === 'win32' ? win32 : posix;
  if (os === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    return pathApi.resolve(
      pathApi.join(localAppData ?? pathApi.join(home, 'AppData', 'Local'), 'Sentry'),
    );
  }
  if (os === 'darwin') {
    return pathApi.resolve(pathApi.join(home, 'Library', 'Application Support', 'Sentry'));
  }
  const xdg = env['XDG_DATA_HOME'];
  return pathApi.resolve(pathApi.join(xdg ?? pathApi.join(home, '.local', 'share'), 'sentry'));
}

export function assertAbsoluteDataRoot(dataRoot: string): string {
  if (!isAbsolute(dataRoot))
    throw new TypeError('Sentry data root must resolve to an absolute path');
  return resolve(dataRoot);
}
