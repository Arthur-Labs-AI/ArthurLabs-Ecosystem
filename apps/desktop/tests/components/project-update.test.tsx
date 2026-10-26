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
        revision: { id: 'rev_01K7777777777777777777779B' },
      })),
      revisions: vi.fn(async () => [
        { id: 'rev_01K7777777777777777777778A', importedAt: '2026-10-20T10:00:00.000Z' },
        { id: 'rev_01K7777777777777777777779B', importedAt: '2026-10-25T12:00:00.000Z' },
      ]),
      doctor: vi.fn(async () => ({ ready: true })),
      update,
      cancelUpdate,
    },
    runs: {
      list: vi.fn(async () => []),
      start: vi.fn(async () => ({ operationId: 'dop_test', runId: 'run_started' })),
    },
    doctors: {
      environment: vi.fn(async () => ({
        agentStacks: [{ id: 'stack_opencode_main', displayName: 'OpenCode', readiness: 'ready' }],
      })),
    },
    production: {
      readiness: vi.fn(async () => ({ ready: true, reasons: [], warnings: [], stacks: [] })),
    },
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
    expect(
      ((await screen.findByRole('button', { name: 'Start Full QA' })) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    const dialog = await startUpdate();
    expect(f.update).toHaveBeenCalledWith('proj_alpha');
    expect(within(dialog).getByText('Updating project')).toBeDefined();
    expect(within(dialog).getByText('Elapsed:')).toBeDefined();
    expect(
      ((await screen.findByRole('button', { name: 'Start Full QA' })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
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

describe('run revision selection', () => {
  it('lists revisions newest-first with added dates and defaults to current', async () => {
    fixture();
    const picker = (await screen.findByLabelText('Run revision')) as HTMLSelectElement;
    const options = Array.from(picker.querySelectorAll('option'));
    expect(options).toHaveLength(2);
    expect(options[0]!.value).toBe('rev_01K7777777777777777777779B');
    expect(options[1]!.value).toBe('rev_01K7777777777777777777778A');
    expect(picker.value).toBe('rev_01K7777777777777777777779B');
    expect(options[0]!.text).toContain('current');
    expect(options[0]!.text).toContain('2026');
    expect(options[0]!.text).not.toContain('T12:00');
    expect(options[1]!.text).not.toContain('current');
  });

  it('starts the run on the selected older revision and shows it for confirmation', async () => {
    const f = fixture();
    const picker = (await screen.findByLabelText('Run revision')) as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'rev_01K7777777777777777777778A' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start Full QA' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm start full QA' });
    expect(within(dialog).getByText(/Revision:/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start QA' }));
    await waitFor(() =>
      expect(f.api.runs.start).toHaveBeenCalledWith(
        'proj_alpha',
        expect.objectContaining({ mode: 'full', revisionId: 'rev_01K7777777777777777777778A' }),
      ),
    );
  });

  it('orders the revision timeline newest-first with readable added dates', async () => {
    fixture();
    await screen.findByLabelText('Run revision');
    const items = document.querySelectorAll('.timeline .item');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('7779B');
    expect(items[0]!.textContent).not.toContain('7778A');
    expect(items[1]!.textContent).toContain('7778A');
    expect(items[0]!.textContent).toContain('2026');
    expect(items[0]!.textContent).not.toContain('2026-10-25T12:00');
  });
});
