import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_BROKER_COMMANDS } from '@qa/shared';
import { DesktopChannelSchemas, isCliAllowed } from '../../src/main/desktop-command-router.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Regression: RuntimeSettings showed 'No usable WSL2 distribution found'
// with Status Connected, because runtime:distros / runtime:select-distro
// were registered but never dispatched - every query fell to
// IPC_UNKNOWN_CHANNEL and the renderer saw an empty list.
// Ubuntu + node were healthy the whole time.
// Dispatch now lives in the shared desktop command router (used by both
// Renderer IPC and the external CLI broker); ipc.ts is a thin transport.
describe('runtime distros IPC dispatch', () => {
  it('dispatches runtime:distros to DesktopApplicationService.runtimeDistros', () => {
    const router = readFileSync(join(root, 'src', 'main', 'desktop-command-router.ts'), 'utf8');
    expect(router).toContain("case 'runtime:distros':");
    expect(router).toContain('service.runtimeDistros()');
  });

  it('dispatches runtime:select-distro to DesktopApplicationService.runtimeSelectDistro', () => {
    const router = readFileSync(join(root, 'src', 'main', 'desktop-command-router.ts'), 'utf8');
    expect(router).toContain("case 'runtime:select-distro':");
    expect(router).toContain('service.runtimeSelectDistro(');
  });

  it('every registered router channel has a dispatch case', () => {
    const router = readFileSync(join(root, 'src', 'main', 'desktop-command-router.ts'), 'utf8');
    const schemaBlock = (router.split('DesktopChannelSchemas')[1] || '').split('};')[0] || '';
    const found = schemaBlock.match(/'[^']+':/g) || [];
    const channels = found.map((s) => s.slice(1, -2));
    expect(channels.length).toBeGreaterThan(0);
    const missing = channels.filter((c) => router.indexOf("case '" + c + "':") < 0);
    expect(missing).toEqual([]);
  });

  it('serves the entire shared external vocabulary with validation', () => {
    for (const command of CLI_BROKER_COMMANDS) {
      expect(DesktopChannelSchemas[command] !== undefined, command).toBe(true);
      expect(isCliAllowed(command), command).toBe(true);
    }
  });

  it('renderer IPC delegates every channel to the shared router', () => {
    const ipc = readFileSync(join(root, 'src', 'main', 'ipc.ts'), 'utf8');
    expect(ipc).toContain('dispatchDesktopCommand');
    expect(ipc).toContain('DesktopChannelSchemas');
    expect(ipc).not.toContain("case 'runs:start':");
  });
});
