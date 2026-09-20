import { describe, expect, it } from 'vitest';
import { WslRuntimeClient } from '../../src/main/services/wsl-runtime-client.js';

describe('wsl path translation contract', () => {
  it('normalizes backslashes before wslpath (argv would otherwise mangle them)', async () => {
    const { toWslPathArg } = await import(
      '../../src/main/services/wsl-runtime-client.js'
    );
    // Regression: `C:\Users\...` arrived at wslpath as `C:Users...`.
    expect(toWslPathArg('C:\\Users\\merte\\Documents\\GitHub\\Fener')).toBe(
      'C:/Users/merte/Documents/GitHub/Fener',
    );
    expect(toWslPathArg('C:\\Users\\merte\\My Project')).toBe('C:/Users/merte/My Project');
    expect(toWslPathArg('D:\\Code\\App')).toBe('D:/Code/App');
    expect(toWslPathArg('/home/merte/project')).toBe('/home/merte/project');
  });

  it('documents the supported Windows path shapes', () => {
    const cases = [
      'C:\\Users\\Mert\\Documents\\Project',
      'C:\\Users\\Mert\\My Project',
      'D:\\Code\\App',
    ];
    for (const input of cases) {
      expect(/^[A-Za-z]:[\\/]/.test(input)).toBe(true);
    }
    expect(/^[A-Za-z]:[\\/]/.test('/home/merte/project')).toBe(false);
    expect(/^[A-Za-z]:[\\/]/.test('relative/path')).toBe(false);
  });

  it('client fails closed without a running runtime', async () => {
    const client = new WslRuntimeClient({ distro: 'Ubuntu', runtimeEntry: '/nonexistent/host.js' });
    await expect(client.request('system.info')).rejects.toMatchObject({ code: 'RUNTIME_OFFLINE' });
  });
});

describe('electron host regression', () => {
  it('desktop production execution does not depend on the Electron node host', async () => {
    // Even when the desktop runs as electron.exe, provider launch must not
    // resolve through it: DesktopApplicationService only forwards RPC.
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const service = readFileSync(
      join(root, 'src', 'main', 'services', 'desktop-service.ts'),
      'utf8',
    );
    expect(service).not.toMatch(/process\.execPath/);
    expect(service).not.toContain('new RunCoordinator');
    expect(service).not.toMatch(/from '@qa\/run-engine'/);
    expect(service).not.toContain('createMuseRegistration');
    expect(service).not.toContain('createDeepSeekRegistration');
    expect(service).not.toContain('createGlmRegistration');
    expect(service).not.toContain('SystemdSandboxBackend');
    const client = readFileSync(
      join(root, 'src', 'main', 'services', 'wsl-runtime-client.ts'),
      'utf8',
    );
    expect(client).toContain("spawn('wsl.exe'");
    expect(client).not.toContain("spawn('dsh'");
    expect(client).not.toContain("spawn('muse'");
    expect(client).not.toContain("spawn('claude'");
  });
});
