import { useEffect, useState } from "react";

/**
 * Which presentation of Arthur to show. It is chosen from the WIDTH of the window and nothing else: no user agent,
 * no platform name, no build flag (the UI never detects its platform; see tests/architecture). A narrow desktop
 * window and a phone get the same shell for the same reason: there is not room for a rail and an inspector.
 */
export const MOBILE_MAX_WIDTH_PX = 720;
export type LayoutMode = "desktop" | "mobile";

const QUERY = `(max-width: ${MOBILE_MAX_WIDTH_PX}px)`;

function currentMode(): LayoutMode {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches ? "mobile" : "desktop";
}

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(currentMode);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(QUERY);
    const update = () => setMode(query.matches ? "mobile" : "desktop");
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mode;
}
