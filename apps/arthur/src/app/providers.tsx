import { useMemo, type ReactNode } from "react";
import { createArthurClient } from "../client";
import type { ArthurClient } from "../client/arthur-client";
import { CapturesProvider } from "../features/capture/captures-context";
import { ArthurClientContext } from "../hooks/use-arthur-client";

interface ArthurProvidersProps {
  /** Overrides the platform-selected client. Used by tests. */
  client?: ArthurClient;
  children: ReactNode;
}

export function ArthurProviders({ client, children }: ArthurProvidersProps) {
  const resolved = useMemo(() => client ?? createArthurClient(), [client]);
  return (
    <ArthurClientContext.Provider value={resolved}>
      <CapturesProvider>{children}</CapturesProvider>
    </ArthurClientContext.Provider>
  );
}
