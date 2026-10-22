# Phase 1.1 — visual polish and interaction fixes

## Scope and plan

Read the full `artifacts/visual-review/REVIEW.md`, measured geometry, workflow captures and reference comparisons. Preserve the approved desktop identity and section order; fix three interaction issues, refine portrait tablet/mobile layout, evaluate DPR 2 screenshot rendering. Other routes remain foundations. No application projects, commits, pushes or deployment are involved.

Root causes and changes:

1. Mobile caption and controls used independent absolute offsets; larger controls overlapped the caption. `WorkflowAnimation` now groups metadata, and the mobile CSS uses two natural-height rows with a 14px gap. Selected previews are centered, bounded, and positioned above the caption; background windows retain their intentional layering. Mobile labels move clear of the title bars.
2. Manual scene selection was a separate writer from scrolling. `InteractiveHero` now seeks the chapter's scroll position and lets ScrollTrigger derive both chapter and progress. Seeking is instant inside the pinned viewport; existing CSS transitions animate the windows. No timer lock, scroll tween, extra animation dependency, or stale manual chapter remains. Non-sticky short-phone/reduced-motion layouts select chapters without seeking. Controls remain disabled until initialization completes, preventing an early click from being overwritten by the initial ScrollTrigger refresh.
3. Native details stayed open after link activation. `Navbar` now closes on destination selection, Escape, outside pointer and focus leaving the menu. Escape restores toggle focus; same-page navigation focuses the destination heading without overriding scrolling; route navigation focuses the new page heading. Expanded state and the plus/minus indicator follow the native details state. Modified clicks preserve browser behavior.
4. The desktop product/card layout persisted down to 761px. Between 761–900px, product sections now stack with a full-width screenshot and balanced two-line headings; suite cards use wider rows. Layouts above 900px retain the existing hierarchy.
5. The hardware annotation intersected the rotated illustration and met the viewport edge. Mobile art now has 6% side insets and room below the unchanged ring for the annotation.
6. Next Image's default q75 softened interface microcopy. Hero/showcase variants now use q90 with explicit allowed qualities and responsive sizes adjusted for the tablet layout. Original authentic screenshot assets remain unchanged.

## Regression evidence

Added `tests/polish.spec.ts` before implementation. All six original regression checks failed against the Phase 1 production page, reproducing mobile overlap/containment at 320/390/600px, stale chapter scroll state, persistent mobile menu, and narrow tablet presentation.

The completed suite also checks reduced-motion no-seek behavior and annotation clearance. Geometry checks await finite CSS animation completion instead of sleeping or passing on intermediate frames. The existing 11 landing checks are retained. The window keyboard test now waits for the initialized control to become enabled before focusing it; Playwright focus itself does not wait for a disabled control to become available. Its keyboard and selected-state assertions are unchanged. `playwright.config.ts` accepts an optional `PLAYWRIGHT_BASE_URL` for alternate local servers; port 3000 remains the default.

A development-server attempt encountered compilation delays. A later production check exposed an early-click initialization race; controls now wait for workflow initialization. Acceptance checks use the production artifact. The broader run caught the hardware annotation's rotated bounding-box intersection; spacing was corrected rather than weakening the test.

## Image-quality evaluation

DPR 2 browser crops: `artifacts/phase-1.1/nexus-q75-dpr2.png`, `nexus-q90-dpr2.png`, and `quality-comparison.png`.

For the same 1920px Nexus rendition requested as WebP:

| Quality | Payload | PSNR against decoded approved screenshot |
| --- | --- | --- |
| 75 | 19,876 bytes | 41.996 dB |
| 90 | 27,940 bytes | 43.523 dB |

q90 adds 8,064 bytes (about 40.6% for this individual rendition) and retains slightly more fine detail. The visual improvement is restrained; it does not make deliberately small application text fully readable at thumbnail scale. PSNR is an image-error measure, not a readability score. AVIF is also enabled and may have different sizes; the measured comparison uses WebP to hold format constant. Source screenshots, content, and colors are unchanged. DPR 2 overview captures at 1440px and 390px are included.

## Files

Modified: `src/components/{InteractiveHero,WorkflowAnimation,Navbar,ProductWindow,ProductShowcase}.tsx`, `src/app/globals.css`, `next.config.ts`, `playwright.config.ts`, `README.md`.

Added: `tests/polish.spec.ts`, `tests/capture-polish.mjs`, this document, and `artifacts/phase-1.1/` evidence. The approved reference and original visual-review evidence remain unchanged.

## Verification

Final command results and screenshot measurements are recorded in `artifacts/phase-1.1/VERIFICATION.md`. Reproduce captures with `npm run start` on port 3000, then `node tests/capture-polish.mjs`.
