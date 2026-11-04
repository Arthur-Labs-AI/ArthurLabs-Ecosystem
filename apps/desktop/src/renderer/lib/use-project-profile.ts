import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectProfileStatus } from '../../shared/ipc-contract.js';
import { sentryApi } from './sentry-api.js';

const POLL_WHILE_BUILDING_MS = 3000;

/** Each agent's profile of the project; refreshes by itself while an agent is still writing. */
export function useProjectProfile(projectId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ['project-profile', projectId];
  const status = useQuery({
    queryKey,
    queryFn: () => sentryApi().projects.profile(projectId as string),
    enabled: projectId !== undefined,
    refetchInterval: (query) =>
      (query.state.data as ProjectProfileStatus | undefined)?.agents.some((agent) => agent.building)
        ? POLL_WHILE_BUILDING_MS
        : false,
  });
  const build = useMutation({
    mutationFn: (agentStackIds?: string[]) =>
      sentryApi().projects.buildProfile(projectId as string, agentStackIds),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  return { status, build };
}
