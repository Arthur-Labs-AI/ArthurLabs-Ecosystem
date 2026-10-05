import { useMemo } from "react";
import type { Capture, KnowledgeObject } from "@arthur/contracts";
import { useNavigation } from "../../app/navigation";
import { Icon, KindGlyph, SOURCE_LABELS, SourceIcon } from "../../components/icons";
import { Margin } from "../../components/Margin";
import { dayLabel, isSameDay, relativeAge } from "../../components/format";
import { CaptureComposer } from "../capture/CaptureComposer";
import { useCaptures } from "../capture/captures-context";
import { GraphCanvas } from "../graph/GraphCanvas";
import { useRelationIndex } from "../graph/relation-index";
import { useKnowledge } from "../knowledge/knowledge-context";
import { useProjects } from "../projects/projects-context";
import { LineageSketch } from "../lineage/LineageRail";
import { useLineageSummaries, useObjectLineage } from "../lineage/lineage-summaries";
import type { OrganizeJob } from "../knowledge/use-knowledge";
import "./home.css";

/** How many recent captures Home shows. The full list is always one click away in Ideas. */
const RECENT_CAPTURES = 8;

/** "Good morning / afternoon / evening" for the user's local time. */
export function greeting(now: Date = new Date()): string {
  const hour = now.getHours();
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

const excerpt = (text: string, max = 140): string => {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
};

/** What happened to one capture: it was organized into ideas, is being organized, failed, or has not been tried. */
function CaptureOutcome({ capture, objects, job, ready, organizedElsewhere, onRetry }: { capture: Capture; objects: KnowledgeObject[]; job: OrganizeJob | undefined; ready: boolean; organizedElsewhere: boolean; onRetry: () => void }) {
  if (job?.status === "queued" || job?.status === "organizing") {
    return (
      <div className="progress">
        <span className="organizing" role="status">
          <i aria-hidden="true" />
          {job.status === "queued" ? "Waiting to organize…" : "Arthur is organizing…"}
        </span>
      </div>
    );
  }
  if (job?.status === "failed") {
    return (
      <div className="progress failed">
        <span role="alert">Couldn't organize this capture. Your words are saved.</span>
        <button type="button" className="btn" onClick={onRetry} aria-label={`Retry organizing capture ${capture.id.slice(0, 8)}`}>
          <Icon name="retry" small />
          Try again
        </button>
        {job.message && <span className="why">{job.message}</span>}
      </div>
    );
  }
  if (job?.status === "empty") {
    return (
      <div className="progress">
        <span className="note">Nothing to structure in this capture.</span>
      </div>
    );
  }
  if (objects.length === 0 && ready && organizedElsewhere) {
    // Organized, but every idea from it was moved to another project: that is not "not organized".
    return (
      <div className="progress">
        <span className="note">Its ideas are in other projects.</span>
      </div>
    );
  }
  if (objects.length === 0 && ready) {
    return (
      <div className="progress">
        <span className="note">Not organized yet.</span>
        <button type="button" className="btn" onClick={onRetry} aria-label={`Organize capture ${capture.id.slice(0, 8)}`}>
          Organize
        </button>
      </div>
    );
  }
  return null;
}

function ConnectedThinking() {
  const { objects } = useKnowledge();
  const index = useRelationIndex();
  const { go } = useNavigation();

  const hub = useMemo(() => {
    let best: KnowledgeObject | undefined;
    for (const object of objects) if (index.countOf(object.id) > (best ? index.countOf(best.id) : 0)) best = object;
    return best;
  }, [objects, index]);

  const neighbourhood = useMemo(() => {
    if (!hub) return null;
    const byId = new Map(objects.map((object) => [object.id, object]));
    const neighbours = index
      .edgesOf(hub.id)
      .map((relation) => byId.get(relation.sourceObjectId === hub.id ? relation.targetObjectId : relation.sourceObjectId))
      .filter((object): object is KnowledgeObject => object !== undefined);
    const unique = [...new Map(neighbours.map((object) => [object.id, object])).values()].sort((a, b) => index.countOf(b.id) - index.countOf(a.id)).slice(0, 5);
    const ids = new Set([hub.id, ...unique.map((object) => object.id)]);
    return { objects: [hub, ...unique], relations: index.usable.filter((relation) => ids.has(relation.sourceObjectId) && ids.has(relation.targetObjectId)) };
  }, [hub, objects, index]);

  return (
    <section aria-labelledby="connected-heading">
      <div className="h2">
        <h2 id="connected-heading">Connected thinking</h2>
        <button type="button" className="link" onClick={() => go("connections")}>
          Open <Icon name="arrow" />
        </button>
      </div>
      {neighbourhood && hub ? (
        <div className="map">
          <div className="graph-frame">
            <GraphCanvas objects={neighbourhood.objects} relations={neighbourhood.relations} scale="mini" label={`Connections around ${hub.title}`} />
          </div>
          <p className="cap-line">
            Around <span className="serif">{hub.title}</span> · {neighbourhood.objects.length - 1} {neighbourhood.objects.length - 1 === 1 ? "idea" : "ideas"}, {neighbourhood.relations.length} {neighbourhood.relations.length === 1 ? "link" : "links"}
          </p>
        </div>
      ) : (
        <div className="map">
          <p className="note">Links between your ideas show up here once Arthur finds them, or once you add one.</p>
        </div>
      )}
    </section>
  );
}

/** The little history shape of one idea, read when it is drawn (an idea that was never edited needs no read). */
function EvolvingSketch({ objectId }: { objectId: string }) {
  const lineage = useObjectLineage(objectId);
  return lineage ? <LineageSketch revisions={lineage.revisions} currentRevisionId={lineage.currentRevisionId} /> : <span aria-hidden="true" style={{ width: 104, height: 14, display: "inline-block" }} />;
}

function RecentlyEvolving() {
  const { objects } = useKnowledge();
  const { byObject } = useLineageSummaries();
  const { go } = useNavigation();
  const evolving = objects
    .map((object) => ({ object, summary: byObject.get(object.id) }))
    .filter((entry): entry is { object: KnowledgeObject; summary: NonNullable<typeof entry.summary> } => entry.summary !== undefined && entry.summary.revisionCount > 1)
    .sort((a, b) => b.summary.updatedAt.localeCompare(a.summary.updatedAt))
    .slice(0, 3);

  return (
    <section aria-labelledby="evolving-heading">
      <div className="h2">
        <h2 id="evolving-heading">Recently evolving</h2>
        <button type="button" className="link" onClick={() => go("evolution")}>
          Open <Icon name="arrow" />
        </button>
      </div>
      {evolving.length === 0 ? (
        <p className="note">Ideas you revise show their history here.</p>
      ) : (
        <ul>
          {evolving.map(({ object, summary }) => (
            <li key={object.id}>
              <button type="button" className="evo" onClick={() => go("evolution", object.id)}>
                <span className="t">{object.title}</span>
                <EvolvingSketch objectId={object.id} />
                <span className="m">
                  r{summary.revisionCount} current · {relativeAge(summary.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HomeScreen() {
  const { status, captures } = useCaptures();
  const { objects, jobs, distill, organizationLoaded, organized, status: knowledgeStatus, error: knowledgeError } = useKnowledge();
  const { active } = useProjects();
  const index = useRelationIndex();
  const { byObject } = useLineageSummaries();
  const { go } = useNavigation();

  const shown = captures.slice(0, RECENT_CAPTURES);
  const groups = useMemo(() => {
    const result: { label: string; captures: Capture[] }[] = [];
    for (const capture of shown) {
      const label = dayLabel(capture.createdAt);
      const last = result[result.length - 1];
      if (last && last.label === label) last.captures.push(capture);
      else result.push({ label, captures: [capture] });
    }
    return result;
  }, [shown]);
  const todayCount = shown.filter((capture) => isSameDay(capture.createdAt)).length;
  const objectsOf = (captureId: string) => objects.filter((object) => object.provenance.captureId === captureId);

  return (
    <div className="home">
      <h1 className="hello">{greeting()}</h1>
      <CaptureComposer />

      <div className="home-grid">
        <section aria-labelledby="today-heading">
          <div className="h2">
            <h2 id="today-heading">{todayCount > 0 ? "Today" : "Recent"}</h2>
            {shown.length > 0 && (
              <small>
                {shown.length} {shown.length === 1 ? "capture" : "captures"}
              </small>
            )}
            <button type="button" className="link" onClick={() => go("ideas")}>
              All ideas <Icon name="arrow" />
            </button>
          </div>

          {status === "loading" && <p role="status">Loading captures…</p>}
          {knowledgeStatus === "error" && knowledgeError && <p role="alert">{knowledgeError}</p>}
          {status === "ready" && captures.length === 0 && (
            <div className="state">
              <h3>Nothing captured yet</h3>
              <p>
                Capture your first thought for {active?.isInbox ? "the Inbox" : (active?.name ?? "this project")}. Arthur turns it into ideas and keeps your original words next to them.
              </p>
            </div>
          )}

          {groups.map((group, groupIndex) => (
            <div key={group.label}>
              {(groupIndex > 0 || todayCount === 0) && <div className="day" style={{ paddingLeft: 0 }}>{group.label}</div>}
              {group.captures.map((capture) => {
                const mine = objectsOf(capture.id);
                return (
                  <article key={capture.id} className="grp" aria-label={`Capture ${capture.id.slice(0, 8)}`}>
                    <div className="cap">
                      <span className="node">
                        <SourceIcon source={capture.source} />
                      </span>
                      <b>{SOURCE_LABELS[capture.source]}</b>
                      <span>{relativeAge(capture.createdAt)}</span>
                      <q>{excerpt(capture.content)}</q>
                    </div>
                    {mine.map((object) => (
                      <button key={object.id} type="button" className="obj" onClick={() => go("ideas", object.id)}>
                        <KindGlyph kind={object.kind} />
                        <span style={{ minWidth: 0 }}>
                          <span className="t" style={{ display: "block" }}>
                            {object.title}
                          </span>
                          <span className="s" style={{ display: "block" }}>
                            {object.body}
                          </span>
                        </span>
                        <Margin source={capture.source} showSource={false} connections={index.countOf(object.id)} revisions={byObject.get(object.id)?.revisionCount} />
                      </button>
                    ))}
                    <CaptureOutcome capture={capture} objects={mine} job={jobs.get(capture.id)} ready={knowledgeStatus === "ready" && organizationLoaded} organizedElsewhere={organized.has(capture.id)} onRetry={() => void distill(capture.id)} />
                  </article>
                );
              })}
            </div>
          ))}
        </section>

        <div className="aside">
          <ConnectedThinking />
          <RecentlyEvolving />
        </div>
      </div>
    </div>
  );
}
