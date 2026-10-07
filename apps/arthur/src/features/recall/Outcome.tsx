import { useMemo, useState, type ReactNode } from "react";
import type { CognitiveAnswer, CognitiveEvidence } from "@arthur/contracts";
import { AnswerParagraphs, Gaps } from "./AnswerView";
import { indexEvidence, isWeak, orderEvidence, synthesisReason, type EvidenceIndex, type Marker } from "./evidence-model";

export interface OutcomeHandlers {
  activeHandle: string | null;
  onMark: (marker: Marker, trigger: HTMLElement) => void;
  onHover: (handle: string | null) => void;
  onRetry: () => void;
}

/** What each outcome says, before any evidence. The three are written and shaped differently on purpose. */
export function OutcomeBody({ answer, handlers, evidence }: { answer: CognitiveAnswer; handlers: OutcomeHandlers; evidence: (entries: CognitiveEvidence[], index: EvidenceIndex, heading: string, open?: boolean) => ReactNode }) {
  const index = useMemo(() => indexEvidence(answer.evidence), [answer.evidence]);
  const { cited, other } = useMemo(() => orderEvidence(answer), [answer]);
  const project = answer.scope.projectName;
  const [weakOpen, setWeakOpen] = useState(false);

  if (answer.outcome === "answered" && answer.answer) {
    return (
      <>
        <section className="ans" aria-labelledby="ans-h" data-outcome="answered">
          <h2 id="ans-h">Answer</h2>
          <AnswerParagraphs paragraphs={answer.answer.paragraphs} index={index} activeHandle={handlers.activeHandle} onMark={handlers.onMark} onHover={handlers.onHover} />
          <Gaps answer={answer} />
        </section>
        {cited.length > 0 ? evidence(cited, index, "Based on") : <p className="ans-none">Arthur didn’t attach any evidence to this answer, so treat it with caution.</p>}
        {other.length > 0 && evidence(other, index, "Also found", false)}
      </>
    );
  }

  if (answer.outcome === "retrieval_only") {
    const reason = synthesisReason(answer);
    return (
      <>
        <section className="ans notice" aria-labelledby="ans-h" data-outcome="retrieval_only">
          <h2 id="ans-h">Found related knowledge</h2>
          <p className="ans-lead">Arthur found relevant knowledge in {project}, but couldn’t write a grounded answer from it. What it found is below.</p>
          {reason && <p className="ans-why">{reason}</p>}
          <button type="button" className="btn" onClick={handlers.onRetry}>
            Try again
          </button>
        </section>
        {evidence(answer.evidence, index, "What Arthur found")}
      </>
    );
  }

  // insufficient_evidence: never a generic error. If the model still wrote what the evidence does say, it is shown, quietly.
  const strong = answer.evidence.filter((entry) => !isWeak(entry));
  const weak = answer.evidence.filter(isWeak);
  return (
    <>
      <section className="ans notice" aria-labelledby="ans-h" data-outcome="insufficient_evidence">
        <h2 id="ans-h">Not enough to answer</h2>
        <p className="ans-lead">Arthur couldn’t find enough evidence in {project} to answer that reliably.</p>
        {answer.answer && answer.answer.paragraphs.length > 0 && (
          <div className="ans-partial">
            <b>What the evidence does say</b>
            <AnswerParagraphs paragraphs={answer.answer.paragraphs} index={index} activeHandle={handlers.activeHandle} onMark={handlers.onMark} onHover={handlers.onHover} muted />
            <Gaps answer={answer} />
          </div>
        )}
        {answer.evidence.length === 0 && <p className="ans-hint">Nothing in {project} matched. Try the words you used when you captured it, or check that you’re in the right project.</p>}
      </section>
      {strong.length > 0 && evidence(strong, index, "What Arthur found")}
      {weak.length > 0 && (
        <section className="evs weak" aria-label="Weak matches">
          <button type="button" className="ev-link" aria-expanded={weakOpen} onClick={() => setWeakOpen((now) => !now)}>
            {weakOpen ? "Hide weak matches" : `Inspect weak matches (${weak.length})`}
          </button>
          {weakOpen && evidence(weak, index, "Weak matches", true)}
        </section>
      )}
    </>
  );
}
