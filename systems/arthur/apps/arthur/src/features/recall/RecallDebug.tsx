import type { CognitiveAnswer } from "@arthur/contracts";

/**
 * Developer-only details: timings, counts and per-entry scores. Normal users never see any of it. It is switched on from the
 * console (`localStorage.setItem("arthur.recall.debug", "1")`), is read-only, and shows structural facts only (the diagnostics
 * the backend already guarantees contain no stored text).
 */
export function recallDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem("arthur.recall.debug") === "1";
  } catch {
    return false;
  }
}

export function RecallDebug({ answer, totalMs }: { answer: CognitiveAnswer; totalMs: number }) {
  if (!recallDebugEnabled()) return null;
  const d = answer.diagnostics;
  return (
    <details className="ask-debug">
      <summary>Developer details</summary>
      <pre>
        {JSON.stringify(
          {
            totalMs,
            outcome: answer.outcome,
            retrieval: d.retrieval,
            synthesis: d.synthesis,
            timings: d.timings,
            counts: d.counts,
            context: d.context && { estimatedTokens: d.context.estimatedTokens, entriesIncluded: d.context.entriesIncluded, dropped: d.context.dropped },
            evidence: answer.evidence.map((entry) => ({ handle: entry.handle, role: entry.role, level: entry.strength.level, points: entry.strength.points, cited: entry.cited, inContext: entry.inContext })),
          },
          null,
          2,
        )}
      </pre>
    </details>
  );
}
