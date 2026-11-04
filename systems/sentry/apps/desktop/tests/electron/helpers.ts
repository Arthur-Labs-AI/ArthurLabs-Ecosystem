import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, '..', '..');

export async function electronLaunch(): Promise<{ app: ElectronApplication; window: Page }> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'sentry-electron-smoke-'));
  const app = await electron.launch({
    executablePath: join(
      desktopRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'electron.cmd' : 'electron',
    ),
    args: [join(desktopRoot, 'dist', 'main', 'index.js')],
    env: {
      ...process.env,
      SENTRY_DATA_ROOT: dataRoot,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
  const window = await app.firstWindow({ timeout: 60000 });
  await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
  return { app, window };
}
