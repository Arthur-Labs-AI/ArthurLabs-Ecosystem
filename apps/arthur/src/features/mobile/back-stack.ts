import { useEffect, useRef } from "react";

/**
 * The system Back gesture, handled by the UI instead of leaving the app.
 *
 * Anything the user can "go back out of" (a pushed page, a sheet, typing mode) is a layer. Opening a layer pushes one
 * history entry; Back (the browser's `popstate`) closes the topmost layer; closing a layer from the UI pops its entry.
 * With no layer open Back is not ours: it leaves the screen the way the platform wants.
 */
interface Layer {
  close: () => void;
}

const stack: Layer[] = [];
let ignore = 0;
let listening = false;

function onPopState() {
  if (ignore > 0) {
    ignore -= 1;
    return;
  }
  const top = stack.pop();
  top?.close();
}

function ensureListener() {
  if (listening || typeof window === "undefined") return;
  window.addEventListener("popstate", onPopState);
  listening = true;
}

/** Test hook: forget every layer and pending pop. */
export function resetBackStack() {
  stack.length = 0;
  ignore = 0;
}

function push(layer: Layer): () => void {
  ensureListener();
  stack.push(layer);
  window.history.pushState({ arthurLayer: stack.length }, "");
  return () => {
    const at = stack.lastIndexOf(layer);
    if (at === -1) return; // Back already closed it
    stack.splice(at, 1);
    ignore += 1;
    window.history.back();
  };
}

/** While `active`, system Back calls `onClose` instead of leaving. `onClose` must make `active` false. */
export function useBackLayer(active: boolean, onClose: () => void) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!active) return;
    return push({ close: () => latest.current() });
  }, [active]);
}
