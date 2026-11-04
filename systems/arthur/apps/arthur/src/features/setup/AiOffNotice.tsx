import { useArthurClient } from "../../hooks/use-arthur-client";
import { useAiConfig } from "./ai-config-context";

/**
 * A quiet line on Home when a cloud capability has no credential. It names what is unavailable and, just as plainly, what still
 * works. It shows nothing while everything is connected, or while the configuration is still unknown.
 */
export function AiOffNotice({ variant, context = "home", onOpenSettings }: { variant: "desktop" | "mobile"; context?: "home" | "ask"; onOpenSettings: () => void }) {
  const client = useArthurClient();
  const ai = useAiConfig();
  const llmOff = ai.isUnavailable("llm");
  const voiceOff = context === "home" && client.capabilities.voiceCapture && ai.isUnavailable("stt");
  if (!llmOff && !voiceOff) return null;

  const lines = [
    llmOff && context === "home" && "Organizing and Ask Arthur are off until you connect AI. Captures are still saved.",
    llmOff && context === "ask" && "Ask Arthur can’t write answers until you connect AI, and captures that haven’t been organized yet can’t be searched. Ideas already organized are still found by your words.",
    voiceOff && "Voice Capture is off until you connect AI. Typing still works.",
  ].filter(Boolean);

  return (
    <div className={variant === "mobile" ? "m-note-block" : "ai-off"} role="status">
      {lines.map((line) => (
        <p key={String(line)}>{line}</p>
      ))}
      <button type="button" className={variant === "mobile" ? "m-pbtn sm" : "btn"} onClick={onOpenSettings}>
        Connect AI
      </button>
    </div>
  );
}
