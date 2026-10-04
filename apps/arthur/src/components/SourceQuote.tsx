import { codePointLength, describeSpanProblem, sliceCodePoints, type Capture, type KnowledgeProvenance } from "@arthur/contracts";

/** The raw capture text with the exact source span highlighted, or an alert if the span does not resolve. */
export function SourceQuote({ capture, provenance }: { capture: Capture | undefined; provenance: KnowledgeProvenance }) {
  const { sourceStart, sourceEnd } = provenance;
  if (!capture || describeSpanProblem(capture.content, sourceStart, sourceEnd) !== null) {
    return <p role="alert">The original text for this idea is not available.</p>;
  }
  const length = codePointLength(capture.content);
  return (
    <blockquote className="quote" aria-label="Original capture text">
      {sliceCodePoints(capture.content, 0, sourceStart)}
      <mark>{sliceCodePoints(capture.content, sourceStart, sourceEnd)}</mark>
      {sliceCodePoints(capture.content, sourceEnd, length)}
    </blockquote>
  );
}
