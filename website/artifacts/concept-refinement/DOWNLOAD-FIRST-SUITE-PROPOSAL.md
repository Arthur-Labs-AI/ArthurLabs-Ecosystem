# Full Suite — download and installation hub

**LAYOUT PROPOSAL ONLY. The existing `/suite` is not replaced in this milestone.**

## Purpose and product boundary

Help visitors obtain and install **Arthur Studio, Nexus and Sentry**. Present their connection as a reason to choose the tools, then offer the immersive story as an optional product demonstration. The three applications remain independent. The Suite package is a distribution convenience: it does not introduce a fourth frontend, launcher, shared runtime or new operational authority.

The package format, supported systems, architectures, verified versions and distribution URLs are currently unverified here. No placeholder should look like a published installer. Planning drawings explicitly show the unavailable/unverified state.

## Proposed composition

### 01 — download-first hero / first viewport

Desktop: approximately 56% editorial introduction, 44% download panel, within the existing maximum content width and shared navigation. Charcoal, ivory type, quiet product accents. Heading: **“Three independent tools. One place to get started.”** Short copy names the three apps and their distinct roles. Compact product identities, not a large animation, establish the package.

The download panel is the first actionable object. It contains:

1. Full Suite identity and a plain availability label.
2. Operating-system selector populated only from verified supported artifacts.
3. Architecture selector constrained to the selected system's verified artifacts.
4. Primary **“Download Full Suite”** action when an exact supported artifact is available.
5. Version, release date, package format and size only when verified for that selection; integrity/signing information only if actually supplied and verified.
6. Release notes and installation guidance links when their destinations exist.

**Current honest drawing state:** “Release details unverified.” Selectors are disabled and read “Platforms unconfirmed” / “Architectures unconfirmed.” Primary button reads **“Full Suite download unavailable”**, with adjacent explanation: “No verified Suite installer is published on this page.” No OS options, platform badges, version numbers or download URL are fabricated. Secondary anchor: “Explore the individual applications.” Do not style a link to a product page as a download.

Mobile: heading first, brief included-app line, then the compact download panel. Put availability and the primary action near the first viewport; do not insert a large hero illustration above them. Keep field labels, native control behavior and 44px minimum targets. No sticky footer covering content. Long error/status text wraps. A future OS suggestion may help only when that platform has verified builds, always with manual override.

### 02 — what is included / individual downloads

Three premium product cards in one desktop row; stacked mobile. Each includes product identity, one-sentence responsibility and its own download/availability row:

- **Arthur Studio:** capture and evolve project knowledge.
- **Nexus:** coordinate models, workers and engineering work.
- **Sentry:** independent verification and review.

When a genuine interface image helps recognition, show one bounded screenshot at its native aspect ratio, without perspective stretching, with a source-resolution-aware display cap. Screenshots illustrate each independent application; they are never cinematic background textures.

Each app has independent release/platform metadata. Never imply matching version numbers, identical platform support or a synchronized release train. Product information links may use the existing verified local `/studio`, `/nexus`, `/sentry` routes. Actual download controls appear only for verified artifact selections.

If the bundle is unavailable but some individual artifacts are verified, keep the Suite unavailable state and offer those independent downloads explicitly. Do not manufacture a bundle in the browser, silently trigger three downloads, or relabel one application's installer as the Suite.

### 03 — release and compatibility information

A restrained release ledger supports the chosen target: bundle metadata (if available) followed by each application's verified version and compatible artifact. Include release notes and last metadata verification time only if recorded. Expose unsupported combinations clearly. “Latest” requires an authoritative channel decision; it must not mean whichever version string sorts highest.

For the current unverified state, show “Release information awaiting verification,” not dummy rows such as v1.0, a fabricated release date or placeholder checksums.

### 04 — installation guidance

A concise target-specific sequence:

1. Choose a verified package compatible with your system and architecture.
2. Follow that artifact's actual integrity/signing guidance when provided.
3. Install the three independent applications using the documented method.
4. Open the applications separately and follow their own first-run instructions.

The exact sequence depends on the real package format and release documentation. Until verified, label this as planned guidance and link only to existing approved instructions. Do not invent terminal commands, package-manager formulas, signing/notarization claims or security-bypass steps. A Suite bundle does not imply an automatically configured live integration.

### 05 — documentation and source

Small, clear rows for Suite installation guidance and each product's documentation/source. Production URLs must be supplied and verified before becoming links. No invented GitHub organization, repository, docs hostname or anchor-to-nowhere. During unavailable design review, show “Documentation link awaiting verification” / “Source link awaiting verification” as text. The current product-information routes remain usable.

### 06 — optional immersive workflow

Below the installation essentials: a quiet preview with **“Explore how the tools connect.”** The initial page does not impose a long pinned scroll sequence. Explicit entry expands/lazy-mounts the immersive component. Native scrolling drives the film; provide “Return to downloads,” skip/read storyboard, keyboard access and reduced-motion stills.

Full intended sequence: **Studio → Nexus → Sentry → Nexus → Studio**. Keep the conceptual label visible. The story demonstrates the intended flow and must not imply completed integration or a successful real run. Reuse the refined crisp DOM/SVG direction after visual approval.

### 07 — hardware ecosystem / closing support

A compact research teaser for Arthur Box, EMG input and future XR; no released-device claim, pricing or download dependency. Link the existing `/hardware` information route. Return visitors to the download section or product information with a small closing action, followed by the unchanged global footer.

## Release availability model

One reviewed release catalog is the future source of truth for **distribution metadata only**. The browser selects an artifact from catalog facts; it does not construct URLs or infer support.

Proposed records (no live schema or API is implemented):

- Package identity: `suite`, `studio`, `nexus`, `sentry`.
- State: `unverified`, `unavailable`, `available`, `withdrawn`.
- Human-approved release/channel identity and version; release date only if sourced.
- Exact system/architecture/package-format identifiers from published artifacts.
- Verified download URL, artifact name and size; optional verified checksum/signature data.
- Source/release-notes/docs URLs, evidence reference and verification timestamp.
- For a Suite artifact, the actual included application versions. Null means unknown, never zero or a guessed value.

| State | User-facing behavior |
| --- | --- |
| Unverified | “Release details unverified”; disabled selectors/download, visible explanation; no support/version claims. |
| Unavailable | Verified information may be shown, but no downloadable artifact; clear reason if known. |
| Available | Enable only the exact selected verified artifact; show its actual metadata and installation instructions. |
| Unsupported target | Preserve valid selections, explain no verified build for that combination; never redirect to another target silently. |
| Withdrawn | Disable the withdrawn artifact and explain known withdrawal information. Offer alternatives only if separately verified. |
| Metadata load/error | Keep download disabled; preserve descriptive product content; show an unavailable-information message and retry if fetching is part of the approved future implementation. |

Native disabled buttons have nearby readable explanations; status text does not rely on color. Use labeled fieldsets/selects and polite status announcements for future selection changes. A missing URL renders no download anchor. UI availability must be based on reviewed release evidence, not user-agent detection or a plausible filename.

## Approval and implementation boundaries

This document and the layout drawings are proposals. They do not create release assets, verify current platform support, implement downloads, connect applications or modify `/suite`. Before implementation, the release/distribution owner must confirm whether a Suite artifact exists, what it contains and where each download/docs/source link comes from. The unavailable state can be built safely before that information arrives, once this layout is approved.

Acceptance for the next build: downloads remain the first meaningful action; unavailable states are honest; each application retains independent identity and metadata; the cinematic demonstration is optional; mobile selectors/controls are usable; the existing Landing Page stays preserved. Production distribution acceptance requires separate verified release evidence.
