/**
 * Best-effort discovery of provider harness executables for the desktop host.
 * GUI-launched Electron often inherits a minimal PATH missing the npm global
 * bin dir, so dsh resolves in a terminal but not in the app. Discovery only
 * suggests absolute paths: an explicit setting always wins and discovery
 * never writes anything on its own.
 */
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

async function existsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function discoverDeepSeekBinary(): Promise<string | undefined> {
  const candidates: string[] = [];
  const prefix = process.env['npm_config_prefix'];
  if (prefix !== undefined && prefix.trim().length > 0) {
    candidates.push(join(prefix.trim(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  }
  const appData = process.env['APPDATA'];
  if (appData !== undefined && appData.trim().length > 0) {
    candidates.push(
      join(appData.trim(), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    );
  }
  const home = process.env['HOME'] ?? process.env['USERPROFILE'];
  if (home !== undefined && home.trim().length > 0) {
    const h = home.trim();
    candidates.push(
      join(h, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    );
    candidates.push(
      join(h, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    );
  }
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    const t = dir.trim();
    if (t.length === 0) continue;
    candidates.push(join(t, 'dsh.cmd'));
    candidates.push(join(t, 'dsh.exe'));
    candidates.push(join(t, 'dsh'));
  }
  for (const candidate of candidates) {
    if (await existsExecutable(candidate)) return candidate;
  }
  return undefined;
}
