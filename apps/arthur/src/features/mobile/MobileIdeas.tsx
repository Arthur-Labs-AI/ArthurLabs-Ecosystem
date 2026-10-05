import { useMemo, useState } from "react";
import { KNOWLEDGE_OBJECT_KINDS, type KnowledgeObject, type KnowledgeObjectKind } from "@arthur/contracts";
import { Icon, KIND_PLURALS, KindGlyph } from "../../components/icons";
import { Margin } from "../../components/Margin";
import { dayLabel, relativeAge } from "../../components/format";
import { useCaptures } from "../capture/captures-context";
import { useRelationIndex } from "../graph/relation-index";
import { useKnowledge } from "../knowledge/knowledge-context";
import { useLineageSummaries } from "../lineage/lineage-summaries";
import { SettingsButton } from "./MobileApp";
import { useMobileNav } from "./mobile-nav";

/** A row's margin needs the source of its capture, looked up here so the row never waits on the whole captures list. */
function IdeaMargin({ object, age }: { object: KnowledgeObject; age: string }) {
  const { captures } = useCaptures();
  const { byObject } = useLineageSummaries();
  const index = useRelationIndex();
  const source = captures.find((capture) => capture.id === object.provenance.captureId)?.source ?? "text";
  return <Margin source={source} connections={index.countOf(object.id)} revisions={byObject.get(object.id)?.revisionCount} age={age} />;
}

export function MobileIdeas() {
  const { objects, status, error } = useKnowledge();
  const { byObject } = useLineageSummaries();
  const { openIdea, capture } = useMobileNav();
  const [kind, setKind] = useState<KnowledgeObjectKind | "all">("all");
  const [query, setQuery] = useState("");

  const updatedAt = (object: KnowledgeObject): string => byObject.get(object.id)?.updatedAt ?? object.createdAt;
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      objects
        .filter((object) => (kind === "all" || object.kind === kind) && (needle === "" || `${object.title}\n${object.body}`.toLowerCase().includes(needle)))
        .sort((a, b) => updatedAt(b).localeCompare(updatedAt(a))),
    [objects, kind, needle, byObject],
  );

  let lastDay = "";
  return (
    <div className="m-ideas" data-screen="ideas">
      <header className="m-head">
        <div className="m-head-text">
          <h1>Ideas</h1>
          <p className="m-sub">
            {objects.length} {objects.length === 1 ? "thought" : "thoughts"}, newest first
          </p>
        </div>
        <SettingsButton />
      </header>
      <label className="m-search">
        <Icon name="search" />
        <input type="search" placeholder="Search ideas" aria-label="Search ideas" value={query} onChange={(event) => setQuery(event.target.value)} enterKeyHint="search" />
      </label>
      <div className="m-hseg" role="group" aria-label="Filter by kind">
        <button type="button" aria-pressed={kind === "all"} onClick={() => setKind("all")}>
          All<i>{objects.length}</i>
        </button>
        {KNOWLEDGE_OBJECT_KINDS.map((option) => {
          const count = objects.filter((object) => object.kind === option).length;
          return (
            <button key={option} type="button" className={count === 0 ? "zero" : ""} aria-pressed={kind === option} onClick={() => setKind(option)}>
              {KIND_PLURALS[option]}
              <i>{count}</i>
            </button>
          );
        })}
      </div>
      <div className="m-scroll m-list-scroll">
        {status === "loading" && (
          <div className="m-state" role="status" aria-label="Loading ideas">
            <div className="skel" style={{ height: 18, width: "55%" }} />
            <div className="skel" style={{ height: 12, width: "90%" }} />
            <p>Loading ideas…</p>
          </div>
        )}
        {status === "error" && error && (
          <p role="alert" className="m-note-block err">
            {error}
          </p>
        )}
        {status === "ready" && objects.length === 0 && (
          <div className="m-state">
            <h2>No ideas yet</h2>
            <p>Capture a thought and Arthur organizes it into ideas, tasks, decisions and questions, each pointing back at your exact words.</p>
            <button type="button" className="m-pbtn primary" onClick={capture}>
              Capture a thought
            </button>
          </div>
        )}
        {status === "ready" && objects.length > 0 && visible.length === 0 && (
          <div className="m-state">
            <h2>Nothing matches</h2>
            <p>No idea matches that search and filter.</p>
          </div>
        )}
        <ul aria-label="Ideas">
          {visible.map((object) => {
            const day = dayLabel(updatedAt(object));
            const heading = day !== lastDay ? day : null;
            lastDay = day;
            return (
              <li key={object.id}>
                {heading && <div className="m-day">{heading}</div>}
                <button type="button" className="m-idea" onClick={() => openIdea(object.id)}>
                  <KindGlyph kind={object.kind} />
                  <span className="m-idea-text">
                    <span className="m-t">{object.title}</span>
                    <span className="m-s">{object.body}</span>
                    <IdeaMargin object={object} age={relativeAge(updatedAt(object))} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
