# ArthurLabs Phase 4B.1 — Liquid Glass material refinement

Scope: refine the approved shared header material while preserving its geometry and behavior. No commit, push, application-repository change, dependency, routing change or cinematic source change.

## Runtime file changed in this milestone

**`src/components/Navbar.module.css` only.** The earlier Phase 4B changes remain pending and intact. `sources-before.json` captures their pre-refinement state; `source-preservation.json` confirms no other source/public/test/root file changed during this milestone.

Generated verification artifacts are under `artifacts/phase-4b1/`: capture/performance/comparison/fallback scripts, original before/after screenshots, geometry/style contracts and this report.

## Material

- Deeper cool charcoal foundation replaces the gray-white frosted fill.
- Static asymmetric internal reflections and soft illumination replace a uniform wash.
- A directional upper specular edge catches light while the lower edge remains quiet.
- The initial 22px multi-filter candidate was simplified after measurements: the final material uses one static 12px blur on the decorative material layer, with no saturation-filter pass. Product hue comes from the very subtle reflection variables, not a full-surface recolor.
- Existing shadow geometry stays at 0/14/38px; shadow density and inset reflection colors are tuned.
- Desktop/mobile disclosure panels share the same graphite vocabulary, with a denser base for readable labels.
- Very subtle reflection variables distinguish neutral Landing/Suite, violet Nexus, forest Sentry and warm Studio. Existing product active attributes are read with CSS :has; no routing/component implementation changed. Browsers without :has retain the neutral default.
- Vendor declarations now place the standard backdrop-filter last. Production inspection found that the earlier ordering was reduced to an unsupported prefixed-only declaration in this Chromium build; the final computed pseudo-layer and menu filters are verified as `blur(12px)`.
- No continuously animated reflection, shader, displacement filter or per-frame CSS update was added. Existing menu transitions/reduced-motion behavior are unchanged.

## Exact preservation

`style-contract.json` compares the parsed stylesheet before/after and verifies that all non-material declarations are identical, including border width/style, type, spacing, sizes, offsets, radii, controls, transforms and transition rules. The new pointer-inert, absolutely positioned :after layer only paints one-pixel reflected edges.

`geometry-comparison.json` compares **20 route/viewport combinations** (five environments × four widths), closed and open. Bounding boxes, computed fonts, padding, gaps, positioning and border radius match exactly. Native closed-details content can retain nonpainted animated boxes, so closed-state comparisons use the actual header controls; open-state comparisons include the entire dropdown. No coordinate tolerance was introduced.

Routes: Landing, Full Suite, Nexus, Sentry, Arthur Studio. Viewports: 390×844, 768×1024, 1440×1000, 1920×1080. All captures use scrollY 0 and disable finite entrance animation during the static screenshot, identically before/after. No page design or animation source is changed by this capture procedure.

## Visual evidence

Original captures: `ENVIRONMENT-WIDTH-{closed,open}-{before,after}.png`.

Side-by-side reviews: `compare-ENVIRONMENT-WIDTH-{closed,open}.png`. These are browser-rendered comparisons of the unmodified original PNGs, with labels above each image and matching scene context. Closed views show the header plus upper Hero; open views show the whole menu. Full original viewport captures remain available beside them.

`material-WIDTH-{dark,bright}-{blur,fallback}.png` covers the menu/header over actual dark Suite and a labeled-in-report bright diagnostic underlay. The bright underlay exists only in disposable browser pages, never in website source.

## Fallback and accessibility

The dense fallback foundation is defined outside @supports. Fallback testing removes backdrop-filter enhancement branches from the browser CSSOM and confirms computed material pseudo-layer and panel filters are `none`, retaining opaque graphite material. This simulates the unsupported CSS branch; an actual legacy rendering engine was not available. Bright and dark captures check label legibility. Product accents and focus outlines remain unchanged.

The functional browser battery verifies route links, keyboard/touch/Escape/outside dismissal, first hydration activation, anchor clearance, reduced motion, menu stacking and existing film interactions.

## Performance

Measured native wheel scrolling with Nexus playback active and Sentry's approved film running. Two samples per route at 1440×1000 and 390×844, before/after, plus alternating same-browser desktop samples. No other website automation browser ran during each performance profile. The wider host is shared; unrelated processes were not modified.

An actual rendering issue was found: the former vendor declaration order was minified to prefixed-only CSS, ignored by this Chromium. Enabling the intended 22px blur plus saturation produced repeatable 33.3ms desktop medians compared with the actual no-blur baseline's 16.7ms. That candidate was rejected.

The final material is simpler: one **12px blur**, isolated on the existing decorative pseudo-layer, without a saturation pass. No page/film implementation was changed to compensate.

| Final alternating desktop A/B | Before median / p95 | After median / p95 |
| --- | --- | --- |
| Nexus, first pair | 16.7 / 33.4 ms | 16.7 / 33.4 ms |
| Nexus, repeated pair | 16.7 / 33.4 ms | 16.7 / 33.4 ms |
| Sentry, first pair | 16.7 / 33.3 ms | 16.7 / 50.0 ms |
| Sentry, repeated pair | 16.7 / 33.4 ms | 16.7 / 50.0 ms |

**A Sentry headless p95 regression remains after simplification.** Median is stable, but performance parity is not claimed. The final separate phone-viewport samples were 16.7ms median; p95 ranged 16.7–33.3ms. These are viewport/RAF diagnostics with wheel-event gaps, not proof of physical-device/compositor 60FPS.

Performance acceptance therefore remains open, especially for Sentry. The fixed material was reduced rather than altering approved animation geometry. Native GPU desktop/mobile profiling is still needed to decide whether the residual cost is acceptable or a stronger performance-oriented material fallback is required. Logs and rejected candidates are retained; favorable samples do not replace the measured regression.

## Build/browser results

| Gate | Result | Evidence |
| --- | --- | --- |
| Production build | PASS | `npm run build`; `build.log`, static routes exported. |
| Standalone TypeScript | PASS | `npm run typecheck`; `typecheck.log`, exit 0. |
| Full existing browser suite | PASS | `PLAYWRIGHT_BASE_URL=http://localhost:3004 npx playwright test --workers=1 --timeout=90000`; `browser-tests.log`: **110 passed (2.8m)**. |
| Exact geometry preservation | PASS | `geometry-comparison.json`: 20 route/viewport combinations, open and closed, exact matches. |
| Non-material CSS preservation | PASS | `style-contract.json`: layout, typography, geometry and interactive styles unchanged. |
| Source preservation | PASS | `source-preservation.json`: Navbar.module.css is the only changed runtime/source file against the Phase 4B snapshot. |
| Normal/fallback material branch | PASS for simulated CSS branches | `fallback-evidence.json`: actual material/menu `blur(12px)` in normal mode, `none` after removing supports enhancements; 8 bright/dark captures. |
| Readability and visual evidence | PASS for inspected Chromium states | 80 original before/after captures plus 40 side-by-side comparisons; `GALLERY.md`. No overflow or page errors in the measured captures. |
| Performance parity | FAIL for Sentry headless p95 | Final alternating A/B retains 16.7ms median, but Sentry p95 is ~50ms vs baseline ~33ms despite the reduced single-filter treatment. Nexus matches baseline. |
| Physical-device GPU/FPS / Safari / Firefox / native legacy fallback engine | UNVERIFIED | Not measured here; no 60FPS or cross-engine claim. |
| Human visual approval | UNVERIFIED / awaiting review | Preview and complete comparison gallery provided. |

There is no dedicated lint/format script in this package. `git diff --check` and direct material-source whitespace checks also pass. Functional/build success does not waive the performance-parity concern.

## Approval and limits

Visual approval remains with the user. Headless viewports are not physical devices; Safari/Firefox, hardware compositor performance and native unsupported-backdrop engines were not exercised. No physical-device 60 FPS claim is made. The source changes are limited to static material layers; existing approved page designs and animation implementations are preserved.
