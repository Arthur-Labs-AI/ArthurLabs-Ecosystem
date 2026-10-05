import { describe, expect, it } from "vitest";
import css from "./mobile.css?raw";

/** jsdom has no layout, so the touch-target and safe-area promises are checked where they are written: in the CSS. */
const rule = (selector: string): string => {
  const at = css.indexOf(`\n${selector} {`);
  if (at === -1) throw new Error(`no rule for ${selector}`);
  return css.slice(at, css.indexOf("}", at));
};
const px = (block: string, property: string): number => Number(new RegExp(`${property}:\\s*(\\d+)px`).exec(block)?.[1]);

describe("mobile.css", () => {
  it("keeps every primary control at or above the 44px floor, and the main buttons at 48px", () => {
    for (const selector of [".m-iconbtn", ".m-mapctl button", ".m-tog button", ".m-pbtn.sm", ".m-pchip"]) {
      const block = rule(selector);
      expect(px(block, "height"), selector).toBeGreaterThanOrEqual(44);
    }
    expect(rule(".m-pbtn")).toContain("height: var(--m-touch)");
    expect(Number(/--m-touch:\s*(\d+)px/.exec(css)?.[1])).toBeGreaterThanOrEqual(48);
    expect(px(rule(".m-iconbtn"), "width")).toBeGreaterThanOrEqual(44);
    expect(px(rule(".m-hseg button"), "min-width")).toBeGreaterThanOrEqual(44);
    expect(px(rule(".m-hseg button"), "min-height")).toBeGreaterThanOrEqual(44);
    expect(px(rule(".m-speak"), "height")).toBeGreaterThanOrEqual(48);
    // The project chip and the rows of the project sheet are touch targets too.
    expect(px(rule(".m-pchip"), "min-height")).toBeGreaterThanOrEqual(44);
    expect(px(rule(".m-prow"), "min-height")).toBeGreaterThanOrEqual(48);
    expect(px(rule(".m-kbbtn"), "height")).toBeGreaterThanOrEqual(48);
    expect(px(rule(".m-rec-stop"), "height")).toBeGreaterThanOrEqual(48);
  });

  it("applies the system safe-area insets to the app, the tab bar and the action bar", () => {
    expect(rule(".m-app")).toContain("safe-area-inset-top");
    expect(rule(".m-app")).toContain("safe-area-inset-left");
    expect(css).toMatch(/--m-safe-b:\s*env\(safe-area-inset-bottom/);
    expect(rule(".m-tabbar")).toContain("var(--m-safe-b)");
    expect(rule(".m-actbar")).toContain("var(--m-safe-b)");
    expect(rule(".m-sheet")).toContain("var(--m-safe-b)");
  });

  it("stops every animation and transition when the user prefers reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important[\s\S]*transition: none !important/);
  });

  it("scopes every selector under an m- prefix, so nothing can reach Marginalia Desktop", () => {
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("{")
      .map((chunk) => chunk.split("}").pop() ?? "")
      .filter((chunk) => chunk.trim() && !chunk.trim().startsWith("@") && !/^\s*(from|to|\d+%|0%,)/.test(chunk));
    const offenders = selectors
      .flatMap((chunk) => chunk.split(","))
      .map((part) => part.trim())
      .filter((part) => part && !/\.m-|\.lab-/.test(part) && !/^(from|to|\d+%)$/.test(part));
    expect(offenders).toEqual([]);
  });

  it("has no decoration the design rules out", () => {
    expect(css).not.toMatch(/backdrop-filter|filter:\s*blur|linear-gradient\([^)]*(#|rgb)(?![^)]*var)/);
  });
});
