import React from 'react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRunSnapshot, useRetestSnapshot } from '../../src/renderer/lib/use-live-run.js';
import type { RunUpdateCallback, RunUpdatePayload } from '../../src/shared/ipc-contract.js';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const listeners = new Set<RunUpdateCallback>();
  const getRun = vi.fn(async (id: string) => run(id, 'completed'));
  const getRetest = vi.fn(async (id: string) => retest(id, 'completed'));
  const start = vi.fn();
  const runtimeStatus = vi.fn(async () => ({ connected: false }));
  vi.stubGlobal('sentry', {
    runs: { get: getRun, start, startProduction: start },
    retests: { get: getRetest, start },
    runtime: { status: runtimeStatus },
    subscribe: {
      onRunUpdate: (cb: RunUpdateCallback) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
  });
  return {
    client,
    getRun,
    getRetest,
    start,
    runtimeStatus,
    listeners,
    emit: (payload: RunUpdatePayload) => act(() => listeners.forEach((cb) => cb(payload))),
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

function run(id: string, status: string) {
  return {
    run: { id, status },
    agentRuns: [],
    findings: [{ id: 'retained' }],
    evidence: [],
    activities: [],
    events: [],
    mergeResults: [],
    verificationRuns: [],
    issues: [],
  };
}
function retest(id: string, status: string) {
  return { retestRun: { id, status }, assessments: [] };
}

describe('canonical live snapshots', () => {
  it('uses an old run notification only as a hint, retaining terminal data while canonical read is pending', async () => {
    const s = setup();
    const hook = renderHook(() => useRunSnapshot('r'), { wrapper: s.wrapper });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    const before = s.getRun.mock.calls.length;
    let resolve!: (value: ReturnType<typeof run>) => void;
    s.getRun.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    s.emit({ kind: 'run-snapshot', runId: 'r', snapshot: run('r', 'agents_running') });
    expect((hook.result.current.data?.run as { status: string }).status).toBe('completed');
    await waitFor(() => expect(s.getRun.mock.calls.length).toBeGreaterThan(before));
    await act(async () => resolve(run('r', 'completed')));
    await waitFor(() => expect(hook.result.current.isFetching).toBe(false));
    expect(hook.result.current.data?.findings).toEqual([{ id: 'retained' }]);
    expect(s.start).not.toHaveBeenCalled();
  });

  it('does not install a retest notification payload over the canonical assessment', async () => {
    const s = setup();
    const hook = renderHook(() => useRetestSnapshot('rt'), { wrapper: s.wrapper });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    s.emit({ kind: 'retest-snapshot', retestRunId: 'rt', snapshot: retest('rt', 'running') });
    await waitFor(() => expect(s.getRetest).toHaveBeenCalledTimes(2));
    expect((hook.result.current.data?.retestRun as { status: string }).status).toBe('completed');
    s.emit({ kind: 'retest-snapshot', retestRunId: 'rt' });
    await waitFor(() => expect(s.getRetest).toHaveBeenCalledTimes(3));
  });

  it.each(['run', 'retest'] as const)(
    'reconciles %s after offline-to-online even with no notification',
    async (kind) => {
      const s = setup();
      s.client.setQueryData(['runtime-status'], { connected: false });
      const hook = renderHook(
        () => (kind === 'run' ? useRunSnapshot('r') : useRetestSnapshot('r')),
        { wrapper: s.wrapper },
      );
      await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
      const get = kind === 'run' ? s.getRun : s.getRetest;
      const before = get.mock.calls.length;
      await act(async () => {
        s.client.setQueryData(['runtime-status'], { connected: true });
      });
      await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
      expect(s.listeners.size).toBe(1);
      expect(s.start).not.toHaveBeenCalled();
    },
  );

  it('cleans up on run switches and unmount, ignoring unrelated hints', async () => {
    const s = setup();
    const hook = renderHook(({ id }) => useRunSnapshot(id), {
      initialProps: { id: 'a' },
      wrapper: s.wrapper,
    });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    hook.rerender({ id: 'b' });
    await waitFor(() => expect(hook.result.current.data?.run).toMatchObject({ id: 'b' }));
    const before = s.getRun.mock.calls.length;
    s.emit({ kind: 'run-snapshot', runId: 'a', snapshot: run('a', 'failed') });
    expect(s.getRun.mock.calls.length).toBe(before);
    expect(s.listeners.size).toBe(1);
    hook.unmount();
    expect(s.listeners.size).toBe(0);
  });

  it('recovers completion and new output missed offline, across repeated reconnects without extra listeners', async () => {
    const s = setup();
    s.getRun.mockResolvedValue(run('r', 'agents_running'));
    const hook = renderHook(() => useRunSnapshot('r'), { wrapper: s.wrapper });
    await waitFor(() =>
      expect(hook.result.current.data?.run).toMatchObject({ status: 'agents_running' }),
    );
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await act(async () => {
        s.client.setQueryData(['runtime-status'], { connected: false });
      });
      const terminal = {
        ...run('r', 'partial'),
        findings: [{ id: 'new finding' }],
        evidence: [{ id: 'retained evidence' }],
      };
      s.getRun.mockResolvedValue(terminal);
      await act(async () => {
        s.client.setQueryData(['runtime-status'], { connected: true });
      });
      await waitFor(() => expect(hook.result.current.data).toEqual(terminal));
      expect(s.listeners.size).toBe(1);
      expect(s.start).not.toHaveBeenCalled();
    }
  });

  it('a late outstanding read cannot replace the newer canonical read triggered by a hint', async () => {
    const s = setup();
    const hook = renderHook(() => useRunSnapshot('r'), { wrapper: s.wrapper });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    let resolveOld!: (value: ReturnType<typeof run>) => void;
    s.getRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = s.client.invalidateQueries({ queryKey: ['run', 'r'] });
    });
    await waitFor(() => expect(resolveOld).toBeDefined());
    s.getRun.mockResolvedValue(run('r', 'partial'));
    s.emit({ kind: 'run-snapshot', runId: 'r', snapshot: run('r', 'agents_running') });
    await waitFor(() => expect(hook.result.current.data?.run).toMatchObject({ status: 'partial' }));
    await act(async () => {
      resolveOld(run('r', 'agents_running'));
      await pending;
    });
    expect(hook.result.current.data?.run).toMatchObject({ status: 'partial' });
  });

  it('stops polling terminal runs and does not perform a discarded duplicate initial read', async () => {
    const s = setup();
    const hook = renderHook(() => useRunSnapshot('r', 100), { wrapper: s.wrapper });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(s.getRun).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(s.getRun).toHaveBeenCalledTimes(1);
  });

  it('polls a nonterminal run in the background and stops when its canonical read becomes terminal', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.runtimeStatus.mockResolvedValue({ connected: true });
    s.getRun.mockResolvedValue(run('r', 'agents_running'));
    const hook = renderHook(() => useRunSnapshot('r', 100), { wrapper: s.wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(hook.result.current.isSuccess && !hook.result.current.runtimeUnavailable).toBe(true);
    focusManager.setFocused(false);
    const before = s.getRun.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(s.getRun.mock.calls.length).toBeGreaterThan(before);
    s.getRun.mockResolvedValue(run('r', 'completed'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(hook.result.current.data?.run).toMatchObject({ status: 'completed' });
    const terminalReads = s.getRun.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(s.getRun.mock.calls.length).toBe(terminalReads);
  });
});
