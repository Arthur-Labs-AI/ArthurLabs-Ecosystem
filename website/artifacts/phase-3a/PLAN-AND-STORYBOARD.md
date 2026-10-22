# Nexus — Inside the Engine / Phase 3A

## Composition and storyboard
Only `/nexus/concept` is introduced. Existing pages and shared styling stay intact. The reference is the Phase 3A brief and established ArthurLabs identity, not the Suite's layout. Technical evidence is reviewed read-only from `/home/kaloyan/Projects/Nexus`; nothing there is executed or modified.

Hero: oversized precise sans typography, Nexus's geometric diamond, near-black #0D0D12, purple #A57AFF. One sharp native-aspect Nexus interface occupies a broad technical stage with a small “Inside the Engine” entry and four connected technology labels. No three-window composition or raster backdrop. The status on the captured interface remains authentic.

The architectural canvas uses one persistent seven-node scene, a modest depth camera and SVG connections. A compact four-chapter rail seeks native scroll. Node inspection opens a native accessible dialog, rather than introducing a permanent sidebar. The scene's coordinate region excludes titles and controls; tablet/mobile use explicitly fitted geometry. Mobile labels remain actionable at 44px or larger, with no dependence on hovering.

1. **Native Core, 0–.25.** Begin with a bounded authentic interface plane. It retreats slightly, opening a precise cutaway: Desktop UI and CLI → client/IPC → Rust kernel; Registry resolution and broker boundary; SQLite journal. Boundaries are explanatory abstractions, not a running call trace. Interface imagery fades once the DOM architecture is revealed. Native value: explicit execution boundaries and authoritative state outside model text, not invented speed metrics. Source existence does not imply every native path is enabled or shipped.
2. **Nova, .25–.50.** The same geometry opens into objective → planning / decomposition → selection / dependencies / tools → independent Sentry handoff. Task: “Build and test an offline-first task manager.” All task packets are illustrative. Nova is explicitly planned/non-runnable in the inspected manifest. Sentry sits outside the native boundary; no native-core ownership is implied. Inspectable responsibilities explain the dependency graph.
3. **CCv2, .50–.77.** Persistent tokens become objective, decisions, execution state, tool observations, checkpoint, artifact references and unresolved work. The unstructured chronological view reorganizes into grounded checkpoint context plus the working tail. Nothing vanishes. Before/After and a labeled comparison range seek the same native timeline, avoiding a second animation clock. SafePointDetector, provenance and integrity seals are explained from existing primitives. Durable mutation is explicitly disabled; no claim of complete production compaction, perfect retention or compression ratio.
4. **Registry, .77–1.** Context tokens become three clearly fictional models, two fictional providers, Nova and worker selection. Role buttons highlight the deterministic sample tag match and connected route. Registry → Nova → worker selection is an architectural illustration; Nova remains planned. Final hold connects runtime, context and model policy into one system. No live configuration, provider probe, prices, context sizes or credential state.

A compact readable four-chapter reference follows, with reduced-motion access to all explanations and interactive comparison/registry examples. Minimal close links back to `/nexus`. No downloads, Engineering Mode UI or full product page sections are added.

## Ten architecture questions
1. Source of truth: content/evidence records in `content.ts`; one normalized native scroll clock for scene motion; deterministic sample Registry data in a pure selector.
2. Ownership: new Nexus-concept components alone own local selection/dialog state. ScrollTrigger alone drives progress; comparison and chapter controls only seek scroll.
3. Dependencies: route → hero / engine / readable reference; engine → content + pure timeline. No application-source imports or network access.
4. Contracts: typed chapter IDs, node content, role keys, sample model/provider identities and normalized geometry. No secrets, live model objects or application state cross into the website.
5. Failure: absent JS leaves complete readable reference and honest content; images retain alt text. Reduced motion removes the long film and exposes static interactive examples. No provider/API dependency can fail because none is contacted.
6. Lifecycle: GSAP matchMedia/context reverts triggers/timelines on unmount and media changes. Native dialog owns Escape/focus containment; selectors remain local. No global wheel handler.
7. Test seams: sample matching is pure; progress, transforms and geometry are observable; tests seek real native scroll and reverse. No random data or fabricated timestamps.
8. Compatibility: hash every existing src/public/config file before work. Add isolated files only; existing route behavior and full test suite remain gates. Rollback consists of removing this concept route/components.
9. Observability: scoped ready/progress/timeline/chapter attributes plus console/page-error capture; artifacts show actual motion and state.
10. Security: no credentials, external calls, execution, configuration persistence or application authority. Examples are inert and labeled. CCv2 integrity seal is not described as authentication.

## Verification plan
Baseline existing browser suite, production build and TypeScript. New tests: synchronized chapter seeking/manual and reverse scrolling, real geometry/camera/path changes, no blank scenes, same node elements, comparison preserving seven facts, deterministic Registry selection, node inspection/Escape/focus, reduced motion, viewport bounds at 390/768/1440/1920 and short mobile, preserved `/nexus` and Suite/Landing.

Capture hero, all four held chapters and transition midpoints at all four widths. Record continuous desktop/mobile forward and reverse scroll with rAF frame intervals; separately sample unrecorded pacing. Inspect rendered screenshots and extracted video frames. Human creative approval remains outstanding.
