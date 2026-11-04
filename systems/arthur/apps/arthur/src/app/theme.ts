/**
 * Appearance: dark is the default; light is the same design system with its own token values (tokens.css).
 * The choice is a per-device preference, not knowledge, so it lives in localStorage and never touches the client.
 */
export type ThemeChoice = "dark" | "light" | "system";

export const THEME_KEY = "arthur.theme";
export const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "system" ? stored : "dark";
  } catch {
    return "dark";
  }
}

/** Sets `data-theme` on <html>. "system" follows the OS preference at the time of the call. */
export function applyTheme(choice: ThemeChoice): void {
  const light = choice === "light" || (choice === "system" && window.matchMedia?.("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
}

export function saveThemeChoice(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // The preference just won't persist; the choice still applies for this session.
  }
  applyTheme(choice);
}

export function applyStoredTheme(): void {
  applyTheme(readThemeChoice());
}
