/**
 * Keyboard shortcuts. Only the ones in `BOUND` do anything today.
 *
 * `RESERVED` are held for features that do not exist yet. Nothing may bind them, so adding them later changes no
 * existing behaviour: Mod+K is for Ask Arthur / the command bar (Cognitive Recall is not implemented yet).
 */
export const BOUND = { capture: "Mod+N", submitCapture: "Mod+Enter", focusSearch: "/" } as const;
export const RESERVED = { askArthur: "Mod+K" } as const;

/** True where the modifier key is ⌘ rather than Ctrl. This only labels a key; it never changes behaviour (both work everywhere). */
export function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /^Mac/i.test(navigator.platform);
}

export const modLabel = (): string => (isApplePlatform() ? "⌘" : "Ctrl");

export const isMod = (event: { metaKey: boolean; ctrlKey: boolean }): boolean => event.metaKey || event.ctrlKey;
