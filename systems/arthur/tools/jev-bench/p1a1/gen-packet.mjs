// Generates ADJUDICATION_PACKET.md from the frozen Phase 1A corpus. Contains NO model outputs and does not alter any label.
import { readFileSync, writeFileSync } from "node:fs";
const corpus = JSON.parse(readFileSync(new URL("../corpus-p1a.json", import.meta.url)));
const ALT = {
  P115: ["REVISE", "Booking the hotel is a concrete step of 'plan the trip'; a reader could treat the capture as filling in the plan.", "NEW", "Hotel booking is an action item that exists independently of the trip plan and could be tracked on its own."],
  P116: ["REVISE", "The invoice template is part of 'build the billing system' and refines it.", "NEW", "A design deliverable with its own owner and lifecycle."],
  P118: ["REVISE", "The announcement email is an element of the launch.", "NEW", "A separate content task that will be finished and closed independently."],
  P120: ["REVISE", "Signing up for a race is a concrete instance of getting fit.", "NEW", "A dated event with its own deadline; the fitness goal does not depend on it."],
  P122: ["REVISE", "Choosing a restaurant is a decision inside the wedding organisation.", "NEW", "A distinct decision with its own options."],
  P124: ["REVISE", "Product photos are a prerequisite for launching.", "NEW", "A separate production task."],
  P126: ["REVISE", "Swapping illustrations is a detail of the onboarding redesign.", "NEW", "A narrow visual change that may happen regardless of any redesign."],
  P128: ["REVISE", "The landing page is an element of the campaign.", "NEW", "A separate web deliverable."],
  P129: ["REVISE", "'Not just a dashboard' reads as a correction of the same sentence about what Orbit is; the object (Orbit's definition) is the same.", "NEW", "A positioning claim that adds an ambition rather than correcting the earlier statement; both statements could coexist."],
  P130: ["REVISE", "Directly restates and corrects what Lumen is.", "NEW", "A strategic reframing deserving its own record, with the old description kept as the earlier stance."],
  P131: ["REVISE", "A correction of the same claim about Kestrel's market.", "NEW", "A new strategic thesis ('in disguise') rather than an edit of the consumer-product statement."],
  P134: ["REVISE", "The broader identity-style goal supersedes the narrow routine.", "NEW", "A different level of abstraction; the routine remains valid as one way to meet the goal."],
  P135: ["UNCERTAIN", "Whether Madrid is a plan to learn Spanish is not stated.", "REVISE", "Can be read as a concrete step of the same goal."],
  P136: ["REVISE", "A correction of the one-line definition of Orbit.", "NEW", "Changes the identity of the product; a different thing is being claimed, not a detail corrected."],
  P138: ["REVISE", "Cutting sugar is a narrower, concrete form of living healthier.", "NEW", "A distinct habit that does not replace the general aspiration."],
  P139: ["REVISE", "Direct redefinition of the same noun phrase.", "NEW", "A different product category (platform for knowledge versus text editor)."],
  P140: ["REVISE", "Explicit contrast statement correcting the earlier description.", "NEW", "A different product concept for a different customer."],
  P142: ["UNCERTAIN", "It is unclear whether the mascot realises the 'playful' brand direction.", "REVISE", "A concrete implementation of the same brand decision."],
  P163: ["REVISE", "A single joint deadline updates both bookings; the 'Lisbon booking' wording merges them.", "NEW", "A cross-cutting deadline that is neither of the two items."],
};
const L = ["# Phase 1A disputed-label adjudication packet", "",
"**Status: for HUMAN review. These labels are NOT changed here. Nothing below was produced by a model, and the original labels were written by the same assistant that assembled this packet, so this document is not an independent adjudication.** No model outputs are included, to avoid anchoring reviewers.", "",
"## How to review", "",
"For each case please answer two separate questions:", "",
"1. **Relation** — is the new capture (a) the same idea as the existing object (continuation / correction / replacement), (b) a different idea, or (c) cannot tell from the text?",
"2. **Automatic action** — would you accept the system revising the existing object *without asking you*? (yes / no / only if I can undo it)", "",
"Separating the two matters: a reviewer may judge the relation to be 'same idea' and still want confirmation for a reframing. The frozen policy only needs question 2 to be 'no'. The frozen label UNCERTAIN is in effect a statement about question 2.", "",
"## The reframing pattern (P131, P136, P140, and related P129, P130, P139)", "",
"All six share one shape: a one-sentence statement of *what a thing is* followed by a later statement of what it *really* is (\"…is a consumer product\" → \"…is really an enterprise tool\"). They share the subject, project and sentence form, so they look like corrections. The disagreement is about what the first sentence *is*:",
"- If it is a **claim being corrected** (like a wrong date), the later sentence revises it and the old claim becomes lineage history.",
"- If it is a **stance or strategy** (identity, positioning), the later sentence is a new position that may need its own record; silently overwriting the old position would hide a pivot.", "",
"Arguments for treating them as REVISE: same subject, polar contrast ('not X'), the author clearly intends to supersede. Arguments for UNCERTAIN/confirmation: the capture changes the product's identity or audience, which downstream decisions depend on; the cost of a wrong merge (loss of a pivot signal in the working view) exceeds the cost of one confirmation; a wording like 'not just' is compatible with *adding* an ambition while keeping the old statement. P136 and P140 add a language dimension (Bulgarian, mixed) with the same ambiguity.", "",
"Questions to the reviewer for this family: (a) is an identity statement a *proposition that can be corrected* or a *position that can be superseded*? (b) should supersession of a position require confirmation? (c) is 'X, not Y' stronger evidence of correction than 'X, also Y'?", "",
"## Cases", ""];
for (const c of corpus.cases.filter((x) => x.disputed)) {
  const a = ALT[c.id];
  L.push(`### ${c.id} — ${c.category}, ${c.lang}, ${c.split} split`, "",
  `- **Existing KnowledgeObject${c.candidates.length > 1 ? "s" : ""}:** ${c.candidates.map((x, i) => `[${i}] (${x.project}) ${x.text}`).join("  ‖  ")}`,
  `- **New capture:** (${c.new_capture.project}) ${c.new_capture.text}`,
  `- **Frozen label:** ${c.expected}${c.target != null ? ` → target ${c.target}` : ""}`,
  `- **Original rationale:** ${c.rationale}`,
  `- **Defensible alternative — ${a[0]}:** ${a[1]}`,
  `- **Defensible alternative — ${a[2]}:** ${a[3]}`,
  `- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________`, "");
}
L.push("## What changes if reviewers disagree", "", "Because results are already reported with and without disputed cases, adjudication will not invalidate the benchmark. It affects (i) the headline 'disputed merge' counts and (ii) which of the six reframing cases count as errors for gates that merge them. Any relabel should be applied in a new corpus version, never in place.");
writeFileSync(new URL("./ADJUDICATION_PACKET.md", import.meta.url), L.join("\n")); console.log(L.length, "lines");
