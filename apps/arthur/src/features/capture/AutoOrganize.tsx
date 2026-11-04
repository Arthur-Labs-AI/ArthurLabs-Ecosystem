import { useEffect, useRef } from "react";
import { useKnowledge } from "../knowledge/knowledge-context";
import { useAiConfig } from "../setup/ai-config-context";
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
  const ai = useAiConfig();
  const latest = useRef(distill);
  latest.current = distill;
  // Without a language-model credential there is nothing to organize WITH: the capture simply stays saved and "Not organized yet",
  // and can be organized later from Home once a key is connected. (While the configuration is unknown, organizing is attempted.)
  const unavailable = ai.isUnavailable("llm");

  useEffect(() => (unavailable ? undefined : subscribe((capture) => void latest.current(capture.id))), [subscribe, unavailable]);
  return null;
}
