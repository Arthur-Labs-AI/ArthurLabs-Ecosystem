import { describe, expect, it } from "vitest";
import tokens from "../../app/styles/tokens.css?raw";
import mobile from "../mobile/mobile.css?raw";
import css from "./recall.css?raw";
import { contrast } from "../../test/contrast";

/** jsdom has no layout, so the layout and accessibility promises of Ask Arthur are checked where they are written: in the CSS. */
const rule = (source: string, selector: string): string => {
  const at = source.indexOf(`\n${selector} {`);
  if (at === -1) throw new Error(`no rule for ${selector}`);
  return source.slice(at, source.indexOf("}", at));
};
const px = (block: string, property: string): number => Number(new RegExp(`${property}:\\s*(\\d+)px`).exec(block)?.[1]);
const token = (name: string): string => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens)![1]!;

describe("recall.css (Desktop)", () => {
  it("puts the evidence beside the answer, and below it when the margin would crush the answer column", () => {
    expect(css).toMatch(/\.ask\s*{[^}]*container-type:\s*inline-size/);
    expect(rule(css, ".ask-grid")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) minmax\(280px, 340px\)/);
    expect(css).toMatch(/@container \(max-width: 880px\)[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    // 1000px window - 232px rail - 72px padding < 880px: stacked. 1280px: beside.
    expect(1000 - 232 - 72).toBeLessThan(880);
    expect(1280 - 232 - 72).toBeGreaterThan(880);
  });

  it("keeps a long answer readable: a measure, wrapping, and no horizontal overflow", () => {
    expect(rule(css, ".ans")).toContain("max-width: 640px");
    expect(rule(css, ".ans-text")).toContain("overflow-wrap: anywhere");
    expect(rule(css, ".ev-body")).toContain("overflow-wrap: anywhere");
    expect(rule(css, ".ev-title")).toContain("overflow-wrap: anywhere");
    expect(rule(css, ".ans-text")).toContain("var(--serif)");
  });

  it("stops the loading motion for people who prefer reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.ask-thread::after[\s\S]*animation: none/);
  });

  it("has no decoration the design rules out: no gradients, glow, blur or bubbles", () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/gradient|backdrop-filter|filter:\s*blur|box-shadow:[^;]*\d+px \d+px \d+px/);
    expect(code).not.toMatch(/border-radius:\s*(1[2-9]|[2-9]\d)px/);
  });

  it("tells current from earlier by more than colour: a dashed line as well as words", () => {
    expect(rule(css, '.ev-chip[data-state="current"]')).toContain("var(--accent)");
    expect(css).toMatch(/\.ev-chip\[data-state="historical"\][\s\S]*border-style:\s*dashed/);
    expect(rule(css, ".ev-past")).toContain("dashed");
    expect(rule(css, ".ans-ref[data-historical]")).toContain("dashed");
  });

  it("uses only text colours that reach AA on the surfaces they sit on", () => {
    for (const surface of ["ground", "sunken"]) {
      for (const ink of ["ink", "ink-2", "ink-3", "accent", "pencil", "del"]) expect(contrast(token(ink), token(surface)), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("mobile.css (Ask Arthur)", () => {
  it("keeps every Ask control at the touch floor", () => {
    expect(px(rule(mobile, ".m-askbar-send"), "height")).toBeGreaterThanOrEqual(48);
    expect(px(rule(mobile, ".m-askbar-send"), "width")).toBeGreaterThanOrEqual(48);
    expect(px(rule(mobile, ".m-askbar textarea"), "min-height")).toBeGreaterThanOrEqual(48);
    expect(px(rule(mobile, ".m-evrow"), "min-height")).toBeGreaterThanOrEqual(48);
    expect(px(rule(mobile, ".m-ask-body .ans-ref"), "min-height")).toBeGreaterThanOrEqual(44);
    expect(px(rule(mobile, ".m-ask-body .ans-ref"), "min-width")).toBeGreaterThanOrEqual(44);
    expect(px(rule(mobile, ".m-ev .ev-btn"), "min-height")).toBeGreaterThanOrEqual(44);
    expect(px(rule(mobile, ".m-askrow"), "min-height") || Number(/min-height:\s*var\(--m-touch\)/.test(rule(mobile, ".m-askrow")))).toBeTruthy();
  });

  it("types the question at 16px or more, so the keyboard never zooms the page", () => {
    expect(px(rule(mobile, ".m-askbar textarea").replace(/font:\s*\d+\s*(\d+)px/, "font-size: $1px"), "font-size")).toBeGreaterThanOrEqual(16);
  });

  it("clears the bottom safe area, so the question bar sits above the keyboard and the gesture bar", () => {
    expect(rule(mobile, ".m-askbar")).toContain("var(--m-safe-b)");
  });
});
