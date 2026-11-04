import { useState } from "react";
import type { RevisionProposal } from "@arthur/contracts";
import { EvolutionError } from "../../client/arthur-client";
import { Icon, KindGlyph } from "../../components/icons";
import { relativeAge } from "../../components/format";
import { SourceQuote } from "../../components/SourceQuote";
import { DiffText, diffCounts } from "./DiffText";
import { CHANGE_LABELS, STATE_LABELS, modelLabel, reasonLines, verificationWarning } from "./review-copy";
import { useReview } from "./review-context";
import { useCapturesById } from "./use-captures-by-id";

export type Variant = "desktop" | "mobile";

/** What the person is told after a decision. `kind: "error"` is an alert; the rest are status messages. */
export interface Notice {
  kind: "ok" | "error";
  text: string;
}

const buttons = (variant: Variant) => ({
  primary: variant === "mobile" ? "m-pbtn primary" : "btn primary",
  plain: variant === "mobile" ? "m-pbtn" : "btn",
  ghost: variant === "mobile" ? "m-pbtn ghost" : "btn ghost",
});

/**
 * One suggestion, with everything needed to judge it: the idea as it is now, the suggested version with what changed, the note it came
 * from, what already supported the idea, how it was checked, and the five decisions. AI-written text is always labelled as such, and
 * the same-family check is always shown as a self-check. Nothing here applies anything: each button asks the native layer, which
 * re-checks that the idea is still exactly what the person read.
 */
export function ProposalDetail({ proposal, variant, onNotice, onOpenIdea }: { proposal: RevisionProposal; variant: Variant; onNotice: (notice: Notice) => void; onOpenIdea?: (objectId: string) => void }) {
  const { review } = useReview();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(proposal.proposed.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { captures, ready: capturesReady } = useCapturesById([proposal.claim.captureId, ...proposal.evidence.map((entry) => entry.captureId)]);
  const b = buttons(variant);
  const current = proposal.current;
  const reviewable = proposal.state === "open" || proposal.state === "deferred";
  const canApprove = reviewable && !proposal.stale && proposal.blocked === null && current !== null;
  const canEdit = reviewable && proposal.blocked === null && current !== null;
  const counts = proposal.diff ? diffCounts(proposal.diff.body.segments) : null;
  const reasons = reasonLines(proposal.claim.reasons);

  // Nothing typed for one suggestion carries over to another: both screens render this component with `key={proposal.id}`, so a different
  // suggestion is a fresh instance. (A reset effect here would also run after the first paint and could undo a tap made in between.)

  async function decide(action: Parameters<typeof review>[0]["action"], done: string, extra: { editedBody?: string } = {}) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await review({ proposalId: proposal.id, action, ...(current ? { reviewedRevisionId: current.revisionId } : {}), ...extra });
      onNotice({ kind: "ok", text: outcome.applied ? done : "That was already decided." });
    } catch (failure) {
      const message = failure instanceof EvolutionError ? failure.message : failure instanceof Error ? failure.message : "That could not be saved.";
      setError(message);
      if (failure instanceof EvolutionError && failure.code === "stale") setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  const evidenceCaptures = proposal.evidence.filter((entry) => entry.role === "existing");
  const claimCapture = captures.get(proposal.claim.captureId);

  return (
    <article className="rv-detail" data-variant={variant} aria-label={`Suggestion for ${current?.title ?? proposal.proposed.title}`}>
      <header className="rv-head">
        <KindGlyph kind={proposal.proposed.kind} />
        <div>
          <h2 className="serif">{current?.title ?? proposal.proposed.title}</h2>
          <p className="rv-sub">
            <span className="rv-ai">{CHANGE_LABELS[proposal.change]}</span>
            <span aria-hidden="true"> · </span>
            {STATE_LABELS[proposal.state]}
            <span aria-hidden="true"> · </span>
            <time dateTime={proposal.createdAt}>{relativeAge(proposal.createdAt)}</time>
          </p>
        </div>
        {onOpenIdea && current && (
          <button type="button" className={b.ghost} onClick={() => onOpenIdea(proposal.objectId)}>
            Open idea
          </button>
        )}
      </header>

      <p className="rv-ai-note" role="note">
        <Icon name="wand" small /> Written by Arthur. Not applied. Nothing changes until you approve it.
      </p>

      {proposal.blocked && (
        <p role="alert" className={variant === "mobile" ? "m-note-block err" : "alert"}>
          {proposal.blocked === "project_archived" ? "Restore the project to review this suggestion." : proposal.blocked === "claim_moved" ? "The note and the idea are no longer in the same project." : "The idea this suggestion was written for no longer exists."}
        </p>
      )}
      {proposal.stale && proposal.blocked === null && reviewable && (
        <p role="alert" className={variant === "mobile" ? "m-note-block err" : "alert"} data-testid="stale-warning">
          This idea changed after Arthur wrote this suggestion, so it can’t be approved as it is. Read the current text below, then edit your own version or dismiss it.
        </p>
      )}

      <section className="rv-sec" aria-labelledby={`rv-now-${proposal.id}`}>
        <h3 id={`rv-now-${proposal.id}`}>The idea now{current && <small> · {current.origin === "user_edit" ? "last edited by you" : "current text"}</small>}</h3>
        <p className="serif rv-text">{current?.body ?? "—"}</p>
      </section>

      <section className="rv-sec rv-suggested" aria-labelledby={`rv-sug-${proposal.id}`}>
        <h3 id={`rv-sug-${proposal.id}`}>
          Suggested version <span className="rv-chip">{modelLabel(proposal.verification.synthesisModel)}</span>
        </h3>
        <p className="serif rv-text" aria-label="Suggested text">
          {proposal.proposed.body}
        </p>
        {proposal.diff && (
          <div className="rv-changes">
            <h4>What changed</h4>
            <p className="serif rv-text" aria-label="Changes">
              <DiffText segments={proposal.diff.body.segments} />
            </p>
            {counts && (
              <p className="rv-stat">
                <span className="rv-ins-stat">+{counts.added} words</span> <span className="rv-del-stat">−{counts.removed} words</span>
              </p>
            )}
          </div>
        )}
      </section>

      <section className="rv-sec" aria-labelledby={`rv-why-${proposal.id}`}>
        <h3 id={`rv-why-${proposal.id}`}>Why you’re asked</h3>
        <ul className="rv-reasons">
          {reasons.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section className="rv-sec" aria-labelledby={`rv-src-${proposal.id}`}>
        <h3 id={`rv-src-${proposal.id}`}>The new note</h3>
        {capturesReady ? <SourceQuote capture={claimCapture} provenance={{ captureId: proposal.claim.captureId, sourceStart: proposal.claim.sourceStart, sourceEnd: proposal.claim.sourceEnd }} /> : <p role="status">Loading your words…</p>}
        {evidenceCaptures.length > 0 && (
          <>
            <h4>What already supports this idea</h4>
            {capturesReady && evidenceCaptures.map((entry) => (
              <SourceQuote key={`${entry.captureId}:${entry.start}`} capture={captures.get(entry.captureId)} provenance={{ captureId: entry.captureId, sourceStart: entry.start, sourceEnd: entry.end }} />
            ))}
          </>
        )}
      </section>

      <section className="rv-sec rv-verify" aria-labelledby={`rv-ver-${proposal.id}`}>
        <h3 id={`rv-ver-${proposal.id}`}>How it was checked</h3>
        <p>
          Passed Arthur’s checks: it adds nothing your notes don’t say, keeps what you wrote, and cites your own words. <span className="rv-chip">{proposal.verification.mode === "same_family_review" ? "Same-model self-check" : "Independent check"}</span>
        </p>
        {proposal.verification.mode === "same_family_review" && (
          <p className="rv-warn" role="note">
            <Icon name="warn" small /> {verificationWarning(proposal.verification.verifierModel)}
          </p>
        )}
        <p className="rv-fine">
          Written by {proposal.verification.synthesisModel}, checked by {proposal.verification.verifierModel}.
        </p>
      </section>

      {proposal.state === "approved" && (
        <p className="rv-done" role="status">
          {proposal.userEdited ? "You approved your own wording." : "You approved this suggestion as written."} The earlier version stays in the idea’s history.
        </p>
      )}

      {editing && current && (
        <form
          className="rv-edit"
          onSubmit={(event) => {
            event.preventDefault();
            void decide("edit_approve", "Saved your version. The earlier text stays in the idea’s history.", { editedBody: text });
          }}
        >
          <label htmlFor={`rv-edit-${proposal.id}`}>Your version</label>
          <p className="rv-fine">You’re editing against the idea as it is now. What you save is marked as written by you.</p>
          <textarea id={`rv-edit-${proposal.id}`} value={text} rows={6} onChange={(event) => setText(event.target.value)} disabled={busy} />
          <div className="rv-actions">
            <button type="submit" className={b.primary} disabled={busy || text.trim().length === 0 || text.trim() === current.body}>
              {busy ? "Saving…" : "Approve my version"}
            </button>
            <button type="button" className={b.ghost} onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className={variant === "mobile" ? "m-note-block err" : "alert"}>
          {error}
        </p>
      )}

      {reviewable && !editing && (
        <div className="rv-actions" role="group" aria-label="Decide">
          <button type="button" className={b.primary} disabled={busy || !canApprove} onClick={() => void decide("approve", "Applied. The earlier text stays in the idea’s history.")}>
            Approve
          </button>
          <button type="button" className={b.plain} disabled={busy || !canEdit} onClick={() => setEditing(true)}>
            Edit &amp; approve
          </button>
          <button type="button" className={b.plain} disabled={busy} onClick={() => void decide("reject", "Dismissed the suggestion. Your note is kept and still waiting.")}>
            Reject
          </button>
          <button type="button" className={b.plain} disabled={busy || proposal.blocked === "project_archived"} onClick={() => void decide("keep_separate", "Kept as its own idea.")}>
            Keep as separate idea
          </button>
          {proposal.state === "open" ? (
            <button type="button" className={b.ghost} disabled={busy} onClick={() => void decide("defer", "Moved to Later.")}>
              Decide later
            </button>
          ) : (
            <button type="button" className={b.ghost} disabled={busy} onClick={() => void decide("reopen", "Back in your review list.")}>
              Review now
            </button>
          )}
        </div>
      )}
    </article>
  );
}
