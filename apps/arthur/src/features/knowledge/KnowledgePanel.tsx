import { useState } from "react";
import { describeSpanProblem, sliceCodePoints, type Capture, type KnowledgeObject } from "@arthur/contracts";
import { useCaptures } from "../capture/captures-context";
import { useKnowledge } from "./use-knowledge";

/** The raw capture text with the object's source span highlighted, or null if it does not resolve. */
function SourceView({ capture, object }: { capture: Capture | undefined; object: KnowledgeObject }) {
  const { sourceStart, sourceEnd } = object.provenance;
  if (!capture || describeSpanProblem(capture.content, sourceStart, sourceEnd) !== null) {
    return <p role="alert">The original text for this object is not available.</p>;
  }
  const length = [...capture.content].length;
  return (
    <blockquote className="source-view" aria-label="Original capture text">
      {sliceCodePoints(capture.content, 0, sourceStart)}
      <mark>{sliceCodePoints(capture.content, sourceStart, sourceEnd)}</mark>
      {sliceCodePoints(capture.content, sourceEnd, length)}
    </blockquote>
  );
}

function ObjectCard({ object, capture }: { object: KnowledgeObject; capture: Capture | undefined }) {
  const [showSource, setShowSource] = useState(false);
  return (
    <li className="knowledge-item">
      <p className="knowledge-heading">
        <span className={`kind kind-${object.kind}`}>{object.kind}</span> <strong>{object.title}</strong>
      </p>
      <p className="knowledge-body">{object.body}</p>
      <p className="capture-meta">
        From capture {object.provenance.captureId.slice(0, 8)} · characters {object.provenance.sourceStart}–{object.provenance.sourceEnd}
      </p>
      <button type="button" className="link-button" aria-expanded={showSource} onClick={() => setShowSource((open) => !open)}>
        {showSource ? "Hide source" : "View source"}
      </button>
      {showSource && <SourceView capture={capture} object={object} />}
    </li>
  );
}

export function KnowledgePanel() {
  const { captures } = useCaptures();
  const { status, objects, distilling, emptyResults, error, distill } = useKnowledge();
  const byId = new Map(captures.map((capture) => [capture.id, capture]));
  const distilled = new Set(objects.map((object) => object.provenance.captureId));

  return (
    <section className="panel" aria-labelledby="knowledge-heading">
      <h2 id="knowledge-heading" className="panel-title">
        Knowledge
      </h2>

      {captures.length === 0 ? (
        <p className="muted">Capture a thought first, then distill it into structured knowledge.</p>
      ) : (
        <ul className="capture-list" aria-label="Captures to distill">
          {captures.map((capture) => (
            <li key={capture.id} className="capture-item distill-row">
              <p className="capture-content">{capture.content}</p>
              <button
                type="button"
                onClick={() => void distill(capture.id)}
                disabled={distilling !== null || distilled.has(capture.id)}
                aria-label={`Distill capture ${capture.id.slice(0, 8)}`}
              >
                {distilling === capture.id ? "Distilling…" : distilled.has(capture.id) ? "Distilled" : "Distill"}
              </button>
              {emptyResults.has(capture.id) && <p className="muted">Nothing to structure in this capture.</p>}
            </li>
          ))}
        </ul>
      )}

      {distilling !== null && <p role="status">Distilling…</p>}
      {error && <p role="alert">{error}</p>}
      {status === "loading" && <p role="status">Loading knowledge…</p>}
      {status === "ready" && objects.length === 0 && <p className="muted">No knowledge objects yet.</p>}
      {objects.length > 0 && (
        <ul className="knowledge-list" aria-label="Knowledge objects">
          {objects.map((object) => (
            <ObjectCard key={object.id} object={object} capture={byId.get(object.provenance.captureId)} />
          ))}
        </ul>
      )}
    </section>
  );
}
