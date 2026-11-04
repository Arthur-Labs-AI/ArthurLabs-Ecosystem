import { Icon } from "../../components/icons";
import { useReview } from "./review-context";
import "./review.css";

/** One quiet line on Home when something is waiting for a decision. It never appears when nothing is, and it never takes over the screen. */
export function ReviewNotice({ variant, onOpen }: { variant: "desktop" | "mobile"; onOpen: () => void }) {
  const { count } = useReview();
  if (count === 0) return null;
  return (
    <div className="rv-notice" data-variant={variant} role="status">
      <Icon name="wand" small />
      <span>
        {count === 1 ? "1 thing is waiting for your review." : `${count} things are waiting for your review.`} Nothing changes until you decide.
      </span>
      <button type="button" className={variant === "mobile" ? "m-pbtn" : "btn"} onClick={onOpen}>
        Review
      </button>
    </div>
  );
}

/** What a capture reads when Automatic Thought Evolution held its notes for review instead of creating ideas. */
export function heldMessage(held: number): string {
  return held === 1 ? "1 note is waiting for your review." : `${held} notes are waiting for your review.`;
}
