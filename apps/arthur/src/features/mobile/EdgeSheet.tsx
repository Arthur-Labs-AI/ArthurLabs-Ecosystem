import { isSymmetricRelationKind } from "@arthur/contracts";
import { KindGlyph } from "../../components/icons";
import { RelationSwatch } from "../../components/RelationArt";
import { formatMoment } from "../../components/format";
import { useRelationIndex } from "../graph/relation-index";
import { ORIGIN_LABELS, RELATION_LABELS, RELATION_MEANINGS } from "../graph/relation-style";
import { useKnowledge } from "../knowledge/knowledge-context";
import { MobileSheet } from "./MobileSheet";

/** One connection as a sentence: what links to what, how, who made it, and which way it points. */
export function EdgeSheet({ relationId, modal, onClose, onOpenIdea }: { relationId: string; modal: boolean; onClose: () => void; onOpenIdea: (objectId: string) => void }) {
  const { objects } = useKnowledge();
  const index = useRelationIndex();
  const relation = index.usable.find((candidate) => candidate.id === relationId);
  const byId = new Map(objects.map((object) => [object.id, object]));
  if (!relation) return null;
  const source = byId.get(relation.sourceObjectId);
  const target = byId.get(relation.targetObjectId);
  const symmetric = isSymmetricRelationKind(relation.kind);
  const title = (id: string): string => byId.get(id)?.title ?? index.externalOf(id)?.title ?? "(unknown idea)";
  /** A title, followed by "Nexus ↗" when it belongs to another project. */
  const named = (id: string) => {
    const far = index.externalOf(id);
    return far ? (
      <>
        {far.title} <span className="m-proj-tag">{far.projectName} ↗</span>
      </>
    ) : (
      title(id)
    );
  };

  return (
    <MobileSheet label="Connection" onClose={onClose} modal={modal} aboveTabs={!modal}>
      <div className="m-sbody">
        <h2 className="m-edge-h">
          <span>{named(relation.sourceObjectId)}</span> <em style={{ color: `var(--rel-${relation.kind})` }}>{RELATION_LABELS[relation.kind]}</em> <span>{named(relation.targetObjectId)}</span>
        </h2>
        <div className="m-edge-means">
          <RelationSwatch kind={relation.kind} width={56} />
          <span>{RELATION_MEANINGS[relation.kind]}</span>
        </div>
        <dl className="m-kv">
          <dt>Created by</dt>
          <dd>
            <span className={relation.origin === "model" ? "m-origin model" : "m-origin"} aria-hidden="true" />
            {ORIGIN_LABELS[relation.origin]}
          </dd>
          <dt>Direction</dt>
          <dd>{symmetric ? "None. It reads the same both ways." : `${title(relation.sourceObjectId)} → ${title(relation.targetObjectId)}`}</dd>
          <dt>Created</dt>
          <dd>
            <time dateTime={relation.createdAt}>{formatMoment(relation.createdAt)}</time>
          </dd>
        </dl>
        {relation.origin === "model" && <p className="m-sheet-note">Arthur proposed this link and checked it twice before saving it. Nothing here changes your ideas.</p>}
        <div className="m-edge-open">
          {[source, target].map(
            (object) =>
              object && (
                <button key={object.id} type="button" className="m-pbtn" onClick={() => onOpenIdea(object.id)}>
                  <KindGlyph kind={object.kind} />
                  <span className="m-ellipsis">Open “{object.title}”</span>
                </button>
              ),
          )}
        </div>
      </div>
    </MobileSheet>
  );
}
