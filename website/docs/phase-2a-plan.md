# Phase 2A — Follow the Idea: bounded implementation plan

Scope: replace only the `/suite` route foundation with a reviewable interactive prototype. All existing Landing Page, navigation, footer, product routes, global styles, image assets and dependency/config files are preserved by recorded SHA-256 fingerprints in artifacts/phase-2a/preserved-files.json. No other monorepo projects are accessed or changed. No commit or push.

Inspected: suite route; global layout/styles; Phase 1.1 hero and its synchronization/readiness fix; product metadata; three authentic screenshots; Next Image configuration; existing browser tests and prior verification documents. Only website documentation is available as architectural evidence; the approved Phase 2A brief is the source for the intended topology. Platform/release/download details are unverified and will not be asserted.

## Architecture review

1. Source of truth: a Suite-only story model defines chapters, frame sequence and normalized scroll destinations. GSAP/ScrollTrigger owns progress while animated; static mode owns the selected normalized position when motion is disabled.
2. Ownership: SuiteWalkthrough is the sole writer of its story state. Children receive typed scene/artifact props. ArchitectureDiagram owns only its selected explanatory node.
3. Dependencies: App Router Suite page composes Suite-only modules; modules consume existing stable product metadata and local screenshot assets. No dependency points back into the Landing Page.
4. Boundaries: only serializable demonstration content, normalized progress and callbacks cross component boundaries. No application APIs, real task data, credentials or operational statuses.
5. Failure semantics: local assets only; intrinsic image sizing preserves layout. Without animation, chapter selection and a complete readable transcript explain every handoff. No network request pretends to execute the demonstration.
6. State lifecycle: scoped GSAP contexts and ScrollTriggers are reverted on unmount, motion toggle and viewport/preference changes. Controls wait for initialization. No timers, automatic playback or background loops are needed.
7. Test seams: chapter buttons, previous/next/replay, normalized scroll and progress attributes, active workspace/frame, motion toggle, reduced-motion emulation and architecture selection.
8. Compatibility: replace the existing minimal Suite page; keep all requested routes. Hash verification protects unrelated existing files. Rollback restores the old Suite page and removes Suite-only modules.
9. Observability: production build/typecheck; browser console and page errors; chapter/scroll assertions; screenshots of full pages, all scenes and transition midpoints at 390/768/1440/1920.
10. Security: no persistence, submission, backend authority or external integration. Links are local verified routes; release/platform details explicitly unconfirmed.

## Implementation

- Suite-specific CSS module; server-rendered hero, independent product showcases, hardware teaser and honest availability panel.
- Scoped client walkthrough: Studio → Nexus → Sentry → Nexus consolidation → Studio, expressed as four chapters and five interface frames. One persistent document element bridges receding/incoming authentic interfaces using reversible GSAP transforms/opacity. Mobile uses reduced perspective and displacement; short/reduced-motion/manual mode removes sticky progression.
- Interactive three-node architecture diagram with only Studio↔Nexus and Nexus↔Sentry connections; all integration claims marked conceptual.
- Regression tests for chapter seek/rail agreement, forward/reverse transitions, Nexus return path, keyboard controls, motion preference/manual mode, responsive layout and Landing Page preservation.

## Design intent

Complement the approved Landing Page with an editorial asymmetric Suite hero and a single immersive interface stage. Preserve sans/Georgia typography, charcoal surfaces, mint/purple/green product accents, restrained borders and generous spacing. Keep every demonstration overlay visually separate from the genuine product captures and explicitly labeled illustrative.
