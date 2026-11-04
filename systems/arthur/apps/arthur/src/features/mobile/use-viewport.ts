import { useEffect, useState } from "react";

export interface ViewportState {
  /** Height of the area the app can actually use. Shrinks while the software keyboard is up. */
  height: number | null;
  keyboardOpen: boolean;
}

/**
 * Follows the visual viewport, so the page is laid out above the software keyboard whether the platform resizes the
 * window or overlays the keyboard on it. Where `visualViewport` does not exist the CSS falls back to 100dvh.
 *
 * One rule keeps taps from being lost: while a finger is down on something marked `data-hold-layout`, the layout does
 * not follow the viewport. Pressing a button closes the keyboard, the viewport grows, the button would slide down
 * from under the finger and the tap would land on nothing. The layout catches up a moment after the finger lifts.
 */
export function useViewport(): ViewportState {
  const [state, setState] = useState<ViewportState>({ height: null, keyboardOpen: false });
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let baseline = Math.max(window.innerHeight, viewport.height);
    let holding = false;
    let release: number | undefined;
    const update = () => {
      if (holding) return;
      baseline = Math.max(baseline, window.innerHeight, viewport.height);
      setState({ height: Math.round(viewport.height), keyboardOpen: baseline - viewport.height > 140 });
    };
    const press = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-hold-layout]")) {
        holding = true;
        window.clearTimeout(release);
      }
    };
    const lift = () => {
      if (!holding) return;
      window.clearTimeout(release);
      release = window.setTimeout(() => {
        holding = false;
        update();
      }, 450);
    };
    update();
    viewport.addEventListener("resize", update);
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("pointerup", lift, true);
    document.addEventListener("pointercancel", lift, true);
    return () => {
      viewport.removeEventListener("resize", update);
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("pointerup", lift, true);
      document.removeEventListener("pointercancel", lift, true);
      window.clearTimeout(release);
    };
  }, []);
  return state;
}
