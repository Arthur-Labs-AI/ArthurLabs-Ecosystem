# Nexus Phase 3A.2 — interactive motion and ￼
CONTRACT
Typed client boundary
Inspect ↗
￼
INTENT BOUNDARY
Intent broker
Inspect ↗
￼
CONFIGURATION
Model Registry
Inspect ↗independent downloads

Preview: http://localhost:3000/nexus/concept

Four independent animated demonstrations now extend the approved Phase 3A.1 educational structure. The Hero and final download section also present Nexus as its own desktop/CLI product. The main `/nexus` route has not been replaced. This is a creative review handoff, not release or final product-page approval.

## Implemented

- **Native Core:** a controllable request packet traces an illustrative inspect path across typed client, broker, configuration, native authorization, provider proposal, tool gate, recorded state and UI response. SVG paths draw, nodes receive depth emphasis, and operation/evidence text follows the clock. The optional unsupported-tool proposal returns an explicit refusal. Responsibility selection pauses/seeks the corresponding boundary; CLI remains separately inspectable.
- **Nova:** a large objective becomes requirements, a dependency plan, work units and conceptual worker assignments. Metadata, observations, a separate Sentry handoff and findings return are choreographed through evolving node geometry, scale, strokes and packets. The original nine-step input/decision/owner/output/why inspector remains synchronized. Planned/non-runnable is explicit.
- **CCv2:** eleven stable record identities accumulate, regroup, form a reference layer and retain their reduced-history treatments. The substantial original/result ledger and its local GSAP Flip comparison remain. Moving records can be selected to pause and inspect their treatment. No record is arbitrarily deleted; durable mutation stays explicitly disabled.
- **Registry:** fictional requirement matching draws connections, explains exclusions, checks the sample configured connection, reorders candidates and transfers eligible metadata toward a conceptual Nova consumer. Reviewer demonstrates refusal with no fallback. Definition browsing stays separate from requirement evaluation.
- Each experience has its own **Play, Pause, Replay, Previous/Next and step timeline**. There is no autoplay on scroll, continuous page film, forced navigation between demos or idle loop. Reduced motion uses settled manual stages. Controllers initialize before enabling playback and clean up on unmount.

Detailed timing, camera/geometry behavior, mechanisms and factual boundaries: [STORYBOARD.md](STORYBOARD.md), [MOTION-PLAN.md](MOTION-PLAN.md), [SOURCE-NOTES.md](SOURCE-NOTES.md).

## Nexus download experience

The primary purple **Download Nexus** Hero action navigates to the informative download section. **Explore the Engine** remains secondary. A compact local sticky navigation sits beneath the unchanged global header; it adds no bottom overlay across the demos. Hero/local download links share fragment navigation, predictable destination focus and a header inset, with immediate movement under reduced motion.

The release targets Windows, Linux and macOS can be inspected, but are not advertised as supported platforms. The existing website release catalog contains no verified artifact, so the page displays **In Development / Download Not Yet Available**. No version, architecture, installer, installation command or external download URL is fabricated. A secondary link says “Explore Nexus as part of the ArthurLabs Suite.” The independent-app architecture is unchanged; no launcher, fourth frontend or unified installer is introduced.

For future releases, `verifiedNexusReleases` consumes the existing shared release catalog and requires a verified Nexus artifact with version, OS, architecture, format, HTTPS artifact link, filename, evidence and verification timestamp, plus release notes and installation instructions. Only records passing the guard become enabled artifact cards. Optional explicit CLI metadata controls what CLI information is shown; missing CLI metadata does not imply inclusion. Invalid, withdrawn or incomplete records fail closed.

This predicate validates reviewed catalog metadata; it does not download, cryptographically verify or test an installer. Publisher verification and actual installation remain prerequisites before populating the catalog. No real installer was available to test here.

## Files

Modified existing website files:

- `src/app/nexus/concept/page.tsx` — composes local navigation and the final downloads section.
- `src/components/nexus-concept/Hero.tsx` — primary/secondary actions and heading inset; authentic screenshot retained.
- `src/components/nexus-concept/features/NativeCore.tsx` — trace integration and synchronized responsibility inspection.
- `src/components/nexus-concept/features/Nova.tsx` — evolving graph and local controller.
- `src/components/nexus-concept/features/Compaction.tsx` — animated continuity surface alongside the approved ledger.
- `src/components/nexus-concept/features/Registry.tsx` — matching choreography alongside approved inspectors.
- `src/components/nexus-concept/features/data.ts` — Native example wording aligned with the inspect task.
- `src/components/nexus-concept/features/features.module.css` — concept-local anchor inset.

Created:

- `src/components/nexus-concept/motion/useFeatureMotion.ts` — isolated GSAP clock/lifecycle, reduced motion and geometry helpers.
- `src/components/nexus-concept/motion/Controls.tsx` — reusable transport and step controls.
- `src/components/nexus-concept/motion/nativeTrace.ts` — authored source-grounded trace definitions.
- `src/components/nexus-concept/motion/NativeFlow.tsx` — shared map points, progressive paths, packet and evidence panel.
- `src/components/nexus-concept/motion/NovaScene.tsx` — evolving SVG orchestration geometry.
- `src/components/nexus-concept/motion/ContextScene.tsx` — persistent context-record choreography.
- `src/components/nexus-concept/motion/RegistryScene.tsx` — matching, exclusion, ordering and transfer geometry.
- `src/components/nexus-concept/motion/motion.module.css` — isolated responsive visual language.
- `src/components/nexus-download/NexusDownloads.tsx` — reusable distribution view, target selectors and navigation links.
- `src/components/nexus-download/releases.ts` — Nexus metadata contract/guard over the existing catalog.
- `src/components/nexus-download/downloads.module.css` — scoped Hero actions, local navigation and download styling.
- `tests/nexus-motion.spec.ts` — thirteen new motion/download checks.
- `artifacts/phase-3a2/` — plans, storyboard, source evidence, regression notes, verification/capture scripts, logs, screenshots, videos and measurements.

No new dependency. Existing tests were preserved unchanged. `preservation.json` compares **78 baseline source/asset/test/config files**: only the eight allowed concept-specific files differ. Landing, Full Suite, shared navigation/styles, existing release catalog and main product routes match the starting snapshot. Nexus application files were inspected read-only. No Git operation, commit or push was performed.

## Executed verification

Scope: exact source and test hashes recorded in `preservation.json`, website production build on port 3000.

| Gate | Result | Evidence |
| --- | --- | --- |
| Pre-change full suite | PASS | `baseline-tests.log`: 53 passed, 1.1m. |
| Production build | PASS | `npm run build`; `build.log`: compiled, TypeScript and static routes generated. |
| Standalone TypeScript | PASS | `npm run typecheck`, exit 0; `typecheck.log`. |
| Full final browser suite | PASS | `npx playwright test --timeout=90000`: **66 passed, 52.0s**; `full-tests.log`. No skipped tests. |
| Actual motion, all four experiences | PASS in Chromium | New tests sample different intermediate SVG/DOM transforms, positions/dash states, compare endpoints, verify pause freezes progression, replay restarts, manual steps and mobile bounds. |
| Reduced motion | PASS in Chromium | Four manual settled playback paths plus existing concept/Landing/Suite reduced-motion checks. Initial preference is read before enabling controls and checked again when playing. |
| Download navigation/availability | PASS | Hero actions, fragment/focus/visible heading, mobile keyboard sticky CTA, three target states, absent enabled installers, Suite link and complete/invalid/withdrawn metadata fixtures. |
| Existing explanations/inspectors | PASS | Original Nexus tests retained; all nine Nova steps, Native hover/focus/edges, CC ledger identities/treatments/guard, separate Registry inspection and independent state. |
| Responsive renders | PASS as capture/containment checks | 390×844, 768×1024, 1440×1000 and 1920×1080 initial/settled full pages and feature/download crops; `screenshot-evidence.json`. |
| Production browser errors | PASS in captured sessions | No page errors or console errors recorded at the four screenshot widths or completed playback captures. No hydration error observed in these production checks. |
| Complete playback evidence | Captured | Desktop/mobile videos show actual start-to-completion playback of all four examples; five geometry samples per feature/size in `motion-evidence.json`. |
| Protected source preservation | PASS | `node artifacts/phase-3a2/check-preservation.cjs`; no unexpected changes among 78 baseline files. |
| Visual inspection | Performed; creative approval pending | Desktop/mobile initial, intermediate and final scenes, download states, and extracted video frames reviewed beyond button assertions. |
| Lint / repository formatting gate | UNVERIFIED | No such script is configured; no lint/format pass claimed. |
| Physical devices, Safari/Firefox, screen-reader review | UNVERIFIED | Chromium with desktop/mobile viewport emulation only. Keyboard semantics tested; no VoiceOver/NVDA acceptance claimed. |
| Real release download/install | UNVERIFIED / unavailable | No verified artifact exists in the website catalog. Metadata fixtures do not substitute for real installer testing. |
| First-time comprehension / creative approval | PENDING HUMAN REVIEW | Watch complete playback and use the questions below before final `/nexus` integration. |

Regression history is retained in `REGRESSION-NOTES.md` and pre-fix logs. An early motion test caught non-moving initial context geometry, and broader checks caught controller-initialization and keyboard-anchor behavior; the implementation was fixed. The final remaining test checked heading position after scrolling to platform controls; that assertion now runs immediately after navigation, before those interactions. Its heading-inset requirement was retained. Existing test files were not changed.

## Media index

- `nexus-1440-complete-motion.webm` — complete desktop examples and download destination.
- `nexus-390-complete-motion.webm` — complete mobile examples and download destination.
- `motion-evidence.json` — actual playback samples, completion, chapter timestamps and recorded frame intervals.
- `motion-{1440,390}-{native,nova,context,registry}-{begin,middle,end}.png` — actual intermediate playback viewport captures.
- `nexus-{390,768,1440,1920}-{initial,settled}-full.png` — full page.
- `nexus-{width}-{initial,settled}-{native-core,nexus-nova,context-compaction,model-registry,nexus-downloads}.png` — clean full-page-derived section crops.
- `before-after-{native,nova,context,registry}.png`, `before-after-overview.png` — prior Phase 3A.1 renders beside actual new playback frames. These compare experience composition, not pixel-identical crop sizes.
- `STORYBOARD.md` — exact authored segment durations and what each movement teaches.

The media shows real DOM/CSS/SVG progression; no video-only animation is substituted and no runtime or provider is called. Camera scrolling is performed by the recording driver between sections. Product animations do not seek page scroll. Step controls are not repeatedly clicked to fake continuous playback. Pause/replay/manual behavior is verified separately in the browser tests.

## Performance observations

`performance.json` measures isolated Chromium requestAnimationFrame intervals over a 4-second active window per feature at both widths, without video recording. Medians were approximately **16.7ms**, with p95 **16.7–16.8ms**. The desktop Native sample had an isolated **49.9ms** maximum; the other desktop samples reached approximately **16.8ms**. Mobile active-window maxima were approximately 16.8ms in that run. These are limited browser/host observations, not a universal FPS, low-end-phone or runtime-performance claim.

Video recording and still capture add substantial overhead. The first desktop capture was taken alongside broad browser checks and had worse intervals; that diagnostic evidence is retained separately in `motion-evidence-under-concurrent-checks.json`. Both delivered walkthroughs were refreshed after the final paint and accessibility corrections, without competing browser checks. Recorded desktop intervals had roughly 33.3ms medians and 49.9–66.6ms p95; mobile medians were roughly 16.7ms. Those capture measurements include encoding/still-capture overhead and occasional stalls. `motion-evidence.json` contains the delivered recording measurements, including any remaining stalls. No frames are fabricated or time-warped to claim smoothness.

There are no new animation dependencies or product-owned idle loops. Each section owns one paused/playing GSAP clock; local geometry is derived from it. The existing CCv2 ledger Flip animation owns a different DOM surface from the continuity canvas. No CSS and GSAP timelines compete for the same transform.

## Rendered review / limits

The graphite/purple identity, typography, existing Hero composition/authentic image and separate editorial sections remain. Diagrams are crisp DOM/SVG, with no enlarged raster background. Planning, execution, verification and refusal have text as well as color. Controls stay in normal flow; the local download navigation occupies a reserved sticky band beneath the shared header.

Mobile uses separate graph geometry and stacked inspectors. It remains a long educational page. Full explanations below a mobile visualization may require pausing and ordinary scrolling. Cards can cross during CCv2 reorganization; direct phase selection provides a settled comparison, and the full record ledger remains inspectable. Videos demonstrate motion rather than provide enough time to read every paragraph.

No-JS rendering retains introductions/default scenes, technical disclosures and download status; interactive demonstrations require JavaScript and transport controls remain disabled until initialized. No production application, task, model, provider, verification or checkpoint is exercised by this website. Native paths are simplified; Nova remains planned; CCv2 durable mutation remains disabled; Registry records are fictional. Source presence is not release availability.

## Review questions and final-page recommendations

Before approving final integration, ask a first-time reader:

1. Where does UI input become a bounded native request, and why is a tool proposal not permission?
2. Why do dependencies, configured roles and returned evidence matter to planned Nova?
3. Which context identities and open work survive representation changes, and why are references/eligibility necessary?
4. Why is a listed model with a missing connection refused? What does Registry supply versus what Nova decides?
5. Which behavior is existing source, which is planned/restricted, and can Nexus actually be downloaded from the current catalog?

For the final Nexus page: retain independent sections and manual controls, reuse the download component with server-validated release metadata, and keep the primary download path informative when artifacts are absent. Obtain creative/educational approval first, then test physical phones, Safari/Firefox and assistive technology before promoting the concept into `/nexus`. Any future artifact publication should coordinate the richer Nexus metadata with the shared Suite catalog and independently verify platform requirements and installers. Do not turn this into a suite launcher or a mandatory continuous scroll film.

No final `/nexus` integration, commit or push is included. Stop here for creative approval.

## Local run

`npm run dev` and open `/nexus/concept`, or `npm run build` followed by `npm run start`. The current local preview uses the verified production build on port 3000.
