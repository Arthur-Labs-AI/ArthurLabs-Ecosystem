import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MAX_QUERY_CHARS, type CognitiveAnswer, type CognitiveEvidence } from "@arthur/contracts";
import { useNavigation } from "../../app/navigation";
import { modLabel } from "../../app/shortcuts";
import { Icon } from "../../components/icons";
import { useProjects } from "../projects/projects-context";
import { useAsk } from "./ask-context";
import { EvidenceDetail, KindLine, StateChips } from "./Evidence";
import { OutcomeBody } from "./Outcome";
import { RecallDebug } from "./RecallDebug";
import { evidenceDomId, type EvidenceIndex, type Marker } from "./evidence-model";
import { useEvidenceNav, type EvidenceTarget } from "./use-evidence-nav";
import "./recall.css";

/** The shared question box. Enter asks, Shift+Enter breaks the line. */
export function QuestionBox({ placeholder, rows = 2 }: { placeholder: string; rows?: number }) {
  const { draft, setDraft, ask, canAsk, state, focusTick } = useAsk();
  const ref = useRef<HTMLTextAreaElement>(null);
  const length = [...draft.trim()].length;
  const over = length > MAX_QUERY_CHARS;
  useEffect(() => {
    if (focusTick > 0) ref.current?.focus();
  }, [focusTick]);
  return (
    <form
      className="ask-form"
      onSubmit={(event) => {
        event.preventDefault();
        ask();
      }}
    >
      <label className="visually-hidden" htmlFor="ask-input">
        Your question
      </label>
      <textarea
        id="ask-input"
        ref={ref}
        rows={rows}
        value={draft}
        placeholder={placeholder}
        aria-describedby={over ? "ask-count" : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            ask();
          }
        }}
      />
      <div className="ask-form-row">
        {length > MAX_QUERY_CHARS - 80 && (
          <span id="ask-count" className={over ? "ask-count over" : "ask-count"} role={over ? "alert" : undefined}>
            {length}/{MAX_QUERY_CHARS}
          </span>
        )}
        <span className="spacer" />
        <button type="submit" className="btn primary" disabled={!canAsk || state.status === "loading"}>
          Ask
        </button>
      </div>
    </form>
  );
}

/** One calm state. The backend reports no stages, so none are invented, and there is no percentage. */
export function Asking({ project, onCancel }: { project: string; onCancel: () => void }) {
  return (
    <div className="ask-loading" role="status" aria-live="polite">
      <i className="ask-thread" aria-hidden="true" />
      <p>Looking through {project}…</p>
      <button type="button" className="ev-link" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

export function AskFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="ans notice" role="alert">
      <h2>That couldn’t be asked</h2>
      <p className="ans-lead">{message}</p>
      <button type="button" className="btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function ProjectLine({ name, archived }: { name: string; archived: boolean }) {
  return (
    <p className="ask-project">
      Active project: <b>{name}</b>
      {archived && <span className="ev-chip" data-state="archived">Archived</span>}
    </p>
  );
}

function EvidenceList({
  entries,
  index,
  heading,
  defaultOpen,
  activeHandle,
  overrides,
  onToggle,
  onHover,
  onOpen,
}: {
  entries: readonly CognitiveEvidence[];
  index: EvidenceIndex;
  heading: string;
  defaultOpen: boolean;
  activeHandle: string | null;
  overrides: ReadonlyMap<string, boolean>;
  onToggle: (handle: string, expanded: boolean) => void;
  onHover: (handle: string | null) => void;
  onOpen: (target: EvidenceTarget, entry: CognitiveEvidence) => void;
}) {
  const headingId = `evs-${heading.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section className="evs" aria-labelledby={headingId}>
      <h2 id={headingId}>
        {heading}
        <span className="ev-n">{entries.length}</span>
      </h2>
      <ol>
        {entries.map((entry) => {
          const expanded = overrides.get(entry.handle) ?? defaultOpen;
          return (
            <li
              key={entry.handle}
              id={evidenceDomId(entry.handle)}
              className="ev"
              tabIndex={-1}
              data-status={entry.status}
              data-external={entry.externalProject || undefined}
              data-active={activeHandle === entry.handle || undefined}
              onMouseEnter={() => onHover(entry.handle)}
              onMouseLeave={() => onHover(null)}
            >
              <div className="ev-head">
                <span className="ev-handle">{entry.handle}</span>
                <KindLine entry={entry} />
                <StateChips entry={entry} />
              </div>
              <h3 className="ev-title">{entry.title}</h3>
              <button
                type="button"
                className="ev-link ev-toggle"
                aria-expanded={expanded}
                aria-label={`${expanded ? "Hide" : "Show"} details for ${entry.handle}, ${entry.title}`}
                onClick={() => onToggle(entry.handle, !expanded)}
              >
                {expanded ? "Hide details" : "Show details"}
              </button>
              {expanded && <EvidenceDetail entry={entry} index={index} onOpen={onOpen} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Marginalia Desktop: the question, the grounded answer, and its evidence in the margin beside it. */
export function AskScreen() {
  const { state, reset, ask, project: asked, readOnly } = useAsk();
  const { go } = useNavigation();
  const { active, closeArchived } = useProjects();
  // Interaction state belongs to the result it was made on: it is keyed by the answer, so a new result starts fresh without an effect.
  const [local, setLocal] = useState<{ answer: CognitiveAnswer | null; active: string | null; overrides: ReadonlyMap<string, boolean> }>({ answer: null, active: null, overrides: new Map() });
  const nav = useEvidenceNav(
    useCallback(
      (target, objectId) => {
        if (target === "evolution") go("evolution", objectId);
        else if (target === "connections") go("connections", objectId);
        else if (target === "project") go("ideas", null);
        else go("ideas", objectId);
      },
      [go],
    ),
  );

  const answer: CognitiveAnswer | null = state.status === "ready" ? state.answer : null;
  const current = local.answer === answer ? local : { answer, active: null, overrides: new Map<string, boolean>() };
  const activeHandle = current.active;
  const overrides = current.overrides;
  const setActiveHandle = useCallback((handle: string | null) => setLocal((now) => ({ ...(now.answer === answer ? now : { answer, active: null, overrides: new Map() }), active: handle })), [answer]);
  const setOverrides = useCallback(
    (update: (now: ReadonlyMap<string, boolean>) => ReadonlyMap<string, boolean>) => setLocal((now) => ({ ...(now.answer === answer ? now : { answer, active: null, overrides: new Map() }), overrides: update(now.answer === answer ? now.overrides : new Map()) })),
    [answer],
  );

  const focusEvidence = useCallback((handle: string) => {
    // Make sure the target is open, then bring it into view and give it focus.
    setOverrides((now) => new Map(now).set(handle, true));
    setActiveHandle(handle);
    window.requestAnimationFrame(() => {
      const node = document.getElementById(evidenceDomId(handle));
      node?.scrollIntoView?.({ block: "nearest", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      node?.focus({ preventScroll: true });
    });
  }, [setOverrides, setActiveHandle]);

  const renderEvidence = useCallback(
    (entries: CognitiveEvidence[], index: EvidenceIndex, heading: string, open = true): ReactNode => (
      <EvidenceList
        entries={entries}
        index={index}
        heading={heading}
        defaultOpen={open}
        activeHandle={activeHandle}
        overrides={overrides}
        onToggle={(handle, expanded) => setOverrides((now) => new Map(now).set(handle, expanded))}
        onHover={setActiveHandle}
        onOpen={(target, entry) => void nav.go(target, entry)}
      />
    ),
    [activeHandle, overrides, nav],
  );

  const onMark = useCallback(
    (marker: Marker) => {
      focusEvidence(marker.entry);
    },
    [focusEvidence],
  );

  const project = asked;
  const body = useMemo(() => {
    if (!answer) return null;
    return <OutcomeBody answer={answer} evidence={renderEvidence} handlers={{ activeHandle, onMark, onHover: setActiveHandle, onRetry: () => ask(answer.query) }} />;
  }, [answer, renderEvidence, activeHandle, onMark, ask]);

  return (
    <section className="ask" aria-labelledby="ask-title">
      <header className="ask-head">
        <h1 id="ask-title">Ask Arthur</h1>
        {project ? <ProjectLine name={project.name} archived={project.archivedAt !== null} /> : <p className="ask-project">Loading projects…</p>}
        {readOnly && (
          <p className="ask-note ask-readonly">
            Read-only: you opened this archived project to ask about it. Nothing here can be changed.{" "}
            <button type="button" className="ev-link" onClick={closeArchived}>
              Back to {active?.name ?? "your project"}
            </button>
          </p>
        )}
        <p className="ask-note">Answers come only from what you’ve captured here, and each one shows where it came from.</p>
      </header>
      <QuestionBox placeholder={project ? `Ask about ${project.name}…` : "Ask about this project…"} />
      <div className="ask-result" aria-live="polite" aria-busy={state.status === "loading"}>
        {state.status === "idle" && (
          <p className="ask-empty">
            Ask a question and Arthur will look for the answer in <b>{project?.name ?? "this project"}</b>. <kbd>{modLabel()} K</kbd> brings you back here from anywhere.
          </p>
        )}
        {state.status === "loading" && <Asking project={state.project.name} onCancel={reset} />}
        {state.status === "error" && <AskFailure message={state.message} onRetry={() => ask(state.query)} />}
        {state.status === "ready" && (
          <>
            {state.answer.scope.archived && (
              <p className="ask-note">
                <Icon name="warn" small /> {state.answer.scope.projectName} is archived. This answer reads it as it was.
              </p>
            )}
            <div className="ask-grid" data-outcome={state.answer.outcome}>
              {body}
            </div>
            {nav.notice && (
              <p role="alert" className="alert">
                {nav.notice}
              </p>
            )}
            <RecallDebug answer={state.answer} totalMs={state.totalMs} />
          </>
        )}
      </div>
    </section>
  );
}
