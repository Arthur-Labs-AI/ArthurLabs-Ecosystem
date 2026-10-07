import type { AnswerParagraph, CognitiveAnswer, CognitiveEvidence, EvidenceHistoryEntry, EvidenceSource, RecallDiagnostics } from "@arthur/contracts";

/** Builders for backend results, so UI tests state only what they are about. These never run in the shipped app. */

export const DIAGNOSTICS: RecallDiagnostics = {
  retrieval: { intent: {}, lexical: "ok", semantic: "disabled", semanticReason: null, semanticCoverage: null, embeddingRequests: 0, uploadedTexts: 0, sqlReads: 7 },
  enrichment: {},
  context: { budgetTokens: 6000, estimatedTokens: 812, entriesIncluded: 3, historyIncluded: 1, dropped: [], truncation: [] },
  synthesis: { state: "ok", reason: null, model: "gpt-4.1-mini", retried: false, requests: 1, strippedRefs: 0, droppedParagraphs: 0, temporalCorrected: 0 },
  timings: { lexicalMs: 4, semanticMs: 0, enrichmentMs: 3, synthesisMs: 1400 },
  counts: {},
  sqlReads: 7,
};

export const source = (partial: Partial<EvidenceSource> = {}): EvidenceSource => ({
  captureId: "cap-1",
  captureProjectId: "p-arthur",
  captureSource: "voice",
  captureCreatedAt: "2026-03-02T09:30:00.000Z",
  spanStart: 0,
  spanEnd: 40,
  excerpt: "We should retry the audio upload three times",
  excerptTruncated: false,
  ...partial,
});

export const past = (partial: Partial<EvidenceHistoryEntry> = {}): EvidenceHistoryEntry => ({
  handle: "E1.h1",
  revisionId: "rev-old",
  status: "historical",
  origin: "initial",
  createdAt: "2026-03-02T09:31:00.000Z",
  title: "Retry audio upload",
  body: "Retry the audio upload once.",
  truncated: false,
  marks: ["root", "matched_query"],
  leadsToCurrent: true,
  source: null,
  ...partial,
});

export function evidence(partial: Partial<CognitiveEvidence> = {}): CognitiveEvidence {
  const handle = partial.handle ?? "E1";
  return {
    handle,
    role: "primary",
    objectId: `obj-${handle}`,
    projectId: "p-arthur",
    projectName: "Arthur",
    externalProject: false,
    kind: "decision",
    title: `Title of ${handle}`,
    currentBody: `Body of ${handle}.`,
    currentRevisionId: `rev-${handle}`,
    status: "current",
    strength: { points: 4.2, level: "strong", sufficient: true, signals: [{ name: "lexical", points: 2.1 }] },
    retrieval: { cosine: 0.71, rrf: 0.0312 },
    graph: null,
    lineage: null,
    provenance: { origin: source(), currentRevisionSource: null, editedSinceCapture: false, currentRevisionOrigin: "initial" },
    cited: true,
    inContext: true,
    ...partial,
  };
}

export const paragraph = (text: string, basedOn: string[], temporal: AnswerParagraph["temporal"] = "current"): AnswerParagraph => ({ text, basedOn, temporal });

export function answer(partial: Partial<CognitiveAnswer> = {}): CognitiveAnswer {
  return {
    query: "What did I decide about audio retries?",
    scope: { projectId: "p-arthur", projectName: "Arthur", archived: false },
    outcome: "answered",
    answer: { paragraphs: [paragraph("You decided to retry the audio upload three times.", ["E1"])], gaps: [] },
    evidence: [evidence()],
    diagnostics: DIAGNOSTICS,
    ...partial,
  };
}

/** A result that exercises everything the UI presents: graph path, external project, history, branch, edited-since-capture. */
export function richAnswer(): CognitiveAnswer {
  const e1 = evidence({
    handle: "E1",
    title: "Retry temporary audio",
    currentBody: "Retry the temporary audio upload three times before giving up.",
    lineage: { revisionCount: 3, entries: [past({ handle: "E1.h1", source: source({ excerpt: "Retry once", spanEnd: 10 }) }), past({ handle: "E1.h2", status: "branch_not_current", leadsToCurrent: false, origin: "user_edit", marks: ["branch_point", "non_current_head"], title: "Retry forever", body: "Retry the upload forever." })] },
    provenance: { origin: source(), currentRevisionSource: null, editedSinceCapture: true, currentRevisionOrigin: "user_edit" },
  });
  const e2 = evidence({
    handle: "E2",
    role: "graph",
    kind: "idea",
    title: "Temporary audio retry",
    objectId: "obj-retry",
    graph: { role: "expanded", score: 0.4, intentRelevant: true, paths: [{ fromObjectId: "obj-E1", fromHandle: "E1", toObjectId: "obj-retry", relationId: "rel-1", relationKind: "depends_on", direction: "out", distance: 1, externalProject: false }], supersededBy: [], supersedes: [], conflictsWith: [], contradictory: false, aliases: [] },
  });
  const e3 = evidence({
    handle: "E3",
    role: "graph",
    kind: "idea",
    title: "Gateway timeouts",
    projectId: "p-nexus",
    projectName: "Nexus",
    externalProject: true,
    objectId: "obj-gw",
    graph: { role: "expanded", score: 0.3, intentRelevant: false, paths: [{ fromObjectId: "obj-E1", fromHandle: "E1", toObjectId: "obj-gw", relationId: "rel-2", relationKind: "related_to", direction: "sym", distance: 1, externalProject: true }], supersededBy: [], supersedes: [], conflictsWith: ["E4"], contradictory: true, aliases: [] },
  });
  const e4 = evidence({ handle: "E4", kind: "decision", title: "Never retry on cellular", status: "superseded", cited: false, graph: { role: "supported", score: null, intentRelevant: true, paths: [], supersededBy: ["E1"], supersedes: [], conflictsWith: [], contradictory: false, aliases: [] }, provenance: null });
  return answer({
    query: "How did the audio retry change?",
    answer: {
      paragraphs: [
        paragraph("Today the upload is retried three times.", ["E1"]),
        paragraph("It started as a single retry, and a branch that retried forever was never adopted.", ["E1", "E1.h1", "E1.h2"], "mixed"),
        paragraph("The Gateway timeouts idea in Nexus feeds into it.", ["E3", "E2"], "external"),
        paragraph("An earlier take on this said to retry just once.", ["E1.h1"], "historical"),
      ],
      gaps: ["Why three was chosen"],
    },
    evidence: [e1, e2, e3, e4],
  });
}

/**
 * A scripted result for looking at Ask Arthur in `vite dev` (add `?recallDemo` to the address). It exists only in development
 * builds and is never reachable from a production bundle. Keywords in the question pick the outcome: "nothing", "found", "many",
 * "weak", otherwise the rich answer.
 */
export function demoAnswer(query: { query: string }, scope: CognitiveAnswer["scope"]): CognitiveAnswer {
  const text = query.query.toLowerCase();
  const base = { query: query.query, scope };
  if (text.includes("nothing")) return answer({ ...base, outcome: "insufficient_evidence", answer: null, evidence: [] });
  if (text.includes("weak")) return answer({ ...base, outcome: "insufficient_evidence", answer: null, evidence: [evidence({ handle: "E1", title: "Possibly related note", strength: { points: 1, level: "weak", sufficient: false, signals: [] } })] });
  if (text.includes("found")) return answer({ ...base, outcome: "retrieval_only", answer: null, evidence: richAnswer().evidence.slice(0, 3), diagnostics: { ...DIAGNOSTICS, synthesis: { ...DIAGNOSTICS.synthesis, state: "unavailable" } } });
  if (text.includes("many")) {
    const many = Array.from({ length: 40 }, (_, i) => evidence({ handle: `E${i + 1}`, title: `Идея номер ${i + 1}: подробности за временното аудио и повторния опит`, currentBody: "Дълго описание на идеята, което продължава на няколко реда и проверява пренасянето на текста. ".repeat(3) }));
    const paragraphs = many.slice(0, 10).map((e, i) => paragraph(`Параграф ${i + 1}. ${"Дълъг отговор на български, който продължава на много редове и проверява четимостта. ".repeat(6)}`, [e.handle, many[i + 10]!.handle]));
    return answer({ ...base, answer: { paragraphs, gaps: [] }, evidence: many });
  }
  return { ...richAnswer(), ...base };
}
