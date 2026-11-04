# Phase 1A disputed-label adjudication packet

**Status: for HUMAN review. These labels are NOT changed here. Nothing below was produced by a model, and the original labels were written by the same assistant that assembled this packet, so this document is not an independent adjudication.** No model outputs are included, to avoid anchoring reviewers.

## How to review

For each case please answer two separate questions:

1. **Relation** — is the new capture (a) the same idea as the existing object (continuation / correction / replacement), (b) a different idea, or (c) cannot tell from the text?
2. **Automatic action** — would you accept the system revising the existing object *without asking you*? (yes / no / only if I can undo it)

Separating the two matters: a reviewer may judge the relation to be 'same idea' and still want confirmation for a reframing. The frozen policy only needs question 2 to be 'no'. The frozen label UNCERTAIN is in effect a statement about question 2.

## The reframing pattern (P131, P136, P140, and related P129, P130, P139)

All six share one shape: a one-sentence statement of *what a thing is* followed by a later statement of what it *really* is ("…is a consumer product" → "…is really an enterprise tool"). They share the subject, project and sentence form, so they look like corrections. The disagreement is about what the first sentence *is*:
- If it is a **claim being corrected** (like a wrong date), the later sentence revises it and the old claim becomes lineage history.
- If it is a **stance or strategy** (identity, positioning), the later sentence is a new position that may need its own record; silently overwriting the old position would hide a pivot.

Arguments for treating them as REVISE: same subject, polar contrast ('not X'), the author clearly intends to supersede. Arguments for UNCERTAIN/confirmation: the capture changes the product's identity or audience, which downstream decisions depend on; the cost of a wrong merge (loss of a pivot signal in the working view) exceeds the cost of one confirmation; a wording like 'not just' is compatible with *adding* an ambition while keeping the old statement. P136 and P140 add a language dimension (Bulgarian, mixed) with the same ambiguity.

Questions to the reviewer for this family: (a) is an identity statement a *proposition that can be corrected* or a *position that can be superseded*? (b) should supersession of a position require confirmation? (c) is 'X, not Y' stronger evidence of correction than 'X, also Y'?

## Cases

### P115 — SUBTASK, en, dev split

- **Existing KnowledgeObject:** [0] (Personal) Plan the trip to Rome.
- **New capture:** (Personal) Book the hotel in Rome.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Hotel booking is part of the trip plan or a separate task; genuinely debatable.
- **Defensible alternative — REVISE:** Booking the hotel is a concrete step of 'plan the trip'; a reader could treat the capture as filling in the plan.
- **Defensible alternative — NEW:** Hotel booking is an action item that exists independently of the trip plan and could be tracked on its own.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P116 — SUBTASK, en, dev split

- **Existing KnowledgeObject:** [0] (Orbit) Build the billing system.
- **New capture:** (Orbit) Design the invoice PDF template.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Part of billing or a standalone design item.
- **Defensible alternative — REVISE:** The invoice template is part of 'build the billing system' and refines it.
- **Defensible alternative — NEW:** A design deliverable with its own owner and lifecycle.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P118 — SUBTASK, en, holdout split

- **Existing KnowledgeObject:** [0] (Kestrel) Launch the new website.
- **New capture:** (Kestrel) Write the launch day announcement email.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Subtask of the launch or its own item.
- **Defensible alternative — REVISE:** The announcement email is an element of the launch.
- **Defensible alternative — NEW:** A separate content task that will be finished and closed independently.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P120 — SUBTASK, en, dev split

- **Existing KnowledgeObject:** [0] (Habits) Get fit this year.
- **New capture:** (Habits) Sign up for the 10k race in May.
- **Frozen label:** UNCERTAIN
- **Original rationale:** A step toward the goal or a distinct plan.
- **Defensible alternative — REVISE:** Signing up for a race is a concrete instance of getting fit.
- **Defensible alternative — NEW:** A dated event with its own deadline; the fitness goal does not depend on it.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P122 — SUBTASK, bg, holdout split

- **Existing KnowledgeObject:** [0] (Лични) Да организирам сватбата.
- **New capture:** (Лични) Да избера ресторант за сватбата.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Подзадача или отделна задача.
- **Defensible alternative — REVISE:** Choosing a restaurant is a decision inside the wedding organisation.
- **Defensible alternative — NEW:** A distinct decision with its own options.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P124 — SUBTASK, bg, holdout split

- **Existing KnowledgeObject:** [0] (Кестрел) Да пуснем нов продукт.
- **New capture:** (Кестрел) Да подготвим снимки за продукта.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Подзадача или самостоятелна.
- **Defensible alternative — REVISE:** Product photos are a prerequisite for launching.
- **Defensible alternative — NEW:** A separate production task.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P126 — SUBTASK, mixed, holdout split

- **Existing KnowledgeObject:** [0] (Orbit) Да направим redesign на onboarding-а.
- **New capture:** (Orbit) Да сменим илюстрациите в onboarding-а.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Част от redesign-а или отделна идея.
- **Defensible alternative — REVISE:** Swapping illustrations is a detail of the onboarding redesign.
- **Defensible alternative — NEW:** A narrow visual change that may happen regardless of any redesign.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P128 — SUBTASK, mixed, holdout split

- **Existing KnowledgeObject:** [0] (Kestrel) Marketing кампания за launch-а.
- **New capture:** (Kestrel) Да направим landing page за кампанията.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Част от кампанията или отделна задача.
- **Defensible alternative — REVISE:** The landing page is an element of the campaign.
- **Defensible alternative — NEW:** A separate web deliverable.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P129 — SCOPE, en, dev split

- **Existing KnowledgeObject:** [0] (Orbit) Orbit is a web dashboard.
- **New capture:** (Orbit) Orbit is an operations platform, not just a dashboard.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Reframing of the definition; revision or a distinct positioning idea.
- **Defensible alternative — REVISE:** 'Not just a dashboard' reads as a correction of the same sentence about what Orbit is; the object (Orbit's definition) is the same.
- **Defensible alternative — NEW:** A positioning claim that adds an ambition rather than correcting the earlier statement; both statements could coexist.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P130 — SCOPE, en, dev split

- **Existing KnowledgeObject:** [0] (Lumen) Lumen is a note-taking app.
- **New capture:** (Lumen) Lumen is a knowledge workspace, not a notes app.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Reframing.
- **Defensible alternative — REVISE:** Directly restates and corrects what Lumen is.
- **Defensible alternative — NEW:** A strategic reframing deserving its own record, with the old description kept as the earlier stance.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P131 — SCOPE, en, holdout split

- **Existing KnowledgeObject:** [0] (Kestrel) Kestrel is a consumer product.
- **New capture:** (Kestrel) Kestrel is really an enterprise tool in disguise.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Positioning shift; unclear whether it replaces the idea.
- **Defensible alternative — REVISE:** A correction of the same claim about Kestrel's market.
- **Defensible alternative — NEW:** A new strategic thesis ('in disguise') rather than an edit of the consumer-product statement.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P134 — SCOPE, en, holdout split

- **Existing KnowledgeObject:** [0] (Habits) Run three times a week.
- **New capture:** (Habits) Be an active person.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Broader goal, unclear relation.
- **Defensible alternative — REVISE:** The broader identity-style goal supersedes the narrow routine.
- **Defensible alternative — NEW:** A different level of abstraction; the routine remains valid as one way to meet the goal.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P135 — SCOPE, en, dev split

- **Existing KnowledgeObject:** [0] (Personal) Learn Spanish.
- **New capture:** (Personal) Spend a month in Madrid.
- **Frozen label:** NEW
- **Original rationale:** Possibly a means to the goal, but arguably its own idea.
- **Defensible alternative — UNCERTAIN:** Whether Madrid is a plan to learn Spanish is not stated.
- **Defensible alternative — REVISE:** Can be read as a concrete step of the same goal.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P136 — SCOPE, bg, holdout split

- **Existing KnowledgeObject:** [0] (Орбит) Орбит е мобилно приложение.
- **New capture:** (Орбит) Орбит е инструмент за мислене, а не просто приложение.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Преформулиране; ревизия или отделна идея.
- **Defensible alternative — REVISE:** A correction of the one-line definition of Orbit.
- **Defensible alternative — NEW:** Changes the identity of the product; a different thing is being claimed, not a detail corrected.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P138 — SCOPE, bg, holdout split

- **Existing KnowledgeObject:** [0] (Лични) Искам да живея по-здравословно.
- **New capture:** (Лични) Искам да спра захарта.
- **Frozen label:** UNCERTAIN
- **Original rationale:** По-тясна цел; част от същото или отделна.
- **Defensible alternative — REVISE:** Cutting sugar is a narrower, concrete form of living healthier.
- **Defensible alternative — NEW:** A distinct habit that does not replace the general aspiration.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P139 — SCOPE, bg, dev split

- **Existing KnowledgeObject:** [0] (Лумен) Лумен е редактор на текстове.
- **New capture:** (Лумен) Лумен е платформа за знания.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Разширяване на определението.
- **Defensible alternative — REVISE:** Direct redefinition of the same noun phrase.
- **Defensible alternative — NEW:** A different product category (platform for knowledge versus text editor).
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P140 — SCOPE, mixed, holdout split

- **Existing KnowledgeObject:** [0] (Orbit) Orbit е SaaS продукт.
- **New capture:** (Orbit) Orbit е по-скоро platform за разработчици, не продукт.
- **Frozen label:** UNCERTAIN
- **Original rationale:** Преформулиране.
- **Defensible alternative — REVISE:** Explicit contrast statement correcting the earlier description.
- **Defensible alternative — NEW:** A different product concept for a different customer.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P142 — SCOPE, mixed, holdout split

- **Existing KnowledgeObject:** [0] (Kestrel) Брандът трябва да е playful.
- **New capture:** (Kestrel) Да направим mascot за марката.
- **Frozen label:** NEW
- **Original rationale:** Възможно следствие, но по-скоро нова идея.
- **Defensible alternative — UNCERTAIN:** It is unclear whether the mascot realises the 'playful' brand direction.
- **Defensible alternative — REVISE:** A concrete implementation of the same brand decision.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

### P163 — TWOFIT, en, dev split

- **Existing KnowledgeObjects:** [0] (Personal) Book a flight to Lisbon.  ‖  [1] (Personal) Book a hotel in Lisbon.
- **New capture:** (Personal) Lisbon booking should be done by Friday.
- **Frozen label:** UNCERTAIN
- **Original rationale:** May cover either or both; arguably a joint update.
- **Defensible alternative — REVISE:** A single joint deadline updates both bookings; the 'Lisbon booking' wording merges them.
- **Defensible alternative — NEW:** A cross-cutting deadline that is neither of the two items.
- **Reviewer:** relation [ same / different / cannot tell ]   automatic revision acceptable [ yes / no / only if undoable ]   notes: ________

## What changes if reviewers disagree

Because results are already reported with and without disputed cases, adjudication will not invalidate the benchmark. It affects (i) the headline 'disputed merge' counts and (ii) which of the six reframing cases count as errors for gates that merge them. Any relabel should be applied in a new corpus version, never in place.