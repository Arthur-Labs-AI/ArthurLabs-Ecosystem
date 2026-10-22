# Phase 4B visual and verification evidence

All paths below are relative to this directory. PNG/WebM/log files remain local and ignored by Git; reports, scripts and structured measurements are available for later review/commit.

## Navigation

- `header-landing-hero.png`: desktop header over the Landing Hero.
- `header-landing-dropdown.png`: Products menu open above Landing's cinematic layers.
- `header-mobile.png`: phone navigation with all three products.
- `header-{landing,suite,nexus,sentry}-{hero,film,dropdown}.png`: material and stacking across each product environment.
- `header-final-tests.log`: 8 navigation gates passed before Sentry integration.

## Official Sentry

For **390, 768, 1440, 1920** widths:

- `sentry-WIDTH-hero.png`
- `sentry-WIDTH-full.png` — full document capture; the long sticky scroll distance appears as document space, so use film frames/video to judge cinematic composition.
- `sentry-WIDTH-snapshot.png`
- `sentry-WIDTH-half-split.png`
- `sentry-WIDTH-three-harnesses.png`
- `sentry-WIDTH-investigation.png`
- `sentry-WIDTH-convergence.png`
- `sentry-WIDTH-results.png`
- `sentry-WIDTH-downloads.png`

`visual-evidence.json`: exact native film progress/camera transforms; zero page/console errors and no horizontal overflow at all four captured sizes.

## Continuous recordings

- `sentry-official-1440-scroll-through.webm`
- `sentry-official-390-scroll-through.webm`
- `recording-evidence.json`: actual native-scroll samples for forward, reverse and resumed-forward segments. No endpoint simulation replaces the live film.

## Release and verification

- `release-revalidation.json` and `published-release.json`: current-publication receipt, 122864963 streamed bytes, matching SHA256/sidecar/source.
- `build.log`, `typecheck.log`, `full-tests.log`: final executed gates.
- `integration-tests.log`: 22 focused integration tests passed before the full final battery.
- `preservation.json`: byte comparisons for approved content/animation source.
- `performance.json`, `main-thread-trace.json`, `trace-summary.json`, `optimization-probe.json`, `dom-probe.json`: measured intervals, main-thread activity and rejected diagnostic alternatives.
- `PERFORMANCE.md`, `VISUAL-REVIEW.md`, `CODE-REVIEW.md`, `REGRESSION-NOTES.md`: interpretations and remaining limits.

## Additional integration views

- `suite-WIDTH-verified-release.png`: expanded individual Sentry installation/source/checksum details at each capture width.
- `sentry-WIDTH-resources.png`: official documentation/Suite composition.
- `support-evidence.json`: no document or expanded-details overflow at all four widths.
- `video-desktop-split.png` / `video-mobile-investigation.png`: frames extracted from the actual final WebM files for visual inspection.

- `native-wheel-performance.json` / `profile-wheel.mjs`: isolated real-wheel input with a read-only RAF sampler, separate from the programmatic-scroll stress benchmark.
- `hydration-before.log` / `final-fix-tests.log`: delayed-script regression and the three passing targeted final fixes.
