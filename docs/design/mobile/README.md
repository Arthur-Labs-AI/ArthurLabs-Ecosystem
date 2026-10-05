# Marginalia Mobile: design exploration (M03.1B)

Status: **design approved. Decisions locked in [`DECISIONS.md`](DECISIONS.md); implementation follow-ups in [`FOLLOW-UPS.md`](FOLLOW-UPS.md).** Still design only. Nothing in `apps/arthur`, Rust, SQLite, `ArthurClient`, the graph, lineage, auto-distill or providers was touched. Everything is static HTML/CSS/JS in this folder. Desktop Marginalia is unchanged and is *reused*: `mobile.css` loads `../exploration/arthur.css` for every colour, relation colour, radius, easing and duration, and `arthur-ui.js` for icons, kind glyphs, relation geometry and the word diff.

| File | What it is |
|---|---|
| `DECISIONS.md`, `FOLLOW-UPS.md` | Locked decisions; implementation follow-ups (separate on purpose). |
| `index.html` | **Interactive playground.** One phone: jump to any composition, 360 / 390 / 412 sizes, gesture vs 3-button nav, Graphite / Daylight, three Home capture surfaces, and the outcome of the next capture (success, organize fails, mic denied, STT fails, empty, interrupted). Live prompt + copy button. |
| `board.html` | Every composition at real size (live iframes), plus 360 / 412 stress and 3-button / Daylight. |
| `system.html` | Mobile tokens, nav anatomy, type, touch, motion, relation geometry, continuity table. |
| `phone.html` | A single screen at exact size (`?s=<preset>&w=&h=&nav=&theme=&cap=&o=&live=1`). Used for screenshots and the board. |
| `mobile.css`, `mobile-ui.js` | Mobile tokens + components; renderer, force layout, map gestures, lineage rail, capture state machine. |
| `demo-data.js`, `export_demo.py` | The real demo DB (`tools/demo-data`), exported read-only. |
| `shots/*.png` | 2× screenshots from headless Chrome. `make-shots.sh` / `shoot.sh` re-render them. |

Open `index.html` or `board.html` in Chrome (`file://` works, fonts are bundled).

---

## 1. Mobile UX philosophy

**Desktop = explore your thinking. Mobile = capture your thinking.**

The phone does four things in this order: **capture → organize → glance → continue thinking.** So:

- The first screen is a question and a way to answer it. Capture is the headline, not a button in a rail.
- Nothing needs two hands. The Capture tab, Speak, Stop, Revise and sheet actions all live in the lower half of the screen.
- Reading is one column. The desktop's side-by-side inspector becomes either a **full-screen page** (Idea detail, where there is a lot to read) or a **bottom sheet** (Map, Filters, Revise, where you want to keep your place).
- It is still a notebook with a memory. Serif for thought, sans for chrome, hairlines and whitespace instead of cards, the thread, the margin, solid = yours / dashed = Arthur's.

## 2. Navigation decision

Bottom bar, five slots: **Home · Ideas · Capture · Connections · Evolution.** Settings is a 44px glyph at the top right of every screen, opening a pushed page. No Ask Arthur / Recall anywhere.

**Capture is an index tab, not a FAB.** It is the desktop rail's ink-filled Capture button turned into a notebook index tab that sticks 12px out of the bar's top edge, with the accent thread-knot (the logo apex) on its edge. It lives *in* the bar so it never covers content, and sits at the lowest, most reachable row. **With microphone permission already granted, tapping it starts listening immediately** (one gesture). **Without permission it only opens Home**, where the Speak page shows one quiet line; the permission request comes after an explicit tap on **Speak**, never from navigation (`DECISIONS.md` 5–6). Current tab = heavier label and icon plus a 24×2px accent bar (the desktop's leading accent bar, rotated).

The bar is hidden when it would be wrong: during recording, in Idea detail (replaced by a Revise / Branch action bar) and while the keyboard is up.

## 3. Capture interaction (the Home decision)

Three surfaces are built and switchable in the playground (`index.html`, right panel):

| | Surface | Verdict |
|---|---|---|
| **C** (locked) | **Speak page**: a raised notebook page with ruled lines ("Write it down, or just say it."), a full-width 56px **Speak** pill, and a 56px keyboard button. | **Canonical mobile Home.** Voice is the biggest target and the text field is one tap away; both live in the thumb zone. Stays recognisably the desktop composer. |
| A (not chosen) | One big microphone: a 176px tap-to-speak disc, typing as a text link. | Strongest voice-first statement, but it makes typing second-class, reads as "a recorder", and pushes Recent off the first screen. |
| B (not chosen) | The desktop composer shrunk, with a small mic. | Text-first is the wrong default on a phone, and a small mic is the weak target. |

**Recording is a full-screen moment**, not a state of the composer: a thread hangs from the top of the screen to a live accent knot (the only looping animation, only while the mic is on), "Listening", a large tabular elapsed clock, one line of reassurance, a 64px **Stop and save**, and **Discard** at the top. No waveform: it would be decoration, and there is no level data in the client anyway. Copy under Stop: *Audio is sent for transcription and isn't kept.* (true to `voice_capture.rs`).

**Why there is no transcript editing step.** The spec asked for "post-transcription editing if appropriate". It isn't: `finishVoiceCapture` persists the capture before it resolves, and the product's own decision is *Raw captures are never edited*. Fixing a mis-heard word happens one step later, by **Revising the idea**, which keeps the history.

### The invariant, made visible

Saving and organizing are separate operations and the UI shows them as two things on the thread:

```
typing/recording → [Transcribing…] → Capture saved → Arthur organizing → Organized
                                          │                  │
                                    solid capture node   dashed thread + hollow nodes
                                                              └─ failed → "Your thought is saved. Retry organizing."
```

The saved Capture is always visible as a solid node with its text. Pending work is **dashed** (Arthur's, not yet real); when organizing finishes, the thread **draws** (700ms) to the real ideas. A failure never removes the capture: it turns the dashed thread into a quiet row with one **Retry organizing** button. Home also shows two real demo states: a capture that was *never* organized ("Organize now") and one that was organized into *nothing* ("Nothing to organize in this one.").

### Failures (copy follows the real native errors)

| State | What the user sees | Source |
|---|---|---|
| Permission | Android's own dialog (mocked, labelled "not ours to style") | `startVoiceCapture` |
| Mic denied | "Microphone is off. Allow microphone access for Arthur in Android settings, then try again. You can still type." + **Type instead** | `microphone_permission_denied` |
| STT / network (retryable) | "Couldn't reach the speech service. Your recording is kept on this phone only while you retry … deleted once it's transcribed, if you discard it, when you leave this screen, or after 15 minutes." + **Retry transcription** / **Discard recording** | `stt_failed` (network) |
| STT not available (terminal) | "Couldn't transcribe. Speech-to-text isn't available right now. Nothing was saved and the recording wasn't kept." + **Record again** / **Type instead** | `stt_not_configured`, auth |
| No speech | "No speech recognised. Nothing was saved." | `empty_transcript` |
| Interrupted | "Recording stopped. Arthur left the screen, so the recording ended. Nothing was saved." | `recording_interrupted` |
| Organizing | "Your thought is saved. Retry organizing." | `DistillationError` |

Terminal voice failures say honestly that nothing was saved. The retryable one says exactly how long the audio lives and what deletes it, because the temporary audio is a promise to the user (`DECISIONS.md` 7–11). Organizing failure is softened, because there the capture really is safe.

## 4. Screen by screen

All against the demo DB (16 captures, 49 ideas, 54 links, 71 revisions). Screenshots in `shots/`.

1. **Home** (`home.png`). Brand + Settings; italic greeting; *What's on your mind?* in Newsreader 36; the Speak page; **Recent** grouped by Capture with the thread: capture node (source glyph + italic excerpt + time) → kind glyphs for its ideas, joined by a hairline with branch ticks. One line per idea (title, links, revisions) so a thumb scrolls it quickly. Ends with "All 49 ideas".
2. **Home · recording** (`home-recording.png`): §3.
3. **Home · organizing / failed** (`home-organizing.png`, `home-orgfail.png`, plus `home-saved`, `home-organized`, `home-transcribing`).
4. **Ideas** (`ideas.png`). Title + count, search (Cyrillic works), scrollable underline kind tabs with counts (All 49, Ideas 20, Tasks 9, …), day groups in italic serif, ~102px rows: kind glyph, serif title (2-line clamp), 2-line preview, margin line *source · links · revisions · age*. No inspector.
5. **Idea detail** (`idea.png`): **full-screen**, not a sheet. A sheet would hide the page that you came from but also cap the reading room; this screen has the most to read (body, source quote, connections, history), so a pushed page wins. Back + "Show on map" on top; kind, edited-ago, title, margin line, body at 18/1.62; then three facets with hairlines: **Source** (capture meta + quote with the exact span highlighted), **Connections** (3 sentence rows, "All 7 connections", Show on map, Find connections for this idea), **Evolution** (last three revisions as a mini rail, "Open"). Sticky action bar: **Revise** (primary), **Branch**. Zero-connection and one-revision objects have their own empty copy.
6. **Connections · List** (`connections-list.png`): §5.
7. **Connections · Map** (`connections-map.png`): §5.
8. **Selected node / edge** (`connections-node.png`, `connections-node-open.png`, `connections-edge.png`): §5.
9. **Evolution** (`evolution.png`): §6.
10. **Revision + diff** (`evolution-rev.png`, `evolution-merge.png`, `evolution-lanes.png`): §6.
11. **Settings** (`settings.png`): only what is true: *Your knowledge* (stored locally), *Voice and organizing* (cloud STT; recording deleted after transcription; organizing sends text to a cloud model), *About* (client, platform, version). No settings the app doesn't have.

360 stress cases (`*-360.png`): Home, Ideas with the 131-character title, its detail, Map, Evolution with a 3-lane lineage and a 3-parent merge, Connections list. 412 cases: Home, List, Evolution.

## 5. Connections: List / Map strategy

The 49-object set proved the graph can't be scaled to fit, so **List is the default** and a first-class view; **Map** is an explicit toggle.

**List.** Ideas ordered by connection count; each is a row (kind glyph, title, count). Expanding one lists its relations as sentences: *relation swatch (same geometry as the map) · other idea · → extends / ← extended by · origin dot (solid yours, dashed Arthur's) · Yours / Arthur's*. Each link appears under both of its ideas, and the footnote says so. Tap a relation for the edge sheet; "Open idea" to jump. A header **Filter** sheet (Made by: All / Yours / Arthur's; Kind: seven swatches, which is also the legend) applies to both views.

**Map.** A true canvas: pointer-based **pan, pinch, wheel zoom** (0.4–2.8×), tap nodes, tap edges (26px hit width), **stable positions** (deterministic hash-seeded force layout computed once, ~1,000 × 1,000 world, about three screens across), **no fit-to-all**: it opens at 1× centred on the selected idea (default: the 7-connection hub). Aids that are not auto-fit: a **minimap** with the current viewport (tap to jump), and 44px **+ / −** buttons (a non-gesture way to zoom). Labels are counter-scaled so they stay 14px on screen at every zoom; at low zoom only hubs and the focus set are labelled. Nodes keep shape = kind, size = connections; edge geometry is exactly desktop's (chevron, dashed + filled arrow, dotted + hollow arrow, bar–bar, double, arrow + stop bar). No glow, no HUD.

**Selection.** Tap a node: it, its neighbours and their edges stay at full opacity, the rest drop to 34%, the world glides (280ms) so the node sits in the area *above* the sheet, and a **peek sheet** appears (kind, title, margin line, Open idea, "7 connections"). Pull up (or the button) to list the connections with their geometry. Tap an edge: sheet with the sentence "A *extends* B", a 56px swatch, the meaning, origin, direction, created, and the desktop's note for model-proposed links. Tap empty canvas to deselect.

## 6. Evolution mobile grammar

The desktop's horizontal two-lane rail is **rotated into a vertical temporal rail** (oldest at top, newest at bottom, as git-log-style top-down). It is not a shrunk copy: it has the same grammar, in a different axis.

- Nodes: rounded-rectangle revision tags (`R3`). **Current** = accent fill (exactly one). **Merge** = underlined tag with the rails of its parents curving in. **From a new capture** = pencil-blue outline. Arrowheads show parent → child.
- Lanes: a branch leaves its parent's row to the right; a merge brings lanes back. Lane spacing 34px. Verified on the real data: a 2-lane branch + merge, and a **3-lane lineage with a 3-parent merge** (`evolution-lanes-*.png`).
- Beside each node: origin ("First capture", "Your edit", "From a new capture", "Merge"), the derived caption (`+15 −0 words · title`, or "Merged R2 + R3"; there is no revision message in the contract), age. *Current* in accent.
- **Selecting a revision expands it in place**, under its row, with the rail running down the left beside it, so orientation is never lost. Contents: **Compared with** (for a merge, a chip per parent: R2 | R3; the diff recomputes), **Changes | Full text** tabs, the deterministic word diff (+ green wash, − red wash *and* strike, never colour alone), title diff when the title changed, the capture quote if the text has one, or "This text is your edit, so it has no capture source." / "Merged text is written by you…", and **Branch from R3**.
- Header: idea picker (a sheet of the 8 ideas that have history), summary line (`5 revisions · 2 branches · 1 merge · R5 is current`), **Revise** and **Merge…** (the real client verbs), and one line for non-technical users: *Every edit keeps the old version. Branch to try another direction, merge to bring them back together.* "Make current" is deliberately absent (not in the client).

## 7. Responsive and token changes

New tokens only (desktop tokens are untouched). Full table in `system.html`.

| Token | Value |
|---|---|
| `--gut` | 20px (16 at 360, 22 at 412) |
| `--safe-t` / `--safe-b` | 36px / 20px gesture or 48px 3-button (`env(safe-area-inset-*)` in production) |
| `--bar-h` | 60px + `--safe-b` |
| `--touch` | 48px primary, 44px floor (40px only for in-row secondary buttons) |
| Type | hero 36 (32 at 360), page 30 (28), thought 30 (27), body 18/1.62 (17), row 17/1.26, UI 15, meta 12.5 (floor 12) |
| Radii | 3 / 6 / 11 (desktop) + 14 sheet top; full only for Speak, Stop, dots |
| Raised surfaces | the Home page, sheets, toast. Everything else is hairlines. |
| Fonts | Newsreader + Hanken Grotesk, with Source Serif 4 Cyrillic and Inter Cyrillic fallbacks (already in `apps/arthur/src/assets/fonts`). Verified with Bulgarian text and an emoji. |

Layout is by JS size class (`data-size` s/m/l from the viewport width) so it can later be a CSS container query or media query. Screens are designed at 360×800, 390×844, 412×915.

## 8. Accessibility

- Targets ≥ 44px (primary 48–64). The one 40px control, the compare chips and `Filter`/`Organize now` buttons, is spaced ≥ 8px from neighbours.
- Nothing is colour-only: kind = shape, relation = line geometry + text label, current/selected = shape + text + accent, diff = wash + strike/underline-style, origin = solid/dashed dot + the words "Yours" / "Arthur's".
- Map gestures have non-gesture equivalents: + / − buttons, **List view** with the same information, minimap tap, and `Enter` on a focused node. Nodes and edges are real focus targets with labels (`aria-label="idea: title, 7 connections"`).
- Status changes use `role="status"` / `role="alert"` (transcribing, errors, toast). Sheets are `role="dialog"` with labels; the grab handle is a button.
- Focus ring 2px accent, as desktop. `prefers-reduced-motion`: all transitions and the thread drawing become instant, the recording knot stops breathing.
- Contrast: `--ink-3` on `--ground` is ~4.2:1, under 4.5. It is used for meta text ≥ 12.5px and decoration; I kept primary labels (tab bar, tab names) on `--ink-2`. **Needs a measured audit before implementation** (same caveat as desktop).
- Dynamic type is not designed: layouts assume the default font scale. Android font scaling should be checked in implementation.

## 9. Desktop ⇄ mobile continuity rules

- **Identical:** notebook-with-a-memory idea; type pairing and Cyrillic fallbacks; Graphite + Daylight; accent only for current / focus / Speak; pencil-blue for Arthur's proposals; five kind glyphs; seven relation geometries and colours; solid = yours, dashed = Arthur's; the margin (source, links, revisions); the thread; Connections organic + serif labels vs Evolution structured + sans labels; all error and empty-state voice; what the client can and cannot do.
- **Transformed:** rail → tab bar with an index-tab Capture; composer → the Speak page; persistent inspector → full-screen detail / bottom sheets; legend-overlay filter → Filter sheet; horizontal rail → vertical rail with in-place expansion; hover and shortcuts → taps and visible buttons; Connections default Map → default List.
- **Desktop only:** ⌘N / ⌥Space / `/`, persistent multi-pane layouts, graph beside inspector, density toggle, Home's "Connected thinking" mini-graph.
- **Mobile only:** full-screen recording; permission, interruption and STT-failure states; the index-tab Capture; minimap and zoom buttons; pinch/pan; map peek sheet; Idea-detail action bar.

## 10. Verification (and what was not verified)

- Rendered every composition in headless Chrome at 2× (52 PNGs): 390×844, 360×800, 412×915, 3-button nav, Daylight, three Home variants, plus the playground, board and system pages with no console errors.
- Scripted interaction checks (clicks): Speak → recording clock; Stop → transcribing → Capture saved → organizing → **Organized** (success path) and → **failed** (organize-fail path); open an idea; List → Map; tap a map node → sheet.
- **Not verified:** real two-finger **pinch** and touch-drag on a device (implemented with Pointer Events, tested only by wheel logic and code review); the Android software keyboard (mocked as a fixed 276px block); the Android permission dialog (mocked); real display cutouts and gesture-bar behaviour; performance on a phone (49 nodes / 54 edges re-render on selection, which is fine here but unmeasured on Android WebView). These need a device pass during implementation.
- Dates are pinned to 2026-10-04 19:25Z so the demo has Today / Yesterday; relative times are computed from that.

## 11. ArthurClient / native limitations the mobile design exposes

1. **(Resolved in design, follow-up 5.) A failed transcription loses the recording today.** `voice_capture.rs` deletes the audio "whatever happens" (RecordingGuard), so STT failure, empty transcript and interruption all mean *nothing saved, nothing retryable*. On a train with a flaky connection this is the most painful flow in the product. The design says so honestly. **Decision taken:** retain the temporary audio only for the active retry flow, never as a library (`DECISIONS.md` 8–10). Production work is `FOLLOW-UPS.md` item 5.
2. **No recording telemetry.** The client only has `start / finish / cancel`: no elapsed time, no state callbacks, no interruption event, no level. The elapsed clock is the UI's own timer; "interrupted" is only discovered when `finish` rejects.
3. **Recording length is unbounded in the UI but not in reality.** `MAX_RECORDING_BYTES` (24MB) makes `read_audio` fail with `recording_failed` at *stop*, after the user has spoken for a long time and lost it. Needs a duration cap with a warning (and, per 1, a way not to lose it).
4. **No way to open Android's app settings or query microphone permission.** After "Don't allow" the UI can only tell the user where to go. A `openAppSettings` / `microphonePermission()` capability would let the recovery be a button.
5. **No cancel during transcription.** `cancelVoiceCapture` is a no-op once stopped; the transcribing state therefore has no cancel.
6. **"Not organized yet" isn't exposed.** Home must tell *never organized* from *organized into nothing*; today that lives in `distillation_runs`, which `ArthurClient` doesn't surface (it can be approximated by "capture with no objects", but that conflates the two). A `Capture.organized` flag, or a `listCaptureStatus()`, is needed. Likewise a *failed* organize is only UI memory today; after a restart it looks like "never organized".
7. **Per-row counts are N+1.** Ideas rows, Home kids and detail need link and revision counts per object; the client has only per-object calls. Needs a batched summary (`listObjectSummaries()`), more urgent on mobile.
8. **Zero-connection objects don't exist in the demo dataset.** Min connections is 1 (the brief assumed some 0). The 0-states (row shows 0, detail empty copy, List footnote) are designed, and the "Organized" and "Capture saved" demo states use synthetic fresh ideas with 0 links to show them. If you want 0-connection objects in the demo DB, `seed_demo_db.py` needs a few.
9. **`createRelation` exists but has no UI** on desktop or mobile (users can't hand-connect two ideas). I did not invent one for mobile.
10. **Still not in the client** (so absent here): remove / confirm a relation, make an *existing* revision current, revision messages.
11. **Map layout is a client concern.** Positions are computed once in the playground and would need caching per object id in the real app so the map is the same map after a restart (as noted for desktop).

## 12. Open questions

None from the exploration. All three (Home variant, Capture-tab behaviour, retry audio) are decided in `DECISIONS.md`. Implementation follow-ups are in `FOLLOW-UPS.md`.
