# M04.7A.1 benchmark corpus review

Original pre-registered labels (`expect`, `maybe`, `forbid`, `world`) are unchanged and still produce the **strict** score. This review adds only
`acceptable` alternatives (scenario-level, in `integration_bench.rs`), used for the separate **semantic-admissibility** score. Classification is by
what the texts say and the relation definitions in `graph/semantics.rs`, not by what any model returned. Disclosure: the A/B had already been read
when the post-edit cases were reviewed; those cases are decided by the edit text itself (quoted below).

| # | Event | Gold relation | Class | Rationale / named alternatives |
|---|-------|---------------|-------|-------------------------------|
| 1 | Phone works offline | extends → Arthur on mobile and desktop | unambiguous | specialises the mobile requirement |
| 1 | | forbid: related_to Phone–Tauri; depends_on Arthur→Phone | unambiguous negatives | no stated link; reversed direction |
| 2 | Local SQLite storage | depends_on Phone works offline → Local SQLite | ambiguous | alternatives with the decision as source: `derived_from`, `extends` Local SQLite → Phone works offline (a means that follows from the requirement) |
| 3 | Buy groceries | none | unambiguous negative | |
| 4 | Arthur on desktop only | contradicts mobile-and-desktop | unambiguous | both cannot stand |
| 5 | Phone offline mode | duplicates Phone works offline | unambiguous | same intent; `maybe` extends is an optional extra |
| 6 | Edit: thin client, needs the PC | retract depends_on, duplicates, extends | unambiguous retractions | the edit text states the opposite |
| 6 | | new `contradicts` Local SQLite ↔ Phone works offline, Phone offline mode ↔ Phone works offline | valid consequence (acceptable) | after the edit "needs the PC for everything" conflicts with both texts |
| 7 | Arthur работи без компютъра / Телефонът пази знанията | depends_on | ambiguous, **implicit** | the link is inferred, never stated; acceptable `related_to`. Diagnosis showed English gets no proposal either |
| 8 | Sync note (bg) | maybe extends / related_to | optional | |
| 9 | Купи хляб | none | unambiguous negative | |
| 10 | Телефонът пази знанията локално → Знанията на телефона | extends | unambiguous | adds the SQLite detail; `duplicates` is NOT acceptable (the rubric says added detail is extends) |
| 11 | Wristband hardware | forbid related_to Wristband hardware–Voice capture | **questionable** | a microphone is a concrete link; not part of the production gate |
| 12 | Wake word → Voice capture | extends | ambiguous | acceptable `depends_on` (needs voice capture to start it); `maybe` depends_on hardware stays |
| 13 | Replace Tailscale | supersedes | ambiguous | explicit replacement; acceptable `contradicts` (both could not stand) |
| 14 | Graph depends on Distillation | depends_on | unambiguous | the rubric's own rule: the note names the prerequisite |
| 15–16 | Arthur battery / weekend | none | unambiguous negatives | shared word "Arthur" only |
| 17 | Write the report | depends_on Collect the data | unambiguous | |
| 18 | Edit: no data needed | retract depends_on; contradicts Write–Collect | retraction unambiguous; `contradicts` **questionable** | the task is rendered moot rather than contradicted; accepted as a defensible alternative, not gate-bearing |
| 19–23 | Sync burst | depends_on Sync service→Pairing, Pairing→Local identity; extends conflict rules→service | unambiguous | stated prerequisites; forbid reversed direction |
| 19–23 | | maybe related_to Sync service–Sync status screen | ambiguous | acceptable `depends_on` status screen → service |
| 24 | Capture shortcut | extends → Capture-first home | ambiguous | acceptable `depends_on` |

Holdout (unseen Bulgarian, written before the prompts were finalised; run once): depends_on (sensor), contradicts (cloud vs local), supersedes
(meeting moved; acceptable contradicts), duplicates across Bulgarian/English, extends (plan with goals), hard negatives (bread, car, milk).
