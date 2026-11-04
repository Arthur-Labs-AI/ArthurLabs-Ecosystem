import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sentryApi } from './sentry-api.js';
import { useRuntimeStatus } from './use-runtime-status.js';

const RUN_TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);

function useSnapshotConnection(id: string | undefined) {
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
        void queryClient.invalidateQueries({ queryKey: ['run', id], exact: true });
    }
  }, [connected, unavailable, id, queryClient]);
  return unavailable;
}

export function useRunSnapshot(runId: string | undefined, pollMs = 750) {
  const queryClient = useQueryClient();
  const runtimeUnavailable = useSnapshotConnection(runId);
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
