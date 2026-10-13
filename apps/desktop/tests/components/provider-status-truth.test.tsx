import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../../src/renderer/pages/Providers.js';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  delete (window as { sentry?: unknown }).sentry;
});
function mount(status: ReturnType<typeof vi.fn>, save = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(client);
  Object.defineProperty(window, 'sentry', {
    configurable: true,
    value: { providers: { status, save, clearKey: vi.fn(), forgetAll: vi.fn() } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Providers />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return {
    client,
    card: () => within(screen.getByRole('region', { name: 'DeepSeek provider settings' })),
  };
}
const deepseek = (source: string, persistence: string, configured = true) => [
  { name: 'DEEPSEEK_API_KEY', configured, source, persistence, hint: 'fixed status only' },
];

describe('Providers distinguishes missing, storage and query failures', () => {
  it('a failed status query never presents credentials as Not set', async () => {
    const query = vi.fn().mockRejectedValue(new Error('transport failed'));
    mount(query);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Provider status unavailable'),
    );
    expect(screen.queryAllByText('Not set')).toHaveLength(0);
    query.mockResolvedValue(deepseek('stored', 'secure'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry provider status' }));
    await waitFor(() => expect(screen.getByText('Stored securely')).toBeTruthy());
  });
  it('loading is unknown rather than missing', () => {
    mount(vi.fn(() => new Promise(() => undefined)));
    expect(screen.queryAllByText('Not set')).toHaveLength(0);
  });
  it('environment values are not called securely stored', async () => {
    const s = mount(vi.fn().mockResolvedValue(deepseek('environment', 'environment')));
    await waitFor(() => expect(s.card().getByText('From environment')).toBeTruthy());
    expect(s.card().queryByText(/Saved securely|Stored securely/)).toBeNull();
  });
  it('unreadable stored data is not called missing', async () => {
    const s = mount(vi.fn().mockResolvedValue(deepseek('unavailable', 'unavailable', false)));
    await waitFor(() => expect(s.card().getByText('Stored credential unavailable')).toBeTruthy());
    expect(s.card().queryByText('Not set')).toBeNull();
  });
  it('a background query failure stops claiming cached stored status', async () => {
    const query = vi.fn().mockResolvedValue(deepseek('stored', 'secure')),
      s = mount(query);
    await waitFor(() => expect(s.card().getByText('Stored securely')).toBeTruthy());
    query.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await s.client.invalidateQueries({ queryKey: ['providers'] });
    });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Provider status unavailable'),
    );
    expect(s.card().queryByText('Stored securely')).toBeNull();
    expect(s.card().queryByText('Not set')).toBeNull();
  });
  it('a failed save does not leave a previous success notice', async () => {
    const query = vi.fn().mockResolvedValue(deepseek('missing', 'missing', false));
    const save = vi
        .fn()
        .mockResolvedValue({ configured: true, persistence: 'secure', source: 'stored' }),
      s = mount(query, save);
    await waitFor(() => expect(query).toHaveBeenCalledOnce());
    const input = s.card().getByLabelText('Value for DEEPSEEK_API_KEY');
    const saveButton = within(input.parentElement!).getByRole('button', { name: 'Save' });
    fireEvent.change(input, { target: { value: 'synthetic-first' } });
    fireEvent.click(saveButton);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved'));
    save.mockRejectedValue(new Error('Credential could not be stored securely'));
    fireEvent.change(input, { target: { value: 'synthetic-second' } });
    fireEvent.click(saveButton);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('could not be stored'),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });
});
