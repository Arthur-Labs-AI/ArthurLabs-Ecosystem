import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useNavigation } from "../../app/navigation";
import { useCaptures } from "../capture/captures-context";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { useBackLayer } from "./back-stack";

export type Page = { kind: "idea"; id: string } | { kind: "settings" } | { kind: "ask" };
export type ConnectionsView = "list" | "map";

export interface MobileNav {
  /** Pushed full-screen pages, oldest first. The last one is on screen; none means a tab is. */
  pages: readonly Page[];
  openIdea: (id: string) => void;
  openSettings: () => void;
  /** Ask Arthur is a pushed page, not a tab: the five tabs stay as they are. */
  openAsk: () => void;
  /** Closes the top page. */
  closePage: () => void;
  /** Leaves every pushed page (used by tab switches). */
  closeAllPages: () => void;
  connectionsView: ConnectionsView;
  setConnectionsView: (view: ConnectionsView) => void;
  /** Home's text composer is open. */
  typing: boolean;
  setTyping: (open: boolean) => void;
  /** Tell the user how Speak will ask for the microphone. Set only by the Capture tab when it did not start recording. */
  micHint: boolean;
  /** The project sheet (switch, create, rename, archive) is open. A Back layer of its own, closed by Back before anything else. */
  projectSheet: boolean;
  openProjectSheet: () => void;
  closeProjectSheet: () => void;
  /** The Capture tab. Records straight away only when the microphone is already known to work. */
  capture: () => void;
}

const Context = createContext<MobileNav | null>(null);

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const { go } = useNavigation();
  const client = useArthurClient();
  const { micKnownGranted, voiceState, startVoice } = useCaptures();
  const [pages, setPages] = useState<readonly Page[]>([]);
  const [connectionsView, setConnectionsView] = useState<ConnectionsView>("list");
  const [typing, setTypingState] = useState(false);
  const [micHint, setMicHint] = useState(false);
  const [projectSheet, setProjectSheet] = useState(false);
  const openProjectSheet = useCallback(() => setProjectSheet(true), []);
  const closeProjectSheet = useCallback(() => setProjectSheet(false), []);

  const openIdea = useCallback((id: string) => setPages((current) => [...current, { kind: "idea", id }]), []);
  const openSettings = useCallback(() => setPages((current) => (current.at(-1)?.kind === "settings" ? current : [...current, { kind: "settings" }])), []);
  const openAsk = useCallback(() => setPages((current) => (current.at(-1)?.kind === "ask" ? current : [...current, { kind: "ask" }])), []);
  const closePage = useCallback(() => setPages((current) => current.slice(0, -1)), []);
  const closeAllPages = useCallback(() => setPages([]), []);
  const setTyping = useCallback((open: boolean) => {
    setTypingState(open);
    if (open) setMicHint(false);
  }, []);

  // Typing mode is one Back step. Each pushed page is another (see <BackLayer> in MobileApp).
  useBackLayer(typing && pages.length === 0, () => setTypingState(false));

  const capture = useCallback(() => {
    setPages([]);
    go("home");
    if (!client.capabilities.voiceCapture) {
      setTyping(true);
      return;
    }
    setTypingState(false);
    if (micKnownGranted && voiceState === "idle") {
      setMicHint(false);
      void startVoice();
    } else {
      // The microphone may never have been allowed. Opening the capture surface is safe; only Speak may ask.
      setMicHint(true);
    }
  }, [go, client, micKnownGranted, voiceState, startVoice, setTyping]);

  const value = useMemo<MobileNav>(
    () => ({ pages, openIdea, openSettings, openAsk, closePage, closeAllPages, connectionsView, setConnectionsView, typing, setTyping, micHint, projectSheet, openProjectSheet, closeProjectSheet, capture }),
    [pages, openIdea, openSettings, openAsk, closePage, closeAllPages, connectionsView, typing, setTyping, micHint, projectSheet, openProjectSheet, closeProjectSheet, capture],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useMobileNav(): MobileNav {
  const value = useContext(Context);
  if (!value) throw new Error("useMobileNav must be used inside <MobileApp>");
  return value;
}
