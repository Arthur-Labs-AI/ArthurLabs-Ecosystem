import { describe, expect, it } from "vitest";
import type { ThoughtRevision } from "@arthur/contracts";
import { captionFor, changeStats, countWords } from "./revision-captions";

const rev = (id: string, body: string, parents: string[] = [], origin: ThoughtRevision["origin"] = "user_edit", title = "Title"): ThoughtRevision => ({
  id,
  objectId: "o",
  kind: "idea",
  title,
  body,
  createdAt: "2026-10-04T12:00:00Z",
  origin,
  parentRevisionIds: parents,
});

describe("revision captions", () => {
  const r1 = rev("r1", "One two three.", [], "initial");
  const r2 = rev("r2", "One two three four five.", ["r1"]);
  const byId = new Map([r1, r2].map((r) => [r.id, r]));
  const labelOf = (id: string) => id.toUpperCase();

  it("counts words the way the diff tokenizes them, in any script", () => {
    expect(countWords("Hello, world!")).toBe(2);
    expect(countWords("Искам да подобря екрана 😀")).toBe(4);
    expect(countWords("")).toBe(0);
  });

  it("derives added and removed words from the deterministic diff", () => {
    expect(changeStats(r1, r2)).toEqual({ added: 2, removed: 0, titleChanged: false, kindChanged: false });
    expect(changeStats(r2, rev("r3", "One four five.", ["r2"]))).toMatchObject({ added: 0, removed: 2 });
  });

  it("captions the first revision, a merge and an edit, and never invents a message", () => {
    expect(captionFor(r1, byId, labelOf)).toBe("First captured");
    expect(captionFor(r2, byId, labelOf)).toBe("+2 −0 words");
    expect(captionFor(rev("m", "x", ["r1", "r2"], "merge"), byId, labelOf)).toBe("Merged R1 + R2");
  });

  it("mentions a changed title or kind", () => {
    expect(captionFor(rev("r3", "One two three four five.", ["r2"], "user_edit", "New title"), new Map([...byId, ["r2", r2]]), labelOf)).toBe("+2 −1 words · title");
    const asTask: ThoughtRevision = { ...r2, id: "r4", kind: "task", parentRevisionIds: ["r2"] };
    expect(captionFor(asTask, byId, labelOf)).toContain("kind");
  });

  it("falls back to the origin when the parent is unknown", () => {
    expect(captionFor(rev("x", "y", ["gone"]), new Map(), labelOf)).toBe("Your edit");
  });
});
