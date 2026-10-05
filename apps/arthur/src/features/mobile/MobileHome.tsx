import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Capture, KnowledgeObject } from "@arthur/contracts";
import { useNavigation } from "../../app/navigation";
import { isMod } from "../../app/shortcuts";
import { Icon, KindGlyph, SOURCE_LABELS, SourceIcon } from "../../components/icons";
import { Margin } from "../../components/Margin";
import { dayLabel, formatMoment, relativeAge } from "../../components/format";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { useCaptures } from "../capture/captures-context";
import type { VoiceFailure } from "../capture/use-captures";
import { useRelationIndex } from "../graph/relation-index";
import { greeting } from "../home/HomeScreen";
import { useKnowledge } from "../knowledge/knowledge-context";
import type { OrganizeJob } from "../knowledge/use-knowledge";
import { useLineageSummaries } from "../lineage/lineage-summaries";
import { useProjects } from "../projects/projects-context";
import { MobileBrand, SettingsButton } from "./MobileApp";
import { useMobileNav } from "./mobile-nav";

/** How many recent captures Home lists. The rest are one tap away in Ideas. */
const RECENT = 8;

const excerpt = (text: string, max = 160): string => {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
};

/**
 * What each voice failure honestly means today. The native layer deletes the recording on every failure, so the copy
 * never offers a retry of the audio: the user has to speak again or type.
 */
function describe(failure: VoiceFailure): { title: string; body: string; canRecord: boolean } {
  switch (failure.code) {
    case "microphone_permission_denied":
      return { title: "Microphone is off", body: `${failure.message} You can still type your thought.`, canRecord: false };
    case "recording_interrupted":
      return { title: "Recording stopped", body: failure.message, canRecord: true };
    case "empty_transcript":
      return { title: "No speech recognised", body: failure.message, canRecord: true };
    case "stt_retryable":
      // The native message names the cause and says the recording is kept, and for how long.
      return { title: "Couldn’t transcribe yet", body: failure.message, canRecord: false };
    case "no_retained_recording":
      return { title: "That recording is gone", body: failure.message, canRecord: true };
    case "stt_failed":
    case "stt_not_configured":
      return { title: "Couldn’t transcribe", body: `${failure.message} The recording isn’t kept, so say it again or type it.`, canRecord: failure.code === "stt_failed" };
    case "voice_unavailable":
      return { title: "Voice isn’t available here", body: failure.message, canRecord: false };
    default:
      return { title: "Couldn’t save the recording", body: failure.message, canRecord: true };
  }
}

function VoiceFailureCard({
  failure,
  onRecord,
  onType,
  onDismiss,
  onRetry,
  onDiscard,
  onOpenSettings,
  voiceAvailable,
}: {
  failure: VoiceFailure;
  onRecord: () => void;
  onType: () => void;
  onDismiss: () => void;
  onRetry: () => void;
  onDiscard: () => void;
  /** Present only when the system will no longer ask, so the app's settings are the only way back. */
  onOpenSettings?: (() => void) | undefined;
  voiceAvailable: boolean;
}) {
  const view = describe(failure);
  const retryable = failure.code === "stt_retryable";
  const warm = failure.code === "microphone_permission_denied" || retryable;
  return (
    <div className={warm ? "m-note-block" : "m-note-block err"} role="alert" data-code={failure.code}>
      <Icon name="warn" />
      <div className="m-note-main">
        <b>{view.title}</b>
        {view.body}
        <div className="m-row-acts">
          {retryable && (
            <>
              <button type="button" className="m-pbtn sm primary" onClick={onRetry}>
                <Icon name="retry" small />
                Retry transcription
              </button>
              <button type="button" className="m-pbtn sm" onClick={onDiscard}>
                Discard recording
              </button>
            </>
          )}
          {onOpenSettings && (
            <button type="button" className="m-pbtn sm primary" onClick={onOpenSettings}>
              Open settings
            </button>
          )}
          {voiceAvailable && view.canRecord && (
            <button type="button" className="m-pbtn sm" onClick={onRecord}>
              <Icon name="mic" />
              Record again
            </button>
          )}
          {!retryable && (
            <button type="button" className={warm && !onOpenSettings ? "m-pbtn sm primary" : "m-pbtn sm"} onClick={onType}>
              Type instead
            </button>
          )}
          {!retryable && (
            <button type="button" className="m-pbtn sm ghost" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Variant C, the Speak page: a notebook page with Speak as the primary action and typing as the quiet alternative. */
function SpeakPage() {
  const client = useArthurClient();
  const { saving, save, voiceState, startVoice } = useCaptures();
  const { typing, setTyping } = useMobileNav();
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const voice = client.capabilities.voiceCapture;
  const writing = typing || !voice;

  useEffect(() => {
    if (typing) input.current?.focus();
  }, [typing]);

  async function submit() {
    if (draft.trim().length === 0 || saving) return;
    if (await save(draft)) {
      setDraft("");
      setTyping(false);
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && isMod(event)) {
      event.preventDefault();
      void submit();
    }
  }

  if (voiceState === "transcribing") {
    return (
      <div className="m-page-card" role="status" aria-live="polite">
        <div className="m-status-line">
          <span className="skel m-dot" />
          <b>Transcribing…</b>
        </div>
        <div className="m-skels">
          <div className="skel" style={{ width: "92%" }} />
          <div className="skel" style={{ width: "78%" }} />
          <div className="skel" style={{ width: "54%" }} />
        </div>
        <p className="m-fine-left">Your recording is being turned into text. It isn’t kept.</p>
      </div>
    );
  }

  if (writing) {
    return (
      <form
        className={typing ? "m-page-card writing" : "m-page-card"}
        aria-label="Capture a thought"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="m-capture-input" className="visually-hidden">
          Thought
        </label>
        <textarea ref={input} id="m-capture-input" className="m-ruled" rows={3} placeholder="Write it down…" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} enterKeyHint="enter" />
        {/* data-hold-layout: pressing an action closes the keyboard; the page must not move under the finger (see use-viewport). */}
        <div className="m-acts" data-hold-layout onMouseDown={(event) => event.preventDefault()}>
          {voice && typing && (
            <button type="button" className="m-pbtn ghost" onClick={() => setTyping(false)}>
              Cancel
            </button>
          )}
          {voice && (
            <button type="button" className="m-micbtn" aria-label="Speak instead" disabled={voiceState !== "idle"} onClick={() => { setTyping(false); void startVoice(); }}>
              <Icon name="mic" />
            </button>
          )}
          <span className="m-spacer" />
          <button type="submit" className="m-pbtn primary" disabled={saving || draft.trim().length === 0}>
            {saving ? "Saving…" : "Capture"}
          </button>
        </div>
        <p className="m-fine-left">Saved first. Arthur organizes it after.</p>
      </form>
    );
  }

  return (
    <div className="m-page-card">
      <button type="button" className="m-rules" onClick={() => setTyping(true)}>
        Write it down, or just say it.
      </button>
      <div className="m-acts">
        <button type="button" className="m-speak" onClick={() => void startVoice()} disabled={voiceState !== "idle"}>
          <Icon name="mic" />
          Speak
        </button>
        <button type="button" className="m-kbbtn" aria-label="Type a thought" onClick={() => setTyping(true)}>
          <Icon name="keyboard" />
        </button>
      </div>
    </div>
  );
}

/** Which captures just finished organizing in this session, so their thread draws once and is then still. */
function useJustOrganized(jobs: ReadonlyMap<string, OrganizeJob>, objectsOf: (captureId: string) => KnowledgeObject[]): ReadonlySet<string> {
  const [drawn, setDrawn] = useState<ReadonlySet<string>>(new Set());
  const previous = useRef<ReadonlyMap<string, OrganizeJob>>(new Map());
  useEffect(() => {
    const finished: string[] = [];
    for (const [id, job] of previous.current) {
      if (job.status === "organizing" && !jobs.has(id) && objectsOf(id).length > 0) finished.push(id);
    }
    previous.current = jobs;
    if (finished.length === 0) return;
    setDrawn((now) => new Set([...now, ...finished]));
    const timer = window.setTimeout(() => setDrawn((now) => new Set([...now].filter((id) => !finished.includes(id)))), 5000);
    return () => window.clearTimeout(timer);
  });
  return drawn;
}

function GhostKid({ width }: { width: number }) {
  return (
    <div className="m-kid ghost">
      <svg className="kind" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="4.6" strokeDasharray="2 2.4" style={{ stroke: "var(--pencil)" }} />
      </svg>
      <span>
        <span className="skel m-skel-line" style={{ width: `${width}%` }} />
        <span className="skel m-skel-line short" style={{ width: `${width - 30}%` }} />
      </span>
    </div>
  );
}

function Outcome({ capture, objects, job, ready, onRetry, organized, organizedElsewhere }: { capture: Capture; objects: KnowledgeObject[]; job: OrganizeJob | undefined; ready: boolean; onRetry: () => void; organized: boolean; organizedElsewhere: boolean }) {
  const short = capture.id.slice(0, 8);
  if (job?.status === "queued" || job?.status === "organizing") {
    return (
      <>
        <p className="m-badge" role="status">
          {job.status === "queued" ? (
            <>
              <Icon name="check" small />
              Capture saved · waiting to organize…
            </>
          ) : (
            <>
              <i className="m-dash" aria-hidden="true" />
              Arthur is organizing…
            </>
          )}
        </p>
        <div className="m-kids pending">
          <GhostKid width={72} />
        </div>
      </>
    );
  }
  if (job?.status === "failed") {
    return (
      <div className="m-kids pending">
        <div className="m-kid ghost">
          <svg className="kind" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="4.6" strokeDasharray="2 2.4" style={{ stroke: "var(--pencil)" }} />
          </svg>
          <span>
            <b className="m-fail-t" role="alert">
              Your thought is saved.
            </b>
            <span className="m-fail-s">Arthur couldn’t organize it just now. Nothing was lost.</span>
            {job.message && <span className="m-fail-why">{job.message}</span>}
            <button type="button" className="m-pbtn sm" onClick={onRetry} aria-label={`Retry organizing capture ${short}`}>
              <Icon name="retry" small />
              Retry organizing
            </button>
          </span>
        </div>
      </div>
    );
  }
  if (job?.status === "empty") return <p className="m-empty-kid">Nothing to organize in this one.</p>;
  // Organized, but every idea from it was moved to another project: that is not "not organized".
  if (objects.length === 0 && ready && organizedElsewhere) return <p className="m-empty-kid">Its ideas are in other projects.</p>;
  if (objects.length === 0 && ready) {
    return (
      <div className="m-kids pending">
        <div className="m-kid ghost">
          <svg className="kind" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="4.6" strokeDasharray="2 2.4" style={{ stroke: "var(--pencil)" }} />
          </svg>
          <span>
            <span className="m-fail-s">Not organized yet.</span>
            <button type="button" className="m-pbtn sm" onClick={onRetry} aria-label={`Organize capture ${short}`}>
              Organize now
            </button>
          </span>
        </div>
      </div>
    );
  }
  return organized ? (
    <p className="m-badge ok" role="status">
      <Icon name="check" small />
      Organized
    </p>
  ) : null;
}

function Stream() {
  const { status, captures } = useCaptures();
  const { objects, jobs, distill, organizationLoaded, organized, status: knowledgeStatus, error: knowledgeError } = useKnowledge();
  const { active } = useProjects();
  const index = useRelationIndex();
  const { byObject } = useLineageSummaries();
  const { openIdea } = useMobileNav();

  const shown = captures.slice(0, RECENT);
  const objectsOf = (captureId: string) => objects.filter((object) => object.provenance.captureId === captureId);
  const justOrganized = useJustOrganized(jobs, objectsOf);

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

  return (
    <section className="m-stream" aria-label="Recent captures">
      {status === "loading" && <p role="status">Loading captures…</p>}
      {knowledgeStatus === "error" && knowledgeError && <p role="alert">{knowledgeError}</p>}
      {status === "ready" && captures.length === 0 && (
        <div className="m-state">
          <h2>Nothing captured yet</h2>
          <p>
            Capture your first thought for {active?.isInbox ? "the Inbox" : (active?.name ?? "this project")}. Arthur turns it into ideas and keeps your original words next to them.
          </p>
        </div>
      )}
      {groups.map((group) => (
        <div key={group.label}>
          <div className="m-day">{group.label}</div>
          {group.captures.map((capture) => {
            const mine = objectsOf(capture.id);
            const drawn = justOrganized.has(capture.id);
            const job = jobs.get(capture.id);
            return (
              <article key={capture.id} className={mine.length > 0 || job ? "m-group has-kids" : "m-group"} aria-label={`Capture ${capture.id.slice(0, 8)}`}>
                <div className="m-cap-row">
                  <span className="m-cap-dot">
                    <SourceIcon source={capture.source} />
                  </span>
                  <div>
                    <q className="m-cap-q">{excerpt(capture.content)}</q>
                    <div className="m-cap-meta">
                      <span>{SOURCE_LABELS[capture.source]}</span>
                      <span aria-hidden="true">·</span>
                      <time dateTime={capture.createdAt} title={formatMoment(capture.createdAt)}>
                        {relativeAge(capture.createdAt)}
                      </time>
                    </div>
                  </div>
                </div>
                {mine.length > 0 && (
                  <div className="m-kids">
                    {mine.map((object) => (
                      <button key={object.id} type="button" className={drawn ? "m-kid draw" : "m-kid"} onClick={() => openIdea(object.id)}>
                        <KindGlyph kind={object.kind} />
                        <span className="m-kid-text">
                          <span className="m-kt">{object.title}</span>
                          <Margin source={capture.source} showSource={false} connections={index.countOf(object.id)} revisions={byObject.get(object.id)?.revisionCount} />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <Outcome capture={capture} objects={mine} job={job} ready={knowledgeStatus === "ready" && organizationLoaded} onRetry={() => void distill(capture.id)} organized={drawn} organizedElsewhere={organized.has(capture.id)} />
              </article>
            );
          })}
        </div>
      ))}
      {objects.length > 0 && <AllIdeas count={objects.length} />}
    </section>
  );
}

function AllIdeas({ count }: { count: number }) {
  const { go } = useNavigation();
  return (
    <div className="m-seeall">
      <button type="button" className="m-tlink" onClick={() => go("ideas")}>
        All {count} {count === 1 ? "idea" : "ideas"}
        <Icon name="chev" small />
      </button>
    </div>
  );
}

export function MobileHome() {
  const client = useArthurClient();
  const { voiceFailure, dismissVoiceFailure, startVoice, micPermission, retryVoice, discardVoice, openAppSettings } = useCaptures();
  const { typing, setTyping, micHint } = useMobileNav();
  const [hidRecovery, setHidRecovery] = useState(false);
  const voice = client.capabilities.voiceCapture;
  // Refused for good: the system will not ask again, so say so up front (not only after a failed attempt) and offer the way back.
  const settingsOnly = voice && micPermission === "denied_permanently";
  useEffect(() => {
    if (!settingsOnly) setHidRecovery(false);
  }, [settingsOnly]);
  const failure: VoiceFailure | null = voiceFailure ?? (settingsOnly && !hidRecovery ? { code: "microphone_permission_denied", message: "The microphone is turned off for Arthur, and the system won’t ask again. Allow it in the system settings, then come back." } : null);

  return (
    <div className={typing ? "m-scroll m-home typing" : "m-scroll m-home"} data-screen="home">
      <header className="m-head m-head-home">
        <MobileBrand />
        <SettingsButton />
      </header>
      {!typing && (
        <>
          <p className="m-hello">{greeting()}</p>
          <h1 className="m-hero">What’s on your mind?</h1>
        </>
      )}
      <SpeakPage />
      {micHint && !typing && voice && (
        <p className="m-hint" role="status">
          <Icon name="mic" small />
          Tap Speak and the microphone will be requested. Nothing is recorded until then.
        </p>
      )}
      {failure && (
        <VoiceFailureCard
          failure={failure}
          voiceAvailable={voice}
          onRecord={() => void startVoice()}
          onType={() => {
            dismissVoiceFailure();
            setHidRecovery(true);
            setTyping(true);
          }}
          onDismiss={() => {
            dismissVoiceFailure();
            setHidRecovery(true);
          }}
          onRetry={() => void retryVoice()}
          onDiscard={() => void discardVoice()}
          onOpenSettings={failure.code === "microphone_permission_denied" && settingsOnly ? () => void openAppSettings() : undefined}
        />
      )}
      {!typing && <Stream />}
    </div>
  );
}
