import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Projects } from '../../src/renderer/pages/Projects.js';
import { ProjectDetail } from '../../src/renderer/pages/ProjectDetail.js';
import { Dashboard } from '../../src/renderer/pages/Dashboard.js';

const clients: QueryClient[] = [];
beforeEach(() => {
  // jsdom has no top layer; the actual dialog/focus behavior is checked in Electron.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

function fixture(state = 'ready') {
  let records = [
    { projectId: 'proj_alpha', name: 'Alpha', state, currentRevisionId: 'rev_alpha', runCount: 2 },
  ];
  const remove = vi.fn(async (_id: string) => {
    records = [];
    return { projectId: 'proj_alpha', deleted: true };
  });
  const api = {
    projects: {
      list: vi.fn(async () => records),
      remove,
      get: vi.fn(async () => ({
        project: { name: 'Alpha', sourcePath: '/original/Alpha' },
        managedCopy: { state },
        revision: { id: 'rev_alpha' },
      })),
      revisions: vi.fn(async () => []),
      doctor: vi.fn(async () => ({ ready: true })),
    },
    runs: { list: vi.fn(async () => []) },
    doctors: { environment: vi.fn(async () => ({ agentStacks: [] })) },
    production: { readiness: vi.fn(async () => ({ ready: false })) },
    system: { activeRuns: vi.fn(async () => []) },
  };
  Object.defineProperty(window, 'sentry', { configurable: true, value: api });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(client);
  const mount = (children: React.ReactNode) =>
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>,
    );
  return {
    api,
    remove,
    client,
    mount,
    erase: () => {
      records = [];
    },
  };
}

describe('project removal', () => {
  it('explains permanent removal and preserves the project when cancelled', async () => {
    const f = fixture();
    f.mount(<Projects />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove project Alpha' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Alpha?' });
    expect(dialog.textContent).toContain('stored copy');
    expect(dialog.textContent).toContain('run history');
    expect(dialog.textContent).toContain('original source folder');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(f.remove).not.toHaveBeenCalled();
    expect(screen.getByRole('article', { name: 'Alpha' })).toBeDefined();
  });

  it('waits for committed deletion and updates mounted Projects and Dashboard by rereading', async () => {
    const f = fixture();
    let complete!: () => void;
    const commit = new Promise<void>((resolve) => {
      complete = resolve;
    });
    f.remove.mockImplementation(async () => {
      await commit;
      f.erase();
      return { projectId: 'proj_alpha', deleted: true };
    });
    const list = f.mount(
      <>
        <section aria-label="Project list">
          <Projects />
        </section>
        <section aria-label="Dashboard">
          <Dashboard />
        </section>
      </>,
    );
    const projects = within(list.getByRole('region', { name: 'Project list' }));
    const dashboard = within(list.getByRole('region', { name: 'Dashboard' }));
    await dashboard.findByText('1', { selector: '.metric-value' });
    fireEvent.click(await projects.findByRole('button', { name: 'Remove project Alpha' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove permanently' }),
    );
    await waitFor(() => expect(f.remove).toHaveBeenCalledWith('proj_alpha'));
    expect(projects.getByRole('article', { name: 'Alpha' })).toBeDefined();
    expect((screen.getByRole('button', { name: 'Removing…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    complete();
    await projects.findByText('No projects yet');
    const projectMetric = within(
      dashboard.getByRole('list', { name: 'Workspace metrics' }),
    ).getAllByRole('listitem')[0]!;
    await within(projectMetric).findByText('0', { selector: '.metric-value' });
    expect(projects.queryByRole('article', { name: 'Alpha' })).toBeNull();
    expect(f.api.projects.list.mock.calls.length).toBeGreaterThan(1);
  });

  it('retains the card and shows backend failure without optimistic cache removal', async () => {
    const f = fixture();
    f.remove.mockRejectedValue(
      Object.assign(new Error('Project cannot be deleted while active'), {
        code: 'PROJECT_LOCKED',
      }),
    );
    f.mount(<Projects />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove project Alpha' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove permanently' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Project cannot be deleted while active',
    );
    expect(screen.getByRole('article', { name: 'Alpha' })).toBeDefined();
    expect(f.api.projects.list).toHaveBeenCalledTimes(1);
  });

  it.each(['locked_for_run', 'updating', 'deleting'])(
    'disables removal while state is %s',
    async (state) => {
      const f = fixture(state);
      f.mount(<Projects />);
      expect(
        ((await screen.findByRole('button', { name: 'Remove project Alpha' })) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(f.remove).not.toHaveBeenCalled();
    },
  );

  it('offers removal from project detail and navigates to the updated list', async () => {
    const f = fixture();
    render(
      <QueryClientProvider client={f.client}>
        <MemoryRouter initialEntries={['/projects/proj_alpha']}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectDetail />} />
            <Route path="/projects" element={<Projects />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Remove project Alpha' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove permanently' }),
    );
    await screen.findByText('No projects yet');
    expect(f.remove).toHaveBeenCalledWith('proj_alpha');
    expect(screen.queryByText('/original/Alpha')).toBeNull();
  });
});
