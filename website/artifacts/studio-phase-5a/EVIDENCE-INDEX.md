# Phase 5A evidence index

## Final deliverables

- `REPORT.md`: implementation, file scope, gates, limits and Phase 5B recommendations.
- `CAPABILITY-AUDIT.md`, `source-research.json`: inspected application code and classification, public release visibility limitation.
- `DESIGN.md`, `PLAN.md`: visual composition, object purpose, motion/responsiveness, ownership and lifecycle.
- `GALLERY.md`: original rendered screenshots and recordings.
- `visual-evidence.json`: viewport, overflow, page errors and native screenshot dimensions.
- `studio-WIDTH-{hero,desk,full}.png`: required 390×844, 768×1024, 1440×1000, 1920×1080 plus 320px.
- `studio-1440-focus-OBJECT.png`: all six independent inspections.
- `studio-WIDTH-focus-{thought,studio}.png`, `studio-390-focus-content.png`: responsive focus and readable details.
- `motion-{lift,expansion,fully-open,return}.png`, `motion-evidence.json`: actual native-render frames and sampled real matrices/rectangles. Separate transitions prevent screenshot readback interfering with a subsequent intermediate capture.
- `studio-1440-exploration.webm`, `studio-390-exploration.webm`: continuous browser motion; desktop raw pointer input and mobile native touch taps; no edited slides. `recording-evidence.json` logs interactions; video metadata is in `video-metadata.json`.
- `performance.json`, `PERFORMANCE.md`: headless rAF sample method/results and explicit limitations.
- `preservation.json`, `preservation-before.json`: 98 existing source/dependency files unchanged.
- `changed-files.json`: exact new source/test/font file inventory with hashes.
- `extra-verification.json`: all six objects inside desk at five widths, hover response, no idle geometry drift and no-JS reader/download access.
- `CODE-REVIEW.md`, `REGRESSION-NOTES.md`: identified/fixed issues and test evidence.

## Executed command logs (local)

`build.log`, `typecheck.log`, `browser-tests.log` are final gates. `baseline-tests.log` records the existing pre-implementation 110-test baseline. `scroll-after-fix.log` records raw-pointer/native-tap preservation; `scroll-locator-centering.log` and earlier scroll logs document the automated-centering diagnosis and anchor-offset setup issue. `first-motion-test.log` reproduces the perspective-plane hit-target blocker before the fix.

Scripts `capture.mjs`, `verify-extra.mjs`, `record.mjs`, `motion-evidence.mjs`, `profile.mjs` reproduce the different evidence classes against the production export served at localhost:3004. Do not run other website automation browsers concurrently with performance profiling. `python3 artifacts/phase-4b/serve-export.py` serves the current `out/` export.

## Diagnostic, superseded evidence

`initial-*.png`, `initial-focus-*.png`, `programmatic.png`, `probe.png`, `probe.mjs`, `concept-tests-initial.log`, `browser-tests-pre-polish.log`, `browser-tests-before-*.log`, `performance-before-final-scroll-check.json`, `recording-before-raw-pointer.json`, `record-first-attempt.log`, `video-*-check.png` and timestamped `video-*.png` are intermediate diagnostics. They are not the final visual deliverables. Old partial recordings under `raw-video/` are not approved exploration videos.

Screenshots, recordings, logs and baseline CSS copies follow existing local-only ignore rules; Markdown, JSON and reproduction scripts can be versioned later if authorized. No commit or push was performed.
