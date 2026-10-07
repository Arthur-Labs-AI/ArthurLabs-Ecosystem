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
/** Layers closed from the UI whose history entry has not been popped yet (popped together, after the current update has finished). */
let pendingPops = 0;
let flushScheduled = false;

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
  pendingPops = 0;
  flushScheduled = false;
}

/**
 * Closing a layer from the UI pops its history entry, but not at once: a layer is often closed and another opened in the same
 * update (a sheet closes and the idea page it led to opens). `history.back()` is asynchronous, so popping straight away would
 * run AFTER the new layer's entry was pushed and remove the wrong one. Instead the pop waits until the update is over, and a
 * layer opened meanwhile takes over the entry that was about to be popped.
 */
function schedulePop() {
  pendingPops += 1;
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    if (pendingPops === 0) return;
    ignore += pendingPops;
    const count = pendingPops;
    pendingPops = 0;
    window.history.go(-count);
  });
}

function push(layer: Layer): () => void {
  ensureListener();
  stack.push(layer);
  if (pendingPops > 0) {
    pendingPops -= 1;
    window.history.replaceState({ arthurLayer: stack.length }, "");
  } else {
    window.history.pushState({ arthurLayer: stack.length }, "");
  }
  return () => {
    const at = stack.lastIndexOf(layer);
    if (at === -1) return; // Back already closed it
    stack.splice(at, 1);
    schedulePop();
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
