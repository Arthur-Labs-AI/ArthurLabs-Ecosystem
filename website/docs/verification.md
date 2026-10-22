# Phase 1 verification — 20 October 2026

Scope: uncommitted website additions on `main`, based on monorepo commit `4555fa4`. Existing website directory was empty. All source, reference, assets, tests, documentation and screenshots are inside `website/`. No application projects were moved, changed, or copied. No commit, push or deployment was performed.

## Gate results

| Gate | Status | Evidence |
| --- | --- | --- |
| Production build | PASS | `npm run build`: compiled successfully; all six requested routes statically generated. |
| TypeScript | PASS | `npm run typecheck`: exit 0, strict checking includes application and browser tests. |
| Packaged application smoke | PASS | `npm run start`, then Chromium tests against the production server on port 3000. |
| End-to-end tests | PASS | `npm run test:e2e`: 11 tests passed. |
| Hydration and browser errors | PASS | Landing smoke test collects console errors and uncaught page errors; both empty. |
| Navigation and images | PASS | Homepage link destinations and anchors resolve, images decode, all six routes return 200; unknown route returns 404. |
| Responsive layout | PASS | Tests at widths 320, 390, 768, 1440, 2560; no horizontal document overflow. Short phone checked at 320×568, including CTA/preview separation. |
| Workflow | PASS | Five chapters, forward/reverse scroll, manual chapter selection, each window selected using Enter, arrow/Home/End chapter navigation. |
| Reduced motion | PASS | Emulated reduce preference removes long sticky story and retains selectable chapter descriptions. |
| Visual comparison | PASS with documented changes | Actual reference and implementation screenshots reviewed at 1440×1000 and 390×844: overview, connected state, suite, all three products, hardware, philosophy, footer. See artifacts. |
| Asset optimization | PASS | Three extracted WebP files total 131,440 bytes, versus 552,697 bytes of original decoded image data. Responsive Next Image variants; no screenshot base64 in React. |
| Separate lint/format gate | UNVERIFIED | No lint/format tool was configured in the empty directory. TypeScript and production compiler ran. |
| Firefox, Safari, real devices | UNVERIFIED | Chromium coverage only; real touch and platform browser checks remain. |
| Screen reader audit | UNVERIFIED | Semantic/keyboard checks executed; no assistive-technology session performed. |

Native builds, database migrations and application integration are outside this website milestone and do not apply. No pre-existing test baseline existed.

## Visual review dimensions

- Composition: preserved hero copy, three layered windows, sticky story, lower section order, product grids and hardware placement.
- Hierarchy: preserved title dominance, serif italic accent, restrained supporting text and primary/secondary CTA treatment.
- Density: reference card counts and desktop/mobile stacking preserved.
- Spacing: reference padding, gaps and breakpoints retained. Tailwind's default line height and paragraph resets corrected after screenshot comparison.
- Proportions: same window aspect ratios, widths, perspective transforms, side clipping on mobile and section shells.
- Typography: same system sans stack, Georgia italic, reference size/weight/letter-spacing values.
- Visual emphasis: same purple Nexus, mint Arthur Studio, green Sentry and dark noise/gradient treatments.
- Empty states: authentic screenshots retained including their actual displayed status; no fabricated app UI.
- Ergonomics: intentional additions are larger chapter targets, a mobile navigation menu, working route links, and selectable reduced-motion chapters.
- Real output: captures from actual production browser render, not component render approximations.

## Intentional differences and limitations

The reference footer's design-concept notices were replaced by concise official-site copy without availability claims. Product links now reach their route foundations. The footer uses the shared brand mark. Short phone screens get a non-sticky introduction to avoid copy/preview collisions. These are implementation improvements, not changes to the visual direction; requester visual acceptance remains pending.

Other routes are intentionally minimal foundations. Workflow text describes a conceptual flow; this site does not connect to the three desktop applications. Hardware remains explicitly concept/prototyping. No downloads or release dates are invented. No deployment or public hosting verification was requested.

## Reproduce screenshots

With the production app running on port 3000, run `python -m http.server 3001 --bind 127.0.0.1` from website/ in another terminal, then `node tests/capture.mjs`. The reference is served unchanged from references/. Captures cover desktop/mobile overview, workflow and every lower landing section.
