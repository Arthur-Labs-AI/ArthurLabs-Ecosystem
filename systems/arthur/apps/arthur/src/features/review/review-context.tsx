import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ClaimOutcome, ResolveClaimInput, ReviewOutcome, ReviewProposalInput, RevisionProposal, UnresolvedClaim } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { useKnowledge } from "../knowledge/knowledge-context";
import { useProjects } from "../projects/projects-context";

export interface ReviewState {
  status: "loading" | "ready" | "error";
  /** Suggestions still waiting for a decision (open or deferred), oldest first. */
  suggestions: RevisionProposal[];
  /**
   * Notes that are waiting for an explicit decision and have NO usable suggested text: Arthur could not tell which idea they belong to,
   * the check refused the text, or the suggestion was dismissed. Nothing is invented for them.
   */
  waiting: UnresolvedClaim[];
  /** Everything that needs the person: suggestions plus waiting notes. Shown as the badge. */
  count: number;
  error: string | null;
  /** How many notes of this capture are waiting (suggested or not), so a capture never reads "nothing to structure" while one is held. */
  heldFor: (captureId: string) => number;
  /** Applies one decision. Rejects with an `EvolutionError`. The queue, the ideas and their histories are re-read afterwards. */
  review: (input: ReviewProposalInput) => Promise<ReviewOutcome>;
  resolveClaim: (input: ResolveClaimInput) => Promise<ClaimOutcome>;
  refresh: () => Promise<void>;
}

const ReviewContext = createContext<ReviewState | null>(null);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The review queue of the ACTIVE project. Reading it is local and works with the feature switched off and offline: a suggestion made
 * earlier stays reviewable. It is re-read when the project changes, after an organize run, and after every decision.
 */
export function ReviewProvider({ children }: { children: ReactNode }) {
  const client = useArthurClient();
  const { activeProjectId, dataVersion } = useProjects();
  const { refresh: refreshKnowledge, distilledVersion } = useKnowledge();
  const [status, setStatus] = useState<ReviewState["status"]>("loading");
  const [suggestions, setSuggestions] = useState<RevisionProposal[]>([]);
  const [claims, setClaims] = useState<UnresolvedClaim[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scope = useRef<string | null>(activeProjectId);
  scope.current = activeProjectId;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const projectId = scope.current;
    if (projectId === null) return;
    try {
      const [proposals, unresolved] = await Promise.all([client.listRevisionProposals({ projectId, states: ["open", "deferred"] }), client.listUnresolvedClaims({ projectId })]);
      // A project switch while this was in flight: what arrived belongs to the previous project and is dropped.
      if (!alive.current || scope.current !== projectId) return;
      setSuggestions(proposals);
      setClaims(unresolved);
      setError(null);
      setStatus("ready");
    } catch (failure) {
      if (!alive.current || scope.current !== projectId) return;
      setError(messageOf(failure));
      setStatus("error");
    }
  }, [client]);

  // Only a switch to ANOTHER project clears the list (never show the previous project's items). A re-read for any other reason (an organize
  // run, a move, a decision) replaces the list in place, so what the person is looking at, and any text they are typing, is not torn down.
  const shownScope = useRef<string | null>(null);
  useEffect(() => {
    if (activeProjectId === null) return;
    if (shownScope.current !== activeProjectId) {
      shownScope.current = activeProjectId;
      setSuggestions([]);
      setClaims([]);
      setStatus("loading");
    }
    void load();
  }, [activeProjectId, dataVersion, distilledVersion, load]);

  const afterDecision = useCallback(async () => {
    await Promise.all([load(), refreshKnowledge()]);
  }, [load, refreshKnowledge]);

  const review = useCallback(
    async (input: ReviewProposalInput): Promise<ReviewOutcome> => {
      try {
        return await client.reviewRevisionProposal(input);
      } finally {
        // Whatever happened (applied, refused as stale, resolved by someone else), show what is stored now.
        await afterDecision();
      }
    },
    [client, afterDecision],
  );

  const resolveClaim = useCallback(
    async (input: ResolveClaimInput): Promise<ClaimOutcome> => {
      try {
        return await client.resolveUnresolvedClaim(input);
      } finally {
        await afterDecision();
      }
    },
    [client, afterDecision],
  );

  const waiting = useMemo(() => claims.filter((entry) => entry.proposalId === null || entry.proposalState === "rejected" || entry.proposalState === "superseded"), [claims]);
  const heldFor = useCallback((captureId: string) => claims.filter((entry) => entry.claim.captureId === captureId).length, [claims]);
  const value = useMemo<ReviewState>(
    () => ({ status, suggestions, waiting, count: suggestions.length + waiting.length, error, heldFor, review, resolveClaim, refresh: load }),
    [status, suggestions, waiting, error, heldFor, review, resolveClaim, load],
  );
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}

export function useReview(): ReviewState {
  const value = useContext(ReviewContext);
  if (!value) throw new Error("useReview must be used inside <ArthurProviders>");
  return value;
}
