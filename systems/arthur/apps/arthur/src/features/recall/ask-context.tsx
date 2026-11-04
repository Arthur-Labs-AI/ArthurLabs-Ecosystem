import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MAX_QUERY_CHARS, type CognitiveAnswer, type CognitiveQuery, type Project } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { useProjects } from "../projects/projects-context";

/**
 * Ask Arthur's one screen state. It lives in memory only: no question, answer or evidence is written anywhere, and a new
 * session starts empty. It survives moving between screens (and resizing across the Desktop/Mobile breakpoint) because it is
 * the same Ask, but it never survives a change of project: an answer belongs to the project it was asked in.
 *
 * This is the only place that builds a `CognitiveQuery`, so the scope is always the active project's id and can never be omitted.
 */
export type AskState =
  | { status: "idle" }
  | { status: "loading"; query: string; project: Project }
  | { status: "ready"; project: Project; answer: CognitiveAnswer; totalMs: number }
  | { status: "error"; query: string; project: Project; message: string; code: string | null };

export interface AskContextValue {
  /** The project a question will be asked in. `null` until projects have loaded. */
  readOnly: boolean;
  project: Project | null;
  state: AskState;
  /** What is in the question box. Kept while the user moves around so a half-written question is not lost. */
  draft: string;
  setDraft: (text: string) => void;
  canAsk: boolean;
  ask: (text?: string) => void;
  /** Abandons the question in flight (the answer, if it arrives, is ignored) or clears a shown result. */
  reset: () => void;
  /** Bumps when something (Mod+K) asks for the question box to take focus. */
  focusTick: number;
  requestFocus: () => void;
}

const Context = createContext<AskContextValue | null>(null);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown): string | null => (typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : null);

export function AskProvider({ children }: { children: ReactNode }) {
  const client = useArthurClient();
  const { active: liveProject, readOnlyProject } = useProjects();
  // The project a question is asked in: the live active project, or an archived one the user explicitly opened read-only.
  const active = readOnlyProject ?? liveProject;
  const [state, setState] = useState<AskState>({ status: "idle" });
  const [draft, setDraft] = useState("");
  const [focusTick, setFocusTick] = useState(0);
  // A request number: a result that arrives after a newer question, a reset or a project change is not shown.
  const current = useRef(0);

  const projectId = active?.id ?? null;
  const previousProject = useRef<string | null>(projectId);
  useEffect(() => {
    // The first project to load is not a change; leaving one project for another is.
    if (previousProject.current !== null && previousProject.current !== projectId) {
      current.current += 1;
      setState({ status: "idle" });
      setDraft("");
    }
    previousProject.current = projectId;
  }, [projectId]);

  const ask = useCallback(
    (text?: string) => {
      const query = (text ?? draft).trim();
      if (!active || query.length === 0 || [...query].length > MAX_QUERY_CHARS) return;
      const ticket = (current.current += 1);
      const project = active;
      const started = typeof performance !== "undefined" ? performance.now() : Date.now();
      setState({ status: "loading", query, project });
      // The explicit, never-omitted scope: the project the user is looking at.
      const request: CognitiveQuery = { query, scope: { projectId: project.id } };
      client.ask(request).then(
        (answer) => {
          if (ticket !== current.current) return;
          const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
          setState({ status: "ready", project, answer, totalMs: Math.round(ended - started) });
        },
        (failure: unknown) => {
          if (ticket !== current.current) return;
          setState({ status: "error", query, project, message: messageOf(failure), code: codeOf(failure) });
        },
      );
    },
    [active, client, draft],
  );

  const reset = useCallback(() => {
    current.current += 1;
    setState({ status: "idle" });
  }, []);
  const requestFocus = useCallback(() => setFocusTick((tick) => tick + 1), []);

  const value = useMemo<AskContextValue>(
    () => ({ project: active, readOnly: readOnlyProject !== null, state, draft, setDraft, canAsk: active !== null && draft.trim().length > 0 && [...draft.trim()].length <= MAX_QUERY_CHARS, ask, reset, focusTick, requestFocus }),
    [active, readOnlyProject, state, draft, ask, reset, focusTick, requestFocus],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAsk(): AskContextValue {
  const value = useContext(Context);
  if (!value) throw new Error("useAsk must be used inside <ArthurProviders>");
  return value;
}
