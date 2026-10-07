import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { isMod, modLabel } from "../../app/shortcuts";
import { useVoiceAvailable } from "../setup/ai-config-context";
import { Icon } from "../../components/icons";
import { useProjects } from "../projects/projects-context";
import { useCaptures } from "./captures-context";
import type { VoiceState } from "./use-captures";
import "./capture.css";

const VOICE_STATUS: Partial<Record<VoiceState, string>> = {
  starting: "Starting the microphone…",
  recording: "Recording…",
  transcribing: "Transcribing…",
};

/**
 * The one place a thought is captured: typed or spoken. Saving only persists the Capture; organizing it into ideas
 * starts afterwards (see AutoOrganize) and can never fail or undo the capture.
 */
export function CaptureComposer({ compact = false, autoFocus = false, onSaved }: { compact?: boolean; autoFocus?: boolean; onSaved?: () => void }) {
  const voiceAvailable = useVoiceAvailable();
  const { saving, error, save, voiceState, startVoice, stopVoice } = useCaptures();
  const { active } = useProjects();
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  async function submit() {
    if (draft.trim().length === 0 || saving) return;
    if (await save(draft)) {
      setDraft("");
      onSaved?.();
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && isMod(event)) {
      event.preventDefault();
      void submit();
    }
  }

  const status = VOICE_STATUS[voiceState];

  return (
    <form className={compact ? "composer compact" : "composer"} onSubmit={handleSubmit} aria-label="Capture a thought">
      <label htmlFor={compact ? "capture-input-dialog" : "capture-input"} className="visually-hidden">
        Thought
      </label>
      <textarea
        ref={input}
        id={compact ? "capture-input-dialog" : "capture-input"}
        rows={2}
        placeholder="What's on your mind?"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {status && (
        <p role="status" className="composer-status">
          {status}
        </p>
      )}
      <div className="composer-bar">
        {voiceAvailable &&
          (voiceState === "recording" ? (
            <button type="button" className="speak recording" onClick={() => void stopVoice()} aria-label="Stop recording">
              <Icon name="stop" />
              Stop
            </button>
          ) : (
            <button type="button" className="speak" onClick={() => void startVoice()} disabled={voiceState !== "idle"} aria-label="Start recording">
              <Icon name="mic" />
              Speak
            </button>
          ))}
        <span className="spacer" />
        {active && !active.isInbox && <span className="hint into">Into {active.name}</span>}
        <span className="hint">Arthur organizes it after you capture</span>
        <button type="submit" className="btn primary" disabled={saving || draft.trim().length === 0}>
          {saving ? "Saving…" : "Capture"} <kbd style={{ borderColor: "currentColor", color: "inherit", opacity: 0.6 }}>{modLabel()}↵</kbd>
        </button>
      </div>
      {error && (
        <p role="alert" className="alert composer-alert">
          {error}
        </p>
      )}
    </form>
  );
}
