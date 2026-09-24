import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Providers } from '../../src/renderer/pages/Providers.js';

/**
 * The advanced harness-binary section must exist with saveable fields:
 * without it the backend binary-override channel is unreachable from
 * Settings, and users cannot fix an unresolvable provider executable.
 */
describe('Providers harness binary section', () => {
  it('renders Linux-path executable fields for all three harnesses', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(MemoryRouter, null, React.createElement(Providers, null)),
      ),
    );
    expect(html).toContain('Execution runtime');
    expect(html).toContain('OpenCode executable');
    expect(html).toContain('DeepSeek executable');
    expect(html).toContain('Claude Code executable');
    expect(html).toContain('Value for SENTRY_OPENCODE_BINARY');
    expect(html).toContain('Value for SENTRY_DEEPSEEK_BINARY');
    expect(html).toContain('Value for SENTRY_GLM_BINARY');
    expect(html).toContain('WSL Linux runtime');
  });
});
