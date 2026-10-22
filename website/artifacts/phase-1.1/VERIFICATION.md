# Phase 1.1 verification — 20 October 2026

Scope: ArthurLabs website only, uncommitted. Production preview: http://localhost:3000. No application projects or other worktrees changed. Approved prototype and Phase 1 review evidence preserved.

## Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Production build | PASS | `npm run build`: compiled and generated all six requested routes. |
| Strict TypeScript | PASS | `npm run typecheck`: exit 0, run after the final test synchronization adjustment. |
| Production browser suite | PASS | `npm run test:e2e`: **19 passed**, 29.4 seconds, final run against port 3000. |
| Hydration, images and navigation | PASS | Existing production smoke test: no browser console/page errors, decoded images, working route and anchor destinations. |
| Mobile chapters | PASS | Capture, Execute, Verify and Connect at 320/390/600px; caption/control separation, image containment, no text truncation or document overflow. Geometry checks await finite CSS animation completion. |
| Chapter/scroll synchronization | PASS | Connect from top seeks >80% story progress; subsequent forward wheel retains Connect; reverse scrolling visits Verify, Execute, Capture and Overview. Keyboard End/ArrowLeft tested. |
| Mobile navigation | PASS | Destination selection, Escape, outside pointer; focus returns to toggle on Escape, same-page heading after anchor navigation and route heading after route navigation. Menu closes. |
| Reduced motion | PASS | Chapters remain selectable without scroll seeking or sticky scroll trap; captions and controls retain clear spacing. |
| Portrait tablet | PASS | 768px full-width product images, two-line Sentry heading, wider single-column suite cards. |
| Hardware annotation | PASS | 390px side insets and clearance below the transformed ring's bounding box. |
| Visual review | PASS for sampled Chromium renders | Fresh full pages at 1440/1920/768/390 plus 600px, all four workflow states, section crops, DPR 2 at 1440/390. Compared against original review captures. |
| Desktop design preservation | PASS | `desktop-fidelity.json`: hero copy, H1, visual stage, suite, all product sections, hardware and philosophy bounding boxes have **0px delta** at 1440 and 1920 from the Phase 1 baseline. |
| Image-quality evaluation | PASS | DPR 2 q75/q90 browser crops inspected. Same-format Nexus sample increases 8,064 bytes, with reference PSNR 41.996 → 43.523 dB. Chosen q90 with original screenshot assets unchanged. |
| Cross-browser / real devices | UNVERIFIED | Firefox, Safari and physical touch devices not tested. |
| Screen reader / sustained FPS | UNVERIFIED | Keyboard and reduced-motion checks executed; no assistive-technology or sustained frame-pacing session. |

No additional lint tool is configured. No new dependencies were added. A final source build is distinct from these browser assertions; both ran successfully. No commit, push or deployment was performed.

## Measured mobile geometry

From `measurements.json` at 390 × 844:

- Each active caption ends at y=768.19px; controls begin at y=782.19px: **14px clearance**.
- The selected Studio/Nexus/Sentry preview has about 59px clearance above the caption and stays inside viewport edges.
- Connect's labels sit above the window chrome; background previews retain deliberate side clipping.
- Horizontal document overflow: 0px in all captured states.

At 600px the caption/control gap is also 14px, with about 19.45px clearance below the selected preview. Capture metrics use settled animation states.

## Screenshots

| Width | Full page | Overview | Connect |
| --- | --- | --- | --- |
| 1440 | [Full](landing-1440-full.png) | [Hero](landing-1440-overview.png) | [Workflow](landing-1440-chapter-4.png) |
| 1920 | [Full](landing-1920-full.png) | [Hero](landing-1920-overview.png) | [Workflow](landing-1920-chapter-4.png) |
| 768 | [Full](landing-768-full.png) | [Hero](landing-768-overview.png) | [Workflow](landing-768-chapter-4.png) |
| 390 | [Full](landing-390-full.png) | [Hero](landing-390-overview.png) | [Workflow](landing-390-chapter-4.png) |

Additional evidence: [mobile before/after](comparison-390.jpg), [desktop before/after](comparison-1440.jpg), [tablet Sentry](landing-768-sentry.png), [full mobile hardware section](hardware-390-section.png), [menu destination](menu-destination-390.png), [DPR 2 quality comparison](quality-comparison.png), [1440 DPR 2 overview](landing-1440-dpr2.png), [390 DPR 2 overview](landing-390-dpr2.png).

The sticky hero's scroll reserve is visible in full-page captures; viewport state captures show the actual scroll-driven experience.

## Files changed in this phase

- `src/components/InteractiveHero.tsx`: single scroll authority, chapter seeking, reduced/short-layout fallback, initialization gating.
- `src/components/WorkflowAnimation.tsx`: chapter positions, metadata grouping, readiness.
- `src/components/Navbar.tsx`: dismissal, indicator, focus behavior.
- `src/components/ProductWindow.tsx`: readiness and q90 responsive image variants.
- `src/components/ProductShowcase.tsx`: q90 and tablet-aware image sizes.
- `src/app/globals.css`: mobile metadata rows/containment/transitions, portrait tablet products/cards, hardware spacing, narrow-phone CTA fit.
- `next.config.ts`: allowed image qualities.
- `playwright.config.ts`: optional alternate local base URL.
- `tests/landing.spec.ts`: await enabled control before keyboard focus; existing expectations retained.
- `tests/polish.spec.ts`: eight regression checks, including all four chapters at three mobile widths.
- `tests/capture-polish.mjs`: reproducible captures.
- `README.md`, `docs/phase-1.1.md`: current behavior, decisions and usage.
- `artifacts/phase-1.1/`: captures, quality measurements, geometry evidence and this record.
