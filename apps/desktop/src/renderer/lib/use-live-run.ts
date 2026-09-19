import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sentryApi } from './sentry-api.js';

const RUN_TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);
const RETEST_TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);

export function useRunSnapshot(runId: string | undefined, pollMs = 750) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['run', runId],
    queryFn: () => sentryApi().runs.get(runId as string),
    enabled: runId !== undefined,
    // TanStack Query v5: refetchInterval receives the query, not the data.
    refetchInterval: (query) => {
      const status = (query.state.data as { run?: { status?: string } } | undefined)?.run?.status;
      if (status !== undefined && RUN_TERMINAL.has(status)) return false;
      return pollMs;
    },
  });
  useEffect(() => {
    if (runId === undefined || window.sentry?.subscribe === undefined) return;
    void sentryApi()
      .runs.get(runId)
      .catch(() => undefined);
    const unsubscribe = window.sentry.subscribe.onRunUpdate((payload) => {
      if (payload.runId !== runId) return;
      if (payload.kind === 'run-snapshot' && payload.snapshot !== undefined) {
        queryClient.setQueryData(['run', runId], payload.snapshot);
      }
      if (payload.kind === 'run-created' && payload.runId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: ['run', payload.runId] });
      }
    });
    return unsubscribe;
  }, [runId, queryClient]);
  return query;
}

export function useRetestSnapshot(retestRunId: string | undefined, pollMs = 750) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['retest', retestRunId],
    queryFn: () => sentryApi().retests.get(retestRunId as string),
    enabled: retestRunId !== undefined,
    refetchInterval: (query) => {
      const status = (query.state.data as { retestRun?: { status?: string } } | undefined)
        ?.retestRun?.status;
      if (status !== undefined && RETEST_TERMINAL.has(status)) return false;
      return pollMs;
    },
  });
  useEffect(() => {
    if (retestRunId === undefined || window.sentry?.subscribe === undefined) return;
    const unsubscribe = window.sentry.subscribe.onRunUpdate((payload) => {
      if (payload.retestRunId !== retestRunId) return;
      if (payload.kind === 'retest-snapshot' && payload.snapshot !== undefined) {
        queryClient.setQueryData(['retest', retestRunId], payload.snapshot);
      }
    });
    return unsubscribe;
  }, [retestRunId, queryClient]);
  return query;
}
