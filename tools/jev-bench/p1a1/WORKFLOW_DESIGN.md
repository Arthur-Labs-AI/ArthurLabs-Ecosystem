# Product workflow for identity decisions (design only, Phase 1A.1)

Nothing here is implemented. No schema commitment is made; names are descriptive.

## Pipeline position
Capture → Distillation → Candidate Retrieval (same Project only) → **Identity Gate** → NEW | REVISE | UNCERTAIN → Thought Lineage / provenance → Graph Integration.
JEV runs only on the shortlist (≤ 4 candidates). A generative model writes revision text only after the gate passes; it never decides identity.

## Behaviour by outcome
**NEW.** Create a separate KO from the capture. Offer, but never auto-create, a "related to" candidate for Graph Integration. If JEV is unavailable or any signal is missing, the default is NEW or UNCERTAIN, never REVISE.

**REVISE (only after every gate in IDENTITY_SEMANTICS.md passes).** Create a *revision*, not an overwrite: the previous KO text remains addressable, the capture is attached as the cause (provenance), and the generated merged text is shown as "updated from capture" with a one-step undo available for a limited period. The synthesised text must quote or cite the capture and previous text so it is checkable; if synthesis fails validation, fall back to UNCERTAIN.

**UNCERTAIN.** Persist the capture as its own KO immediately (no data loss, no silent merge) with a lightweight *pending-identity* state, and surface it for confirmation.

## Possible confirmation workflow (UNCERTAIN)
1. Capture is saved as a standalone thought; a non-blocking prompt appears: "Does this change *<existing idea title>*?" with options: **Update it** / **Keep separate** / **Not sure, ask later**.
2. When there are several candidates, show the top two with their text and let the user pick one, "none", or "later".
3. For reframing specifically, label the prompt honestly: "This looks like it changes what *<idea>* is. Replace it, keep both, or record the old version as the earlier stance?" Offer a third outcome beyond merge/separate: **supersede with stance history** (new KO linked to the old one as "replaces this position").
4. Unanswered prompts expire into "Keep separate" after a configurable period; they never auto-merge.
5. User answers become labelled data for later evaluation (opt-in, local), which is the cheapest source of real, independently adjudicated labels.
6. Batch mode: a weekly review lists pending items so voice capture is not interrupted.

## Lineage and provenance (conceptual, no schema decision)
- Every identity decision should be recorded with: candidate set shown, scores per signal, thresholds/policy version, model identifier (`jev-1.13.0`), outcome, and who/what decided (gate or user). This makes decisions auditable and re-runnable when thresholds change.
- A REVISE is a lineage edge capture → KO revision; a NEW from UNCERTAIN keeps an *unresolved-identity* edge to the candidate so a later user answer can be applied retroactively without rewriting history.
- "Supersede with stance history" maps onto the same lineage edge type with a different label; it needs no new concept beyond a typed relation.
- Whether these live in existing tables or new ones is a separate decision for M04.7B design review.

## Failure and cost behaviours
Provider timeout or error → UNCERTAIN (capture still saved). Rate limit (80 req/s documented, dynamic) is not a concern at personal-use volumes. Cost is negligible ($0.042/M input tokens; ≈ $0.00005 per decision with guards).
