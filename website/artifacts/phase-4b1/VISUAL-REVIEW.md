# Rendered material review

Compared all five requested environments at 390, 768, 1440 and 1920px, in matching closed/open states. Representative side-by-side images are collected in `GALLERY.md`.

- **Composition / proportions:** exact geometry matches for the header, logo, nav items, CTA, mobile controls and open menu. No toolbar reduction or spacing changes.
- **Hierarchy / typography:** source declarations and measured fonts match exactly. The existing Explore/Downloads button treatment and product-mark accents are untouched.
- **Material / emphasis:** the cool charcoal face is darker and less uniform than the former gray wash; asymmetric low-opacity reflection layers provide restrained depth. The upper edge catches more light and the lower edge is quieter. No animated shimmer or neon outline.
- **Environmental identity:** the same material persists across pages. Route-derived reflection colors are intentionally faint, never whole-surface product recoloring.
- **Menu continuity:** the desktop/mobile panels use a denser graphite face. Final 12px diffusion softens competing background detail, while product names/descriptions retain their existing contrast and placement.
- **Bright/dark readability:** normal and fallback diagnostic captures retain readable labels over the real dark environment and a bright underlay. The underlay is a test fixture only. Fallback has a dense base, not transparent glass.
- **Motion / ergonomics:** no new decorative loop or per-frame CSS mutation. Existing touch targets, focus outlines, menu transitions and reduced-motion rules are unchanged and covered by the browser suite.

Human material approval remains pending. Sentry's measured headless p95 cost remains an explicit performance concern, separate from the visual inspection.
