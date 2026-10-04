import { useEffect, useRef } from "react";
import { useKnowledge } from "../knowledge/knowledge-context";
import { useCaptures } from "./captures-context";

/**
 * Starts organizing every capture right AFTER it has been persisted.
 *
 * The invariant this component exists to keep: a capture is saved first, and saving never depends on the model.
 * It is wired as a subscriber that runs after persistence and cannot fail a capture. If organizing fails, the capture
 * stays exactly as saved and the failure becomes a retryable job; no knowledge object is ever created by the UI.
 */
export function AutoOrganize() {
  const { subscribe } = useCaptures();
  const { distill } = useKnowledge();
  const latest = useRef(distill);
  latest.current = distill;

  useEffect(() => subscribe((capture) => void latest.current(capture.id)), [subscribe]);
  return null;
}
