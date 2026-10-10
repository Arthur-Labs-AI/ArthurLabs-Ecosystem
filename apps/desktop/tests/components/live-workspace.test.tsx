import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunWorkspace } from '../../src/renderer/pages/RunWorkspace.js';
import { AgentInspector } from '../../src/renderer/components/AgentInspector.js';
import { RunSummaryPanel } from '../../src/renderer/components/RunSummaryPanel.js';
import { RetestWorkspace } from '../../src/renderer/pages/RetestWorkspace.js';
import { AppShell } from '../../src/renderer/components/AppShell.js';
import { makeAgentNodeView } from '../fixtures.js';

vi.mock('../../src/renderer/components/RunCanvas.js', () => ({
  RunCanvas: ({
    nodes,
    onSelect,
  }: {
    nodes: Array<{ id: string; label: string }>;
    onSelect: (id: string) => void;
  }) => (
    <div>
      {nodes.map((node) => (
        <button key={node.id} onClick={() => onSelect(node.id)}>
          {node.label} canvas
        </button>
      ))}
    </div>
  ),
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

const stacks = ['stack_opencode_main', 'stack_deepseek_main', 'stack_glm_main'];
function snapshot(status = 'agents_running') {
  return {
    run: {
      id: 'r',
      projectId: 'p',
      mode: 'full',
      status,
      snapshotId: 's',
      executionKind: 'production',
      createdAt: '2026-10-10T00:00:00Z',
      configuration: { agentStackIds: stacks },
    },
    agentRuns: stacks.map((agentStackId, index) => ({
      id: 'a' + index,
      qaRunId: 'r',
      agentStackId,
      status: 'completed',
    })),
    findings: [{ id: 'f', agentRunId: 'a0', title: 'Retained finding', severity: 'high' }],
    evidence: [],
    events: [],
    activities: [],
    mergeResults: [],
    verificationRuns: [],
    issues: [],
  };
}
function workspace(data = snapshot()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(['run', 'r'], data);
  const get = vi.fn(async () => data);
  const exportSave = vi.fn(
    async (): Promise<{ status: 'cancelled' } | { status: 'saved'; path: string }> => ({
      status: 'cancelled',
    }),
  );
  vi.stubGlobal('sentry', {
    runs: { get, exportSave, revealExport: vi.fn(), cancel: vi.fn() },
    projects: { get: vi.fn(async () => ({ name: 'Fixture project' })) },
    runtime: { status: vi.fn(async () => ({ connected: true })) },
    subscribe: { onRunUpdate: () => () => undefined },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs/r']}>
        <Routes>
          <Route path="/runs/:runId" element={<RunWorkspace />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, get, exportSave };
}

describe('truthful run workspace', () => {
  it('switches agent inspectors and never shows a peer finding under another agent', async () => {
    const data = snapshot();
    data.findings.push({ id: 'peer', agentRunId: 'a1', title: 'DeepSeek only', severity: 'low' });
    workspace(data);
    fireEvent.click(screen.getByRole('button', { name: /OpenCode canvas/ }));
    fireEvent.click(screen.getByRole('tab', { name: /Findings/ }));
    expect(screen.getByText('Retained finding')).toBeTruthy();
    expect(screen.queryByText('DeepSeek only')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /DeepSeek canvas/ }));
    expect(screen.getByText('DeepSeek QA')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Findings/ }));
    expect(screen.getByText('DeepSeek only')).toBeTruthy();
    expect(screen.queryByText('Retained finding')).toBeNull();
  });

  it('retains the historical retest assessment after a failed refresh', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const data = {
      retestRun: {
        id: 'rt',
        status: 'completed',
        sourceProjectRevisionId: 'old',
        targetProjectRevisionId: 'new',
      },
      assessments: [{ result: 'fixed' }],
    };
    client.setQueryData(['retest', 'rt'], data);
    const get = vi.fn(async () => data);
    vi.stubGlobal('sentry', {
      retests: { get },
      runtime: { status: vi.fn(async () => ({ connected: true })) },
      subscribe: { onRunUpdate: () => () => undefined },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/retests/rt']}>
          <Routes>
            <Route path="/retests/:retestRunId" element={<RetestWorkspace />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(client.getQueryState(['retest', 'rt'])?.fetchStatus).toBe('idle'));
    get.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['retest', 'rt'] });
    });
    expect(screen.getByText('FIXED')).toBeTruthy();
    expect(await screen.findByText(/Cached results remain available/)).toBeTruthy();
  });

  it('a status query error does not leave a cached connected indicator or claim no active runs', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    client.setQueryData(['runtime-status'], { connected: true });
    const status = vi.fn(async () => ({ connected: true }));
    vi.stubGlobal('sentry', { runtime: { status }, system: { activeRuns: vi.fn(async () => []) } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AppShell />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(status).toHaveBeenCalled());
    status.mockRejectedValue(new Error('private transport diagnostic'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['runtime-status'] });
    });
    await waitFor(() => expect(screen.queryByText('Runtime connected')).toBeNull());
    expect(screen.getByText('Runtime offline')).toBeTruthy();
    expect(screen.getByText(/Active runs unavailable/)).toBeTruthy();
    expect(screen.queryByText('private transport diagnostic')).toBeNull();
  });
  it('keeps cached results and selected inspector after a communication error, then reconciles', async () => {
    const s = workspace();
    fireEvent.click(screen.getByRole('button', { name: /OpenCode canvas/ }));
    expect(screen.getByText('OpenCode QA')).toBeTruthy();
    s.get.mockRejectedValue(new Error('transport unavailable'));
    await act(async () => {
      await s.client.invalidateQueries({ queryKey: ['run', 'r'] });
    });
    await waitFor(() => expect(s.client.getQueryState(['run', 'r'])?.status).toBe('error'));
    expect(screen.getByText('OpenCode QA')).toBeTruthy();
    expect(screen.getByText(/Cached results remain available/)).toBeTruthy();
    s.get.mockResolvedValue(snapshot('partial'));
    await act(async () => {
      await s.client.invalidateQueries({ queryKey: ['run', 'r'] });
    });
    await waitFor(() => expect(screen.queryByText(/Cached results remain available/)).toBeNull());
    expect(screen.getByText('OpenCode QA')).toBeTruthy();
  });

  it.each(['cancelled', 'saved', 'failure'] as const)(
    'export %s reports only the confirmed outcome',
    async (outcome) => {
      const s = workspace(snapshot('completed'));
      if (outcome === 'saved')
        s.exportSave.mockResolvedValue({ status: 'saved', path: '/saved/report.json' });
      if (outcome === 'failure')
        s.exportSave.mockRejectedValue(new Error('destination is read-only'));
      fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
      await waitFor(() => expect(s.exportSave).toHaveBeenCalledWith('r', 'json'));
      if (outcome === 'saved') expect(await screen.findByText('JSON exported')).toBeTruthy();
      if (outcome === 'failure')
        expect(await screen.findByText('destination is read-only')).toBeTruthy();
      if (outcome === 'cancelled') {
        await act(async () => undefined);
        expect(screen.queryByText('JSON exported')).toBeNull();
        expect(screen.queryByText('Action failed')).toBeNull();
      }
    },
  );

  it.each([1, 2, 3])(
    'overview includes all %i selected agents even before workers exist',
    (count) => {
      const data = snapshot();
      data.run.configuration.agentStackIds = stacks.slice(0, count);
      data.agentRuns = [];
      render(<RunSummaryPanel snapshot={data} />);
      expect(screen.getByText(`${count} selected`)).toBeTruthy();
      expect(
        within(screen.getByRole('region', { name: 'Results by agent' })).getAllByRole('button'),
      ).toHaveLength(count);
    },
  );
  it('terminal startup failure does not call unstarted agents waiting', () => {
    const data = snapshot('failed');
    data.agentRuns = [];
    render(<RunSummaryPanel snapshot={data} />);
    expect(screen.queryByText(/agents are waiting/)).toBeNull();
    expect(screen.getAllByText('Not started')).toHaveLength(3);
  });
});

describe('independent partial agent reports', () => {
  it.each(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'])(
    '%s zero findings has terminal context',
    (status) => {
      render(
        <AgentInspector
          data={{
            view: makeAgentNodeView({ status, findingsCount: 0 }),
            findings: [],
            evidence: [],
          }}
          initialTab="findings"
        />,
      );
      expect(screen.queryByText(/this agent yet/)).toBeNull();
      expect(
        screen.getByText(
          status === 'completed'
            ? /Completed with no reported findings/
            : /No findings were reported before/,
        ),
      ).toBeTruthy();
    },
  );
  it.each(['failed', 'cancelled', 'timed_out', 'interrupted'])(
    '%s retains partial findings with clear context',
    (status) => {
      render(
        <AgentInspector
          data={{
            view: makeAgentNodeView({ status }),
            findings: [{ id: 'f', title: 'Retained finding', severity: 'high' }],
            evidence: [],
          }}
          initialTab="findings"
        />,
      );
      expect(screen.getByText('Retained finding')).toBeTruthy();
      expect(screen.getByText(/Partial report/)).toBeTruthy();
    },
  );
});
