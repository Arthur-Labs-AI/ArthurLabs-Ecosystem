# Phase 5A performance observations

Final production export, Chromium headless; 1440×1000 and 390×844. Two repeated samples each. Actual thought and authentic-interface open/return interactions; native rAF deltas retained only during lifting/opening/closing. No video encoder or other website automation browser was running during this profile. The host is shared; unrelated processes were not stopped.

| Viewport / repeat | Frames | Median | p95 | Maximum | >50ms | Running CSS after settling |
| --- | --- | --- | --- | --- | --- | --- |
| 1440×1000 / 1 | 158 | 16.7ms | 33.4ms | 33.4ms | 0 | 0 |
| 1440×1000 / 2 | 155 | 16.7ms | 33.4ms | 50.1ms | 2 | 0 |
| 390×844 / 1 | 202 | 16.7ms | 16.7ms | 33.3ms | 0 | 0 |
| 390×844 / 2 | 201 | 16.7ms | 16.7ms | 33.4ms | 0 | 0 |

Two finite hover/focus CSS transitions can still be running immediately at Return; after 40 rAF ticks the count is zero in every sample. The independent idle check also compares real DOMMatrix values and element bounds over 30 frames with no drift. There are no decorative loops or wheel handlers in the concept.

Earlier diagnostics (`performance-before-final-scroll-check.json`) recorded desktop medians around 33ms and p95 of 67–83ms. Those results are retained, not hidden; final samples are better but the experiment does not isolate shared-host variation, focus/scroll effects or browser compositing. This is not a controlled before/after optimization claim.

Finite width/height, typography and padding interpolation deliberately cause layout during object expansion; they are candidates for a compositor-oriented refinement after visual direction is approved. The scene remains small DOM/CSS/SVG with existing GSAP, no new 3D framework, shaders, per-frame backdrop blur or idle simulation. Three local WOFF2 files total 157,308 bytes. The screenshot remains the original local WebP, never stretched above native width.

These are JavaScript rAF interval diagnostics, **not** physical display/compositor FPS. The recordings are encoded at 25fps; that is their capture format, not an application frame-rate claim. Physical desktop/phone GPUs, Safari/Firefox and memory/thermal behavior remain unverified. No stable 60FPS or production-performance guarantee is made.