import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../src/renderer/pages/RuntimeSettings.js';

function renderWith(distros: unknown, status: unknown): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(['runtime-distros'], distros);
  queryClient.setQueryData(['runtime-status'], status);
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(RuntimeSettings, null),
      ),
    ),
  );
}

const windowsDistros = {
  distros: [{ name: 'Ubuntu', state: 'Running', version: 2 }],
  preferred: 'Ubuntu',
  selected: 'Ubuntu',
};
const windowsStatus = {
  connected: true,
  distro: 'Ubuntu',
  hostPlatform: 'windows',
  executionMode: 'wsl2',
};

const linuxDistros = {
  distros: [],
  preferred: null,
  selected: null,
  hostPlatform: 'linux',
  executionMode: 'native-linux',
  distribution: { id: 'cachyos', prettyName: 'CachyOS' },
};
const linuxStatus = {
  connected: true,
  hostPlatform: 'linux',
  executionMode: 'native-linux',
  distribution: { id: 'cachyos', prettyName: 'CachyOS' },
};

describe('runtime settings host views', () => {
  it('keeps the WSL selector on Windows', () => {
    const markup = renderWith(windowsDistros, windowsStatus);
    expect(markup).toContain('Save distribution');
    expect(markup).toContain('Ubuntu');
    expect(markup).toContain('Change distribution');
  });

  it('shows native host facts without WSL guidance on CachyOS', () => {
    const markup = renderWith(linuxDistros, linuxStatus);
    expect(markup).toContain('Execution Runtime');
    expect(markup).toContain('CachyOS');
    expect(markup).toContain('Native Linux');
    expect(markup).not.toContain('Save distribution');
    expect(markup).not.toContain('Change distribution');
    expect(markup).not.toContain('Install Ubuntu');
    expect(markup).not.toContain('wsl --install');
    expect(markup).not.toContain('wsl-runtime.md');
  });
});
