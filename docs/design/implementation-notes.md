# Marginalia: implementation notes

The design specification in [`exploration/`](exploration/) is **frozen** (committed unchanged before implementation). This file
records every place the implementation differs from it, and every decision the spec left open, so the spec stays a clean
reference and the differences are not rediscovered as bugs.

## Approved by the product owner
- Graphite is the only theme. **Daylight is not implemented** (its tokens exist in the exploration only).
- **No "Ask Arthur" navigation item.** Only the shortcut is reserved: `Mod+K` (see `app/shortcuts.ts`, which also tests that nothing binds it).
- **Footer wording:** "Knowledge stored locally", never wording that implies no data reaches cloud services (voice transcription and
  the language model are cloud services).
- **No Tailwind, no shadcn.** The existing React + plain CSS stack is kept; the spec's tokens are CSS custom properties. No new dependency was added
  (Lucide was optional and not needed: the generic icons are ten small inline SVGs, and kinds/relations/brand are custom anyway).
- **Auto-distill after a successful capture**, with the invariants documented in `apps/arthur/README.md` ("Auto-organize") and tested in
  `features/capture/auto-organize.test.tsx`.
- Organizing is also shown in the rail footer ("Organizing…", or "N captures couldn't be organized" linking to Home) so a background failure is never silent on another screen.
- Home grouped by Capture; Evolution idea picker; edge labels only on focus; "Find connections"; derived revision captions; no unsupported
  relation/revision actions (no remove/confirm connection, no "make current" on an existing revision).

## Deviations from the frozen spec
| Spec | Implementation | Why |
|---|---|---|
| `--ink-3: #747971` | `#8a8f86` | Measured contrast on the ground was 4.04:1, below WCAG AA (4.5:1) for the 12px meta text it is used for. New value is 5.45:1. `--ink-4` stays decorative/disabled only. |
| Newsreader + Hanken Grotesk only | plus **Source Serif 4** and **Inter** Cyrillic subsets, scoped by `unicode-range` | Neither face has basic Cyrillic and the user writes Bulgarian. Without a fallback, Cyrillic would render in a system font. Latin text is unaffected. |
| Origin label "Proposed by the model" (old `ORIGIN_LABELS`) | "Proposed by Arthur" | Product language. |
| Origin filter "Proposed by Arthur" | "Arthur's" | The filter groups model-proposed *and* system-created links (everything not made by the user), so "proposed" would be inaccurate. |
| "Find an idea" search on Connections | not built | Ideas already has search; a map search needs a design for what it highlights. Left for a later step. |
| Hand-placed graph positions | seeded force layout (`graph-layout.ts`) | Real data needs a stable computed layout. Each node starts from a hash of its own id, so adding an idea does not reshuffle the map. Region captions ("Capture & cognition") were decorative and are not built. |
| Evolution columns by time order | columns by generation, lanes by branch (`lineage-layout.ts`) | Deterministic from the DAG alone; a parent is always left of its child; branches and merges stay readable. |
| "Sort" and "Filter" buttons on Ideas | not built | They did nothing in the spec; only real controls ship. Search and the kind tabs are real. |
| Greeting "Good evening" | follows the local time of day | A fixed evening greeting is wrong in the morning. |
| Window 1100×760, title "A.R.T.H.U.R." | 1280×800, min 1000×640, title "Arthur" | The design is composed at 1280; the long name is for About/docs only. |
| Shared folder named `ui/` | `components/` | `components` is a root governed by the repo's UI boundary rules; `ui` would have silently escaped them. |

## Behaviour that is intentionally unchanged
`ArthurClient` and every client implementation, `packages/contracts`, SQLite schema, the Cognitive Graph and Thought Lineage logic,
provenance rules (an edit or merge never claims a Capture source), the Rust layer, AI/provider infrastructure. The only behavioural
addition is the auto-distill orchestration, and it lives entirely in the UI layer on top of the existing `distillCapture`.

## Known gaps
- Mobile layout is not built (the rail, inspectors and graph need their mobile forms). The 1000–1200px desktop range trims side panels.
- The map has no zoom/pan; it fits the view. A map of hundreds of ideas will need both.
- Per-object revision counts are loaded with one `getObjectLineage` per idea (in parallel). A batched or derived query would be better at scale.
- Visuals were verified in a browser against a seeded in-memory client, not inside the Tauri shell (no Rust toolchain in this environment).
