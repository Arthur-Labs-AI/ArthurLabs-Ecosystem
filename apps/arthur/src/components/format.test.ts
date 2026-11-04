import { describe, expect, it } from "vitest";
import { dayLabel, isSameDay, relativeAge } from "./format";

const now = new Date(2026, 9, 4, 18, 30); // Sun 4 Oct 2026, 18:30 local
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("relativeAge", () => {
  it("speaks in minutes, hours, then days", () => {
    expect(relativeAge(ago(10_000), now)).toBe("just now");
    expect(relativeAge(ago(34 * MIN), now)).toBe("34 min ago");
    expect(relativeAge(ago(2 * HOUR), now)).toBe("2 h ago");
    expect(relativeAge(new Date(2026, 9, 3, 10, 0).toISOString(), now)).toBe("Yesterday");
    expect(relativeAge(new Date(2026, 9, 1, 10, 0).toISOString(), now)).toBe("3 d ago");
  });
  it("falls back to a short date, and tolerates garbage", () => {
    expect(relativeAge(new Date(2026, 8, 1).toISOString(), now)).not.toMatch(/ago|Yesterday/);
    expect(relativeAge("not a date", now)).toBe("");
  });
});

describe("dayLabel / isSameDay", () => {
  it("names today and yesterday, and dates the rest", () => {
    expect(dayLabel(ago(2 * HOUR), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 3, 23, 0).toISOString(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 1, 9, 0).toISOString(), now)).not.toMatch(/Today|Yesterday/);
    expect(dayLabel("nope", now)).toBe("");
  });
  it("compares calendar days, not 24-hour windows", () => {
    expect(isSameDay(new Date(2026, 9, 4, 0, 5).toISOString(), now)).toBe(true);
    expect(isSameDay(new Date(2026, 9, 3, 23, 55).toISOString(), now)).toBe(false);
  });
});
