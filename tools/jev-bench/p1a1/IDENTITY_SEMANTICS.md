# KnowledgeObject identity semantics (proposal, Phase 1A.1)

Status: proposal for review. Not implemented. Not a schema change.

## Definition
A new capture **belongs to** an existing KnowledgeObject (KO) iff it asserts something about the **same proposition, decision or commitment** that the KO already records, and it **supersedes or specifies** that assertion, so that the KO's current content after the update would be a faithful single statement of the author's present position. Equivalent test: *could the old text be replaced by the merged text without the author feeling that something they decided or believed has been silently lost or changed in kind?*

Not sufficient on their own: same Project, same subject or product name, shared vocabulary, same screen or module, semantic similarity, temporal proximity.

## Relation taxonomy
| Relation | Meaning | Same KO? | Automatic revision? |
|---|---|---|---|
| Continuation / refinement | Adds detail, a value or a constraint to the *same* proposition; the earlier text stays true | yes | yes, if all gates pass |
| Correction | Replaces a wrong value, date, name or number of the same proposition | yes | yes, if all gates pass |
| Replacement of a decision | Swaps the option chosen for the same decision (vendor, library, date, storage) | yes | yes, if explicit supersession wording ("instead of", "switch from", "we dropped") and all gates pass |
| Reframing | Changes **what the thing is, what it is for, who it is for, how broadly it applies, or inverts a role** | arguably yes, but the *kind* of the KO changes | **never automatic**: confirmation required |
| New feature / separate idea, same Project | Another requirement, task or idea that shares a project or topic | no | never: create NEW |
| Subtask derived from a task | A step toward an existing task | not by default | never automatic: UNCERTAIN (a subtask is usually its own KO linked to the parent, not an edit of it) |
| Two related ideas | Same topic or domain, different proposition | no | never: NEW (graph link candidate, not a revision) |
| Cross-project lookalike | Would be a continuation, but the candidate lives in another Project | no | never: NEW (project boundary) |
| Ambiguous / unresolved reference | "it", "that", "make it faster" with no unique referent | unknown | never: UNCERTAIN |
| Several plausible targets | More than one candidate fits | unknown | never: UNCERTAIN |

## When an automatic revision is justified (all must hold)
1. **Project boundary:** target is in the same Project as the capture.
2. **Unique target:** exactly one candidate is a plausible referent; top-two gap is large; no other candidate scores as a plausible target.
3. **Same-proposition evidence from two JEV signals** (Noul and Choice agree on the same target at the frozen thresholds). These are two readings of one model, not independent verification.
4. **Not a reframing:** reframing guard (Noul and Choice) below its block thresholds.
5. **Explicit referent:** the capture names or unmistakably describes the target's content; pronoun-only captures never qualify.
6. **Reversible:** the previous text and the capture are retained as lineage so the revision can be undone.

## When human confirmation is needed
Reframing signal fires; ambiguous or unresolved reference; more than one plausible target; subtask-versus-parent; any gate disagreement; low confidence; the signals are unavailable (provider error); disputed-type patterns (positioning, scope broadening or narrowing of an identity statement).

## When NEW is created without asking
Different idea from every candidate (including same-topic, same-project separate features); cross-project; no candidate above the NEW threshold.

## Mapping from labels
`REVISE` = all six conditions pass. `NEW` = separate KO. `UNCERTAIN` = **preserve the capture as its own record, do not merge, ask**. The label UNCERTAIN is therefore a statement about *what the system may do automatically*, not a claim that the relation is truly unknowable; a reviewer may judge a reframing to be "really the same idea" and the correct system behaviour is still to ask.
