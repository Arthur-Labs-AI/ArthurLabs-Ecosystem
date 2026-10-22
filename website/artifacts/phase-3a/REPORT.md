# Nexus — Inside the Engine / Phase 3A handoff

A separately accessible concept at `/nexus/concept`. The existing `/nexus` page, Landing, Full Suite, shared navigation/styles and application repositories are outside the implementation scope. No commit or push was made. Phase 3A stops for human creative approval.

## Implemented

The hero introduces Nexus with a single sharp, native-aspect desktop interface and the requested “One task. The right intelligence.” headline. It uses a technical purple/near-black identity and a recognizable geometric Nexus mark, rather than the three-window Landing composition.

One persistent seven-node DOM/SVG scene moves through four connected technologies. The bounded interface retreats to reveal typed client/IPC, Rust kernel, broker boundary, SQLite journal and Registry resolution. The diagram's native-authority outline encloses kernel/store, leaving UI, Registry and provider selection outside.

The same tokens become an illustrative Nova dependency graph, then seven pieces of working context, then a fictional model/provider registry. Context flow follows dependency paths. Sentry is a separate dashed verification handoff, not a native-core component. Inspection dialogs explain component responsibilities and evidence limits without permanent sidebar panels.

Before/After and the context range input seek the same native scroll timeline as the chapter controls. All seven example facts persist and show sample content; the compacted layout reorganizes them into grounded context, evidence and open work. No fake compression ratio or lossless-compaction promise is displayed. Model roles deterministically highlight planner→Sample A, coder→Sample B or reviewer→Sample C, with explicit fictional providers/tags/context policies. The route passes through the provider relationship and planned Nova before worker selection; no direct model-to-worker bypass is drawn.

Native scrolling remains authoritative; no wheel interception, timer-driven animation or competing chapter clock. GSAP matchMedia owns timeline/ScrollTrigger cleanup. A native dialog handles Escape/focus containment and restores the selected node's focus. Reduced motion removes the sticky reserve while preserving four readable technology explanations, detailed responsibilities, context comparison and sample Registry controls. A minimal closing link returns to `/nexus`.

## Evidence and truthfulness

Read `SOURCE-EVIDENCE.md` and `source-evidence-hashes.json` for the inspected local source snapshot. No application tests or runtime were executed. This is source review, not a shipped-release audit.

- **Native Core:** Rust kernel/store/daemon/client/CLI/broker modules exist; execution scopes remain bounded and are not universally enabled by this website.
- **Nova:** inspected manifest is planned, non-selectable and non-runnable. The graph is explicitly illustrative.
- **CCv2:** SafePointDetector, checkpoint and provenance/content-seal primitives exist. Durable mutation is explicitly disabled by the inspected source policy. An integrity seal is not keyed authentication or a guarantee of safety.
- **Registry:** resolver code exists with role/capability/route validation and immutable compiled snapshots. All shown model/provider records and matching policies are fictional; no live model data, prices, context sizes or credentials are used.

## Production files

New route: `src/app/nexus/concept/page.tsx`.

New isolated components/content/styles under `src/components/nexus-concept/`:

- `Hero.tsx`: product reveal and authentic interface.
- `Engine.tsx`: native-scroll lifecycle, chapter/inspection controls and persistent architectural scene.
- `createEngine.ts`: one reversible geometry/depth/context-flow timeline.
- `content.ts`: chapter copy, responsibilities, seven context facts and deterministic sample-role data.
- `ContextComparison.tsx`: reusable timeline-seeking control and static comparison.
- `RegistryExplorer.tsx`: sample role control and accessible reference explorer.
- `Reference.tsx`: all four technology explanations, scope distinctions and closing link.
- `engine.module.css`: scoped responsive visual system.

New `tests/nexus-concept.spec.ts` covers all supported viewports and interactions. No existing test expectations were changed. Planning, evidence, captures, recordings and reproducible scripts are in `artifacts/phase-3a/`.

## Verification and visual review

Baseline before implementation: **39 existing browser tests passed** (`baseline-tests.log`). New focused tests passed after adding compact-camera movement and correcting test selectors to account for accessible-name whitespace. The camera assertion originally exposed that the compact scene stayed at an identity transform; a small 2% pullback now gives tablet/mobile a lighter but real camera transition.

Final checks ran against the production build. `source-manifest.json` scopes the source files.

| Gate | Result | Executed evidence |
| --- | --- | --- |
| Baseline browser suite | PASS | `npx playwright test` before implementation: 39 passed in 23.2s (`baseline-tests.log`) |
| Production build | PASS | `npm run build`: all ten pages generated, including `/nexus/concept` and preserved `/nexus` (`build.log`) |
| TypeScript | PASS | `npm run typecheck` (`typecheck.log`) |
| Full browser suite | PASS | `npx playwright test`: **50 passed in 43.0s**, including 11 new Nexus tests (`browser-tests.log`) |
| Navigation / hydration-console smoke | PASS | `node artifacts/phase-3a/smoke.mjs`: no page/console errors or broken local links; four reference chapters without JavaScript (`smoke.json`) |
| Preservation | PASS | All 50 pre-existing website source, asset and configuration hashes unchanged (`preservation.json`) |
| Rendered visual inspection | PASS | Hero, four held technologies and midpoints at 390/768/1440/1920; short 390×667 and 1440×700/900 regression checks |
| Separate lint command | UNVERIFIED | No separate lint script is configured; no lint-pass claim |
| Real-device / Safari / Firefox performance | UNVERIFIED | Chromium only in this environment |
| Final creative acceptance | UNVERIFIED | Awaiting user review; Phase 3A stops here |

Short-desktop regression checks first demonstrated an overlap: the opening interface reached above the heading at 700px and 900px heights. The interface is now sized by both architectural-canvas dimensions using container units, preserving its native aspect ratio. Both tests pass without weakening the heading/footer clearance assertions. `opening-regression-before.log` preserves the original failures. Source hashes scope the checks. The diagram has no blank handoff: the bounded interface overlaps the initial boundary reveal, and every later phase retains the same seven nodes. Rendered screenshots and extracted recording frames are inspected in addition to tests; final visual approval remains the user's decision.

## Visual storyboard and evidence

`PLAN-AND-STORYBOARD.md` defines the four-act composition and ten architecture decisions before implementation. `four-chapter-storyboard.png` combines actual held Native Core, Nova, CCv2 and Registry screenshots. `desktop-motion-strip.jpg` and `mobile-motion-strip.jpg` contain frames extracted from actual recordings.

For each of 390, 768, 1440 and 1920px, `nexus-{width}-hero.png` and `nexus-{width}-full.png` show the page. Main workflow screenshots are named `native`, `nova`, `context-before`, `context-after`, `registry`, and `unified`; `opening`, `native-nova`, `nova-context`, `context-transform`, and `context-registry` capture transition midpoints. Additional images show Registry selection, inspection dialogs and reduced motion. `nexus-1440-dpr2.png` preserves the high-density hero evidence.

`nexus-1440-workflow.webm` and `nexus-390-workflow.webm` record the actual continuous film forward, a sample-role selection and inspection, then reverse scrolling. They are not slideshows. `browser-evidence.json` contains sampled geometry/progress/transforms and recording frame intervals.

## Run locally

From `/home/kaloyan/Projects/Arthur Labs Ecosystem/website`, run `npm run dev` and open `http://localhost:3000/nexus/concept`. Production preview: `npm run build`, then `npm run start`. Run `npm run typecheck` and `npm run test:e2e` with that preview running. Capture script: `node artifacts/phase-3a/capture.mjs`.

## Remaining limitations and next page recommendations

- Concept approval is pending. This milestone does not replace `/nexus` or claim Phase 3 is complete.
- Native source components are not proof of a fully enabled/shipped runtime. Nova is planned and durable CCv2 mutation is disabled in the inspected snapshot. Recheck these facts against the intended release before promoting this page.
- Diagrams abstract implementation boundaries; they are not request traces or live task/agent output. Seven sample context facts are explanatory, not a real entire execution history.
- Interface text remains bounded by the authentic raster source. Technical interactions use crisp DOM/SVG and do not depend on reading miniature screenshot controls.
- Real-device Safari/iOS, Firefox and hardware-accelerated performance remain unverified. Headless frame intervals are reported without a 60-FPS claim.
- The complete Nexus page should separately design Engineering Mode, CLI/Desktop, Sentry integration, verified downloads, compatibility, documentation and installation. Those sections were deliberately not implemented here.

## Measured frame pacing

Actual headless Chromium rAF intervals at DPR1 during native scrolling. These measurements do not establish sustained 60 FPS or real-device performance. Recording/software-rendering overhead may contribute to the difference; that is an inference, not a diagnosed cause.

| Viewport | Without recording: median / p95 / maximum | With recording: median / p95 / maximum |
| --- | --- | --- |
| 1440×1000 | 16.7 / 33.4 / 116.7 ms | 33.3 / 50.1 / 200.1 ms |
| 390×844 | 16.7 / 16.8 / 66.7 ms | 16.7 / 16.7 / 33.4 ms |

Desktop recording drops frames; unrecorded scrolling also has occasional longer frames. Mobile was steadier in this environment. The desktop and mobile recordings are approximately 46 seconds each, showing continuous forward motion, Registry selection/inspection and reverse motion. No autoplay loop, particle system, WebGL engine or additional animation dependency was introduced.

## Rendered design review against the brief

| Dimension | Rendered assessment / remaining review |
| --- | --- |
| Composition | Single Nexus reveal followed by one architectural canvas; distinct from Landing's three-window composition and Suite's cross-product film. |
| Hierarchy | Large product headline and authentic interface lead; technical chapters and source-status labels follow. |
| Density | Seven persistent components/facts; dedicated compact coordinates at tablet/phone widths. |
| Spacing | Held nodes clear headings/footer; opening interface is bounded at short desktop heights. Regression checks retain clearance assertions. |
| Proportions | Native image aspect ratio retained; both canvas dimensions bound the architectural interface plane. |
| Typography | Clear sans headings and technical mono labels. Phone example payload text is intentionally compact; full explanations remain available through inspection/reference. |
| Emphasis | Purple highlights Native Core and selected sample model/route; external Sentry handoff is dashed. |
| Empty-state honesty | No live task status, model output, scores or real provider availability. Planned Nova and disabled durable CCv2 are explicit. |
| Ergonomics | Nodes/controls have at least 44px targets; native slider/keyboard/dialog semantics; Escape and focus restoration verified. |
| Visual evidence | Four viewport widths, four held chapters, transition midpoints, actual recording frames and DPR2 capture reviewed. Human approval remains pending. |

During spatial reorganization some paths and node surfaces cross briefly; held positions stay separated and readable. These transitional overlaps, compact phone typography and pacing should be part of the final human motion review rather than being hidden by static screenshots. This is a concept awaiting creative acceptance.

## Review links

- 390px: [Hero](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-390-hero.png>) · [Full page](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-390-full.png>) · [Native Core](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-390-native.png>) · [Nova](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-390-nova.png>) · [CCv2](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-390-context-after.png>) · [Registry](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-390-registry.png>)
- 768px: [Hero](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-768-hero.png>) · [Full page](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-768-full.png>) · [Native Core](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-768-native.png>) · [Nova](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-768-nova.png>) · [CCv2](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-768-context-after.png>) · [Registry](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-768-registry.png>)
- 1440px: [Hero](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-1440-hero.png>) · [Full page](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-1440-full.png>) · [Native Core](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-1440-native.png>) · [Nova](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-1440-nova.png>) · [CCv2](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-1440-context-after.png>) · [Registry](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-1440-registry.png>)
- 1920px: [Hero](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-1920-hero.png>) · [Full page](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-1920-full.png>) · [Native Core](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-1920-native.png>) · [Nova](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-1920-nova.png>) · [CCv2](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-1920-context-after.png>) · [Registry](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-1920-registry.png>)

[Four-chapter visual storyboard](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/four-chapter-storyboard.png>) · [Desktop recording](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-1440-workflow.webm>) · [Mobile recording](</home/kaloyan/Projects/Arthur Labs Ecosystem/website/artifacts/phase-3a/nexus-390-workflow.webm>)
