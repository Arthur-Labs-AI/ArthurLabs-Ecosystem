import { afterEach, describe, expect, it } from "vitest";
import { applyStoredTheme, readThemeChoice, saveThemeChoice, THEME_KEY } from "./theme";

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("theme", () => {
  it("defaults to dark", () => {
    applyStoredTheme();
    expect(readThemeChoice()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("saves and applies light, and ignores unknown stored values", () => {
    saveThemeChoice("light");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    window.localStorage.setItem(THEME_KEY, "neon");
    expect(readThemeChoice()).toBe("dark");
  });
});
