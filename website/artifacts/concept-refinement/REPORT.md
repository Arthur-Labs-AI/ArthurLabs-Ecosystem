# Full Suite direction update — refined concept and proposals

Preview: **http://localhost:3000/suite/concept**. Refresh an already-open preview to load the new production build.

## Implemented now

Removed both raster application backgrounds, the Next Image import, screenshot filters, image masks and obsolete crop styling from the cinematic scene. No raster application image is requested or rendered there.

The Studio opening is now a crisp DOM capture surface: restrained workspace identity, a fine baseline and the original emerging thought. Nexus uses SVG coordination guides and quiet product-colored lighting. Knowledge nodes, relationships, requirement hierarchy and orchestration graph remain sharp DOM/CSS/SVG elements. These surfaces are explicitly illustrative, not replicas of native application UI.

The successful transformation is preserved: same six information elements, same camera/node timeline, same relationship morphing, same native scroll clock and same conceptual project. Camera movement remains reversible; reduced motion still exposes a complete readable storyboard. Replay now focuses the opening heading without an additional scroll, and the readable-storyboard target is keyboard-focusable.

Measured comparison with the prior captured experiment reports **0px node-position difference at every sampled state**, at 390/768/1440/1920 widths. Returning to the middle in reverse also gives **0px node-position difference**. The changed visual layer is the environment, not the approved information choreography.

## Proposed, not implemented

1. **Full workflow storyboard:** nine visual shots and a detailed camera/information treatment for Studio → Nexus → Sentry → Nexus → Studio. Sentry's independent review, the report's return to Nexus, Nexus consolidation and Studio's richer project knowledge are all designed. No further film stages were implemented.
2. **Download-first Suite layout:** hero with the primary Suite download panel, included-app identities and individual downloads, release/compatibility information, installation guidance, documentation/source, optional immersive workflow, hardware research teaser and preserved footer. Desktop/mobile review drawings are supplied. The existing `/suite` was not rebuilt.

The Suite remains a distribution package containing three independent applications. No fourth app, launcher, new runtime, backend integration, installer or distribution API was created.

## Availability handling

The proposal's current state is **unverified/unavailable on this page**. OS and architecture fields remain disabled without verified supported artifacts; the primary action says “Full Suite download unavailable.” Metadata does not show invented versions, dates, platforms, signatures, package sizes or release URLs.

A future reviewed release catalog provides exact artifacts and independently versioned application metadata. Download links appear only for verified target/artifact combinations. If only individual application builds are verified, offer those explicitly and keep the Suite package unavailable. Documentation/source links also require verified destinations; missing destinations render explanatory text rather than fake anchors. No installer availability or global absence of releases is asserted by these drawings.

The full proposal describes unverified, unavailable, available, unsupported-target, withdrawn and metadata-error states. Installation steps and signing/integrity guidance depend on the actual artifact and documentation. Until then, no invented shell commands or package-manager instructions are shown.

## Changed files

Existing files modified only within the concept:

- `src/components/suite-concept/ConceptFilm.tsx`: scalable environment, honest illustrative copy and focus handling.
- `src/components/suite-concept/createFilm.ts`: replaces the two raster-layer targets with scalable scene cues; main node/camera/path choreography unchanged.
- `src/components/suite-concept/concept.module.css`: removes raster/filter/mask treatments and adds scoped capture/orchestration styling.
- `tests/concept.spec.ts`: one added assertion protecting the no-raster scene; prior movement, reversal, mobile and reduced-motion checks remain intact.

All deliverables, drawings and capture scripts are in `artifacts/concept-refinement/`. No dependency or shared source was modified. `preservation.json` confirms **34 protected pre-existing source/config files unchanged**, including the current Suite, Landing, shared components/global styling and the concept route composition. All three original application screenshot assets also match their retained original hashes.

No application project, other worktree or Git history was changed. No commit or push.

## Review files

### Refined experiment

- `concept-1440-scroll.webm` and `concept-390-scroll.webm`: actual browser recordings of continuous forward/reverse native scrolling.
- `film-strip.jpg`: extracted desktop recording frames.
- `concept-WIDTH-begin.png`, `knowledge.png`, `plan.png`, `end.png`: four principal poses at WIDTH = 390, 768, 1440, 1920.
- Additional `unfold-*`, `align-*`, `transform-*`, `reverse-middle` captures show actual transition states.
- `concept-WIDTH-storyboard.jpg`: compact principal-pose boards.
- `comparison-390-begin.jpg`, `comparison-1440-begin.jpg`, and equivalent knowledge/end comparisons: prior raster scene beside the refined vector scene.
- `concept-390-reduced.png`: reduced-motion presentation.

### Future workflow proposal

- `FULL-WORKFLOW-STORYBOARD.md`: detailed shot sequence, camera movement, information continuity, mobile/reduced-motion treatment and architecture boundary.
- `full-workflow-storyboard.png` / `.svg`: nine-panel visual storyboard. Proposed shots are explicitly distinguished from the implemented opening.

### Download-first page proposal

- `DOWNLOAD-FIRST-SUITE-PROPOSAL.md`: detailed section layout, responsive behavior, release-source ownership, metadata requirements and availability states.
- `download-layout-desktop.png` / `.svg` and `download-layout-mobile.png` / `.svg`: layout review drawings, explicitly labeled **proposal / not implemented**. Controls are schematic unavailable-state examples, not working distribution UI.

## Verification

| Gate | Result | Evidence |
| --- | --- | --- |
| Production build | PASS | `npm run build`: all nine routes generated; `build.log`. |
| TypeScript | PASS | `npm run typecheck`, exit 0; `typecheck.log`. |
| Full browser suite | PASS | **46 passed in 1.6m**, production Chromium; `browser-tests.log`. Includes all previous 45 checks and the new raster guard. |
| Focused concept checks | PASS | Eight tests: four-width movement/reversal, reduced motion, two mobile held-pose collision cases and no raster background. |
| Preserved choreography | PASS | `motion-summary.json`: maximum node difference from the prior captured motion = 0px at every checked width; maximum reverse difference = 0px. |
| Browser runtime / overflow | PASS | Four-width capture sessions: no page/console errors or horizontal overflow; `measurements.json`. |
| Preservation | PASS | `preservation.json`: no changed protected source/config or original screenshot asset. Existing Suite/Landing tests pass. |
| Rendered visual review | PASS (agent inspection) | Compared before/after and refined desktop/mobile views, recording frame strip, full workflow board and desktop/mobile layout drawings. Human visual approval remains pending. |
| Cross-browser / physical devices / DPR 2 | UNVERIFIED | Chromium/DPR 1 checks only. |
| Lint / formatting | UNVERIFIED | No configured repository command. |
| Release availability | UNVERIFIED | This milestone designs the interface and states; it does not verify or publish distribution artifacts. |
| Creative approval | UNVERIFIED | The requested stopping point before replacing `/suite` or extending the film. |

The first pre-change raster guard could not connect because the preview was not running; that attempt did not demonstrate a behavioral red result. The previous two raster layers are established by source inspection and the retained before captures. The new guard ran and passed against the final production build. No claim is made that the initial connection failure reproduced the visual defect.

## Performance observations and limits

The refined scene requests no application screenshot assets. The broad raster masks/filters and large image compositing layers are gone; the remaining animation is six information elements, SVG relationships/traces and simple depth/lighting cues.

240 warm-scene requestAnimationFrame intervals, without video encoding, at DPR 1:

| Viewport | Median | p95 | Maximum | Intervals over 50ms |
| --- | --- | --- | --- | --- |
| 1440×900 | 16.7ms | 33.4ms | 116.8ms | 1 / 240 |
| 390×844 | 16.7ms | 50.1ms | 400ms | 13 / 240 |

These are callback timings in headless Chromium, not presented-GPU-frame measurements. They cannot establish stable 60 FPS or a controlled before/after speedup: earlier samples and system load varied. Mobile outliers remain visible in the data. Real-device/cold-start/Safari/Firefox profiling remains open. The full scene and drawings remain a visual-review milestone, not production release acceptance.

## Reproduce

The production preview is currently on port 3000. Use `npm run dev`, or `npm run build` then `npm run start` after stopping the existing server. `npm run test:e2e` runs the full browser suite.

Evidence: `node artifacts/concept-refinement/capture.mjs`; draw proposals with `python3 artifacts/concept-refinement/draw-proposals.py`, render them with `node artifacts/concept-refinement/render-proposals.mjs`, and compose before/after boards with `python3 artifacts/concept-refinement/make-comparisons.py` (Pillow).

Stop here for visual approval. The final Full Suite download page and the Sentry/return animation remain proposals only.
