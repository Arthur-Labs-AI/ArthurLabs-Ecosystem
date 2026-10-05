import { useEffect, type ReactNode } from "react";
import { useCaptures } from "../features/capture/captures-context";
import { useKnowledge } from "../features/knowledge/knowledge-context";
import { ProjectSwitcher } from "../features/projects/ProjectSwitcher";
import { Icon, Mark, type IconName } from "../components/icons";
import { useNavigation, type Screen } from "./navigation";
import { isMod, modLabel } from "./shortcuts";

const ITEMS: { screen: Exclude<Screen, "settings">; label: string; icon: IconName }[] = [
  { screen: "home", label: "Home", icon: "home" },
  { screen: "ideas", label: "Ideas", icon: "ideas" },
  { screen: "connections", label: "Connections", icon: "connections" },
  { screen: "evolution", label: "Evolution", icon: "evolution" },
];

/**
 * The rail and the global Capture action. Capture is a verb you perform from anywhere, so it is a button here
 * and a shortcut, not a page.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { screen, go, openCapture, captureOpen } = useNavigation();
  const { objects, jobs, distilling } = useKnowledge();
  const { voiceState, stopVoice } = useCaptures();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isMod(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        openCapture();
      }
      // Mod+K is deliberately NOT bound: it is reserved for Ask Arthur (see shortcuts.ts).
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openCapture]);

  // Organizing happens in the background, so its outcome must be visible from every screen, not only Home.
  const failed = [...jobs.values()].filter((job) => job.status === "failed").length;

  // A recording must never run invisibly: show it whenever the composer itself is not on screen.
  const composerVisible = screen === "home" || captureOpen;
  const showRecording = !composerVisible && (voiceState === "recording" || voiceState === "starting" || voiceState === "transcribing");

  return (
    <div className="app">
      <aside className="rail" aria-label="Sidebar">
        <div className="brand">
          <Mark />
          <b>Arthur</b>
        </div>
        <ProjectSwitcher />
        <button type="button" className="capture-btn" onClick={openCapture}>
          <Icon name="plus" />
          Capture
          <kbd>{modLabel()} N</kbd>
        </button>
        {showRecording && (
          <div className="rec-pill">
            <i className="dot" aria-hidden="true" />
            <span>{voiceState === "transcribing" ? "Transcribing" : "Recording"}</span>
            {voiceState === "recording" && (
              <button type="button" className="btn" onClick={() => void stopVoice()} aria-label="Stop recording from the sidebar">
                Stop
              </button>
            )}
          </div>
        )}
        <nav className="nav" aria-label="Primary">
          {ITEMS.map((item) => (
            <button key={item.screen} type="button" aria-current={screen === item.screen ? "page" : undefined} onClick={() => go(item.screen)}>
              <Icon name={item.icon} />
              {item.label}
              {item.screen === "ideas" && objects.length > 0 && <span className="count">{objects.length}</span>}
            </button>
          ))}
        </nav>
        <div className="rail-spacer" />
        <nav className="nav" aria-label="Secondary">
          <button type="button" aria-current={screen === "settings" ? "page" : undefined} onClick={() => go("settings")}>
            <Icon name="settings" />
            Settings
          </button>
        </nav>
        <div className="rail-foot">
          {failed > 0 ? (
            <button type="button" className="foot-alert" onClick={() => go("home")}>
              <i className="dot err" aria-hidden="true" />
              {failed === 1 ? "1 capture couldn't be organized" : `${failed} captures couldn't be organized`}
            </button>
          ) : distilling !== null ? (
            <b role="status">
              <i className="dot pulse" aria-hidden="true" />
              Organizing…
            </b>
          ) : (
            <b>
              <i className="dot" aria-hidden="true" />
              Ready
            </b>
          )}
          <span>Knowledge stored locally</span>
        </div>
      </aside>
      <main className="main" id="main">
        {children}
      </main>
    </div>
  );
}
