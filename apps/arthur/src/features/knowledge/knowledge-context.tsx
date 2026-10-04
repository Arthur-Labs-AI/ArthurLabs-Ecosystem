import { createContext, useContext, type ReactNode } from "react";
import { useKnowledgeState, type KnowledgeState } from "./use-knowledge";

const KnowledgeContext = createContext<KnowledgeState | null>(null);

/** One shared knowledge state, so the Knowledge panel and the Cognitive Graph always see the same objects. */
export function KnowledgeProvider({ children }: { children: ReactNode }) {
  return <KnowledgeContext.Provider value={useKnowledgeState()}>{children}</KnowledgeContext.Provider>;
}

export function useKnowledge(): KnowledgeState {
  const state = useContext(KnowledgeContext);
  if (!state) throw new Error("useKnowledge must be used inside <ArthurProviders>");
  return state;
}
