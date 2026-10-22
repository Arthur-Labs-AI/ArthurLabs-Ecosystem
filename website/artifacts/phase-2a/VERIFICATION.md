# Phase 2A verification — 20 October 2026

Scope: local uncommitted `/suite` interactive prototype in `website`. No Git history operation, commit, push or deployment was performed. Source scope is recorded in `source-manifest.json`; unchanged shared files are recorded in `preserved-files.json` and `preservation-result.json`. This is a visual-review milestone, not production acceptance.

| Gate | Result | Evidence |
| --- | --- | --- |
| Production build | PASS | `npm run build`: compiled and prerendered all eight routes successfully with Next.js 16.4.2. |
| TypeScript | PASS | `npm run typecheck`: `tsc --noEmit`, exit 0. Build also passed TypeScript. |
| Production browser tests | PASS | Final `npm run test:e2e`: 30 passed in 41.6s, Chromium, two workers against `next start` at localhost:3000. 19 existing tests and 11 Suite tests. |
| Chapter/scroll agreement | PASS | Return seek to 93%, forward/reverse through all five frames, previous/next, keyboard End, replay; native scroll restoration after pause/manual selection/resume, followed by wheel scrolling. |
| Handoff continuity | PASS | Same connected document element across all four handoffs and reverse; intermediate interface opacity assertions. |
| Responsive layouts | PASS | 390×844, 768×1024, 1440×1080, 1920×1080 tests; full-page/scene captures also at 1440×1000. No horizontal overflow in capture observations. |
| Reduced motion / short mobile | PASS | Reduced-motion chapter and both return-frame controls; 390×667 manual layout; readable transcript. |
| Browser runtime | PASS | No page errors in Suite navigation test or any of the four capture sessions; hydration rendered successfully in Chromium. |
| Existing Landing preservation | PASS | All 22 recorded shared/source/asset/config hashes unchanged. Landing captures at 390 and 1440. Mobile capture is pixel-identical; desktop RGB RMS difference is approximately 0.86/0.82/0.98 out of 255, in animated hero region. Existing Landing tests passed in final run. |
| Screenshot review | PASS (agent review) | Reviewed heroes, scene/supporting-section sheets at four widths, full-page contact sheet and handoff board. Human visual approval remains pending. |
| Lint / formatter | UNVERIFIED | Repository has no configured lint/format command; none added for this prototype. |
| Other browsers / physical devices | UNVERIFIED | No Firefox, Safari, physical touch device, screen-reader or DPR 2 Suite performance acceptance run in this milestone. |
| Human visual approval | UNVERIFIED | Required before Phase 2B begins. |

## Verification history

A regression assertion caught actual resume drift caused by global smooth scrolling. Restoring with native instant scrolling after the sticky layout settles fixes it. The assertion checks actual scroll position, allows under three pixels for ScrollTrigger endpoint rounding, then wheels forward and verifies the Return chapter remains selected.

One intermediate concurrent capture/test run intermittently failed the existing 600px Landing focused-window containment check. The same source passed that check earlier, passed an isolated rerun, and passed the final complete run with capture work stopped. No Landing code or that test's expectations were changed. Treat this as a remaining existing timing sensitivity rather than evidence of a Suite layout change.

## Screenshot evidence

For each width 390, 768, 1440, 1920:

- `suite-WIDTH-full.png`: unaltered full-page capture, including the sticky storytelling scroll reserve. A full-page screenshot cannot represent the changing sticky stage throughout that reserve.
- `suite-WIDTH-hero.png`.
- `suite-WIDTH-capture.png`, `orchestrate.png`, `verify.png`, `return.png`: the four chapters.
- `suite-WIDTH-consolidate.png`: essential intermediate Nexus return frame.
- `suite-WIDTH-handoff-studio-nexus.png`, `handoff-nexus-sentry.png`, `handoff-sentry-nexus.png`, `handoff-nexus-studio.png`.
- `suite-WIDTH-architecture.png`, `products.png`, `hardware.png`, `availability.png`.
- `review-sheet-WIDTH.jpg`: compact scene/section board.

`workflow-scenes.jpg` and `workflow-handoffs.jpg` provide desktop review boards. `suite-390-reduced-motion.png` shows the static return flow. `capture-observations.json` records scene/frame/opacity/geometry observations, overflow and page errors. `landing-pixel-comparison.json` records the baseline comparison.
