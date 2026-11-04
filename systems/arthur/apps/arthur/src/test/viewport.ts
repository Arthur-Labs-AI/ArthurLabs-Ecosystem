import { afterEach } from "vitest";
import { resetBackStack } from "../features/mobile/back-stack";

/**
 * A controllable `matchMedia`, so a test can put the app at a phone or desktop width and move between them.
 * jsdom has no layout, so the width is what the test says it is. Nothing else about the query is interpreted
 * except `max-width: <px>`; every other query (e.g. reduced motion) answers "no".
 */
export function installViewport(initialWidth: number) {
  const original = window.matchMedia;
  let width = initialWidth;
  const listeners = new Set<{ query: string; fn: () => void }>();
  const matches = (query: string): boolean => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return max ? width <= Number(max[1]) : false;
  };
  window.matchMedia = ((query: string) => {
    const entry = { query, fn: () => undefined as void };
    return {
      get matches() {
        return matches(query);
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, fn: () => void) => listeners.add({ query, fn: (entry.fn = fn) }),
      removeEventListener: (_type: string, fn: () => void) => {
        for (const item of listeners) if (item.fn === fn) listeners.delete(item);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
  return {
    /** Resizes the "window" and tells every listener, like the browser does when the width crosses a breakpoint. */
    setWidth(next: number) {
      width = next;
      for (const item of [...listeners]) item.fn();
    },
    restore() {
      window.matchMedia = original;
      resetBackStack();
    },
  };
}

/** Installs a phone-width viewport for one test file and removes it afterwards. Returns the controller. */
export function usePhoneViewport(width = 390) {
  const holder: { current: ReturnType<typeof installViewport> | null } = { current: null };
  const control = {
    start: () => (holder.current = installViewport(width)),
    setWidth: (next: number) => holder.current?.setWidth(next),
  };
  afterEach(() => {
    holder.current?.restore();
    holder.current = null;
  });
  return control;
}
