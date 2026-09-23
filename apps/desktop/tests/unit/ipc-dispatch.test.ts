import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Regression: RuntimeSettings showed 'No usable WSL2 distribution found'
// with Status Connected, because runtime:distros / runtime:select-distro
// were registered in PayloadSchemas but never dispatched in the switch -
// every query fell to IPC_UNKNOWN_CHANNEL and the renderer saw an empty list.
// Ubuntu + node were healthy the whole time.
describe('runtime distros IPC dispatch', () => {
  it('dispatches runtime:distros to DesktopApplicationService.runtimeDistros', () => {
    const ipc = readFileSync(join(root, 'src', 'main', 'ipc.ts'), 'utf8');
    expect(ipc).toContain("case 'runtime:distros':");
    expect(ipc).toContain('service.runtimeDistros()');
  });

  it('dispatches runtime:select-distro to DesktopApplicationService.runtimeSelectDistro', () => {
    const ipc = readFileSync(join(root, 'src', 'main', 'ipc.ts'), 'utf8');
    expect(ipc).toContain("case 'runtime:select-distro':");
    expect(ipc).toContain('service.runtimeSelectDistro(');
  });

  it('every registered PayloadSchema channel has a dispatch case', () => {
    const ipc = readFileSync(join(root, 'src', 'main', 'ipc.ts'), 'utf8');
    const schemaBlock = (ipc.split('const PayloadSchemas')[1] || '').split('};')[0] || '';
    const found = schemaBlock.match(/'[^']+':/g) || [];
    const channels = found.map((s) => s.slice(1, -2));
    expect(channels.length).toBeGreaterThan(0);
    const missing = channels.filter((c) => ipc.indexOf("case '" + c + "':") < 0);
    expect(missing).toEqual([]);
  });
});
