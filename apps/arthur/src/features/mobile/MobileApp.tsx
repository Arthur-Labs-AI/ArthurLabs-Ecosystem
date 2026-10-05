import { useEffect, useState } from "react";
import { useNavigation, type Screen } from "../../app/navigation";
import { Icon, Mark, type IconName } from "../../components/icons";
import { useCaptures } from "../capture/captures-context";
import { MobileBackLayer } from "./MobileBackLayer";
import { MobileConnections } from "./MobileConnections";
import { MobileEvolution } from "./MobileEvolution";
import { MobileHome } from "./MobileHome";
import { MobileIdeaDetail } from "./MobileIdeaDetail";
import { MobileIdeas } from "./MobileIdeas";
import { ProjectChip, ProjectSheet } from "./MobileProjects";
import { MobileSettings } from "./MobileSettings";
import { MobileNavProvider, useMobileNav } from "./mobile-nav";
import { useViewport } from "./use-viewport";
import "./mobile.css";

type Tab = Exclude<Screen, "settings">;
const LEFT: { screen: Tab; label: string; icon: IconName }[] = [
  { screen: "home", label: "Home", icon: "home" },
  { screen: "ideas", label: "Ideas", icon: "ideas" },
];
const RIGHT: { screen: Tab; label: string; icon: IconName }[] = [
  { screen: "connections", label: "Connections", icon: "connections" },
  { screen: "evolution", label: "Evolution", icon: "evolution" },
];

/** Settings lives at the top right of every tab, never in the bar. */
export function SettingsButton() {
  const { openSettings } = useMobileNav();
  return (
    <>
      <ProjectChip />
      <button type="button" className="m-iconbtn" aria-label="Settings" onClick={openSettings}>
        <Icon name="settings" />
      </button>
    </>
  );
}

export function MobileBrand() {
  return (
    <div className="m-brandrow">
      <Mark size={24} />
      <b>Arthur</b>
    </div>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A recording is a moment, not a state of a form: it takes the whole screen and hides the bar. */
function Recording() {
  const { voiceState, stopVoice, cancelVoice } = useCaptures();
  const { go } = useNavigation();
  const [seconds, setSeconds] = useState(0);
  const live = voiceState === "recording";

  useEffect(() => {
    if (!live) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [live]);

  return (
    <div className="m-rec" role="dialog" aria-modal="true" aria-label="Recording">
      <div className="m-rec-top">
        <button type="button" className="m-pbtn ghost" onClick={() => void cancelVoice()} disabled={!live}>
          <Icon name="x" />
          Discard
        </button>
      </div>
      <div className="m-rec-mid">
        <div className="m-rec-thread" aria-hidden="true" />
        <div className="m-rec-live" aria-hidden="true" />
        <p className="m-rec-label" role="status">
          {live ? "Listening" : "Starting the microphone…"}
        </p>
        <div className="m-rec-clock" role="timer" aria-label={`${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds`}>
          {Math.floor(seconds / 60)}:{pad(seconds % 60)}
        </div>
        <p className="m-rec-cue">Say it however it comes. Arthur organizes it after.</p>
      </div>
      <div className="m-rec-bottom">
        <button
          type="button"
          className="m-rec-stop"
          disabled={!live}
          onClick={() => {
            go("home");
            void stopVoice();
          }}
        >
          <i aria-hidden="true" />
          Stop and save
        </button>
        <p className="m-rec-fine">Audio is sent for transcription and isn’t kept.</p>
      </div>
    </div>
  );
}

function Tab({ item }: { item: { screen: Tab; label: string; icon: IconName } }) {
  const { screen, go } = useNavigation();
  const { closeAllPages, pages } = useMobileNav();
  const current = screen === item.screen && pages.length === 0;
  return (
    <button
      type="button"
      className="m-tab"
      aria-current={current ? "page" : undefined}
      onClick={() => {
        closeAllPages();
        go(item.screen);
      }}
    >
      <Icon name={item.icon} />
      <span>{item.label}</span>
    </button>
  );
}

function TabBar() {
  const { capture } = useMobileNav();
  return (
    <nav className="m-tabbar" aria-label="Primary">
      {LEFT.map((item) => (
        <Tab key={item.screen} item={item} />
      ))}
      <button type="button" className="m-tab m-tab-cap" aria-label="Capture" onClick={capture}>
        <Icon name="mic" />
        <span>Capture</span>
      </button>
      {RIGHT.map((item) => (
        <Tab key={item.screen} item={item} />
      ))}
    </nav>
  );
}

function Frame() {
  const { screen } = useNavigation();
  const { pages, typing, projectSheet } = useMobileNav();
  const { voiceState, voiceFailure, discardVoice } = useCaptures();
  const { height, keyboardOpen } = useViewport();
  const top = pages.at(-1);
  const tab: Tab = screen === "settings" ? "home" : screen;
  const recording = voiceState === "recording" || voiceState === "starting";
  // The retry card lives on Home. Leaving Home (another tab, a page, Settings) leaves the retry flow, and the
  // recording kept for it is deleted: it is never held for a user who has gone elsewhere.
  const retryOpenHere = voiceFailure?.code === "stt_retryable" && tab === "home" && top === undefined;
  useEffect(() => {
    if (voiceFailure?.code === "stt_retryable" && !retryOpenHere && voiceState === "idle") void discardVoice();
  }, [voiceFailure, retryOpenHere, voiceState, discardVoice]);
  const hideBar = keyboardOpen || top !== undefined || (typing && tab === "home");

  return (
    <div className="m-app" style={height !== null ? { height } : undefined}>
      {pages.map((_, index) => (
        <MobileBackLayer key={index} />
      ))}
      <div className="m-screen" aria-hidden={top ? true : undefined} inert={top ? true : undefined}>
        {tab === "home" && <MobileHome />}
        {tab === "ideas" && <MobileIdeas />}
        {tab === "connections" && <MobileConnections />}
        {tab === "evolution" && <MobileEvolution />}
        {voiceState === "transcribing" && tab !== "home" && (
          <p className="m-strip" role="status">
            Transcribing…
          </p>
        )}
      </div>
      {top?.kind === "idea" && <MobileIdeaDetail key={`${pages.length}-${top.id}`} objectId={top.id} />}
      {top?.kind === "settings" && <MobileSettings />}
      {!hideBar && <TabBar />}
      {projectSheet && <ProjectSheet />}
      {recording && <Recording />}
    </div>
  );
}

/** Marginalia Mobile: a bottom tab bar, one column, full-screen pages and bottom sheets. */
export function MobileApp() {
  return (
    <MobileNavProvider>
      <Frame />
    </MobileNavProvider>
  );
}
