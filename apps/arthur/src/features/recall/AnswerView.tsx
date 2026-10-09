import type { ReactNode } from "react";
import type { AnswerParagraph, CognitiveAnswer } from "@arthur/contracts";
import { Icon } from "../../components/icons";
import { TEMPORAL_NOTES, markersFor, type EvidenceIndex, type Marker } from "./evidence-model";

/**
 * The paragraphs of an answer, each with the evidence it rests on shown as small margin references (E1, E3 · earlier). A reference
 * is a button: it points at the evidence, wherever the host shows it. A paragraph that mixes current and earlier knowledge says so
 * under itself, in words.
 */
export function AnswerParagraphs({
  paragraphs,
  index,
  activeHandle,
  onMark,
  onHover,
  muted = false,
}: {
  paragraphs: readonly AnswerParagraph[];
  index: EvidenceIndex;
  activeHandle: string | null;
  onMark: (marker: Marker, trigger: HTMLElement) => void;
  onHover: (handle: string | null) => void;
  muted?: boolean;
}): ReactNode {
  return (
    <div className={muted ? "ans-body muted" : "ans-body"}>
      {paragraphs.map((paragraph, at) => {
        const markers = markersFor(paragraph, index);
        const note = TEMPORAL_NOTES[paragraph.temporal];
        const active = activeHandle !== null && markers.some((marker) => marker.entry === activeHandle);
        return (
          <div key={at} className="ans-para" data-temporal={paragraph.temporal} data-active={active || undefined}>
            <p className="ans-text">{paragraph.text}</p>
            <div className="ans-margin">
              {markers.length > 0 && (
                <ul className="ans-refs" aria-label="Based on">
                  {markers.map((marker) => (
                    <li key={marker.handle}>
                      <button
                        type="button"
                        className="ans-ref"
                        data-historical={marker.historical || undefined}
                        data-active={activeHandle === marker.entry || undefined}
                        aria-label={`Evidence ${marker.handle}: ${marker.description}`}
                        onClick={(event) => onMark(marker, event.currentTarget)}
                        onMouseEnter={() => onHover(marker.entry)}
                        onMouseLeave={() => onHover(null)}
                        onFocus={() => onHover(marker.entry)}
                        onBlur={() => onHover(null)}
                      >
                        {marker.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {note && (
                <p className="ans-temporal">
                  <Icon name="evolution" small />
                  {note}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Gaps({ answer }: { answer: CognitiveAnswer }) {
  const gaps = answer.answer?.gaps ?? [];
  if (gaps.length === 0) return null;
  return (
    <div className="ans-gaps">
      <b>Not covered by what you’ve written</b>
      <ul>
        {gaps.map((gap, at) => (
          <li key={at}>{gap}</li>
        ))}
      </ul>
    </div>
  );
}
