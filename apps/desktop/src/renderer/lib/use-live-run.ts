import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sentryApi } from './sentry-api.js';
import { useRuntimeStatus } from './use-runtime-status.js';

const RUN_TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);
const RETEST_TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);

function useSnapshotConnection(kind: 'run' | 'retest', id: string | undefined) {
  const runtime = useRuntimeStatus();
  const queryClient = useQueryClient();
  const unavailable = runtime.isError || runtime.data?.connected === false;
  const connected = !runtime.isError && runtime.data?.connected === true;
  const wasUnavailable = useRef(false);
  useEffect(() => {
    if (unavailable) wasUnavailable.current = true;
    if (connected && wasUnavailable.current) {
      wasUnavailable.current = false;
      if (id !== undefined)
        void queryClient.invalidateQueries({ queryKey: [kind, id], exact: true });
    }
  }, [connected, unavailable, id, kind, queryClient]);
  return unavailable;
}

export function useRunSnapshot(runId: string | undefined, pollMs = 750) {
  const queryClient = useQueryClient();
  const runtimeUnavailable = useSnapshotConnection('run', runId);
  const query = useQuery({
    queryKey: ['run', runId],
    queryFn: () => sentryApi().runs.get(runId as string),
    enabled: runId !== undefined,
    refetchIntervalInBackground: true,
    // TanStack Query v5: refetchInterval receives the query, not the data.
    refetchInterval: (query) => {
      if (runtimeUnavailable) return false;
      const status = (query.state.data as { run?: { status?: string } } | undefined)?.run?.status;
      if (status !== undefined && RUN_TERMINAL.has(status)) return false;
      return pollMs;
    },
  });
  useEffect(() => {
    if (runId === undefined || window.sentry?.subscribe === undefined) return;
    const unsubscribe = window.sentry.subscribe.onRunUpdate((payload) => {
      if (payload.runId !== runId) return;
      if (payload.kind === 'run-snapshot') {
        // Notifications are unordered hints, not canonical cache writes.
        void queryClient.invalidateQueries({ queryKey: ['run', runId], exact: true });
      }
      if (payload.kind === 'run-created' && payload.runId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: ['run', payload.runId] });
      }
    });
    return unsubscribe;
  }, [runId, queryClient]);
  return { ...query, runtimeUnavailable };
}

export function useRetestSnapshot(retestRunId: string | undefined, pollMs = 750) {
  const queryClient = useQueryClient();
  const runtimeUnavailable = useSnapshotConnection('retest', retestRunId);
  const query = useQuery({
    queryKey: ['retest', retestRunId],
    queryFn: () => sentryApi().retests.get(retestRunId as string),
    enabled: retestRunId !== undefined,
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      if (runtimeUnavailable) return false;
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
      if (payload.kind === 'retest-snapshot' || payload.kind === 'retest-created') {
        void queryClient.invalidateQueries({ queryKey: ['retest', retestRunId], exact: true });
      }
    });
    return unsubscribe;
  }, [retestRunId, queryClient]);
  return { ...query, runtimeUnavailable };
}
