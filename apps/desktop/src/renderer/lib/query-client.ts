import { QueryClient } from '@tanstack/react-query';

export function createDesktopQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: true,
        staleTime: 1000,
      },
    },
  });
}
