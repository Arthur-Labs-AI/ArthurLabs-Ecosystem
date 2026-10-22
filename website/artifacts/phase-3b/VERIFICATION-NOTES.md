# Verification notes

- Baseline before route/shared edits: 64/66 browser tests passed against the user's development server. Two Landing tests failed: 600px focused-window containment and reduced-motion scrollY assertion. Evidence: baseline-tests.log.
- Initial production run: 68/71 passed. Landing 600px containment reproduced. Reduced-motion Landing passed. Two new product motion tests incorrectly sampled the first static Native Core SVG instead of its animated trace; corrected to sample explicit animated-element geometry, preserving the actual-movement assertion. No application source fix or weakened motion requirement.
- Existing route-foundation assertions now expect the specified product headline on /nexus; /studio and /sentry assertions unchanged.
- No Landing, Suite, global style, motion hook, timeline, diagram geometry, download guard or release catalog changed. File digest inventory captured before edits and compared afterward (before.json, changed-files.json).
- Screenshots are Chromium render evidence, not final human visual approval. Physical touch, assistive technology and Safari/Firefox remain separate verification.
- Final production run on the final built source: **72 passed (4.2m)**, including all six new official-page tests. Both earlier Landing failures passed unchanged. Keep their earlier intermittent observations visible; this milestone did not fix Landing.
- Final build and standalone TypeScript passed. The final image quality prop is explicitly 90, matching the existing Next configuration and the actual q=90 URLs already recorded in screenshot evidence.
