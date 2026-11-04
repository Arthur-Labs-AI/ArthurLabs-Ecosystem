import { useState } from "react";
import { applyTheme, readThemeChoice, saveThemeChoice, THEME_CHOICES, type ThemeChoice } from "../../app/theme";

/** Dark / Light / System. A per-device preference, applied immediately. */
export function AppearanceSettings() {
  const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);
  function pick(next: ThemeChoice) {
    setChoice(next);
    saveThemeChoice(next);
    applyTheme(next);
  }
  return (
    <div className="seg flat" role="group" aria-label="Theme">
      {THEME_CHOICES.map((option) => (
        <button key={option.value} type="button" aria-pressed={choice === option.value} onClick={() => pick(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
