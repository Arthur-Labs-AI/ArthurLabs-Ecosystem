# ARTHUR NEURON RevB — JLCPCB Pre-Order Closure

## Mission

Continue on branch `codex/revb-horizontal-jst`.

The comprehensive pre-manufacturing audit is complete. We have also received written technical responses from JLCPCB on October 12–13, 2026.

Your task is to incorporate the manufacturer's existing guidance, resolve digitally actionable manufacturing blockers, and prepare the current horizontal-JST revision for JLCPCB's **Review Before Payment** process.

Do not repeat the entire electrical audit.

## 1. Existing JLCPCB confirmations

The manufacturer has already provided these responses:

### Special plated-through hole

Current design:
- Finished hole: Ø1.90 mm
- Top copper land: Ø2.30 mm
- Top solder-mask opening: Ø1.95 mm
- Bottom copper land: Ø3.00 mm

JLCPCB confirmed:

- This geometry is generally acceptable under standard four-layer PCB fabrication.
- Finished-hole dimensions should be specified by the designer; manufacturing compensation is applied by JLCPCB.
- Pad and solder-mask openings can be manufactured at a 1:1 ratio.
- A solder-mask opening smaller than a drilled hole may be treated as a tented/plugged via.
- Minimum via annular ring: 0.075 mm per side.
- Recommended component plated-hole annular ring: at least 0.2 mm per side.
- Ø1.95 mm mask opening is acceptable, but approximately Ø2.0 mm or greater is preferred when feasible to reduce mask intrusion risk.

These are general process confirmations, not final CAM approval of the BAT post.

### Solder mask

JLCPCB confirmed:

- Green solder mask with at least 0.1 mm spacing is generally acceptable.
- The previously identified 22 via-to-mask proximity cases were considered generally acceptable.
- Minor annular ring exposure may occur.
- The factory will raise an Engineering Question if necessary.

The earlier inquiry referred to 201 vias. The current design has 191 vias, so verify current geometry independently.

### Surface finish

JLCPCB recommended ENIG for consistent pad thickness and fine-pitch fabrication.

### Economic PCBA

JLCPCB confirmed that the design is potentially compatible with Economic PCBA.

However:
- Specific components may require Standard PCBA.
- Component eligibility is checked during BOM review.
- The requested configuration of five fabricated boards with two SMT-assembled boards was not definitively confirmed.
- Pricing is generated after uploading files and choosing order parameters.

### Review process

JLCPCB supports Review Before Payment.

The manufacturer can inspect uploaded Gerber, drill and BOM files before final production authorization.

Support also recommended Confirm Production File so CAM modifications can be reviewed before production.

## 2. Update the audit findings

Review:

`evidence/pre-manufacturing-audit/FINAL_AUDIT.md`

Create a supplemental manufacturer-disposition report without overwriting the independent audit.

Classify each finding as:

- CLOSED — verified by available evidence
- PARTIALLY ADDRESSED — manufacturer guidance exists but specific design approval remains
- OPEN — requires correction
- FACTORY CONFIRMATION REQUIRED
- PHYSICAL VALIDATION REQUIRED

Map the October 12–13 JLCPCB responses to the relevant AUD findings.

Do not classify a finding as CLOSED merely because the manufacturer gave general manufacturing guidance.

## 3. Resolve actionable design issues

Investigate and, where technically justified, implement minimal corrections to:

- AUD-04: Silkscreen clearances and pin-1 markings.
- AUD-08: Three verified BOM metadata discrepancies.
- Any verified manufacturing-file inconsistencies affecting the current horizontal-JST revision.

Preserve:
- PCB outline: 51.30 × 64.95 mm
- Four-layer architecture
- Component values and electrical connectivity
- Five horizontal electrode JST connectors
- Existing battery JST
- Current XIAO mechanical architecture unless a defect is demonstrated

Do not change the Ø1.95 mm BAT-post solder-mask opening automatically. Evaluate the 2.0 mm manufacturer recommendation against the actual copper and solder-mask geometry first.

If a change is necessary but cannot be justified confidently, document it as a pending engineering decision rather than guessing.

## 4. XIAO assembly qualification

Investigate AUD-06 using existing CAD, manufacturer documentation and assembly evidence.

Determine:

- Whether the proposed BAT post geometry remains manufacturable.
- Whether any documented tolerance conflicts exist.
- Whether the PCB factory must preserve special mask and plating geometry.
- Which issues cannot be resolved without a real XIAO module or physical fixture.

Do not claim the physical module fit has been qualified digitally.

## 5. JLCPCB-specific PCBA package

Prepare a consistent package for the CURRENT horizontal-JST revision.

Verify:

- Gerber and drill exports.
- BOM part numbers and references.
- CPL coordinates and rotations.
- JST orientations.
- Diode and IC polarity.
- X1 oscillator sourcing.
- U1 factory DNP designation.
- Manual XIAO assembly instructions.
- Four-layer PCB stackup and finish.
- Panelization and factory rail requirements.

Create a release candidate manifest containing file hashes, revision identifiers and explicit exclusion of obsolete vertical-JST manufacturing packages.

Keep all outputs marked:

**NOT RELEASED — PENDING FACTORY APPROVAL**

## 6. Prepare only the remaining manufacturer questions

Do not repeat questions already answered by JLCPCB.

Prepare a concise, professional follow-up email requesting design-specific confirmation of:

1. Panelization, rails, fiducials and depaneling for a 51.30 × 64.95 mm board.
2. Whether five fabricated PCBs with two SMT-assembled boards are supported.
3. Specific Economic PCBA eligibility and stock for all selected components.
4. Factory placement preview and polarity/orientation confirmation.
5. CAM handling of remaining 0.09 mm silkscreen-to-pad cases, if any remain.
6. Finished-hole/mask treatment for the actual BAT-post geometry.
7. Any special manufacturing constraints for the six horizontal JST-PH connectors and XIAO manual assembly interface.

Where possible, structure the questions around the attached current manufacturing files rather than general specifications.

Do not send the email or submit a production order.

## 7. Final validation

After authorized corrections:

- Re-run ERC and DRC.
- Verify schematic/PCB parity.
- Compare regenerated manufacturing exports against current source.
- Revalidate all relevant BOM/CPL references.
- Independently inspect layer plots.
- Confirm no obsolete vertical JST parts remain.
- Check that no unrelated electrical changes occurred.

Do not hide, waive or weaken new violations.

## Deliverables

Create:

`evidence/pre-manufacturing-audit/jlcpcb-closure/`

Include:

1. `CLOSURE_REPORT.md`
2. `JLCPCB_CONFIRMED_VS_PENDING.md`
3. `JLCPCB_FOLLOWUP_EMAIL.md`
4. `ORDER_READINESS_CHECKLIST.md`
5. `MANUFACTURING_MANIFEST.json`
6. Updated verification evidence
7. Any justified minimal source corrections and clearly labeled release-candidate exports

Keep prior reports and fabrication packages intact.

Do not commit automatically.

## Final decision

Finish with an explicit verdict:

- READY FOR JLCPCB REVIEW BEFORE PAYMENT
- BLOCKED — REQUIRES DESIGN CORRECTION

Also state separately whether the package is approved for actual PCB/PCBA production.

Factory approval must not be treated as body-contact safety approval.

Human-contact testing remains prohibited until a separate qualified electrical safety assessment and required physical validations are completed.

**Goal: close the existing manufacturing questions efficiently and prepare the first Arthur Neuron RevB bench prototype order without unnecessary redesign.**