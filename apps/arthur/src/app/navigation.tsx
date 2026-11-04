import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type Screen = "home" | "ideas" | "connections" | "evolution" | "review" | "ask" | "settings";

export interface Navigation {
  screen: Screen;
  /** The idea the user is looking at. Shared, so "Open in Connections" lands on the same idea. */
  focusId: string | null;
  /** Switches screen. Pass `focusId` to also change which idea is in focus; omit it to keep the current one. */
  go: (screen: Screen, focusId?: string | null) => void;
  focus: (focusId: string | null) => void;
  captureOpen: boolean;
  openCapture: () => void;
  closeCapture: () => void;
}

const NavigationContext = createContext<Navigation | null>(null);

export function NavigationProvider({ initialScreen = "home", children }: { initialScreen?: Screen; children: ReactNode }) {
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);

  const go = useCallback((next: Screen, id?: string | null) => {
    setScreen(next);
    if (id !== undefined) setFocusId(id);
  }, []);
  const openCapture = useCallback(() => setCaptureOpen(true), []);
  const closeCapture = useCallback(() => setCaptureOpen(false), []);

  const value = useMemo<Navigation>(() => ({ screen, focusId, go, focus: setFocusId, captureOpen, openCapture, closeCapture }), [screen, focusId, go, captureOpen, openCapture, closeCapture]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): Navigation {
  const value = useContext(NavigationContext);
  if (!value) throw new Error("useNavigation must be used inside <NavigationProvider>");
  return value;
}
