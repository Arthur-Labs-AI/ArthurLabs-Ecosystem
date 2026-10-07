# M04D implementation notes: Ask Arthur UI

Status: implemented, verified on host and on the Android emulator, **uncommitted**. Schema stays **v7**; the M04B floor stays **0.40**.
Nothing in `recall/` ranking, Graph, Lineage, Project semantics or synthesis grounding was changed.

## What was built

* **Client boundary.** `ask` was already there. Added `getSemanticRecallStatus`, `setSemanticRecallEnabled`, `purgeSemanticIndex`
  (contract `SemanticRecallStatus`, mirrors the native struct; the native commands already existed). The preview client has an in-memory
  consent state and an injectable `recall.answer` for tests.
* **One place builds the question.** `features/recall/ask-context.tsx` is the only UI file that calls `client.ask`, and it always sends
  `{ query, scope: { projectId: <active project> } }`. The result lives in memory only (never written anywhere), survives moving
  between screens and resizing across the Desktop/Mobile breakpoint, and is dropped when the project changes. Guarded in
  `tests/architecture` (M04D guard).
* **Desktop.** "Ask Arthur" in the rail (after Evolution) with `Ctrl/⌘ K`. A serif answer column with margin references (`E1`,
  `E3 · earlier`, `E1 · branch`) and the evidence in the margin beside it ("Based on"); below ~880 px of content width (a 1000 px
  window) the evidence falls under the answer. Marker click focuses and highlights the evidence item; hovering an item highlights the
  paragraphs it supports.
* **Mobile.** No sixth tab. Home gets an "Ask about <Project>…" line under Speak; Ask is a pushed full-screen page (like Settings, so the
  system Back gesture works the same way). The result scrolls above a question bar fixed at the bottom (thumb reach, above the
  keyboard). The asked question moves up into the result and the bar clears. Evidence rows (56 px+) open a bottom sheet with the detail;
  the sheet closes when a new question is asked.
* **Outcomes.** `answered` (answer + "Based on" + "Also found"), `insufficient_evidence` ("Arthur couldn't find enough evidence in
  <Project> to answer that reliably.", never an error; a model-written partial answer is shown quietly under "What the evidence does
  say"; weak matches behind "Inspect weak matches"), `retrieval_only` ("Found related knowledge", the reason in plain words, a "Try
  again", and the full evidence). A request that cannot be served at all is a separate error with retry.
* **Evidence.** Kind, title, `Current` / `Superseded`, `Earlier version` / `Branch not adopted` (history entries), `Nexus ↗` for another
  project, `Edited since capture`, `Weak match`; "Included because" sentences from the Graph path (`A depends on B`, `Contradicts X`,
  `Replaced by X`, `Also recorded as…`); "View source" (exact Capture excerpt, source kind and date, and an explicit note that an edited
  idea's capture may not contain its current wording); "Earlier versions" using the Evolution screen's origin words; actions Open idea,
  Open original capture, Open in Evolution, Open in Connections, Open <Project> (only the ones that exist for that entry). Never shown:
  scores, cosine, RRF, ids, token counts. They appear only in "Developer details", switched on with
  `localStorage.setItem("arthur.recall.debug","1")`.
* **Cross-project navigation.** Opening evidence from another project makes that project active first, then opens the screen
  (`use-evidence-nav.ts`). If the project cannot be opened the user is told and stays put.
* **Semantic consent** is a Settings section on Desktop and Mobile (`SemanticRecallSettings`): OFF by default, says lexical Recall always
  works, what is sent (idea text and questions) and what stays (the index), that turning it off stops requests at once and keeps the
  vectors ignored, and "Delete semantic index" (two-step). It never reads or mentions an API key. Ask Arthur never prompts for it.
* **Loading** is one neutral line ("Looking through <Project>…") with Cancel. The backend reports no stages, so none are invented and
  there is no percentage.

## Deviations and findings (please read)

1. **Archived projects (final pass).** The Projects invariant is unchanged: an archived project can never be the *active* project, so
   nothing can be captured into, created in, edited in or moved into it. Instead `ProjectsState` gained a narrow
   `readOnlyProject` / `openArchived` / `closeArchived`, reached from the existing archived list ("Open read-only" beside "Restore", on
   Desktop and in the Mobile project sheet). It does one thing: it supplies the scope of Ask Arthur (`readOnlyProject ?? active`).
   Ask then shows "Archived" and "Read-only. Nothing here can be changed. Back to <live project>". It ends on Back to <project>, on
   switching, creating, archiving or restoring any project, and it drops the shown result. Normal questions never carry an archived id.
   Guarded in the architecture test (`openArchived` never calls `setActiveProject`).
2. **"Open original capture"** opens the idea, whose Source section already shows the full capture with the span highlighted. There is no
   separate capture viewer in the app, and none was invented.
3. **Excerpts are bounded by design** (a few per answer; none for other-project entries). The benchmark first read this as a provenance
   mismatch; it is not. The UI now says "The exact words aren't shown here. Open the original capture to read them."
4. **Back stack (kept).** Invariant: when one layer closes and another opens in the same state update, the history cleanup for the closed
   layer must not remove the newly opened layer's history entry. `back-stack.ts` defers the pop to the end of the update and lets a
   layer opened meanwhile take over the entry. The unit test proves this generically (any close + open in one update leaves one entry
   per open layer, and Back then closes the newest layer first).
5. A dev-only `?recallDemo` scripted result exists for looking at the UI in `vite dev`. It is behind `import.meta.env.DEV` and is not in
   the production bundle (checked). Test fixtures live in `src/test/recall-fixtures.ts`.
6. `RESERVED` shortcuts is now empty; `Mod+K` moved to `BOUND`. Two shell tests that asserted "no Ask item" were updated.

## End-to-end benchmark (`recall_e2e_benchmark`, deterministic, runs in CI)

The whole `ask` path over the 90-question golden corpus, five configurations. The embedder is the concept-lexicon double and the answer
model is a double that quotes the strongest evidence verbatim. **So "synthesis grounding" here checks Arthur's own mapping and
validation, not a real model's prose**; that stays the ignored live tier. Semantic-only numbers are the double, not semantic quality.

| configuration | evidence recall | graph classes | lineage facts | answered / insufficient |
|---|---|---|---|---|
| L lexical only | 0.82 | 0.67 | 0.60 | 59 / 31 |
| S semantic only | 0.59 | 0.50 | 0.43 | 11 / 79 |
| H hybrid | 0.88 | 0.67 | 0.60 | 65 / 25 |
| HG hybrid + Graph | 0.94 | 1.00 | 0.60 | 65 / 25 |
| Full (+ Lineage) | 0.94 | 1.00 | 1.00 | 65 / 25 |

In every configuration: valid evidence handles 100%; project leakage 0; obsolete-as-current 0; provenance excerpts shown are exact
(100%, with 1 to 5 entries per run not given an excerpt, by design); edited-since-capture flag 100% correct; insufficient-evidence
refusals correct (13/13, none reached the model); paragraphs faithful to what they cite 100%; temporal labels consistent 100%.
Gates re-judged on the answers: Graph +33.3 pp (error reduction 100%); Lineage +40.0 pp. Answer wall time with the double: p50 ≈ 5-6 ms,
p95 ≈ 11-14 ms.

## Android emulator acceptance (Pixel_10 x86_64, API 37, real app, real `gpt-4.1-mini` and OpenAI embeddings)

Driven through the WebView debugger with **real (trusted) taps** for navigation and `adb input keyevent` for system Back; data read
back through the app's own commands. Database backed up first and restored byte-for-byte after.

1-3. Home → Ask about Inbox → a direct question was answered with margin references and a "Based on" list.
4-6. Evidence sheet: Current / Edited since capture, View source (exact capture words and the edited-since note), Open idea (the idea
page with its capture quote). System Back: idea → **Ask with the answer kept** → Home → (exit).
7-8. Dependency question: the Graph-added task showed "Included because: Use EMG wristband to start and stop capture depends on Measure
wristband latency on the real device".
9-10. After two edits to an idea: an evolution question was answered with the paragraph labelled "Current and earlier wording" and
references `E1 · earlier`; the sheet listed both earlier versions (`Earlier version`, `First capture` / `Your edit`, view source).
11. A Bulgarian question was handled (Cyrillic answer text; the model judged the evidence insufficient and the UI showed
"What the evidence does say" quietly).
12. An unrelated question: "couldn't find enough evidence in Inbox", no error.
13. Semantic OFF (default): lexical Recall answered; 0 embedding requests, 0 uploaded texts.
14. Enabled from Settings: 64 ideas indexed in ~2 s; a paraphrase with no shared words found the wristband idea (1 request, 1 text).
15. Disabled: next question made 0 requests and the 64 vectors were kept but ignored.
16. "Delete semantic index" (two taps): 0 vectors; lexical Recall still answered.
17. Force-stop and relaunch: no history. None of the five questions' text exists anywhere under the app's data directory (a positive
control for the search passed), the question box is empty, no result is shown, `localStorage` is empty.

Honest note: the model is conservative and varies between runs; the same evolution question was `answered` once and
`insufficient_evidence` the next time, and a Bulgarian "what did we decide" question came back insufficient with partial text. The UI
handles both. Interaction state in the two Ask screens was refactored (keyed by the answer instead of effects) after the last device
build; it is covered by the unit tests, not re-run on the device.

## Performance (device unless noted)

* Time from tapping Ask to the first loading state: 52-108 ms.
* Local Recall (retrieval + Graph + Lineage + provenance + context): 5 ms with semantic off, 7-25 ms with it; with a query embedding
  round trip the whole retrieval was 0.19-1.0 s.
* Synthesis: about 1.0-1.5 s; whole question to answer: 1.6-4.1 s.
* Rendering 40 evidence rows and 10 long Bulgarian paragraphs at 360 px (browser): result visible within ~130 ms; no horizontal overflow
  at 360, 390, 412 px (mobile) or 1000, 1280, 1440 px (desktop; the evidence column goes beneath the answer at 1000).

## Final pre-commit pass (fresh APK from the final tree)

Focused emulator acceptance with real taps and the real Gboard keyboard: Ask → question → real grounded answer → evidence sheet → Open
idea → system Back → **Ask with the result kept** → another question → Back → Home → Back leaves the app → relaunch restores Home.
Sheet → close → reopen → Back: closes the sheet first (stays on Ask), next Back → Home. Switching project drops the old result.
Archived "Old work" opened read-only from the project sheet: labelled Archived, the question was asked with that project's id (its
evidence came from it), and the active project stayed the live one. Semantic Recall OFF (default) answered lexically.

Software keyboard (411 dp and 360 dp): Ask opens with the keyboard up and the page resizes so the question bar sits directly above it
with the send button visible; a long Bulgarian question is editable (typing, DEL) and the bar grows to a maximum height and scrolls;
the keyboard's Send key submits; opening and closing the keyboard with a result on screen leaves the result and draft intact; system
Back dismisses the keyboard first and only then leaves the page; no horizontal overflow at either width. Cyrillic was entered by
setting the value (the emulator input tool cannot type it); ASCII typing and deletion went through the real keyboard.

Honest notes: two live questions in this pass took 46-50 s on the emulator's flaky network and degraded to `retrieval_only` with the
evidence kept (the designed behaviour); the mobile project sheet does not re-read the project list when it opens, so projects created
outside the app appear after a relaunch (pre-existing, not changed).
