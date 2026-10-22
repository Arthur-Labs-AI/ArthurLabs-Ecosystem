# ArthurLabs Landing Page — visual quality review

20 October 2026. Review only: no application source, styling, dependencies, routes, or configuration changed. Generated evidence is confined to `artifacts/visual-review/`.

## Assessment

The Next.js landing page closely reproduces the approved HTML prototype. Retain its visual direction. Three important interaction/layout issues should be corrected before Phase 2; the remaining suggestions are targeted polish, not a redesign. No blocker-level rendering failure was observed in the reviewed Chromium scenarios.

The approved prototype and current production page were captured in Chromium at device scale factor 1, matching these viewports:

| Viewport | Reference full page | Implementation full page |
| --- | --- | --- |
| 1440 × 1000 | [Reference](reference-1440-full.png) | [Implementation](implementation-1440-full.png) |
| 1920 × 1080 | [Reference](reference-1920-full.png) | [Implementation](implementation-1920-full.png) |
| 768 × 1024 | [Reference](reference-768-full.png) | [Implementation](implementation-768-full.png) |
| 390 × 844 | [Reference](reference-390-full.png) | [Implementation](implementation-390-full.png) |

All eight full-page images were captured after decoding the screenshots. Additional viewport captures cover the initial hero and Capture, Execute, Verify, and Connect states for both versions. Full-page captures contain the sticky hero's reserved scroll space; that static image area is not evidence of an empty section during normal scrolling. The workflow viewport captures supplement those images.

## Important findings

### 1. Mobile workflow descriptions overlap the chapter controls

**Origin:** implementation regression at 390px. **Evidence:** [Capture state](implementation-390-capture.png), [prototype Capture state](reference-390-capture.png), `interaction-measurements.json`; `src/app/globals.css:126` in conjunction with the positioning at lines 102–103.

At 390 × 844 the description ends at y=740.80px, while chapter controls start at y=731.19px: a 9.61px overlap. The prototype's 24px controls start at y=743.19px and clear the description. Increasing controls to 36px without reserving extra vertical space caused the regression. It occurs across chapters 1–4; the card edge appears to cut into the tops of the controls. Hit testing confirms the buttons remain clickable, so this is a visual separation defect rather than blocked interaction.

**Recommended action:** retain the larger targets and reserve an explicit gap between the preview caption and controls. Check all four descriptions rather than only the overview.

### 2. Selecting a chapter does not synchronize the scroll position

**Origin:** behavioral difference from the prototype, all four widths. **Evidence:** `measurements.json`, `transitions-*.json`; `src/components/WorkflowAnimation.tsx:23`, `src/components/InteractiveHero.tsx:17` and `:39`.

Selecting Nexus from the top puts the reference at scrollY=1008px (1440 viewport), 1089px (1920), 860px (768), or 603px (390). The implementation stays at scrollY=0 in every case. The visual chapter changes, but the progress rail still reflects the old scroll position. Reproduction: select Connect at the top; scroll through the first 10% of the story and Connect remains; cross into 20% and the page jumps back to Capture. The observed sequence is 4 → 1 → 2 → 3 → 4.

**Recommended action:** make chapter navigation seek the matching story position, or define a consistent manual-mode/scroll reconciliation behavior. Preserve reversible navigation and reduced-motion handling.

### 3. Mobile navigation remains open after an in-page selection

**Origin:** added mobile-menu behavior. **Evidence:** [Destination obscured by menu](mobile-menu-after-anchor.png), `interaction-measurements.json`; `src/components/Navbar.tsx:4`.

At 390px, open Menu and select Our approach. The page reaches the philosophy section, but the details element retains its `open` attribute. The fixed dropdown covers part of the destination heading. The plus symbol also remains unchanged while open. A visitor must dismiss the menu separately.

**Recommended action:** close the menu after choosing a destination, restore sensible focus, and support predictable Escape/outside dismissal. Keep the existing menu styling.

## Minor findings and premium-polish opportunities

### 4. Tablet typography and image balance need a tailored check

**Origin:** inherited from the prototype, not an implementation mismatch. **Evidence:** [768px product comparison](compare-768-products.jpg), [suite comparison](compare-768-suite.jpg); `src/app/globals.css:102`.

At 768px the desktop two-column product layout and three-column suite layout are still active because stacking starts at 760px. The Sentry heading wraps as “Confidence / is / engineered.” and Arthur Studio becomes “Think freely. / Connect / deeply.” The screenshots beside them are relatively small. Suite cards are readable but narrow. This makes portrait-tablet composition feel less resolved than the desktop/mobile versions.

**Opportunity:** tune the intermediate breakpoint, column proportions, or heading line lengths while retaining the approved hierarchy and section order. The isolated “is” is the clearest typography target.

### 5. Screenshot fidelity is good overall, with slight additional fine-text softness

**Origin:** implementation optimization difference. **Evidence:** [1:1 1920px hero crop](quality-1920.png); `src/components/ProductWindow.tsx:6`, `src/components/ProductShowcase.tsx:5`.

All authentic application screenshots load and retain their colors and content. Side-by-side crops show mild extra softness in the implementation's small Nexus interface labels compared with the embedded source, consistent with re-encoding extracted WebP through Next Image at q=75. This is fine-detail polish, not a major image-quality failure. The scaled application text is already small in the reference.

**Opportunity:** compare a higher-quality responsive rendition for text-heavy screenshots, especially the focused hero state, and validate sharpness at DPR 2 before changing the current size/quality balance. High-DPI visual acceptance has not been performed here.

### 6. Mobile focused previews and labels are crowded

**Origin:** primarily inherited. **Evidence:** [390px Capture](implementation-390-capture.png), [Connect](implementation-390-connect.png), and corresponding reference captures.

Selected Arthur Studio extends about 7px beyond the left viewport edge; selected Sentry extends about 7px beyond the right. Captions cover the lower portion of the active screenshot. In Connect, the tiny Capture/Execute/Verify labels sit across the window chrome and are hard to separate from application microcopy. The Nexus overview also inherits a cover crop that trims its left navigation, and the Sentry screenshot carries its own application title bar underneath the synthetic window chrome.

**Opportunity:** refine focused-window containment and label clearance while preserving the layered composition and deliberately clipped background previews. Treat screenshot framing/chrome consistently. No new screenshot content or fabricated application states are proposed.

### 7. Mobile hardware annotation needs breathing room

**Origin:** inherited. **Evidence:** [390px closing-section comparison](compare-390-closing.jpg); `src/app/globals.css:96` and `:102`.

The “EXPLORATION / FORM + FUNCTION” annotation sits across the lower edge of the hardware ring and finishes against the viewport edge. It feels less deliberately placed than the rest of the mobile section.

**Opportunity:** give the annotation a clear relationship to the object and a consistent content inset. The existing conceptual hardware illustration can remain.

## Fidelity and behavior checklist

| Area | Observation |
| --- | --- |
| Hero composition | Closely matches at all four widths. Measured hero-copy and stage bounding boxes are identical between reference and implementation. Window positioning, perspective, layering, glow, and background grain are retained. |
| Typography | Same computed H1 font stack, weight, size, and line height. Font sizes: 102.24px at 1440, 116.8px at 1920, 61.44px at 768, 53px at 390. Georgia italic accent matches. Tablet wraps remain a polish opportunity. |
| Hierarchy and emphasis | Title, light primary CTA, secondary CTA, product roles, and purple/mint/green accents are consistent with the approved reference. |
| Spacing and density | Suite, each product, hardware, and philosophy have identical measured section starts/heights at every viewport. Card counts, gaps, mobile stacking, and section padding match. Footer content changes cause only 6–9px total-page-height differences. |
| Screenshot quality | Authentic assets; no missing or broken images observed. Mild extra fine-text softness documented above. |
| Workflow motion | Forward/reverse chapter progression and transform interpolation observed at all widths. Motion is a timed CSS transition between scroll thresholds, as in the prototype; only the rail is continuously scrubbed by GSAP. Manual chapter/scroll disagreement is documented above. No frame-rate benchmark or 60fps claim is made. |
| Section transitions | Sticky hero releases into suite; alternating product backgrounds, hardware divider/gradient, philosophy and footer follow the reference. Lower sections remain static, as in the prototype. No new reveal animation is necessary for fidelity. |
| Responsive behavior | No horizontal document overflow at the four captured widths. Desktop layering and mobile stack preserved. 768px breakpoint and 390px overlay issues documented above. |
| Reduced motion | Additional 390px capture confirms non-sticky, fully opaque hero with selectable chapter content: [capture](reduced-motion-390.png). No animated scroll progression required to access the content. |
| Browser errors | No uncaught page errors observed in the eight primary capture sessions. This is not a substitute for a full accessibility or cross-browser audit. |

## Intentional differences that are reasonable to retain

- Mobile navigation exposes the product routes, whereas the prototype hides those links.
- Product showcases and suite names link to the requested route foundations.
- Footer copy describes the official site rather than a design concept, and uses the shared brand mark.
- Chapter controls are larger on mobile; their placement needs the correction in finding 1.
- Reduced-motion visitors retain chapter selection.
- Main CTA groups are about 8px wider than the reference at desktop due to explicit flex gaps/arrows; this is a minor difference with no hierarchy/layout failure.

## Recommended sequence

1. Correct the three important issues, then recapture 390px and chapter-navigation states.
2. Refine the tablet text/image balance and mobile caption/annotation spacing.
3. Evaluate screenshot rendition quality at DPR 2.
4. Keep the current visual identity, desktop composition, section geometry, and restrained motion direction.

This review establishes visual fidelity in the sampled Chromium viewport states. Safari, Firefox, real touch-device behavior, screen-reader operation, sustained frame pacing, and high-DPI sharpness remain unverified. No implementation changes were made, and no Phase 2 work was started.
