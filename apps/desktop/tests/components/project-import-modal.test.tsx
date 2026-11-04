import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Projects } from '../../src/renderer/pages/Projects.js';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  delete (window as { sentry?: unknown }).sentry;
});

function mountProjects(options: {
  pickDirectory?: () => Promise<string | null>;
  add?: (path: string) => Promise<unknown>;
  cancelAdd?: () => Promise<{ cancelled: boolean }>;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(client);
  const pickDirectory = options.pickDirectory ?? vi.fn().mockResolvedValue(null);
  const add = options.add ?? vi.fn().mockResolvedValue({ projectId: 'proj_1' });
  const cancelAdd = options.cancelAdd ?? vi.fn().mockResolvedValue({ cancelled: true });
  Object.defineProperty(window, 'sentry', {
    configurable: true,
    value: {
      projects: {
        list: vi.fn().mockResolvedValue([]),
        add,
        cancelAdd,
      },
      dialogs: {
        pickDirectory,
      },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Projects />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { pickDirectory, add, cancelAdd };
}

describe('Project import modal window & cancellation', () => {
  it('does not open the modal or start counting before a folder is selected', async () => {
    let resolvePicker!: (value: string | null) => void;
    const pickDirectory = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolvePicker = resolve;
        }),
    );
    const add = vi.fn();
    mountProjects({ pickDirectory, add });
    await waitFor(() => expect(screen.getByText('No projects yet')).toBeTruthy());

    fireEvent.click(screen.getAllByRole('button', { name: /Add Project/i })[0]!);
    expect(pickDirectory).toHaveBeenCalledOnce();
    // While the OS directory picker is still open, modal must NOT appear
    expect(screen.queryByRole('dialog', { name: 'Adding project to Sentry' })).toBeNull();
    expect(add).not.toHaveBeenCalled();

    // User cancels the folder picker -> still no modal and no error alert
    resolvePicker(null);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Adding project to Sentry' })).toBeNull();
  });

  it('opens the modal with smooth_loader_flat_logo.gif after folder selection, blocks Escape, and supports Cancel + beforeunload abort', async () => {
    let rejectAdd!: (err: Error) => void;
    const add = vi.fn(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectAdd = reject;
        }),
    );
    const cancelAdd = vi.fn().mockResolvedValue({ cancelled: true });
    mountProjects({
      pickDirectory: vi.fn().mockResolvedValue('/workspace/my-repo'),
      add,
      cancelAdd,
    });
    await waitFor(() => expect(screen.getByText('No projects yet')).toBeTruthy());

    fireEvent.click(screen.getAllByRole('button', { name: /Add Project/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Adding project to Sentry' });
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector('img[src="./smooth_loader_flat_logo.gif"]')).toBeTruthy();
    expect(dialog.textContent).toContain('my-repo');
    expect(dialog.textContent).toContain('0s');

    // Escape does not dismiss the modal while upload is active
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Adding project to Sentry' })).toBeTruthy();

    // Closing the app / window triggers cancelAdd automatically
    window.dispatchEvent(new Event('beforeunload'));
    expect(cancelAdd).toHaveBeenCalledOnce();

    // Clicking Cancel import aborts and closes the modal without showing an error alert
    fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }));
    rejectAdd(new Error('Project import cancelled by user'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Adding project to Sentry' })).toBeNull(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
