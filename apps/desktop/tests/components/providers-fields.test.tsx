import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { HarnessBinaryCard, Providers } from '../../src/renderer/pages/Providers.js';

/**
 * The advanced harness-binary section must exist with saveable fields:
 * without it the backend binary-override channel is unreachable from
 * Settings, and users cannot fix an unresolvable provider executable.
 * It lives collapsed under "Advanced runtime binaries"; the card itself
 * still renders every Linux-path executable field.
 */
describe('Providers harness binary section', () => {
  function renderBinaryCard(): string {
    return renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(HarnessBinaryCard, {
          statuses: [],
          values: {},
          setValues: () => undefined,
          onSave: () => undefined,
          onClear: () => undefined,
          savePending: false,
          clearPending: false,
          onError: () => undefined,
        }),
      ),
    );
  }

  it('renders Linux-path executable fields for all three harnesses', () => {
    const html = renderBinaryCard();
    expect(html).toContain('Execution runtime');
    expect(html).toContain('OpenCode executable');
    expect(html).toContain('DeepSeek executable');
    expect(html).toContain('Claude Code executable');
    expect(html).toContain('Value for SENTRY_OPENCODE_BINARY');
    expect(html).toContain('Value for SENTRY_DEEPSEEK_BINARY');
    expect(html).toContain('Value for SENTRY_GLM_BINARY');
    expect(html).toContain('WSL Linux runtime');
  });

  it('organizes provider settings around agents, not raw env names', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(MemoryRouter, null, React.createElement(Providers, null)),
      ),
    );
    expect(html).toContain('OpenCode');
    expect(html).toContain('DeepSeek');
    expect(html).toContain('GLM');
    expect(html).toContain('API key');
    expect(html).toContain('Model');
    expect(html).toContain('Advanced runtime binaries');
    // Credential fields keep accessible labels so every value stays saveable.
    expect(html).toContain('Value for OPENROUTER_API_KEY');
    expect(html).toContain('Value for DEEPSEEK_API_KEY');
    expect(html).toContain('Value for ANTHROPIC_AUTH_TOKEN');
  });
});
