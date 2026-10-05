import { useMemo, type ReactNode } from "react";
import { createArthurClient } from "../client";
import type { ArthurClient } from "../client/arthur-client";
import { AutoOrganize } from "../features/capture/AutoOrganize";
import { CapturesProvider } from "../features/capture/captures-context";
import { GraphProvider } from "../features/graph/graph-context";
import { KnowledgeProvider } from "../features/knowledge/knowledge-context";
import { LineageSummariesProvider } from "../features/lineage/lineage-summaries";
import { ProjectsProvider } from "../features/projects/projects-context";
import { ProjectScopeSync } from "../features/projects/ProjectScopeSync";
import { ArthurClientContext } from "../hooks/use-arthur-client";
import { NavigationProvider, type Screen } from "./navigation";

interface ArthurProvidersProps {
  /** Overrides the platform-selected client. Used by tests. */
  client?: ArthurClient;
  /** Screen shown first. Used by tests. */
  initialScreen?: Screen;
  children: ReactNode;
}

export function ArthurProviders({ client, initialScreen, children }: ArthurProvidersProps) {
  const resolved = useMemo(() => client ?? createArthurClient(), [client]);
  return (
    <ArthurClientContext.Provider value={resolved}>
      <ProjectsProvider>
        <CapturesProvider>
          <KnowledgeProvider>
            <GraphProvider>
              <LineageSummariesProvider>
                <NavigationProvider {...(initialScreen ? { initialScreen } : {})}>
                  <ProjectScopeSync />
                  <AutoOrganize />
                  {children}
                </NavigationProvider>
              </LineageSummariesProvider>
            </GraphProvider>
          </KnowledgeProvider>
        </CapturesProvider>
      </ProjectsProvider>
    </ArthurClientContext.Provider>
  );
}
