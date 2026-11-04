import { diffRevisionContent, type RevisionDiff, type RevisionOrigin, type ThoughtRevision } from "@arthur/contracts";

/**
 * Revisions carry no commit message, so none is ever invented. A caption is derived from the deterministic diff
 * against the parent: how many words were added and removed, and whether the title changed.
 */

export const ORIGIN_LABELS: Record<RevisionOrigin, string> = {
  initial: "First capture",
  user_edit: "Your edit",
  distillation: "From a new capture",
  merge: "Merge",
  system: "Created by Arthur",
};

/** The short tag above a revision on the rail. */
export const ORIGIN_TAGS: Record<RevisionOrigin, string> = {
  initial: "capture",
  user_edit: "edit",
  distillation: "from capture",
  merge: "merge",
  system: "system",
};

const WORD = /[\p{Alphabetic}\p{N}]+/gu;
export const countWords = (text: string): number => text.match(WORD)?.length ?? 0;

export interface ChangeStats {
  added: number;
  removed: number;
  titleChanged: boolean;
  kindChanged: boolean;
}

export function changeStats(parent: ThoughtRevision, revision: ThoughtRevision): ChangeStats {
  return statsFromDiff(diffRevisionContent(parent, revision));
}

/** The same numbers from a diff the client already produced. */
export function statsFromDiff(diff: RevisionDiff): ChangeStats {
  let added = 0;
  let removed = 0;
  for (const part of [diff.title, diff.body]) {
    for (const segment of part.segments) {
      if (segment.op === "insert") added += countWords(segment.text);
      else if (segment.op === "delete") removed += countWords(segment.text);
    }
  }
  return { added, removed, titleChanged: diff.title.changed, kindChanged: diff.kind.changed };
}

/** "First captured", "Merged R2 + R3", or "+15 −0 words · title". `labelOf` maps a revision id to its R-number. */
export function captionFor(revision: ThoughtRevision, byId: ReadonlyMap<string, ThoughtRevision>, labelOf: (id: string) => string): string {
  if (revision.origin === "initial" || revision.parentRevisionIds.length === 0) return "First captured";
  if (revision.parentRevisionIds.length > 1) return `Merged ${revision.parentRevisionIds.map(labelOf).join(" + ")}`;
  const parent = byId.get(revision.parentRevisionIds[0] as string);
  if (!parent) return ORIGIN_LABELS[revision.origin];
  const stats = changeStats(parent, revision);
  const extras = [stats.titleChanged ? "title" : null, stats.kindChanged ? "kind" : null].filter((part): part is string => part !== null);
  return `+${stats.added} −${stats.removed} words${extras.length > 0 ? ` · ${extras.join(", ")}` : ""}`;
}
