/**
 * Keyboard shortcuts. Only the ones in `BOUND` do anything.
 *
 * `RESERVED` are held for features that do not exist yet. Nothing may bind them, so adding them later changes no
 * existing behaviour. (Mod+K was reserved for Ask Arthur until it shipped; it is bound now.)
 */
export const BOUND = { capture: "Mod+N", askArthur: "Mod+K", submitCapture: "Mod+Enter", focusSearch: "/" } as const;
export const RESERVED: Record<string, string> = {};

/** True for Mod+K with no other modifier. */
export const isAskShortcut = (event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string }): boolean =>
  isMod(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k";

/** True where the modifier key is ⌘ rather than Ctrl. This only labels a key; it never changes behaviour (both work everywhere). */
export function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /^Mac/i.test(navigator.platform);
}

export const modLabel = (): string => (isApplePlatform() ? "⌘" : "Ctrl");

export const isMod = (event: { metaKey: boolean; ctrlKey: boolean }): boolean => event.metaKey || event.ctrlKey;
