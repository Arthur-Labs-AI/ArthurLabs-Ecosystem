import { CAPTURE_SOURCE_KINDS, KNOWLEDGE_OBJECT_KINDS, type AnswerParagraph, type CaptureSourceKind, type CognitiveAnswer, type CognitiveEvidence, type EvidenceHistoryEntry, type EvidenceSource, type KnowledgeObjectKind, type RecallTemporal } from "@arthur/contracts";
import { RELATION_LABELS } from "../graph/relation-style";

/**
 * Presentation rules for an Ask Arthur result. Everything here is a pure function of the backend's `CognitiveAnswer`: this layer
 * never retrieves, ranks, scores or decides what is evidence. It only chooses words and order.
 */

export const isKind = (kind: string): kind is KnowledgeObjectKind => (KNOWLEDGE_OBJECT_KINDS as readonly string[]).includes(kind);
export const isSourceKind = (source: string): source is CaptureSourceKind => (CAPTURE_SOURCE_KINDS as readonly string[]).includes(source);

/** What the evidence is, in the words the Evolution screen already uses. */
export const STATE_LABELS = {
  current: "Current",
  superseded: "Superseded",
  historical: "Earlier version",
  branch_not_current: "Branch not adopted",
} as const;

export const TEMPORAL_NOTES: Record<RecallTemporal, string | null> = {
  current: null,
  historical: "Earlier version",
  mixed: "Current and earlier wording",
  external: "From another project",
};

/** Why a revision is in the answer's history, in plain words. */
export const MARK_LABELS: Record<string, string> = {
  matched_query: "Matches your wording",
  root: "First version",
  new_capture: "Changed by a new capture",
  branch_point: "Where it branched",
  non_current_head: "End of a branch",
  merge: "Merge",
  parent: "Just before the change",
  path: "On the way to the current version",
};

export const markLabel = (mark: string): string | null => MARK_LABELS[mark] ?? null;

/** A handle in a paragraph: `E3` is the entry, `E3.h1` an earlier revision of it. */
export function parseHandle(handle: string): { entry: string; history: boolean } {
  const [entry, rest] = handle.split(".");
  return { entry: entry ?? handle, history: rest !== undefined };
}

export interface Marker {
  /** The handle as the backend wrote it. */
  handle: string;
  /** The evidence entry it points at. */
  entry: string;
  /** Points at an earlier revision, not at the current text. */
  historical: boolean;
  label: string;
  /** For screen readers and tooltips: what the marker opens. */
  description: string;
}

export interface EvidenceIndex {
  byHandle: Map<string, CognitiveEvidence>;
  byHistoryHandle: Map<string, EvidenceHistoryEntry>;
}

export function indexEvidence(evidence: readonly CognitiveEvidence[]): EvidenceIndex {
  const byHandle = new Map(evidence.map((entry) => [entry.handle, entry]));
  const byHistoryHandle = new Map<string, EvidenceHistoryEntry>();
  for (const entry of evidence) for (const past of entry.lineage?.entries ?? []) byHistoryHandle.set(past.handle, past);
  return { byHandle, byHistoryHandle };
}

/** The markers of one paragraph. A handle that does not resolve to evidence is dropped, never shown. */
export function markersFor(paragraph: AnswerParagraph, index: EvidenceIndex): Marker[] {
  const seen = new Set<string>();
  const markers: Marker[] = [];
  for (const handle of paragraph.basedOn) {
    if (seen.has(handle)) continue;
    seen.add(handle);
    const { entry, history } = parseHandle(handle);
    const evidence = index.byHandle.get(entry);
    if (!evidence) continue;
    const past = history ? index.byHistoryHandle.get(handle) : undefined;
    if (history && !past) continue;
    const branch = past?.status === "branch_not_current";
    markers.push({
      handle,
      entry,
      historical: history,
      label: history ? `${entry} · ${branch ? "branch" : "earlier"}` : entry,
      description: `${history ? (branch ? "Branch not adopted, from " : "Earlier version of ") : ""}${evidence.title}`,
    });
  }
  return markers;
}

/** Evidence the answer rests on first (in the order it is first cited), then everything else Arthur found. */
export function orderEvidence(answer: CognitiveAnswer): { cited: CognitiveEvidence[]; other: CognitiveEvidence[] } {
  const index = indexEvidence(answer.evidence);
  const order: string[] = [];
  for (const paragraph of answer.answer?.paragraphs ?? []) for (const marker of markersFor(paragraph, index)) if (!order.includes(marker.entry)) order.push(marker.entry);
  const cited = order.map((handle) => index.byHandle.get(handle)).filter((entry): entry is CognitiveEvidence => entry !== undefined);
  const other = answer.evidence.filter((entry) => !order.includes(entry.handle));
  return { cited, other };
}

/** A weak entry is a similar-looking candidate nothing else supports. It may be inspected, never presented as support. */
export const isWeak = (entry: CognitiveEvidence): boolean => entry.strength.level === "weak";

/** One line per way the Graph connected this entry. Never mentions scores, weights or algorithms. */
export function includedBecause(entry: CognitiveEvidence, index: EvidenceIndex): string[] {
  const lines: string[] = [];
  const titleOf = (handle: string): string => index.byHandle.get(handle)?.title ?? "another idea";
  if (entry.role === "graph") {
    for (const path of entry.graph?.paths ?? []) {
      const label = RELATION_LABELS[path.relationKind as keyof typeof RELATION_LABELS] ?? "is connected to";
      const from = titleOf(path.fromHandle);
      lines.push(path.direction === "in" ? `${entry.title} ${label} ${from}` : `${from} ${label} ${entry.title}`);
    }
  }
  const graph = entry.graph;
  if (graph) {
    for (const handle of graph.conflictsWith) lines.push(`Contradicts ${titleOf(handle)}`);
    for (const handle of graph.supersedes) lines.push(`Replaces ${titleOf(handle)}`);
    for (const handle of graph.supersededBy) lines.push(`Replaced by ${titleOf(handle)}`);
    for (const alias of graph.aliases) lines.push(`Also recorded as “${alias.title}”`);
  }
  return [...new Set(lines)];
}

export const hasEarlierVersions = (entry: CognitiveEvidence): boolean => (entry.lineage?.entries.length ?? 0) > 0;

/** Where one piece of evidence can take the user. Only what exists for it is offered. */
export interface EvidenceActions {
  idea: true;
  capture: boolean;
  evolution: boolean;
  connections: boolean;
  project: boolean;
}

export function actionsFor(entry: CognitiveEvidence): EvidenceActions {
  return {
    idea: true,
    capture: entry.provenance?.origin != null,
    evolution: hasEarlierVersions(entry) || (entry.lineage?.revisionCount ?? 0) > 1,
    connections: entry.graph !== null,
    project: entry.externalProject,
  };
}

export interface SourceView {
  excerpt: string | null;
  truncated: boolean;
  /** "Typed capture", "Voice capture", or just "Capture" for a source this build does not know. */
  sourceLabel: string;
  when: string;
}

const SOURCE_NOUN: Record<CaptureSourceKind, string> = { text: "Typed capture", voice: "Voice capture", emg: "Wristband capture" };

export function sourceView(source: EvidenceSource): SourceView {
  return { excerpt: source.excerpt, truncated: source.excerptTruncated, sourceLabel: isSourceKind(source.captureSource) ? SOURCE_NOUN[source.captureSource] : "Capture", when: source.captureCreatedAt };
}

/** What the synthesis state means to a person. Structural reasons only; nothing here ever contains stored text. */
export function synthesisReason(answer: CognitiveAnswer): string | null {
  switch (answer.diagnostics.synthesis.state) {
    case "unavailable":
      return answer.diagnostics.synthesis.reason === "llmNotConfigured" ? "Ask Arthur needs an AI connection to write answers. Connect one in Settings → AI & Voice. What it found by your words is below." : "The answer model isn't available right now.";
    case "failed":
      return "The answer model didn't respond.";
    case "invalidOutput":
      return "The written answer didn't pass Arthur's checks, so it isn't shown.";
    default:
      return null;
  }
}

/** The `E1`..`En` handle of an evidence DOM node. */
export const evidenceDomId = (handle: string): string => `ev-${handle}`;
