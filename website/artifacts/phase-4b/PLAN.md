# Phase 4B implementation plan

Baseline: existing Cloudflare Pages static-export configuration is preserved. Website-only changes; no commit, push, deployment or application invocation.

## A — navigation before Sentry integration

Replace the shared Navbar with a CSS-material floating header, desktop product disclosure and responsive native details navigation. Preserve brand and official routes. Use disclosure semantics with ordinary links, Escape/outside/focus-leave dismissal, arrow/Home/End convenience and focus restoration; no hover-only activation. Keep existing cinematic header-height contract and z-index above films and local product navigation. Verify new header and existing mobile behavior before integrating Sentry.

## B — product route and catalog

Compose official Sentry from existing Hero, ChamberExperience, SupportingSections and Downloads. Add a product-context Hero variant and explicit ordered supporting sections without duplicating the timeline or losing the original concept route. Sentry selection, chapter seeking, immutable snapshot topology, independent outcomes and authored-evidence boundaries stay intact.

Promote exact revalidated Sentry release facts into one shared website-owned metadata source. Existing catalog and concept import those facts; Nexus eligibility remains unchanged. Full Suite may offer the individual Sentry archive but must retain unavailable unified Suite status. No macOS/native Linux Desktop or signed/offline installer claim.

## C — executed evidence

Build and standalone TypeScript, complete Playwright suite, official Sentry route tests, header keyboard/mobile/destination/layering/overflow tests. Capture 390/768/1440/1920 and smoke 320. Real continuous desktop/mobile forward-and-reverse recordings. Compare concept/official and glass-disabled diagnostics in isolated Chromium contexts, collect RAF intervals, browser trace and main-thread metrics. Optimize only where measurements support the change; report unresolved pacing honestly.

Generated out/ is a local build output, not application source. Reports distinguish browser measurements from human visual approval and physical-device coverage.

## Metadata ownership review (architecture-review)

1. Source of truth: one checked-in `lib/sentry-release` record with timestamped publication, source, checksum and prerequisites; Suite and both Sentry routes derive from it.
2. Ownership: website release maintainers edit metadata; product components are read-only consumers. No runtime catalog mutation or application authority.
3. Dependencies: stable release types → verified Sentry facts/validator → shared catalog and concept adapter → page components. No import from lower layers to UI; no runtime cycle.
4. Boundary: typed Artifact/SentryRelease facts and filtered arrays only. No credentials, live application state or provider calls cross into the website.
5. Failure: incomplete, withdrawn or non-HTTPS metadata produces no download; remote verification failure blocks promotion. Browser receives a static reviewed snapshot, not a live availability guarantee.
6. Lifecycle: static build captures reviewed facts; withdrawal requires catalog edit/rebuild. Header listeners/media observers clean up on unmount; film retains its existing cleanup.
7. Test seams: eligibility helpers accept injected catalogs, allowing missing/hash/withdrawal/unsafe-URL cases without external network. Browser tests operate actual anchors and native scroll.
8. Compatibility: retain existing release imports/re-exports and concept public API; Nexus guard stays unchanged. Rollback restores empty shared catalog while preserving local concept reference.
9. Observability: audit receipt includes checkedAt/source/hash/bytes/publication; disabled downloads explain unavailable state. Film keeps native progress/stage attributes for measurements.
10. Security: static HTTPS links only, no binaries executed or credentials accessed. SHA256 identifies the audited archive, not publisher cryptographic authentication or installer safety. No new privilege or persistence boundary.

Header gate completed before Sentry implementation: `header-final-tests.log`, 8 passed (18.1s). The previous mobile-name regression was corrected by preserving product accessible names and adding accessible descriptions, not by weakening the existing interaction test. Header material was inspected in settled screenshots; dropdown density was increased after early captures showed too much underlying headline detail.
