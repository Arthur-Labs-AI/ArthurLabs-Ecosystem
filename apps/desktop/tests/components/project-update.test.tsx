import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectDetail } from '../../src/renderer/pages/ProjectDetail.js';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  delete (window as { sentry?: unknown }).sentry;
});

function fixture() {
  const update = vi.fn(async () => {
    await new Promise<never>(() => undefined);
  });
  const cancelUpdate = vi.fn(async () => ({ cancelled: true, count: 1 }));
  const api = {
    projects: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({
        project: { name: 'Alpha', sourcePath: '/original/Alpha' },
        managedCopy: { state: 'ready' },
        revision: { id: 'rev_alpha' },
      })),
      revisions: vi.fn(async () => []),
      doctor: vi.fn(async () => ({ ready: true })),
      update,
      cancelUpdate,
    },
    runs: { list: vi.fn(async () => []) },
    doctors: {
      environment: vi.fn(async () => ({
        agentStacks: [{ id: 'stack_opencode_main', displayName: 'OpenCode', readiness: 'ready' }],
      })),
    },
    production: { readiness: vi.fn(async () => ({ ready: true, reasons: [], warnings: [], stacks: [] })) },
    system: { activeRuns: vi.fn(async () => []) },
  };
  Object.defineProperty(window, 'sentry', { configurable: true, value: api });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/proj_alpha']}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { api, update, cancelUpdate };
}

async function startUpdate() {
  fireEvent.click(await screen.findByRole('button', { name: 'Update Project' }));
  return screen.findByRole('dialog', { name: 'Updating project in Sentry' });
}

describe('project revision update', () => {
  it('opens a blocking modal and disables run start while updating', async () => {
    const f = fixture();
    expect(((await screen.findByRole('button', { name: 'Start Full QA' })) as HTMLButtonElement).disabled).toBe(false);
    const dialog = await startUpdate();
    expect(f.update).toHaveBeenCalledWith('proj_alpha');
    expect(within(dialog).getByText('Updating project')).toBeDefined();
    expect(within(dialog).getByText('Elapsed:')).toBeDefined();
    expect(((await screen.findByRole('button', { name: 'Start Full QA' })) as HTMLButtonElement).disabled).toBe(true);
  });

  it('cancels the revision from the modal without closing it implicitly', async () => {
    const f = fixture();
    const dialog = await startUpdate();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel update' }));
    await waitFor(() => expect(f.cancelUpdate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog', { name: 'Updating project in Sentry' })).toBeDefined();
  });

  it('does not dismiss the blocking modal on Escape', async () => {
    const f = fixture();
    const dialog = await startUpdate();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Updating project in Sentry' })).toBeDefined();
    expect(f.cancelUpdate).not.toHaveBeenCalled();
  });

  it('abandons the revision when the window unloads mid-update', async () => {
    const f = fixture();
    await startUpdate();
    window.dispatchEvent(new Event('beforeunload'));
    await waitFor(() => expect(f.cancelUpdate).toHaveBeenCalledTimes(1));
  });
});
