import { createContext, useContext, type ReactNode } from "react";
import { useProjectsState, type ProjectsState } from "./use-projects";

const ProjectsContext = createContext<ProjectsState | null>(null);

/**
 * The single source of truth for which project Arthur is looking at. Desktop and Mobile read it from here; no screen
 * keeps its own copy, and the captures, ideas and graph states re-read when it changes.
 */
export function ProjectsProvider({ children }: { children: ReactNode }) {
  return <ProjectsContext.Provider value={useProjectsState()}>{children}</ProjectsContext.Provider>;
}

export function useProjects(): ProjectsState {
  const state = useContext(ProjectsContext);
  if (!state) throw new Error("useProjects must be used inside <ArthurProviders>");
  return state;
}
