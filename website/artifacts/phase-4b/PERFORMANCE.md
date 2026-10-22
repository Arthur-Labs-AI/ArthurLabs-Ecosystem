# Phase 4B performance investigation

## Method and scope

One isolated headless Chromium browser, sequential disposable contexts, desktop 1440×1000 and phone 390×844. No other website test/capture/recording browser ran during the profile. The wider host was shared with unrelated applications/jobs, which were not stopped or modified.

Each sample drives real native scrolling through the same film interval using requestAnimationFrame for four seconds. Browser RAF intervals, Long Task entries and CDP Performance metric deltas are preserved in `performance.json`. Diagnostic modes: idle, film scroll, header backdrop-filter disabled, SVG hidden, normal repeat. Visibility/filter overrides occur only inside disposable pages and do not ship.

`main-thread-trace.json` is the raw local Chrome DevTools trace; `trace-summary.json` aggregates named events. The desktop official **normal** sample included tracing overhead. Compare the untraced repeated normal samples for a more comparable route observation. Programmatic `scrollTo` can flush pending layout: the trace's largest FunctionCall names the diagnostic driver's `frame`, not proof of a production-JS function bug. Event totals can overlap/nest and must not be summed into one frame budget.

## Results

| Untraced normal repeat | Median RAF interval | p95 |
| --- | ---: | ---: |
| Concept / desktop | 33.3 ms | 66.6 ms |
| Official / desktop | 33.4 ms | 66.6 ms |
| Concept / phone | 33.4 ms | 66.7 ms |
| Official / phone | 33.3 ms | 33.4 ms |

Idle medians were 16.7 ms. The traced official desktop first sample was substantially slower (66.7 ms median / 183.4 ms p95), so it is disclosed rather than used as a fair route comparison.

The trace recorded 56 Layout events (~1953 ms cumulative, maximum ~90 ms), 56 UpdateLayoutTree events (~692 ms cumulative) and 105 Paint events (~239 ms cumulative) in the sampled window. The largest Layout events mark document-level layout with roughly 65–68 dirty objects. This establishes significant style/layout work in this test, not that one application/runtime process caused it.

Disabling the header blur did not establish a consistent improvement over warmed normal repeats. Hiding the SVG improved some intervals, but layout totals remained large and comparisons varied. Neither diagnostic proves the new header is cost-free or the sole cause of slower frames.

## Targeted optimization probes

`optimization-probe.json` compares normal rendering with skipped identical attribute writes and visual-stage layout/paint containment. Roughly 96–97% of measured attribute assignments repeated the current value, but eliminating them did not consistently improve warmed frame intervals/layout duration.

`dom-probe.json` additionally skips identical textContent writes. Desktop normal repeat was 33.4 ms median / 83.4 ms p95; guarded repeat was 33.3 / 66.6. Phone normal and guarded repeats were both 16.7 / 33.4, and layout duration did not consistently fall. The cold guarded desktop sample was worse (50 / 166.8). These results do not justify a smoothness claim or promoting a prototype patch into the approved film.

**No animation source or geometry optimization was promoted.** Containment and setter overrides remain diagnostic-only. The actual production film retains its approved timeline, camera and reversible transitions.

## Open acceptance concern

Smooth animation on representative hardware is **UNVERIFIED**; these samples do not establish 60 FPS. Phone-sized headless viewport is not a physical phone. Safari/Firefox GPU/backdrop behavior is also unverified. Before performance approval, profile native user-driven scrolling on target desktop/mobile hardware and examine forced layout and SVG foreignObject rendering with a stable host budget. Functional tests and visually correct endpoints do not close this concern.

## Native wheel control measurement

A second **isolated** browser run (`profile-wheel.mjs`) sends 40 actual Playwright wheel inputs with 50ms gaps through the same .20 → .80 range. Its RAF sampler only reads timestamps; it never calls scrollTo or reads layout per frame. One initial seek/settling happens before each measured sample. This distinguishes user-input behavior from the RAF scrollTo stress driver's synchronous-layout cost.

| Native wheel / normal glass | Median RAF | p95 RAF | End progress |
| --- | ---: | ---: | ---: |
| Concept / desktop | 16.7 ms | 33.4 ms | .800 |
| Official / desktop | 16.7 ms | 33.3 ms | .800 |
| Concept / phone viewport | 16.7 ms | 16.8 ms | .800 |
| Official / phone viewport | 16.7 ms | 16.8 ms | .800 |

Normal official LayoutDuration was ~471ms desktop / 385ms phone viewport over each input window, versus ~361ms / 266ms with header blur disabled. The disabled sample follows the normal sample, so warm-up/order and host variance prevent attributing all of that difference to blur. Desktop p95 remained 33.3ms with blur disabled. There is no established material official-route regression relative to the reference concept in these matched normal-input samples.

The native-wheel results are encouraging and show the programmatic stress driver's cost matters. They **do not** establish delivered compositor FPS or physical-device 60FPS: wheel events have gaps, the sampler includes intervening frames, the renderer is headless, and there is no sustained touch/trackpad hardware campaign. The slow stress/trace results are retained rather than replaced with only favorable measurements. Representative-device performance acceptance remains open.
