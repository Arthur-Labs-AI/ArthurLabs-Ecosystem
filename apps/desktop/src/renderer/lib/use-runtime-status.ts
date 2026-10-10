import { useQuery } from '@tanstack/react-query';
import { sentryApi } from './sentry-api.js';

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
