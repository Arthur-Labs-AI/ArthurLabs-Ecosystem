import { useArthurClient } from "../../hooks/use-arthur-client";
import { useAiConfig } from "../setup/ai-config-context";
import { useSpeechSource } from "./speech-context";
import "./speech.css";

/**
 * "Listen": reads one Arthur answer aloud, only when asked. It never plays by itself and starts no conversation.
 *
 * It exists only where the device can play audio AND text-to-speech has a credential; otherwise it is simply absent and the text
 * answer is untouched. A failure shows one fixed sentence under the button and never changes the answer above it.
 */
export function ListenButton({ text, source = "answer" }: { text: string; source?: string }) {
  const client = useArthurClient();
  const ai = useAiConfig();
  const speech = useSpeechSource(source);
  if (!client.capabilities.speechOutput || ai.isUnavailable("tts") || text.trim().length === 0) return null;

  return (
    <div className="listen">
      <button
        type="button"
        className="listen-btn"
        aria-pressed={speech.active}
        aria-label={speech.active ? "Stop listening" : "Listen to this answer"}
        onClick={() => void (speech.active ? speech.stop() : speech.speak(text))}
      >
        {speech.active ? (speech.preparing ? "Preparing… Stop" : "Stop") : "Listen"}
      </button>
      {speech.truncated && <p className="listen-note">Reading the first part of a long answer.</p>}
      {speech.error && (
        <p className="listen-note" role="status">
          {speech.error}
        </p>
      )}
    </div>
  );
}
