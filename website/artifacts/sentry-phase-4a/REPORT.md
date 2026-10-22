# Sentry Phase 4A — The Verification Chamber

Preview: `/sentry/concept` (production preview at http://localhost:3003/sentry/concept; existing dev server at http://localhost:3000/sentry/concept).

Status: implementation for human creative approval. The official `/sentry` route is unchanged. No commit/push, application mutation, provider invocation or installer execution.

## Implemented

- Premium Sentry hero with authentic eye/S branding, the requested headline and authentic dashboard image. Download anchors reach the individual Sentry distribution center; Explore reaches the actual cinematic film.
- One continuous, reversible GSAP/ScrollTrigger native-scroll clock. A revision enters the Linux runtime, freezes into a manifest-bound snapshot, branches toward selected independent harnesses, expands into private workspaces, exposes illustrative code/evidence, preserves imperfect outcomes and collects separate results in one overview.
- Persistent source/harness/evidence identities. Moving packets and progressively drawn SVG paths carry those identities; convergence is not a merger, verifier, ingestion, deduplication or confidence-scoring pipeline.
- Desktop visual stage occupies 69% of the film, with a synchronized explanatory rail. Phones/tablets use a vertical geometry and stacked full-width explanation rather than a miniature desktop diagram. In-film harness focus makes each private chamber inspectable.
- Select one, two or three harnesses; choose Full/Targeted QA; change selection/scope inside the film without resetting progress. Nonmodal configuration supports Escape/outside dismissal. Chapters seek the same native scroll interval; Replay and Skip remain explicit controls.
- Reduced motion uses manual, settled stages with all nine equivalent explanations available outside the film. Pre-hydration controls are disabled until the controller exists. Invisible final report controls remain inert until their presentation is ready.
- Report inspector exposes originating harness, AgentRun status, evidence/source reference, frozen snapshot and limitations. DeepSeek “Partial output” correctly represents a failed AgentRun with usable evidence, while the parent may be partial. Authored samples are explicitly not live Sentry runs.
- Supporting foundations cover actual harness integrations, Full/Targeted scope, provenance, managed history/cancellation/recovery/exports, authentic fixture UI, supported CLI reference and unavailable native Nexus integration.

## Capability research and current release verification

Read the supplied v1 architecture, assessment, roadmap and prepared release notes; inspect current local coordinator, snapshots, private workspaces, registrations, domain aggregation, schemas, runtime/Desktop/CLI boundaries, persistence, reporting and authentic UI assets. The local feature copy is not assumed identical to current publication. Six core files were fetched at published v1.0.2 source and matched the inspected local files byte-for-byte (`references/source-comparison.json`).

The supplied release preparation documents are historical. GitHub currently publishes stable **v1.0.2** with packaged production CLI for **Windows 11 x64 + WSL2**. Streamed all **122,864,963** ZIP bytes and compared SHA256 against GitHub's asset digest and fetched checksum sidecar. All three match; nothing was executed. Receipt: `references/artifact-verification.json`.

The concept uses the existing `eligibleArtifacts` strategy with additional typed checksum/source/install guards. Its catalog remains isolated until official Sentry/Suite integration is approved; approved pages and their current catalog behavior are unchanged. The published artifact is an **unsigned ZIP with online Linux runtime bootstrap**, not a signed or offline installer. Native Linux Desktop remains deferred; no macOS support is claimed. CLI is verified in v1.0.2, not inferred from older archives.

Full classifications and precise limits: [CAPABILITY-AUDIT.md](CAPABILITY-AUDIT.md). Composition, nine shots, ten boundary answers and file plan: [STORYBOARD.md](STORYBOARD.md).

## Files created

- `src/app/sentry/concept/page.tsx` — server composition/metadata.
- `src/components/sentry-concept/Hero.tsx` — identity, native interface and working anchors.
- `data.ts` — nine explanations, illustrative findings, scope/outcome rules.
- `geometry.ts` — pure camera/chamber/curve interpolation.
- `createChamber.ts` — persistent-node renderer and single scroll timeline.
- `PipelineScene.tsx` — scalable layered SVG/DOM world.
- `ChamberExperience.tsx` — configuration, chapters, motion/reduced-motion lifecycle.
- `Explanation.tsx` — synchronized stage/input/operation/output/benefit/detail.
- `RunReport.tsx` — separately attributable sample result inspector.
- `ScopeComparison.tsx` — interactive Full/Targeted comparison.
- `SupportingSections.tsx` — harnesses, provenance, product capabilities, interfaces and integration boundaries.
- `releases.ts`, `Downloads.tsx` — verified concept metadata and individual download UI.
- `chamber.module.css` — isolated responsive visual/motion styling.
- `public/images/sentry-mark.webp` — actual Sentry mark, lossless WebP (39,016 bytes).
- `public/images/sentry-finding.webp` — authentic documented fixture UI (118,886 bytes, 1783×1062).
- `tests/sentry-concept.spec.ts` — geometry, outcomes, metadata, four viewport sizes, reversal, chapter/report/selection/scope/download, reduced-motion, keyboard/touch, in-film state and responsive reinitialization tests.
- `artifacts/sentry-phase-4a/` — research receipts, plan/audit, screenshots, scripts, recordings and gate logs.

No pre-existing source/public/test file was modified: `changed-files.json` compares complete SHA256 inventories against `before.json`. Existing Landing, Suite, Nexus, generic `/sentry`, shared styling and release catalog remain byte-identical.

## Visual evidence

At each of **390×844, 768×1024, 1440×1000, 1920×1080**:

- `sentry-{width}-hero.png`
- `sentry-{width}-opening.png`
- `sentry-{width}-snapshot.png`
- `sentry-{width}-half-split.png`
- `sentry-{width}-split.png`
- `sentry-{width}-investigations.png`
- `sentry-{width}-partial.png`
- `sentry-{width}-convergence-midpoint.png`
- `sentry-{width}-report.png`, `sentry-{width}-recorded.png`
- `sentry-{width}-downloads.png`, `sentry-{width}-full.png`

`render-evidence.json` records actual path data/dash progress, transforms, packet positions, viewport errors and overflow checks. Full-page captures include the native sticky section's long scroll extent; its blank spacer in a flattened image is not an empty live viewport. Stage captures and continuous recordings are the appropriate evidence for the pinned experience.

Completed continuous desktop/phone recordings and measured performance are listed below. The videos show actual browser scrolling through reverse and forward passes, not endpoint slides.

## Local use

From `/website`: `npm ci` if dependencies are needed, then `npm run dev`; open `/sentry/concept`. Production: `npm run build`, then `npm run start` (or `npm run start -- --port 3003`). No application runtime is needed for this authored demonstration.

## Remaining limitations / official integration recommendations

- Human creative approval remains pending. Successful geometry/browser checks do not establish visual approval.
- All project data, source code, evidence and outcomes in the film are illustrative. No live review, verified bug, reproducible failure or automatic consensus is claimed.
- Native Nexus integration remains unavailable in the inspected native Desktop; supported Sentry external CLI is a distinct boundary.
- Whole-window screenshots are for authentic recognition; fine interface detail is inherently small on phones. The cinematic scene itself uses crisp scalable elements.
- On mobile/tablet the reader can choose the focused private chamber; the full desktop three-chamber panorama becomes a readable vertical layout.
- The report is intentionally an abbreviated, schema-informed explanatory surface, not a replacement Sentry frontend or a complete live report.
- This audit verifies publication, metadata and downloaded checksum; it does not perform Windows installation, WSL provisioning, signing validation, provider campaigns or clean-machine application acceptance.
- Browser automation uses Chromium/emulated touch. Physical devices, Firefox/Safari and assistive-technology audits remain unverified.
- Static verified release metadata is a dated snapshot, not a live release-monitoring service. Official integration should promote reviewed Sentry metadata to the shared release source without affecting Nexus availability or inventing a unified Suite installer.
- Before replacing `/sentry`, obtain visual approval of split/return choreography and mobile explanation density; then retain the concept route as reference, reuse its components, preserve explicit capability statuses and finish cross-browser/device profiling.

## Executed gate results

| Gate | Status | Evidence |
| --- | --- | --- |
| Pre-change browser baseline | PASS | `baseline-tests.log` — 72 passed (2.1m). |
| Final production build | PASS | `npm run build`; `build.log` — compiled, TypeScript checked and all routes statically generated. |
| Final standalone TypeScript | PASS | `npm run typecheck`; `typecheck.log`, exit 0. |
| Complete final browser suite | PASS | `PLAYWRIGHT_BASE_URL=http://localhost:3003 npx playwright test --workers=1 --timeout=90000`; `final-tests.log` — **87 passed (5.4m)**. |
| Sentry motion/responsive/accessibility interactions | PASS | All 15 new tests passed, including real SVG dash/path/camera/packet changes, half states, reversal, persistent identities, selected-only execution, single-clock seeking, tablet navigation clearance, resizing, report inspection, reduced motion, keyboard and touch. |
| Approved page preservation | PASS | Existing Landing/Suite/Nexus tests pass and pre-existing source/public/test hashes are unchanged. |
| Public Sentry artifact availability/integrity | PASS for audited artifact | GitHub publication/metadata, streamed ZIP SHA256, asset digest and checksum sidecar agree. This is not an installation/security acceptance campaign. |
| Human creative approval | PENDING | Review preview, intermediate screenshots and continuous recordings. |
| Physical devices / Safari / Firefox / screen readers | UNVERIFIED | Not exercised here. |
| Separate lint/format command | UNVERIFIED / not configured | No dedicated lint/format script exists in this website package. |

Prior failed/interrupted receipts remain visible rather than being hidden: `full-tests-before-label-fix.log`, `interrupted-host-load.log`, `chapter-diagnostic.json`, `REGRESSION-NOTES.md`, `HOST-OBSERVATIONS.md`. The final complete run passed with all assertions intact and no changes to approved source files. One worker reduced pressure from unrelated host builds; no tests were skipped or expectation weakened.

## Completed recordings and measured motion

- `sentry-1440-scroll-through.webm`: **86.56 seconds**, actual desktop native scroll through all nine scenes, reverse into the split and forward again, then supporting sections/downloads.
- `sentry-390-scroll-through.webm`: **81.08 seconds**, the same full phone journey with vertical geometry.
- `recording-evidence.json`: 21 sampled native-progress/path/camera/packet states per forward/reverse/return segment. Both viewports record no page or console errors. Forward endpoints were reached before the reverse pass, whose first recorded state is progress 1.0.
- `video-desktop-split.png` and `video-mobile-investigation.png` were extracted from the actual video files and visually inspected.
- Additional `sentry-{width}-workspaces.png` frames show the workspace expansion. Phone `sentry-390-investigate-deepseek.png` and `sentry-390-investigate-glm.png` demonstrate separately inspectable lanes.

## Performance observations — unresolved limitation

The shared-host headless sweep in `performance.json` measured **183.2ms median / 366.7ms p95** frame intervals at 1440px and **116.7ms median / 266.7ms p95** at 390px. These are slow observations, not a smoothness or 60FPS claim.

Further controlled diagnostics (`render-profile.json`, `render-profile.log`) measured idle and scrolling states, temporarily hid the SVG in a diagnostic-only browser context, and tried a transform-layer hint. Later repetitions were still slow with the SVG hidden and did not establish a reliable benefit from the hint. No diagnostic DOM alteration was promoted into delivered code or used in final product screenshots/recordings. The changing shared host load prevents attributing the results conclusively to a single rendering cause. No unrelated process was modified or stopped.

**Frame pacing remains an unresolved performance limitation.** A stable frame budget on an idle host and representative GPU/browser/device remains **UNVERIFIED**. Before official `/sentry` integration, profile real paints/layout/compositing with other builds idle; isolate the shared fixed noise/backdrop, inherited style updates and SVG/foreignObject rendering costs as controlled candidates. Preserve the existing continuous geometry and architecture while addressing measured bottlenecks. Do not infer approval from functional tests.

The film has no custom idle animation loop: its active updates derive from native-scroll progress; hero entrance is finite, and reduced-motion uses manual settled stages. Functional continuity, reverse poses, persistent identities and selected-only execution are verified independently of frame-rate performance.

## Final state

All pre-existing source/public/test files remain unchanged. The final production build, standalone TypeScript and complete 87-test browser run pass. Prior failures/interruption and slow performance measurements remain disclosed. No commit or push. Awaiting human creative approval before any official Sentry route integration.
