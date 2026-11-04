import { createContext, useContext, type ReactNode } from "react";
import { useGraph, type GraphState } from "./use-graph";

const GraphContext = createContext<GraphState | null>(null);

/** One shared set of relations, so Home, Ideas, Connections and the inspectors always agree on the graph. */
export function GraphProvider({ children }: { children: ReactNode }) {
  return <GraphContext.Provider value={useGraph()}>{children}</GraphContext.Provider>;
}

export function useGraphState(): GraphState {
  const state = useContext(GraphContext);
  if (!state) throw new Error("useGraphState must be used inside <ArthurProviders>");
  return state;
}
