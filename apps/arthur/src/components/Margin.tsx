import type { CaptureSourceKind } from "@arthur/contracts";
import { Icon, SOURCE_LABELS, SourceIcon } from "./icons";

/**
 * The margin of a thought: where it came from, how many connections it has, how many revisions.
 * Every row, inspector and node uses this, in this order.
 */
export function Margin({ source, connections, revisions, age, showSource = true }: { source: CaptureSourceKind; connections: number; revisions: number | undefined; age?: string; showSource?: boolean }) {
  return (
    <div className="margin">
      {showSource && (
        <span className="src" title="Source">
          <SourceIcon source={source} />
          {SOURCE_LABELS[source]}
        </span>
      )}
      <span title="Connections" aria-label={`${connections} ${connections === 1 ? "connection" : "connections"}`}>
        <Icon name="link" small />
        <span className="num">{connections}</span>
      </span>
      {revisions !== undefined && (
        <span title="Revisions" aria-label={`${revisions} ${revisions === 1 ? "revision" : "revisions"}`}>
          <Icon name="rev" small />
          <span className="num">r{revisions}</span>
        </span>
      )}
      {age !== undefined && <span className="when">{age}</span>}
    </div>
  );
}
