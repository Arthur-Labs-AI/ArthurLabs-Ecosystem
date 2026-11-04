import type { DiffSegment } from "@arthur/contracts";

/** Words that differ between two texts: removed words are struck through, added words are underlined. Colour never carries it alone. */
export function DiffText({ segments }: { segments: readonly DiffSegment[] }) {
  return (
    <span className="rv-diff">
      {segments.map((segment, index) =>
        segment.op === "equal" ? (
          <span key={index}>{segment.text}</span>
        ) : segment.op === "insert" ? (
          <ins key={index} className="rv-ins">
            <span className="rv-sr">added: </span>
            {segment.text}
          </ins>
        ) : (
          <del key={index} className="rv-del">
            <span className="rv-sr">removed: </span>
            {segment.text}
          </del>
        ),
      )}
    </span>
  );
}

/** How many words a diff adds and removes, for the one-line summary. */
export function diffCounts(segments: readonly DiffSegment[]): { added: number; removed: number } {
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
  let added = 0;
  let removed = 0;
  for (const segment of segments) {
    if (segment.op === "insert") added += words(segment.text);
    if (segment.op === "delete") removed += words(segment.text);
  }
  return { added, removed };
}
