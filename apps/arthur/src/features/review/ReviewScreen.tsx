import { useEffect, useMemo, useState } from "react";
import type { RevisionProposal, UnresolvedClaim } from "@arthur/contracts";
import { useNavigation } from "../../app/navigation";
import { KindGlyph } from "../../components/icons";
import { ProposalDetail, type Notice } from "./ProposalDetail";
import { WaitingNote } from "./WaitingNote";
import { CHANGE_LABELS, excerpt } from "./review-copy";
import { useReview } from "./review-context";
import "./review.css";

type Item = { id: string; kind: "suggestion"; proposal: RevisionProposal } | { id: string; kind: "note"; entry: UnresolvedClaim };

/** Everything waiting for a decision, in one list: suggestions Arthur wrote, then notes it could not write one for. */
export function useReviewItems(): Item[] {
  const { suggestions, waiting } = useReview();
  return useMemo(
    () => [
      ...suggestions.map((proposal): Item => ({ id: proposal.id, kind: "suggestion", proposal })),
      ...waiting.map((entry): Item => ({ id: `note:${entry.claim.pendingId}`, kind: "note", entry })),
    ],
    [suggestions, waiting],
  );
}

export function itemTitle(item: Item): string {
  return item.kind === "suggestion" ? (item.proposal.current?.title ?? item.proposal.proposed.title) : item.entry.claim.title;
}

export function itemLine(item: Item): string {
  return item.kind === "suggestion" ? `${CHANGE_LABELS[item.proposal.change]} · ${excerpt(item.proposal.claim.body, 70)}` : `No suggested text · ${excerpt(item.entry.claim.body, 70)}`;
}

export function itemFlag(item: Item): string | null {
  if (item.kind === "suggestion") return item.proposal.state === "deferred" ? "Later" : item.proposal.stale ? "Idea changed" : null;
  return item.entry.claim.state === "deferred" ? "Later" : null;
}

export type { Item as ReviewItem };

export function ReviewScreen() {
  const review = useReview();
  const items = useReviewItems();
  const { go } = useNavigation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Keep a valid selection: the first item, and the next one after a decision removed the open one.
  useEffect(() => {
    if (items.length === 0) setSelectedId(null);
    else if (selectedId === null || !items.some((item) => item.id === selectedId)) setSelectedId(items[0]?.id ?? null);
  }, [items, selectedId]);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const openIdea = (objectId: string) => go("ideas", objectId);

  return (
    <div className="review">
      <div className="page-head" style={{ padding: 0 }}>
        <div>
          <h1>Review</h1>
          <p>Suggestions Arthur wrote from your new notes. Nothing changes until you approve it.</p>
        </div>
      </div>

      {review.status === "loading" && <p role="status">Loading what’s waiting…</p>}
      {review.status === "error" && (
        <p role="alert" className="alert">
          Could not read the review list: {review.error}
        </p>
      )}

      {review.status === "ready" && items.length === 0 && (
        <div className="state">
          <h2>Nothing is waiting for you</h2>
          <p>When a new note adds to, corrects or replaces one of your ideas, Arthur can write a suggested new version and it will appear here. You can turn this on in Settings. Your ideas stay exactly as they are until you approve a change.</p>
          <button type="button" className="btn" onClick={() => go("settings")}>
            Open Settings
          </button>
        </div>
      )}

      {items.length > 0 && (
        <div className="rv-grid">
          <nav className="rv-list" aria-label="Waiting for review">
            <ul>
              {items.map((item) => {
                const flag = itemFlag(item);
                return (
                  <li key={item.id}>
                    <button type="button" aria-current={item.id === selectedId ? "true" : undefined} onClick={() => setSelectedId(item.id)}>
                      <KindGlyph kind={item.kind === "suggestion" ? item.proposal.proposed.kind : item.entry.claim.kind} />
                      <span className="rv-li">
                        <b className="serif">{itemTitle(item)}</b>
                        <small>{itemLine(item)}</small>
                      </span>
                      {flag && <span className="rv-chip">{flag}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <section aria-label="Decide">
            {notice && notice.kind === "ok" && (
              <p className="rv-banner" role="status" data-testid="review-notice">
                {notice.text}
              </p>
            )}
            {selected?.kind === "suggestion" && <ProposalDetail key={selected.id} proposal={selected.proposal} variant="desktop" onNotice={setNotice} onOpenIdea={openIdea} />}
            {selected?.kind === "note" && <WaitingNote key={selected.id} entry={selected.entry} variant="desktop" onNotice={setNotice} onOpenIdea={openIdea} />}
          </section>
        </div>
      )}
      {items.length === 0 && notice && notice.kind === "ok" && review.status === "ready" && <p className="rv-banner" role="status" data-testid="review-notice">{notice.text}</p>}
    </div>
  );
}
