import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/renderer/components/AppShell.js';
import { RunWorkspace } from '../../src/renderer/pages/RunWorkspace.js';
import { RuntimeSettings } from '../../src/renderer/pages/RuntimeSettings.js';
import { Environment } from '../../src/renderer/pages/Environment.js';

vi.mock('../../src/renderer/components/RunCanvas.js', () => ({
  RunCanvas: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button onClick={() => onSelect('agent-stack_opencode_main')}>Inspect OpenCode</button>
  ),
}));

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function shell(cachedReport = false) {
  const initial = deferred<{ connected: boolean }>();
  const status = vi.fn(() => initial.promise);
  const activeRuns = vi.fn(async () => []);
  const start = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const report = {
    run: {
      id: 'r',
      projectId: 'p',
      mode: 'full',
      status: 'completed',
      snapshotId: 's',
      createdAt: '2026-10-12T00:00:00Z',
      configuration: { agentStackIds: ['stack_opencode_main'] },
    },
    agentRuns: [
      { id: 'a', qaRunId: 'r', agentStackId: 'stack_opencode_main', status: 'completed' },
    ],
    findings: [{ id: 'f', agentRunId: 'a', title: 'Retained report finding', severity: 'high' }],
    evidence: [],
    events: [],
    activities: [],
    mergeResults: [],
    verificationRuns: [],
    issues: [],
  };
  const get = vi.fn(async () => report);
  if (cachedReport) client.setQueryData(['run', 'r'], report);
  vi.stubGlobal('sentry', {
    runtime: { status },
    system: { activeRuns },
    runs: { get, start },
    projects: { get: vi.fn(async () => ({ name: 'Fixture project' })) },
    subscribe: { onRunUpdate: () => () => undefined },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[cachedReport ? '/runs/r' : '/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<p>Workspace</p>} />
            <Route path="/runs/:runId" element={<RunWorkspace />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, initial, status, activeRuns, start, get };
}

const warning = /Runtime communication unavailable/;
describe('runtime connectivity presentation through the real status hook', () => {
  it.each([RuntimeSettings, Environment])(
    '%s also distinguishes initial discovery in runtime detail views',
    async (Page) => {
      const initial = deferred<{ connected: boolean }>();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      clients.push(client);
      client.setQueryData(['environment'], { agentStacks: [] });
      const distros = {
        distros: [{ name: 'Ubuntu', state: 'Running', version: 2 }],
        selected: 'Ubuntu',
        preferred: 'Ubuntu',
      };
      client.setQueryData(['runtime-distros'], distros);
      vi.stubGlobal('sentry', {
        runtime: { status: () => initial.promise, distros: async () => distros },
        doctors: { environment: async () => ({ agentStacks: [] }) },
        cli: { status: async () => ({ started: false, connectedClients: [] }) },
      });
      render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Page />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(screen.getByText('Checking runtime…')).toBeTruthy();
      expect(screen.queryByText(/Runtime Offline/i)).toBeNull();
      expect(screen.queryByText('Offline')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      await act(async () => initial.resolve({ connected: true }));
      expect(
        await screen.findByText(Page === Environment ? 'Runtime connected' : 'Connected'),
      ).toBeTruthy();
    },
  );

  it('shows checking, without an offline warning, while the initial request is pending', () => {
    const s = shell();
    expect(screen.getByText('Checking runtime…')).toBeTruthy();
    expect(screen.queryByText('Runtime offline')).toBeNull();
    expect(screen.queryByText(warning)).toBeNull();
    expect(s.status).toHaveBeenCalledTimes(1);
    expect(s.start).not.toHaveBeenCalled();
  });

  it('shows connected after the initial successful response', async () => {
    const s = shell();
    await act(async () => s.initial.resolve({ connected: true }));
    expect(await screen.findByText('Runtime connected')).toBeTruthy();
    expect(screen.queryByText('Checking runtime…')).toBeNull();
    expect(screen.queryByText(warning)).toBeNull();
  });

  it('shows offline and cached-result guidance after an explicit disconnected response', async () => {
    const s = shell();
    await act(async () => s.initial.resolve({ connected: false }));
    expect(await screen.findByText('Runtime offline')).toBeTruthy();
    expect(screen.getByText(warning).textContent).toContain(
      'No execution is restarted automatically',
    );
    expect(screen.getByRole('link', { name: 'Runtime settings' })).toBeTruthy();
  });

  it('shows unavailable communication after an initial failure without leaking transport details', async () => {
    const s = shell();
    await act(async () => s.initial.reject(new Error('private diagnostic')));
    expect(await screen.findByText('Runtime offline')).toBeTruthy();
    expect(screen.getByText(warning)).toBeTruthy();
    expect(screen.queryByText('Checking runtime…')).toBeNull();
    expect(screen.queryByText('private diagnostic')).toBeNull();
  });

  it('a failed refresh overrides a previously confirmed cached connection', async () => {
    const s = shell();
    await act(async () => s.initial.resolve({ connected: true }));
    await screen.findByText('Runtime connected');
    s.status.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await s.client.invalidateQueries({ queryKey: ['runtime-status'] });
    });
    expect(await screen.findByText('Runtime offline')).toBeTruthy();
    expect(screen.queryByText('Runtime connected')).toBeNull();
    expect(screen.getByText(warning)).toBeTruthy();
    expect(s.client.getQueryData(['runtime-status'])).toEqual({ connected: true });
  });

  it('retains confirmed connectivity during a pending background refetch', async () => {
    const s = shell();
    await act(async () => s.initial.resolve({ connected: true }));
    await screen.findByText('Runtime connected');
    const refresh = deferred<{ connected: boolean }>();
    s.status.mockReturnValue(refresh.promise);
    act(() => {
      void s.client.invalidateQueries({ queryKey: ['runtime-status'] });
    });
    await waitFor(() => expect(s.status).toHaveBeenCalledTimes(2));
    expect(s.client.getQueryState(['runtime-status'])?.fetchStatus).toBe('fetching');
    expect(screen.getByText('Runtime connected')).toBeTruthy();
    expect(screen.queryByText('Checking runtime…')).toBeNull();
    expect(screen.queryByText(warning)).toBeNull();
    await act(async () => refresh.resolve({ connected: true }));
    expect(screen.getByText('Runtime connected')).toBeTruthy();
  });

  it('reconciles read caches once on offline-to-connected without starting execution', async () => {
    const s = shell();
    await act(async () => s.initial.resolve({ connected: false }));
    await screen.findByText('Runtime offline');
    await waitFor(() =>
      expect(s.client.getQueryState(['system', 'active-runs'])?.fetchStatus).toBe('idle'),
    );
    const before = s.activeRuns.mock.calls.length;
    s.status.mockResolvedValue({ connected: true });
    await act(async () => {
      await s.client.invalidateQueries({ queryKey: ['runtime-status'] });
    });
    expect(await screen.findByText('Runtime connected')).toBeTruthy();
    await waitFor(() => expect(s.activeRuns).toHaveBeenCalledTimes(before + 1));
    expect(screen.queryByText(warning)).toBeNull();
    expect(s.start).not.toHaveBeenCalled();
  });

  it('keeps a cached completed run report readable during unavailable communication', async () => {
    const s = shell(true);
    await act(async () => s.initial.resolve({ connected: false }));
    expect(await screen.findByText('Runtime offline')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect OpenCode' }));
    fireEvent.click(screen.getByRole('tab', { name: /Findings/ }));
    expect(screen.getByText('Retained report finding')).toBeTruthy();
    expect(screen.getByText(warning)).toBeTruthy();
    expect(s.client.getQueryData(['run', 'r'])).toMatchObject({ run: { status: 'completed' } });
    expect(s.start).not.toHaveBeenCalled();
  });
});
