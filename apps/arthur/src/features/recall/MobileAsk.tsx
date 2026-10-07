import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MAX_QUERY_CHARS, type CognitiveAnswer, type CognitiveEvidence } from "@arthur/contracts";
import { AiOffNotice } from "../setup/AiOffNotice";
import { useNavigation } from "../../app/navigation";
import { Icon } from "../../components/icons";
import { MobileSheet } from "../mobile/MobileSheet";
import { useMobileNav } from "../mobile/mobile-nav";
import { useProjects } from "../projects/projects-context";
import { useAsk } from "./ask-context";
import { EvidenceDetail, KindLine, StateChips } from "./Evidence";
import { Asking, AskFailure, ProjectLine } from "./AskScreen";
import { OutcomeBody } from "./Outcome";
import { RecallDebug } from "./RecallDebug";
import { type EvidenceIndex, type Marker } from "./evidence-model";
import { useEvidenceNav, type EvidenceTarget } from "./use-evidence-nav";
import "./recall.css";

/** Home's way in: a line that reads like the question box, so Ask is one tap from the first screen and the tab bar stays at five. */
export function AskEntry() {
  const { openAsk } = useMobileNav();
  const { active } = useProjects();
  return (
    <button type="button" className="m-askrow" onClick={openAsk}>
      <Icon name="ask" />
      <span className="m-askrow-text">{active ? `Ask about ${active.name}…` : "Ask Arthur…"}</span>
    </button>
  );
}

function EvidenceSheet({ entry, index, onClose, onOpen }: { entry: CognitiveEvidence; index: EvidenceIndex; onClose: () => void; onOpen: (target: EvidenceTarget, entry: CognitiveEvidence) => void }) {
  return (
    <MobileSheet label={`Evidence ${entry.handle}: ${entry.title}`} onClose={onClose}>
      <div className="m-sbody m-ev">
        <div className="ev-head">
          <span className="ev-handle">{entry.handle}</span>
          <KindLine entry={entry} />
        </div>
        <h2 className="m-ev-title">{entry.title}</h2>
        <div className="m-ev-chips">
          <StateChips entry={entry} />
        </div>
        <EvidenceDetail entry={entry} index={index} onOpen={onOpen} />
      </div>
    </MobileSheet>
  );
}

function EvidenceRows({ entries, heading, onPick, activeHandle }: { entries: readonly CognitiveEvidence[]; heading: string; onPick: (entry: CognitiveEvidence, trigger: HTMLElement) => void; activeHandle: string | null }) {
  const id = `m-evs-${heading.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section className="evs m-evs" aria-labelledby={id}>
      <h2 id={id}>
        {heading}
        <span className="ev-n">{entries.length}</span>
      </h2>
      <ol>
        {entries.map((entry) => (
          <li key={entry.handle}>
            <button type="button" className="m-evrow" data-status={entry.status} data-active={activeHandle === entry.handle || undefined} aria-label={`${entry.handle}, ${entry.title}. Show details`} onClick={(event) => onPick(entry, event.currentTarget)}>
              <span className="ev-head">
                <span className="ev-handle">{entry.handle}</span>
                <KindLine entry={entry} />
                <StateChips entry={entry} />
              </span>
              <span className="ev-title">{entry.title}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AskBar({ onSend }: { onSend: () => void }) {
  const { draft, setDraft, canAsk, state, focusTick } = useAsk();
  const ref = useRef<HTMLTextAreaElement>(null);
  const length = [...draft.trim()].length;
  // Opening Ask with nothing on screen goes straight to the question; a kept result is not covered by the keyboard. (Only on arrival and on an explicit request.)
  const idle = state.status === "idle";
  useEffect(() => {
    if (idle || focusTick > 0) ref.current?.focus();
  }, [focusTick]);
  return (
    <form
      className="m-askbar"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
        ref.current?.blur();
      }}
    >
      <label className="visually-hidden" htmlFor="m-ask-input">
        Your question
      </label>
      <textarea
        id="m-ask-input"
        ref={ref}
        rows={1}
        value={draft}
        enterKeyHint="send"
        placeholder="Ask a question…"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canAsk && state.status !== "loading") {
              onSend();
              ref.current?.blur();
            }
          }
        }}
      />
      <button type="submit" className="m-askbar-send" aria-label="Ask" disabled={!canAsk || state.status === "loading"}>
        <Icon name="arrow" />
      </button>
      {length > MAX_QUERY_CHARS && (
        <p className="m-askbar-over" role="alert">
          {length}/{MAX_QUERY_CHARS}: shorten the question to ask it.
        </p>
      )}
    </form>
  );
}

/**
 * Ask Arthur on Marginalia Mobile: a full-screen page reached from Home. The result scrolls above; the question bar sits at the
 * bottom, within thumb reach and above the keyboard. Evidence opens in a sheet and jumps on to the existing idea page.
 */
export function MobileAsk() {
  const { state, reset, ask, setDraft, project, readOnly } = useAsk();
  const { active, closeArchived } = useProjects();
  const scroller = useRef<HTMLDivElement>(null);
  // A new question starts at the top of its result, whatever the last one scrolled to.
  useEffect(() => {
    if (state.status === "loading") scroller.current?.scrollTo?.({ top: 0 });
  }, [state.status]);
  const asked = state.status === "idle" ? null : state.status === "ready" ? state.answer.query : state.query;
  const { go } = useNavigation();
  const { closePage, closeAllPages, openIdea, openSettings, setConnectionsView } = useMobileNav();
  // A sheet belongs to the result it was opened from, so a new question closes it: the state is keyed by the answer.
  const [picked, setPicked] = useState<{ answer: CognitiveAnswer | null; handle: string | null; active: string | null }>({ answer: null, handle: null, active: null });
  const nav = useEvidenceNav(
    useCallback(
      (target, objectId) => {
        setSheet(null);
        if (target === "idea" || target === "capture") {
          // The idea page opens above Ask, so Back returns to the result.
          openIdea(objectId);
          return;
        }
        closeAllPages();
        if (target === "connections") setConnectionsView("list");
        if (target === "project") go("ideas", null);
        else go(target, objectId);
      },
      [openIdea, closeAllPages, go, setConnectionsView],
    ),
  );

  const answer: CognitiveAnswer | null = state.status === "ready" ? state.answer : null;
  const index = useMemo(() => (answer ? { byHandle: new Map(answer.evidence.map((e) => [e.handle, e])), byHistoryHandle: new Map(answer.evidence.flatMap((e) => (e.lineage?.entries ?? []).map((h) => [h.handle, h] as const))) } : null), [answer]);
  const sheet = picked.answer === answer ? picked.handle : null;
  const activeHandle = picked.answer === answer ? picked.active : null;
  const setSheet = useCallback((handle: string | null) => setPicked((now) => ({ answer, handle, active: handle ?? (now.answer === answer ? now.active : null) })), [answer]);
  const setActiveHandle = useCallback((handle: string | null) => setPicked((now) => ({ answer, handle: now.answer === answer ? now.handle : null, active: handle })), [answer]);
  const opened = answer?.evidence.find((entry) => entry.handle === sheet) ?? null;

  const renderEvidence = useCallback(
    (entries: CognitiveEvidence[], _index: EvidenceIndex, heading: string): ReactNode => (
      <EvidenceRows
        entries={entries}
        heading={heading}
        activeHandle={activeHandle}
        onPick={(entry) => {
          setActiveHandle(entry.handle);
          setSheet(entry.handle);
        }}
      />
    ),
    [activeHandle, setActiveHandle, setSheet],
  );
  const onMark = useCallback((marker: Marker) => {
    setActiveHandle(marker.entry);
    setSheet(marker.entry);
  }, [setActiveHandle, setSheet]);

  return (
    <div className="m-page m-ask" role="region" aria-label="Ask Arthur">
      <div className="m-page-top">
        <button type="button" className="m-iconbtn" aria-label="Back" onClick={closePage}>
          <Icon name="back" />
        </button>
      </div>
      <div ref={scroller} className="m-scroll m-ask-scroll" aria-live="polite" aria-busy={state.status === "loading"}>
        <header className="m-head">
          <div className="m-head-text">
            <h1>Ask Arthur</h1>
            {project ? <ProjectLine name={project.name} archived={project.archivedAt !== null} /> : <p className="m-sub">Loading projects…</p>}
            {readOnly && (
              <p className="m-sub">
                Read-only. Nothing here can be changed.{" "}
                <button type="button" className="m-tlink" onClick={closeArchived}>
                  Back to {active?.name ?? "your project"}
                </button>
              </p>
            )}
          </div>
        </header>
        <AiOffNotice variant="mobile" context="ask" onOpenSettings={openSettings} />
        <div className="m-ask-body">
          {asked && (
            <p className="m-ask-q">
              <span className="visually-hidden">Your question: </span>
              {asked}
            </p>
          )}
          {state.status === "idle" && <p className="ask-empty">Ask about what you’ve captured in <b>{project?.name ?? "this project"}</b>. Arthur answers only from your own notes and shows where each part came from.</p>}
          {state.status === "loading" && <Asking project={state.project.name} onCancel={reset} />}
          {state.status === "error" && <AskFailure message={state.message} onRetry={() => ask(state.query)} />}
          {answer && index && (
            <>
              {answer.scope.archived && (
                <p className="ask-note">
                  <Icon name="warn" small /> {answer.scope.projectName} is archived. This answer reads it as it was.
                </p>
              )}
              <div className="ask-grid" data-outcome={answer.outcome}>
                <OutcomeBody answer={answer} evidence={renderEvidence} handlers={{ activeHandle, onMark, onHover: () => undefined, onRetry: () => ask(answer.query) }} />
              </div>
              {nav.notice && (
                <p role="alert" className="m-note-block err">
                  {nav.notice}
                </p>
              )}
              {state.status === "ready" && <RecallDebug answer={answer} totalMs={state.totalMs} />}
            </>
          )}
        </div>
      </div>
      <AskBar
        onSend={() => {
          ask();
          // The question moves up into the result; the bar is free for the next one.
          setDraft("");
        }}
      />
      {opened && index && (
        <EvidenceSheet
          entry={opened}
          index={index}
          onClose={() => setSheet(null)}
          onOpen={(target, entry) => void nav.go(target, entry)}
        />
      )}
    </div>
  );
}
