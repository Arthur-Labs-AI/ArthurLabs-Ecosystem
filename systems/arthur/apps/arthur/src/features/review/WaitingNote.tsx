import { useState } from "react";
import type { UnresolvedClaim } from "@arthur/contracts";
import { EvolutionError } from "../../client/arthur-client";
import { KindGlyph } from "../../components/icons";
import { relativeAge } from "../../components/format";
import { SourceQuote } from "../../components/SourceQuote";
import { reasonLines } from "./review-copy";
import { useReview } from "./review-context";
import { useCapturesById } from "./use-captures-by-id";
import type { Notice, Variant } from "./ProposalDetail";

/**
 * A note that is waiting for a decision and has NO suggested text (Arthur couldn't tell which idea it belongs to, the check refused
 * the text, or the suggestion was dismissed). Nothing is invented for it: the person keeps it as its own idea, leaves it for later,
 * or opens one of the ideas it might belong to and edits that idea themselves.
 */
export function WaitingNote({ entry, variant, onNotice, onOpenIdea }: { entry: UnresolvedClaim; variant: Variant; onNotice: (notice: Notice) => void; onOpenIdea?: (objectId: string) => void }) {
  const { resolveClaim } = useReview();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { captures, ready: capturesReady } = useCapturesById([entry.claim.captureId]);
  const b = variant === "mobile" ? { plain: "m-pbtn", ghost: "m-pbtn ghost", primary: "m-pbtn primary" } : { plain: "btn", ghost: "btn ghost", primary: "btn primary" };
  const lines = reasonLines(entry.claim.reasons);

  async function decide(action: "keep_separate" | "defer" | "reopen", done: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await resolveClaim({ pendingId: entry.claim.pendingId, action });
      onNotice({ kind: "ok", text: outcome.applied ? done : "That was already decided." });
    } catch (failure) {
      setError(failure instanceof EvolutionError ? failure.message : failure instanceof Error ? failure.message : "That could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rv-detail" data-variant={variant} aria-label={`Waiting note: ${entry.claim.title}`}>
      <header className="rv-head">
        <KindGlyph kind={entry.claim.kind} />
        <div>
          <h2 className="serif">{entry.claim.title}</h2>
          <p className="rv-sub">
            Waiting for your decision · {entry.claim.state === "deferred" ? "Later · " : ""}
            <time dateTime={entry.createdAt}>{relativeAge(entry.createdAt)}</time>
          </p>
        </div>
      </header>

      <p className="rv-note" role="note">
        Arthur has no suggested text for this note. Your words are saved exactly as you said them.
      </p>

      <section className="rv-sec" aria-labelledby={`rv-note-${entry.claim.pendingId}`}>
        <h3 id={`rv-note-${entry.claim.pendingId}`}>Your note</h3>
        {capturesReady ? <SourceQuote capture={captures.get(entry.claim.captureId)} provenance={{ captureId: entry.claim.captureId, sourceStart: entry.claim.sourceStart, sourceEnd: entry.claim.sourceEnd }} /> : <p role="status">Loading your words…</p>}
      </section>

      <section className="rv-sec" aria-labelledby={`rv-why-${entry.claim.pendingId}`}>
        <h3 id={`rv-why-${entry.claim.pendingId}`}>Why you’re asked</h3>
        <ul className="rv-reasons">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      {entry.candidates.length > 0 && (
        <section className="rv-sec" aria-labelledby={`rv-cand-${entry.claim.pendingId}`}>
          <h3 id={`rv-cand-${entry.claim.pendingId}`}>Ideas it might belong to</h3>
          <ul className="rv-candidates">
            {entry.candidates.map((candidate) => (
              <li key={candidate.objectId}>
                <span className="serif">{candidate.title}</span>
                {onOpenIdea && (
                  <button type="button" className="link" onClick={() => onOpenIdea(candidate.objectId)}>
                    Open
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="rv-fine">To add this note to one of them, open the idea and edit it yourself, then keep the note as its own idea or leave it here.</p>
        </section>
      )}

      {error && (
        <p role="alert" className={variant === "mobile" ? "m-note-block err" : "alert"}>
          {error}
        </p>
      )}

      <div className="rv-actions" role="group" aria-label="Decide">
        <button type="button" className={b.primary} disabled={busy || entry.projectArchived} onClick={() => void decide("keep_separate", "Kept as its own idea.")}>
          Keep as separate idea
        </button>
        {entry.claim.state === "deferred" ? (
          <button type="button" className={b.ghost} disabled={busy} onClick={() => void decide("reopen", "Back in your review list.")}>
            Review now
          </button>
        ) : (
          <button type="button" className={b.ghost} disabled={busy} onClick={() => void decide("defer", "Moved to Later.")}>
            Decide later
          </button>
        )}
      </div>
    </article>
  );
}
