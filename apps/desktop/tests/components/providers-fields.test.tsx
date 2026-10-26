import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HarnessBinaryCard, Providers } from '../../src/renderer/pages/Providers.js';

afterEach(() => cleanup());

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
    expect(html).toContain('OpenCode API key (Zen &amp; Go)');
    expect(html).toContain('OpenRouter API key (Pay-as-you-go)');
    expect(html).toContain('<summary class="metadata">Explanation</summary>');
    expect(html).toContain('API key');
    expect(html).toContain('Model');
    expect(html).toContain('Advanced runtime binaries');
    expect(html).not.toContain('placeholder="missing"');
    // Credential fields keep accessible labels so every value stays saveable.
    expect(html).toContain('Value for OPENCODE_API_KEY');
    expect(html).toContain('Value for OPENROUTER_API_KEY');
    expect(html).toContain('Value for DEEPSEEK_API_KEY');
    expect(html).toContain('Value for ANTHROPIC_AUTH_TOKEN');
  });
});

describe('Providers OpenCode executable suggestion', () => {
  const DEEPSEEK_SAVED = {
    name: 'SENTRY_DEEPSEEK_BINARY',
    configured: true,
    persistence: 'persisted',
    source: 'persisted',
    hint: '/home/merte/.local/share/sentry/tools/deepseek/bin/dsh',
  };
  const SUGGESTED = '/home/merte/.local/share/sentry/tools/opencode/node_modules/.bin/opencode';

  function mountCard(
    statuses: Array<{
      name: string;
      configured: boolean;
      persistence: string;
      source: string;
      hint: string;
    }>,
  ) {
    function Wrapper(): React.JSX.Element {
      const [values, setValues] = React.useState<Record<string, string>>({});
      return (
        <MemoryRouter>
          <HarnessBinaryCard
            statuses={statuses}
            values={values}
            setValues={setValues}
            onSave={() => undefined}
            onClear={() => undefined}
            savePending={false}
            clearPending={false}
            onError={() => undefined}
          />
        </MemoryRouter>
      );
    }
    render(<Wrapper />);
  }

  it('auto-fills the empty OpenCode field from the sibling home directory', async () => {
    mountCard([DEEPSEEK_SAVED]);
    const input = (await screen.findByLabelText(
      'Value for SENTRY_OPENCODE_BINARY',
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(SUGGESTED));
    expect(
      screen.getByText('Suggested OpenCode path derived from your other executable settings.'),
    ).toBeDefined();
  });

  it('offers the suggestion over a stale saved path without overwriting it', async () => {
    mountCard([
      DEEPSEEK_SAVED,
      {
        name: 'SENTRY_OPENCODE_BINARY',
        configured: true,
        persistence: 'persisted',
        source: 'persisted',
        hint: '/home/stale/.local/share/sentry/tools/opencode/node_modules/.bin/opencode',
      },
    ]);
    const input = (await screen.findByLabelText(
      'Value for SENTRY_OPENCODE_BINARY',
    )) as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Use suggested path' }));
    await waitFor(() => expect(input.value).toBe(SUGGESTED));
  });

  it('stays quiet without a usable sibling path', async () => {
    mountCard([]);
    const input = (await screen.findByLabelText(
      'Value for SENTRY_OPENCODE_BINARY',
    )) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(screen.queryByRole('button', { name: 'Use suggested path' })).toBeNull();
    expect(
      screen.queryByText('Suggested OpenCode path derived from your other executable settings.'),
    ).toBeNull();
  });
});
