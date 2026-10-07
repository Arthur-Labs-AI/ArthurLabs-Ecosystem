import { describe, expect, it } from "vitest";
import tokens from "./tokens.css?raw";
import { contrast } from "../../test/contrast";

/** WCAG 2.x contrast, measured from the tokens in tokens.css, so a token edit that drops below AA fails here. */
const token = (name: string): string => {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens);
  if (!match) throw new Error(`token --${name} not found`);
  return match[1] as string;
};
const SURFACES = ["ground", "sunken", "raised", "overlay"] as const;

describe("text contrast of the Graphite tokens", () => {
  it.each(SURFACES)("ink, ink-2 and ink-3 are at least 4.5:1 on %s (AA for small text)", (surface) => {
    for (const ink of ["ink", "ink-2", "ink-3"]) expect(contrast(token(ink), token(surface)), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  });

  it("the accent and Arthur's pencil blue read as text on every surface", () => {
    for (const surface of SURFACES) {
      expect(contrast(token("accent"), token(surface)), `accent on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token("pencil"), token(surface)), `pencil on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the filled controls read: Speak (accent-ink on accent) and Capture (ground on ink)", () => {
    expect(contrast(token("accent-ink"), token("accent"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("ground"), token("ink"))).toBeGreaterThanOrEqual(4.5);
  });

  it("every relation colour reaches 3:1 against the map ground, so a line is visible without its label", () => {
    for (const kind of ["related_to", "extends", "depends_on", "derived_from", "contradicts", "duplicates", "supersedes"]) {
      expect(contrast(token(`rel-${kind}`), token("ground")), kind).toBeGreaterThanOrEqual(3);
    }
  });

  it("ink-3, the meta colour the mobile design relies on, is the corrected value, not the exploration's 4.04:1 one", () => {
    expect(token("ink-3").toLowerCase()).not.toBe("#747971");
    expect(contrast("#747971", token("ground"))).toBeLessThan(4.5);
  });
});
