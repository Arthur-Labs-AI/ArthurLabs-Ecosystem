# Phase 4B.1 evidence

All files are in this directory. Generated PNGs/logs remain local under the website's existing evidence ignore rules.

## Final visual comparisons

Five environments: `landing`, `suite`, `nexus`, `sentry`, `studio`.

Four widths: `390`, `768`, `1440`, `1920`.

- `ENVIRONMENT-WIDTH-closed-before.png` / `...-after.png`: full original viewport captures with identical scroll position.
- `ENVIRONMENT-WIDTH-open-before.png` / `...-after.png`: desktop Products dropdown or native mobile navigation open.
- `compare-ENVIRONMENT-WIDTH-{closed,open}.png`: labeled side-by-side crops of the original captures at the same scale.
- `material-{390,1440}-{dark,bright}-{blur,fallback}.png`: final normal/fallback material. Bright is a diagnostic underlay in a disposable browser page.

## Exact geometry and scope

- `geometry-before.json`, `geometry-after.json`: measured surfaces and controls.
- `geometry-comparison.json`: exact open/closed match for all 20 page/viewport combinations.
- `style-contract.json`: non-material stylesheet declarations identical.
- `sources-before.json`, `source-preservation.json`: only Navbar.module.css differs from the pending Phase 4B snapshot.
- `file-inventory.json`: complete artifact inventory and the one runtime file changed.

## Final gates and performance

- `build.log`, `typecheck.log`, `browser-tests.log`.
- `fallback-evidence.json`: normal pseudo-layer/menu computed `blur(12px)`; fallback computed `none`.
- `performance-before.json`, `performance-after.json`: two native-wheel samples per route/viewport, Nexus playback active, Sentry film scrolling.
- `performance-ab.json`: final alternating same-browser comparison against actual emitted baseline behavior.
- `performance-root22-ab.json`, `performance-radius-probe.json`, `performance-layer-probe.json`, `performance-single-filter-probe.json`: diagnostic candidates that led to the simpler final filter. Pre-filter-fix samples are archived with explicit names; they are not final production measurements.

Scripts in this directory reproduce the captures, comparisons, geometry/style contracts, fallback emulation and performance samples. Review `REPORT.md` and `REGRESSION-NOTES.md` for interpretation and limits.
