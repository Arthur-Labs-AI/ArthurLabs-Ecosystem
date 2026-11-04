# Sentry command center UI continuation

2026-10-23. Continued the owner's unfinished renderer changes on `main`, based
on `2640efc`. The owner approved the new UI and then requested the original green
palette; forest-green accents and olive surfaces are now restored. Changes remain
uncommitted. No backend, IPC contract, persistence schema, dependency, lockfile,
version, or provider execution behavior changed.

## Implementation

- Completed the shared status icons, shell, notifications, disclosure controls,
  command palette, Runs, Issues, History, and Retest presentation. Existing
  Projects, Environment, and Settings inherit the same theme and shared controls.
- Fixed two graph defects: entrance animation overrode React Flow position
  transforms; rebuilding controlled nodes discarded measured dimensions and
  caused `NaN` coordinates while dragging. Controlled changes now preserve
  measurements, drag state, and user positions through selection and telemetry.
- Saved positions and viewport are scoped by run. Malformed saved coordinates
  are ignored. Storage writes are debounced during movement and immediate at
  drag completion. Reset restores canonical positions without losing dimensions.
- Added animated state-colored edges, inspected-edge emphasis, canvas-local
  shortcuts, fit/zoom controls, wheel/pinch zoom, and pane dragging.
- Moved Retest assessment below the agent row for full and targeted layouts;
  bounded its inspector and corrected the compact sidebar's overflowing labels.
- Reduced motion disables CSS animation including pseudo-elements, SVG travel
  pulses, and JavaScript viewport transitions. Border and empty-state motion
  use opacity instead of continuously repainting conic gradients or shadows.

## Verification

Executed on Windows against this working tree:

| Gate                                        | Result     | Evidence                                                                              |
| ------------------------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| Desktop suite                               | PASS       | `pnpm --filter @qa/desktop test`: 496 passed, 3 existing skips                        |
| Workspace lint                              | PASS       | `pnpm lint`: 20 successful tasks                                                      |
| Workspace types                             | PASS       | `pnpm typecheck`: 37 successful tasks                                                 |
| Workspace build                             | PASS       | `pnpm build`: 20 successful tasks                                                     |
| Browser interactions                        | PASS       | `node apps/desktop/tests/browser/ui-smoke.mjs`: all 13 application routes             |
| Repository hygiene                          | PASS       | `pnpm repository:check`                                                               |
| Changed-file formatting                     | PASS       | Prettier check on changed renderer, tests, documentation, and protocol records        |
| Full repository formatting                  | FAIL       | Untouched `.superharness/session-progress.md` has pre-existing formatting differences |
| Packaged Electron / real provider execution | UNVERIFIED | Not run for this renderer-only change                                                 |

The initial direct desktop build found stale generated runtime-protocol exports;
the normal workspace build regenerated dependencies and passed. Vite still emits
its advisory warning for the approximately 543 kB renderer chunk. Backend package
test suites, release packaging, and hosted CI were not rerun or claimed.

Regression evidence: 11 status cases failed before correction; the real browser
drag check reproduced invalid stored coordinates before measurement preservation;
two full/targeted Retest layout cases failed before separating the assessment row.
New Vitest checks also cover measurement retention, selection, per-run layout
isolation, invalid storage, immediate drag persistence, reset, edge selection,
shortcut scope, and reduced-motion viewport options.

Browser checks exercise edge geometry while holding a dragged node, drag-stop
persistence, telemetry refresh, wheel/button zoom, pane pan, resize, view switches,
reset, invalid storage, reduced motion, palette keyboard/focus restoration, and
800px compact layout. Synthetic bridge data is isolated to the test browser;
no owner profile, project, credentials, runtime operation, or paid call is used.

## Rendered review

Screenshots are generated under `.tmp-sentry-test-fixtures/ui-review/` (ignored).
Reviewed Dashboard, Projects, project detail, run graph, Retest, Issues, History,
Environment, Providers, Settings, Runtime, palette, empty/loading/offline states,
and compact graph. The reference is the unfinished pass's existing visual
language, rather than a separate supplied mockup.

| Dimension                 | Observed result                                                                |
| ------------------------- | ------------------------------------------------------------------------------ |
| Composition / proportions | Shared shell and page regions retained; graph and inspector stay bounded       |
| Hierarchy / emphasis      | Gradient page titles, cyan primary actions, and distinct lifecycle colors      |
| Density / spacing         | Compact node summaries, separated sections, consistent filter surfaces         |
| Typography                | Existing sans/mono families retained with consistent headings and metadata     |
| Empty / loading states    | Calm scanning motif and readable loading, empty, and offline feedback          |
| Interaction ergonomics    | Labeled controls, keyboard palette, scoped graph shortcuts, focus restoration  |
| Responsive layout         | Compact sidebar labels hidden; workspace stacks with accessible graph controls |

Self-review found no remaining blocker in correctness, data loss/security,
state lifecycle, or backend ownership. Browser evidence verifies the renderer
flow through a fixture bridge; packaged-native acceptance remains unverified.

## Reproduce browser checks

Start `pnpm --filter @qa/desktop dev`, then run the browser script with Playwright
available. `SENTRY_PLAYWRIGHT_MODULE` may point to an installed Playwright package;
`SENTRY_BROWSER_EXECUTABLE` may select an installed Chrome executable. Optional
`SENTRY_UI_URL` and `SENTRY_UI_OUTPUT` override the local URL and screenshot folder.
The script intentionally does not install dependencies or start a real runtime.

`shux contract` was attempted before inspection; the executable is unavailable.
Task status, ledger, and handoff were maintained directly.

## Owner-approved palette correction

The follow-up changes only colors in `styles.css`, `sentry-theme.css`,
`RunCanvas.tsx`, and `edges/NeonEdge.tsx`. The original Git palette supplies
forest green `#4e7d48`, background `#0d100d`, olive surfaces, warm neutral text,
and yellow live-activity indicators. Blue/cyan backgrounds, gradients, focus
rings, glows, and purple accents are replaced throughout the renderer. Graph
edges and dot grid use CSS theme variables. Approved composition, spacing,
typography, interactions, animations, and backend behavior remain unchanged.

Follow-up verification: `pnpm build` PASS (20 tasks, 19 cached); desktop lint and
renderer typecheck PASS; focused canvas/status tests PASS (16 cases); the browser
smoke script PASS across all 13 routes, with screenshots in
`.tmp-sentry-test-fixtures/ui-green-review/`. Rendered Dashboard, graph, and
command palette were compared to the previous captures: composition, density,
spacing, proportions, typography, empty/loading treatment, and control ergonomics
are preserved, while visual emphasis follows the restored palette. Full Desktop
496/3 above is prior-pass evidence, not a new full-suite run. Packaged native and
real-provider acceptance remain unverified. Source is rebuilt and uncommitted.
