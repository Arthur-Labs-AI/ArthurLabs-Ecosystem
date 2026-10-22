# Phase 2B — cinematic polish and animation recovery

Preview: **http://localhost:3000/suite**. Work is local and uncommitted. No push, deployment, application-project change or other product-page work.

## Confirmed diagnosis

The reproducible static behavior was caused by an unconditional short-viewport fallback: `max-height:739px` set `staticMode=true` and CSS removed the sticky scroll reserve. At **1440×700 and 390×667 with normal motion**, there was no active story timeline and every sampled document transform was `none`. This is common in a short browser window or side panel. The original user's browser session was unavailable for inspection, so its exact viewport/preference setting is not asserted.

At **1440×1000 and 390×844**, Phase 2A did initialize GSAP and ScrollTrigger. The document and panels had changing computed transforms during brief handoff intervals. No runtime error, hydration failure or wrong scroll container was reproduced. The old design returned the card to the same dock after each short lift, making much of the progression appear static. There was no hero entrance or supporting-section motion code. Existing tests explicitly expected short screens to be static and did not measure document displacement.

See `diagnosis-before.json`, `diagnose.mjs`, `before-*.png`, and the exact source snapshot in `before-source/`. The new 1440×700 regression failed before the fix at `data-static`: expected false, received true.

## Fix and visual refinement

- Removed height as a reason to disable animation. Normal-motion short viewports now use a compact pinned stage. Reduced motion and explicit Pause still offer a nonanimated manual layout.
- Extracted a deterministic normalized GSAP timeline, driven by native window scroll. The same physical document emerges from Studio, lifts into the foreground, travels to an alternate dock in Nexus, moves into Sentry, returns through Nexus consolidation, and finally docks back in Studio.
- Application captures recede, translate, change depth and enter continuously. Handoff midpoints contain overlapping transformed interfaces, rather than a discrete screenshot replacement. Mobile uses smaller displacements and no perspective rotation.
- Added subtle scene-specific focus regions on the genuine screenshots and a temporary destination outline. Product captures are unchanged and no application state is fabricated.
- Added a staggered three-line headline entrance, application introduction, document reveal, and control entrance. Added scroll-controlled architecture line drawing/flow, restrained product entry and hover/focus states, hardware parallax, and availability entry. All are scoped to Suite and bypassed for reduced motion.
- Replaced generic inspector copy with each frame's contribution: captured constraints/brief, coordinated work, independent QA, consolidated feedback/outstanding work, and updated decisions/next tasks. Illustrative status remains explicit.
- Added normalized timeline and scroll progress attributes for inspection. Chapter selection still seeks the same actual scroll position; previous/next, replay, keyboard, pause/resume and reverse scrolling share that authority.
- Mobile artifact docks remain inside the viewport, with a dedicated lower annotation area and the focus caption below it. Chapter controls retain larger touch targets.

## Modified and created files

Modified:

- `src/app/suite/page.tsx` — Suite-only motion wrapper around existing sections.
- `src/components/suite/SuiteHero.tsx` — entrance targets, preserving title and composition.
- `src/components/suite/SuiteWalkthrough.tsx` — short-height recovery, extracted timeline, frame-specific context, focus/destination layers, measured progress.
- `src/components/suite/StoryControls.tsx` — removes forced disabled manual control on short screens.
- `src/components/suite/story.ts` — scene-specific typed context and steps.
- `src/components/suite/ArchitectureDiagram.tsx` — animated line/flow targets and mobile connectors.
- `src/components/suite/IndependentProducts.tsx`, `SuiteHardware.tsx`, `SuiteAvailability.tsx` — scoped motion targets.
- `src/components/suite/suite.module.css` — compact viewport layout, mobile annotation space, focus/destination and interaction polish.
- `tests/suite.spec.ts` — updates only the superseded short-height fallback expectation. Existing navigation, reverse, pause and reduced-motion assertions remain.

Created:

- `src/components/suite/createStoryTimeline.ts` — normalized visual timeline and distinct handoff paths.
- `src/components/suite/SuiteMotion.tsx` — hero/supporting animation lifecycle with reduced-motion matching.
- `tests/suite-motion.spec.ts` — eight tests measuring real transforms, displacement, crossfade, containment, reversal, entrance and architecture draw.
- `tests/capture-suite-motion.mjs` — repeatable measured captures and browser recordings.
- `artifacts/phase-2b/` — all evidence, before source snapshot, comparisons, measurements and reports.

All 22 protected Landing/shared/config/asset hashes match the original records (`preservation-result.json`). No new dependency or screenshot asset was added.

## How to review

Open `/suite`, keep normal motion enabled, and scroll through the stage. Compare all five scene states and, especially, adjacent frames in each handoff sequence. Chapter buttons seek immediately to the corresponding scroll position; they are navigation controls, not automatic playback. Pause collapses the long story into manual exploration; Enable motion restores its corresponding scroll position. Reduced motion intentionally remains static and selectable.

The full-page image includes the necessary sticky scroll reserve. It cannot show the changing pinned stage at every location. Measured viewport sequences and recordings are the acceptance evidence for that region; reserved height was not removed merely to shorten screenshots.

## Remaining limitations and acceptance

- This is still a conceptual frontend demonstration. Authentic idle captures, including Nexus's unavailable-backend message, remain visible. Relevant genuine task/QA/result captures would improve storytelling without manufacturing supported behavior.
- The physical document is continuous, while its illustrative contents update at frame boundaries. It does not execute or stream an actual task.
- Tiny native interface text is not intended as a usable application replica on a phone; readable external narrative and the transcript carry the explanation. Further product-state capture work should prioritize mobile legibility.
- Chromium automation and agent screenshot inspection are not Safari/Firefox, screen-reader or physical-device acceptance. Those remain unverified.
- Scroll films are evidence of visible progression, not performance benchmarks. Frame pacing was not measured; no 60 FPS claim is made.
- Human visual approval remains required. Recommendation: review the recordings and handoff boards for Phase 2 visual acceptance, then perform cross-browser/device acceptance before production release. Phase 2B stops for approval; no product-page implementation begins.

## Rendered design review

Compared final viewport captures against Phase 2A at 390, 768, 1440 and 1920 pixels. This is agent review; it does not replace the requested human approval.

| Dimension | Observed result |
| --- | --- |
| Composition | Approved editorial hero and one-interface stage retained; no simultaneous stacked hero redesign. |
| Hierarchy | Foreground document leads each handoff; scene-specific inspector explains each workspace's role. |
| Density | Context remains short; tablet/mobile hide the desktop inspector and retain readable scene narrative. |
| Spacing | Mobile caption has a separate bottom row; stage entry/exit lead into transcript and architecture without a blank viewport interval. |
| Proportions | Card size is reduced on desktop and constrained on mobile; background screenshots remain genuine. |
| Typography | Existing sans/editorial serif treatment and chapter titles retained; headline reveal uses transforms, not layout changes. |
| Visual emphasis | Subtle product-colored focus regions identify the prompt/brief, QA area and returned knowledge; destination outline appears during handoffs. |
| Static alternative | Reduced-motion and explicit Pause remain readable and selectable, with both Nexus consolidation and Studio return accessible. |
| Ergonomics | Chapter, transport, return-frame and keyboard controls preserved; motion never supplies the only explanation of the workflow. |

Before/after boards and dense transition boards are generated from actual browser screenshots, not fabricated app imagery. Full-resolution source captures remain alongside them.

## Executed verification — final source

| Gate | Result | Evidence |
| --- | --- | --- |
| Production build | PASS | `npm run build`, Next.js 16.4.2; all eight routes generated successfully. |
| TypeScript | PASS | `npm run typecheck`, `tsc --noEmit`, exit 0. |
| Full browser suite | PASS | `npm run test:e2e`: **38 passed** in 1.0m, Chromium, two workers, production `next start`; `browser-tests.log`. Includes the original 30 tests (one deliberately updated short-height requirement) plus eight motion tests. |
| Normal motion in short windows | PASS | Measured movement at 390×667, 390×844, 768×700, 1440×700, 1440×1000, 1920×1080. |
| Visible handoffs and reverse | PASS | All four paths: changed document positions, changed panel transforms, intermediate opacity, and return to the same positions when reversing; `motion-summary.json`, `motion-measurements.json`, motion tests. |
| Chapter/pause/replay/keyboard | PASS | Existing Suite tests verify actual scroll seeking and native position restoration followed by wheel scrolling. Runtime checks show timeline/scroll agreement at 0.77 for the intermediate Nexus return at all four checked widths. |
| Reduced motion | PASS | Manual layout remains selectable, both return frames accessible; hero/document computed transforms are none. `suite-390-reduced.png` and browser tests. |
| Viewport continuity | PASS | Four-width entry, dense handoff, reverse and exit captures reviewed. No nonzero pinned-stage offsets during sampled active range, no horizontal overflow or uncontained document samples; story/architecture remain visible through the exit. |
| Browser runtime | PASS | `runtime-check.json`: no page errors or console errors at 390×667, 768×1024, 1440×700, 1920×1080. Four capture sessions also report no page errors. |
| Landing preservation | PASS | All 22 protected hashes unchanged. **390px and 1440px Landing screenshots pixel-identical** to Phase 2A; `landing-comparison.json`. Existing Landing browser tests pass. |
| Videos | PASS | VP9 WebM validated by ffprobe: desktop 1440×900, 19.48 seconds; mobile 390×844, 19.40 seconds. Forward and reverse scroll; source frames inspected in `film-strip.jpg`. |
| Rendered visual comparison | PASS (agent review) | Before/after boards, scene/section sheets at all four widths, dense adjacent transition captures, and recording frame strip inspected. Human approval remains open. |
| Lint / formatter | UNVERIFIED | No configured repository lint/format command. No new tool/dependency introduced. |
| Safari/Firefox, physical devices, assistive technology, DPR 2/frame pacing | UNVERIFIED | Not executed in this milestone; do not infer these from Chromium results. |
| Human visual approval | UNVERIFIED | This is the requested stopping point before further development. |

An intermediate 36/38 run exposed a test parser issue (`strokeDashoffset` has a CSS unit) and a five-second readiness deadline during browser initialization. The parser now uses `parseFloat`; readiness awaits the actual initialized state with a 15-second deadline. The visual displacement/reversal assertions were not weakened. The focused eight motion tests and final complete 38-test run pass.

### Measured first handoff

Distance is the document's bounding-box displacement from normalized progress 0.185 to 0.240, not a frame-rate measurement.

| Width | Displacement | Timeline progress | Interface opacity at midpoint (outgoing / incoming) |
| --- | --- | --- | --- |
| 390 | 68.2px | .185 → .240 | .451 / .349 |
| 768 | 184.6px | .185 → .240 | .4514 / .3486 |
| 1440 | 269.5px | .185 → .240 | .450 / .350 |
| 1920 | 316.3px | .185 → .240 | .4497 / .3503 |

All four handoff midpoint positions returned with **0px measured displacement** when revisited in reverse, at each captured width. Across the measured story samples there were no horizontal-overflow, uncontained-document or displaced-pin cases. These are deterministic geometry observations, not performance claims.

## Evidence index

- `suite-1440-scroll.webm`, `suite-390-scroll.webm`: forward/reverse browser recordings.
- `film-strip.jpg`: frames extracted from the final desktop recording.
- `transition-sequence-1440.jpg`, `transition-sequence-390.jpg`: four adjacent frames for each of the four handoffs. Original PNG files retain their full dimensions.
- `suite-WIDTH-capture.png`, `orchestrate.png`, `verify.png`, `consolidate.png`, `return.png`: all five states at WIDTH = 390, 768, 1440, 1920.
- `suite-WIDTH-emerge-1.png`, `emerge-2.png`: Studio document emergence.
- `suite-WIDTH-ROUTE-1.png`, `-2.png`, `-mid.png`, `-3.png`: measured adjacent handoff frames; ROUTE = studio-nexus, nexus-sentry, sentry-nexus, nexus-studio.
- `suite-WIDTH-entry.png`, `exit.png`, `reverse-PROGRESS.png`: entry/exit and reversal evidence.
- `suite-WIDTH-full.png`, `hero.png`, `architecture.png`, `products.png`, `hardware.png`, `availability.png`: full-page and supporting sections.
- `review-sheet-WIDTH.jpg`: compact scene/section review boards.
- `comparison-390-orchestrate.jpg`, `comparison-1440-orchestrate.jpg`, and equivalent `hero.jpg` files: Phase 2A / Phase 2B comparisons.
- `before-1440x700.png`, `before-390x667.png`, `after-1440x700.png`, `after-390x667.png`: reproduced short-window problem and compact normal-motion recovery. Before screenshots remain at Capture because native scrolling could not advance the disabled story.
- `motion-measurements.json`, `motion-summary.json`: actual scroll position, normalized trigger/timeline progress, document rectangle/transform, panel opacity/transforms and pinned geometry.
- `runtime-check.json`, `browser-tests.log`, `preservation-result.json`, `landing-comparison.json`, `source-manifest.json`: runtime, regression and preservation evidence.

To reproduce: use `npm run build`, `npm run start`, `npm run typecheck`, `npm run test:e2e`, then `node tests/capture-suite-motion.mjs`. Generate review boards with `python3 artifacts/phase-2b/make-review-boards.py` (Pillow). The local production preview remains running on port 3000.
