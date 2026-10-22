# ArthurLabs website

A self-contained Next.js App Router application. Run commands from this directory; other monorepo applications are not required.

## Local development

Requires Node.js 20.9+ and npm.

```sh
npm ci
npm run dev
```

Open http://localhost:3000.

## Production and verification

```sh
npm run build
npm run typecheck
npm run start
# In another terminal, against the production server:
npx playwright install chromium
npm run test:e2e
```

Routes: `/`, `/suite`, `/studio`, `/nexus`, `/sentry`, `/hardware`, plus `/suite/concept`, `/nexus/concept` and `/sentry/concept`.

Landing, Full Suite and Nexus have implemented product experiences. Studio, the official Sentry route and Hardware remain foundations. The separate Sentry concept contains the Verification Chamber for visual review. Suite and Nexus downloads remain unavailable without verified metadata; the isolated Sentry concept includes a verified Windows release with its requirements and checksum evidence.

## Structure

- `src/app`: routes, metadata, global design styles.
- `src/components`: navbar, hero, windows, workflow, suite, showcases, hardware, philosophy, footer.
- `src/lib/products.ts`: shared product content and screenshot metadata.
- `public/images`: three authentic screenshots extracted from the approved prototype and encoded as WebP (131,440 bytes combined, about 76% smaller than decoded original images). Next Image supplies responsive q90 variants and lazy-loads lower showcases. The DPR 2 quality comparison and measured payload tradeoff are recorded under `artifacts/phase-1.1/`.
- `references/arthurlabs-landing-prototype.html`: unchanged approved source, preserved from the supplied Downloads attachment because the website directory was initially empty.
- `tests/landing.spec.ts` and `tests/polish.spec.ts`: production browser and interaction regression checks.
- `artifacts`: versioned review reports, metadata and reproduction scripts. Generated screenshots, recordings and logs stay local and are ignored; report links to that media require the local evidence directory.
- `docs`: implementation decisions and verification record.

The design retains the reference's system sans-serif typography, Georgia italic accents, palettes, spacing, window perspective, section order, and responsive layouts. No remote fonts or external application runtimes are required.

## Interaction and accessibility

GSAP ScrollTrigger maps scroll progress to overview → Arthur Studio → Nexus → Sentry → connected return flow. CSS interpolates the window transforms and opacity in both directions; GSAP keeps the progress indicator synchronized. Clicking windows or chapter buttons seeks the matching position inside the pinned story; CSS animates the windows while scroll remains the single chapter authority. Arrow keys, Home and End work within chapter controls.

Reduced motion removes sticky scroll progression and animated transforms, while preserving selectable previews and chapter text. Short mobile viewports use a fixed-height, non-sticky introduction with manual controls so content does not collide. Mobile navigation exposes every product route, closes after navigation, and supports Escape, outside-click and focus-leave dismissal. Skip navigation, visible focus indicators, image descriptions, live chapter text, and semantic sections are included.

## Review evidence and limitations

Milestone reports live in `artifacts/`; the latest Sentry report is `artifacts/sentry-phase-4a/REPORT.md`. The last recorded full browser battery passed 87 tests. Reports distinguish verified functionality from conceptual or planned runtime behavior.

Sentry animation frame pacing remains an open performance limitation under the measured shared-host load. Chromium automation does not establish Safari, Firefox, physical-device or screen-reader approval. Concept routes remain separate from official-page visual approval.
