import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeSettings } from '../../src/renderer/pages/RuntimeSettings.js';

const clients: QueryClient[] = [];
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.restoreAllMocks();
});

function fixture({ active = false, connected = true, linux = false } = {}) {
  const result = {
    distro: 'Ubuntu',
    diskBytesBefore: 5 * 2 ** 30,
    diskBytesAfter: 3 * 2 ** 30,
    windowsFreeBytesBefore: 2 * 2 ** 30,
    windowsFreeBytesAfter: 4 * 2 ** 30,
    reconnected: true,
  };
  const reclaimSpace = vi.fn(async () => result);
  const api = {
    runtime: {
      reclaimSpace,
      status: vi.fn(async () => ({
        connected,
        distro: 'Ubuntu',
        hostPlatform: linux ? 'linux' : 'windows',
        executionMode: linux ? 'native-linux' : 'wsl2',
      })),
      distros: vi.fn(async () => ({
        distros: [{ name: 'Ubuntu', state: 'Running', version: 2 }],
        selected: 'Ubuntu',
        preferred: 'Ubuntu',
      })),
    },
    system: { activeRuns: vi.fn(async () => (active ? [{ runId: 'run_active' }] : [])) },
  };
  Object.defineProperty(window, 'sentry', { configurable: true, value: api });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RuntimeSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { api, client, result, reclaimSpace };
}

describe('WSL space reclamation', () => {
  it('explains the whole-distro interruption and can cancel without calling maintenance', async () => {
    const f = fixture();
    fireEvent.click(await screen.findByRole('button', { name: 'Reclaim Windows disk space' }));
    const dialog = screen.getByRole('dialog', { name: 'Reclaim Windows disk space?' });
    expect(dialog.textContent).toContain('Ubuntu');
    expect(dialog.textContent).toContain('other applications');
    expect(dialog.textContent).toContain('administrator');
    expect(dialog.textContent).toContain('grow');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(f.reclaimSpace).not.toHaveBeenCalled();
  });

  it('awaits maintenance, blocks double submission, shows measured bytes and refreshes data', async () => {
    const f = fixture();
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    f.reclaimSpace.mockImplementation(async () => {
      await pending;
      return f.result;
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reclaim Windows disk space' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart Ubuntu and reclaim' }));
    await waitFor(() => expect(f.reclaimSpace).toHaveBeenCalledTimes(1));
    expect(
      (screen.getByRole('button', { name: 'Reclaiming…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.getByRole('dialog')).toBeDefined();
    complete();
    await screen.findByText(/Reclaimed 2.00 GiB/);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(f.api.runtime.status.mock.calls.length).toBeGreaterThan(1));
  });

  it('shows UAC cancellation and allows retry', async () => {
    const f = fixture();
    f.reclaimSpace.mockRejectedValueOnce(new Error('Administrator approval was cancelled.'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reclaim Windows disk space' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart Ubuntu and reclaim' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('cancelled');
    expect(
      (screen.getByRole('button', { name: 'Restart Ubuntu and reclaim' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it.each([{ active: true }, { connected: false }])(
    'disables maintenance when unavailable: %j',
    async (opts) => {
      fixture(opts);
      const button = await screen.findByRole('button', { name: 'Reclaim Windows disk space' });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    },
  );

  it('does not expose Windows compaction on native Linux', async () => {
    fixture({ linux: true });
    await screen.findByText('Execution Runtime');
    expect(screen.queryByRole('button', { name: 'Reclaim Windows disk space' })).toBeNull();
  });

  it('reports zero recovery honestly and distinguishes failed reconnect', async () => {
    const f = fixture();
    f.reclaimSpace.mockResolvedValue({
      ...f.result,
      diskBytesAfter: f.result.diskBytesBefore,
      reconnected: false,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reclaim Windows disk space' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart Ubuntu and reclaim' }));
    await screen.findByText(/Reclaimed 0.00 GiB/);
    expect(screen.getByRole('alert').textContent).toContain('Reconnect');
  });
});
