import { useState } from "react";
import { Icon, KindGlyph } from "../../components/icons";
import { useMobileNav } from "../mobile/mobile-nav";
import { ProposalDetail, type Notice } from "./ProposalDetail";
import { WaitingNote } from "./WaitingNote";
import { itemFlag, itemLine, itemTitle, useReviewItems } from "./ReviewScreen";
import { useReview } from "./review-context";
import "./review.css";

/** The list of everything waiting for a decision, as a pushed full-screen page. */
export function MobileReview() {
  const review = useReview();
  const items = useReviewItems();
  const { closePage, openReviewItem, openSettings } = useMobileNav();

  return (
    <div className="m-page" role="region" aria-label="Review">
      <div className="m-page-top">
        <button type="button" className="m-iconbtn" aria-label="Back" onClick={closePage}>
          <Icon name="back" />
        </button>
      </div>
      <div className="m-scroll">
        <header className="m-head">
          <div>
            <h1>Review</h1>
            <p className="m-sub">Suggestions Arthur wrote from your new notes. Nothing changes until you approve it.</p>
          </div>
        </header>
        {review.status === "loading" && <p role="status">Loading what’s waiting…</p>}
        {review.status === "error" && (
          <p role="alert" className="m-note-block err">
            Could not read the review list: {review.error}
          </p>
        )}
        {review.status === "ready" && items.length === 0 && (
          <div className="m-state">
            <h2>Nothing is waiting for you</h2>
            <p>When a new note adds to, corrects or replaces one of your ideas, Arthur can write a suggested new version and it will appear here. Your ideas stay exactly as they are until you approve a change.</p>
            <button type="button" className="m-pbtn" onClick={openSettings}>
              Open Settings
            </button>
          </div>
        )}
        {items.length > 0 && (
          <ul className="rv-m-list" aria-label="Waiting for review">
            {items.map((item) => {
              const flag = itemFlag(item);
              return (
                <li key={item.id}>
                  <button type="button" className="rv-m-row" onClick={() => openReviewItem(item.id)}>
                    <KindGlyph kind={item.kind === "suggestion" ? item.proposal.proposed.kind : item.entry.claim.kind} />
                    <span className="rv-li">
                      <b className="serif">{itemTitle(item)}</b>
                      <small>{itemLine(item)}</small>
                    </span>
                    {flag && <span className="rv-chip">{flag}</span>}
                    <Icon name="chev" small />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** One suggestion or waiting note as its own page, so the system Back gesture returns to the list. */
export function MobileReviewItem({ id }: { id: string }) {
  const items = useReviewItems();
  const { status } = useReview();
  const { closePage, openIdea } = useMobileNav();
  const [done, setDone] = useState<Notice | null>(null);
  const item = items.find((candidate) => candidate.id === id);

  return (
    <div className="m-page" role="region" aria-label="Suggestion">
      <div className="m-page-top">
        <button type="button" className="m-iconbtn" aria-label="Back" onClick={closePage}>
          <Icon name="back" />
        </button>
      </div>
      <div className="m-scroll">
        {done && (
          <div className="m-state" data-testid="review-done">
            <h2 role="status">{done.text}</h2>
            <button type="button" className="m-pbtn primary" onClick={closePage}>
              Back to review
            </button>
          </div>
        )}
        {!done && item?.kind === "suggestion" && <ProposalDetail key={item.id} proposal={item.proposal} variant="mobile" onNotice={setDone} onOpenIdea={openIdea} />}
        {!done && item?.kind === "note" && <WaitingNote key={item.id} entry={item.entry} variant="mobile" onNotice={setDone} onOpenIdea={openIdea} />}
        {!done && !item && status === "ready" && (
          <div className="m-state">
            <h2>This is no longer waiting</h2>
            <p>It was decided somewhere else, or the idea changed.</p>
            <button type="button" className="m-pbtn" onClick={closePage}>
              Back to review
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
