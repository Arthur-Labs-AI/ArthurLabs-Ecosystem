# Marginalia Mobile: implementation notes (M03.1B-1)

The production mobile UI for the approved design in this folder. Design is unchanged; this records how it was built, where
production is weaker than the design (and degrades honestly), and what was measured on a real Android WebView.

## Architecture

One application, two presentations.

```
ArthurProviders (client, captures, knowledge, graph, lineage summaries, navigation)   <- shared, unchanged
└── App
    ├── DesktopApp   (Shell + Home/Ideas/Connections/Evolution/Settings)               <- Marginalia Desktop, unchanged
    └── MobileApp    (features/mobile: tab bar, pages, sheets)                         <- Marginalia Mobile
```

* **Selection** is `app/layout-mode.ts`: `matchMedia("(max-width: 720px)")`, nothing else. No user agent, platform name or build
  flag (the `ui-does-not-detect-platform` architecture rule still passes, and a test greps the file for them). A narrow desktop
  window gets the mobile shell for the same reason a phone does. Resizing across the breakpoint keeps the user's place because
  both shells read the same navigation state.
* **Shared:** `ArthurClient`, all hooks and contexts, contracts, relation/lineage semantics (`relation-style`, `revision-captions`,
  `use-lineage`, `use-graph`), `layoutGraph`, `KindGlyph`/`RelationSwatch`/`Margin`/`SourceQuote`, the tokens in
  `app/styles/tokens.css`.
* **New (mobile only):** everything in `features/mobile/`, `features/lineage/vertical-layout.ts` (pure layout for the vertical
  rail), `app/layout-mode.ts`.
* **Touched in shared code, additively:** `icons.tsx` (keyboard, back, minus, filter), `GraphCanvas.tsx` (exports `NodeShape` and
  `wrap`, no behaviour change), `use-captures.ts` (adds `voiceFailure`, `dismissVoiceFailure`, `micKnownGranted`, `cancelVoice`;
  existing fields untouched), `vite.config.ts` (tests may read stylesheets with `?raw`). No desktop CSS or desktop screen changed.
* **CSS:** one file, `features/mobile/mobile.css`, every class prefixed `m-`; a test fails if any selector is not.

## Behaviour decisions

| Topic | Implementation |
|---|---|
| Capture tab | Records immediately only if the microphone is **known** to work in this app run (`micKnownGranted`: set by a successful start, cleared by a refusal, never persisted). Otherwise it opens Home with the hint "Tap Speak and the microphone will be requested". Only **Speak** can raise the system dialog. |
| Why not query permission | `ArthurClient` has no permission query. A persisted "granted" flag could be stale (a revoked permission would make navigation raise the dialog), so it is memory only: first Capture tap after a fresh launch always opens Home. Verified on the device. |
| Voice failures | The native layer deletes the recording on every failure, so there is **no retry-audio UI**. The card says "The recording isn't kept, so say it again or type it." Retry/Discard-recording is M03.1B-2 (`FOLLOW-UPS.md` 5). |
| Organization state | Same as desktop: a failed job is UI memory; a capture with no ideas and no job reads "Not organized yet" with **Organize now**. Cannot tell never-organized from organized-into-nothing (`FOLLOW-UPS.md` 1, 2). |
| Back | `back-stack.ts`: every pushed page, sheet and typing mode is one history entry, so system Back closes the top layer instead of leaving. |
| Keyboard | The app is as tall as `visualViewport`, so Capture/Cancel and sheet actions sit above the keyboard; typing mode hides the tab bar and the greeting. |
| Counts | Rows still use per-object lineage reads (existing `LineageSummariesProvider`); nothing cached or invented. Measured below. |

## Deviations from the locked design

1. Home greeting is the desktop's time-of-day line ("Good morning"), not the weekday phrase in the mock.
2. "Capture saved" is shown while the job is queued ("Capture saved · waiting to organize…"), not as a separate timed state; "Organized" shows for 5 s after a job finishes in this session.
3. The map draws ideas with **no** connections as isolated nodes (desktop does); the design mock hid them.
4. Find connections is an icon button with an accessible name in the Connections header (design: same); there is no manual "Add a connection" form on mobile, although desktop has one. Not designed, so not built.
5. Typing mode additionally has a **Cancel** and a mic switch next to Capture (the design had mic + hint + Capture).
6. The tab bar is hidden on every pushed page (design hid it only in Idea detail), and during typing.
7. The Evolution "Merge…" sheet pre-picks the last two non-merge revisions.
8. Idea detail "Show on map" appears only when the idea has connections.
9. Settings About shows the runtime values (client, platform, version) like desktop; the mock used placeholders.
10. Graphite only (no Daylight), as on desktop.
11. Documentation correction: the design README said `createRelation` had no UI; desktop has "Add a connection". Fixed in `README.md` and `FOLLOW-UPS.md`.

## Contrast (measured, `app/styles/contrast.test.ts`)

The exploration's `--ink-3 #747971` measured **4.04:1** on ground. Production already uses `#8a8f86`:

| Text | ground | sunken | raised | overlay |
|---|---|---|---|---|
| ink | 14.43 | 14.95 | 13.31 | 12.11 |
| ink-2 | 7.82 | 8.10 | 7.21 | 6.56 |
| ink-3 | 5.45 | 5.64 | 5.03 | 4.57 |
| accent | 8.30 | 8.60 | 7.66 | 6.96 |
| pencil | 6.98 | 7.23 | 6.44 | 5.86 |

Speak (accent-ink on accent) 8.20, Capture tab (ground on ink) 14.43. Every relation colour reaches ≥ 3:1 on ground
(lowest: related_to 4.63). No token had to change.

## Measurements on a real Android WebView

Pixel_10 x86_64 emulator, API 37, debug build, software GPU, demo database (49 objects, 54 relations) plus a few captures.

* `list_knowledge_objects` 69 ms, `list_relations` 40 ms.
* `get_object_lineage` for 54 objects in parallel: **256 ms** (this is the N+1 in `FOLLOW-UPS.md` 3; acceptable here, grows linearly).
* Connections List → Map first paint with 54 nodes / 54 edges: **195 ms** (layout included).
* Sizes (via `wm size`, same 2.625 density): 360×800, 390×844, 412×915. No horizontal page scroll and no element past the right edge on Home, Ideas, Idea detail (Bulgarian + emoji, 131-character title), Map, Evolution (3-lane lineage with a 3-parent merge).
* Safe areas: gesture navigation reports a 24 px bottom inset, 3-button navigation 48 px, top 55 px; the web view is edge-to-edge and the tab bar, action bar and sheets sit clear of both.
* Touch targets: a scan found one control under 44 px (the "All" kind tab, 37 px wide); fixed with `min-width: 44px` and covered by a CSS test. Not re-scanned on the device after that last change.

## Real Android acceptance

| # | Check | Result |
|---|---|---|
| 1–3 | Launch, mobile shell, all five tabs | Pass |
| 4–5 | Real microphone capture and cloud STT | Pass. The emulator has no microphone, so speech synthesized by a text-to-speech service was injected through the emulator's audio API; STT returned the sentence. |
| 6–8 | Capture persisted, auto-distill, ideas appear | Pass (two ideas from one voice capture; also from typed captures) |
| 9–12 | Idea detail, Connections List, Map, Evolution | Pass |
| 13–16 | Force-stop, process gone, relaunch, state | Pass: after force-stop `pidof` was empty; after relaunch Home groups (8), ideas (54), links (54) and the newest capture were identical. Done on the build before the last CSS-only rebuilds; the emulator then crashed and lost its disk, so the final build re-ran steps 1–8 only. |
| – | Permission: Capture tab on a fresh launch | Opens Home with the hint; focus stayed in Arthur, no dialog |
| – | Permission: Speak | Dialog appears only now; "Don't allow" → "Microphone is off"; Capture tab afterwards does not record or prompt |
| – | Offline STT | "Could not reach the speech service… The recording isn't kept…"; nothing saved |
| – | Offline organizing | "Your thought is saved. … Nothing was lost." + Retry organizing; retry succeeded once back online |
| – | Software keyboard | Capture/Cancel visible above it; one tap saves; Revise sheet actions above it (3-button navigation too) |
| – | Back | Closes page → tab, sheet → page, filter sheet; never leaves while a layer is open |
| – | **Back at the root** | The native abort occurred here (`FORTIFY: pthread_mutex_lock called on a destroyed mutex`). Pre-existing; **fixed in M03.1B-2** (see `hardening-notes.md`). |

One first-attempt STT call failed with a network error on a fresh process and succeeded on retry; shown honestly by the UI, cause not
investigated. Typing-mode Back and the 360/412 keyboard cases were not exercised on the device.

Screenshots from the device are in `android/`.

## What stayed for M03.1B-2 (now done)

The five items in `FOLLOW-UPS.md` are untouched: durable organization state, recoverable organization failure, batched counts,
Open Settings / permission recovery (plus a permission query so the Capture tab can know without a first Speak), and
temporary-audio STT retry. Also open: the root-Back native abort, and a decision on a manual "Add a connection" on mobile.
