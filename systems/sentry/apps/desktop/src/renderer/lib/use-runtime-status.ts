import { useQuery } from '@tanstack/react-query';
import { sentryApi } from './sentry-api.js';

/** A pending refresh preserves confirmed data; errors override stale data. */
export function runtimeConnectionState(runtime: {
  isError: boolean;
  data?: { connected: boolean } | undefined;
}): 'checking' | 'connected' | 'unavailable' {
  if (runtime.isError || runtime.data?.connected === false) return 'unavailable';
  return runtime.data?.connected === true ? 'connected' : 'checking';
}

/** Connectivity is communication state, never a QA outcome. */
export function useRuntimeStatus() {
  return useQuery({
    queryKey: ['runtime-status'],
    queryFn: () => sentryApi().runtime.status(),
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
    retry: false,
  });
}
