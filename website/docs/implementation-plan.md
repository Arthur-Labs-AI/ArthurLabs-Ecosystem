# Phase 1 implementation plan

Scope: reproduce the approved landing prototype in the empty website directory; establish six App Router routes. No application changes, repository restructuring, external services, release claims, commits, or pushes.

Inspected: parent README, repository status/history, empty website directory, complete attached prototype including embedded images and all CSS/script behavior. Baseline: no application or tests exist. Reference copied unchanged into references/.

## Architecture review

1. Source of truth: product metadata in src/lib/products.ts; chapter metadata in the workflow component; approved visual source in references/.
2. Ownership: InteractiveHero owns the selected chapter; ScrollTrigger derives it from scroll progress. Children receive explicit props.
3. Dependencies: App Router pages compose components; components consume stable metadata. No reverse dependencies.
4. Boundaries: server components pass serializable product records to the interactive client hero. No application runtime or internal app data crosses this boundary.
5. Failure: no remote API or font dependency. Screenshots are local. Without JavaScript, the overview and all lower sections/navigation remain readable.
6. Lifecycle: GSAP matchMedia/context creates and tears down ScrollTrigger on mount, viewport preference changes, and unmount. Manual selection persists until scrolling changes the chapter region.
7. Test seams: chapter controls, window buttons, data-scene, route headings, and real browser viewport/media emulation provide deterministic interaction checks.
8. Compatibility: website is empty, so no migration. Reference remains unchanged; rollback removes only new website files.
9. Observability: production build, TypeScript, browser console/page errors, response statuses, screenshots, and interaction assertions.
10. Security: no input submission, authentication, persistence, or added privilege. Only local public assets and internal links.

## Implementation sequence

- Preserve reference and extract its authentic screenshots to optimized public/images WebP assets.
- Establish package/config files and App Router layout. Retain the reference CSS vocabulary and breakpoints, adding targeted accessibility/layout corrections.
- Compose Brand, Navbar, ProductWindow, WorkflowAnimation, InteractiveHero, SuiteSection, ProductShowcase, HardwareTeaser, Footer.
- Establish product/suite/hardware foundations with honest phase status and working navigation.
- Run production build, typecheck, and browser checks; capture and compare desktop/mobile reference and implementation images; record results in docs/verification.md.
