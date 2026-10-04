import { createContext, useContext, type ReactNode } from "react";
import { useCapturesState, type CapturesState } from "./use-captures";

const CapturesContext = createContext<CapturesState | null>(null);

/** One shared captures state, so every panel sees the same list and the same recording. */
export function CapturesProvider({ children }: { children: ReactNode }) {
  return <CapturesContext.Provider value={useCapturesState()}>{children}</CapturesContext.Provider>;
}

export function useCaptures(): CapturesState {
  const state = useContext(CapturesContext);
  if (!state) throw new Error("useCaptures must be used inside <ArthurProviders>");
  return state;
}
