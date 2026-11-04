import { describe, expect, it } from 'vitest';
import { deriveRuntimeHostView } from '../../src/renderer/lib/runtime-host-view.js';

describe('runtime host view', () => {
  it('shows the distro selector on Windows/WSL2', () => {
    const view = deriveRuntimeHostView(
      { connected: true, hostPlatform: 'windows', executionMode: 'wsl2', distro: 'Ubuntu' },
      { distros: [], preferred: 'Ubuntu', selected: 'Ubuntu' },
    );
    expect(view.kind).toBe('windows');
    expect(view.showDistroSelector).toBe(true);
    expect(view.hostLabel).toBe('Windows');
    expect(view.executionLabel).toBe('WSL2');
    expect(view.distroLabel).toBe('Ubuntu');
  });

  it('hides the selector and shows CachyOS on native Linux', () => {
    const view = deriveRuntimeHostView(
      {
        connected: true,
        hostPlatform: 'linux',
        executionMode: 'native-linux',
        distribution: { id: 'cachyos', prettyName: 'CachyOS' },
      },
      {
        distros: [],
        preferred: null,
        selected: null,
        hostPlatform: 'linux',
        executionMode: 'native-linux',
        distribution: { id: 'cachyos', prettyName: 'CachyOS' },
      },
    );
    expect(view.kind).toBe('linux');
    expect(view.showDistroSelector).toBe(false);
    expect(view.hostLabel).toBe('CachyOS');
    expect(view.executionLabel).toBe('Native Linux');
    expect(view.distroLabel).toBe('CachyOS');
  });

  it('reads the native signal from the distros payload alone', () => {
    const view = deriveRuntimeHostView(undefined, {
      distros: [],
      preferred: null,
      selected: null,
      executionMode: 'native-linux',
      distribution: { id: 'cachyos', prettyName: 'CachyOS' },
    });
    expect(view.kind).toBe('linux');
    expect(view.showDistroSelector).toBe(false);
  });

  it('keeps the legacy WSL UI when host fields are absent', () => {
    const view = deriveRuntimeHostView({ connected: true }, { distros: [], preferred: null });
    expect(view.kind).toBe('unknown');
    expect(view.showDistroSelector).toBe(true);
  });
});
