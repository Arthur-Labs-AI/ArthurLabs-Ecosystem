# Phase 4B.1 — material only

Baseline is the pending Phase 4B working tree, not Git HEAD. All existing uncommitted work is preserved. `sources-before.json` captures source/public/tests/root-file hashes before this refinement.

Only expected runtime-source change: `src/components/Navbar.module.css`.

- Keep all dimensions, offsets, border widths/radii, typography, spacing, layout, links, controls and motion behavior byte-for-byte unchanged.
- Darken the base into cool graphite; layer static asymmetric inner reflections and delicate top/bottom edge highlights. Keep the existing fixed blur radius and avoid animated lighting or per-frame updates.
- Use inherited CSS custom properties for extremely subtle environmental reflection colors. Existing official-route `aria-current` and `data-accent` attributes provide context through :has selectors; routing/component code stays untouched.
- Apply the same material vocabulary to denser desktop/mobile disclosure surfaces. Leave product marks, accents, focus states and hit targets unchanged.
- Capture all five environments at 390/768/1440/1920, closed and open, before and after. Compare exact bounding boxes, fonts, paddings, gaps, radius and positions; create review comparisons from original captures.
- Profile actual wheel scrolling over active Nexus Native Core and Sentry film, with two repeats at desktop/phone viewport before and after in isolated browser sessions. Do not claim physical-device FPS from this diagnostic.
- Build, standalone TypeScript and the full existing browser battery; explicit CSS fallback and bright/dark visual checks. Stop for visual approval without committing/pushing.
