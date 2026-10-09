# PHASE3C-0R — USB connector DFM resolution

Decision: prefer **USB4215 replacement**, conditionally. **Neither path is fully qualified; readiness is NO.** USB4105 has no demonstrated fabricator exception. USB4215 removes the locating-hole blocker and fits the accepted tab geometrically, but the manufacturer drawing does not establish a PCB-edge datum. Saved plane fills also require a later authorized clearance/isolation verification.

Decision-only examination dated 2026-09-27. Production SHA-256: `d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005`. All five requested reports were read and their hashes are recorded in JSON. Production was loaded read-only; the failed candidate was used only through its diagnostic evidence. All 2167 preexisting project files remain byte-identical. Only these two decision reports were created.

## Path A — USB4105 as-is

The accepted official geometry remains confirmed: two Ø0.65 locating holes; minimum nominal hole-edge to adjacent GND-land edge 0.1944 mm. Four reported intrinsic errors correspond to two physical gaps, each reported against two coincident logical GND pads. The diagnostics also contain separate plane-clearance errors; qualifying the intrinsic gaps would not qualify those errors. The official cached footprint and manufacturer drawing are hash-bound in JSON.

| Authority / case | Value | Meaning |
|---|---:|---|
| Current project hole-to-copper | 0.2500 mm | Enforced conservative project requirement; shortfall 0.0556 mm |
| GCT recommended footprint | 0.1944 mm resulting gap | Manufacturer geometry; does not prove JLC acceptance |
| JLC rigid NPTH-to-track | 0.2000 mm | Published minimum; proposed gap is 0.0056 mm below it |
| JLC NPTH annular pad | ≥0.45 mm recommended | Different geometry: annular pad around NPTH; not adjacent SMT-pad clearance |
| JLC sealing-film process | 0.20 mm copper removal | Does not grant preservation of a neighboring solder land |
| Exact rigid NPTH-to-SMD-pad exception | Not found | UNVERIFIED; no supported sub-0.20 exception |

These distinctions follow the [JLC rigid capability table](https://jlcpcb.com/capabilities/pcb-capabilities). It does not explicitly provide separate relaxed treatment for NPTH-to-SMD pads or pours. The [Chinese capability page](https://www.jlc.com/portal/vtechnology.html) explicitly includes pads/tracks/pours in a ≥0.20 mm row, but inspection of the surrounding heading places that row in **FPC**, not rigid PCB. Applying it to this board would be an invalid qualification. No documentary evidence supports an SMT-pad exemption. The requested three-way classification is **ambiguous / requires CAM approval**, not explicitly supported. Acceptance gate: **UNVERIFIED**.

No footprint-specific exception is justified now. Reject shrinking/moving/deleting locating holes, changing GND lands, lowering the global rule, or suppressing DRC. An exception becomes admissible only after written approval binds the unchanged as-built geometry to the selected fabrication process.

### Exact CAM request — prepared, not sent

> For a standard four-layer FR-4 rigid PCB using our unchanged GCT USB4105 manufacturer land pattern, can you explicitly approve nominal edge-to-edge spacing 0.1944 mm between each of two finished Ø0.65 mm NPTH locating holes and the adjacent exposed GND SMT land? There are two physical gaps and four logical-pad DRC errors. Your rigid table lists NPTH-to-track 0.20 mm and 0.20 mm copper removal around sealed NPTH. Does this apply identically to SMD pads and copper pours? Will CAM remove/resize any part of these GND solder lands or change the holes? Please confirm acceptance of the exact submitted Gerber/drill geometry without copper clipping, footprint changes or special fabrication, state finished-hole/registration tolerances, mask treatment, stack-up/finish restrictions, and provide a written order-specific exception if approved.

Supply an **unmodified** manufacturing excerpt covering the complete connector and surrounding copper, including F.Cu/GND lands, mask and paste, both inner layers and B.Cu, separate NPTH and PTH/slot Excellon files, Edge.Cuts, stack-up/finish, and an enlarged dimensioned image showing the nearest copper/hole points. Include all four logical GND labels and identify the two physical gaps. Bind any approval to the complete manufacturing archive SHA-256. Do not send the failed candidate as a routing or release base. No Gerbers were generated or external message sent in this task.

## Path B — manufacturer geometry

[GCT product evidence](https://gct.co/connector/usb4215) establishes USB2.0 Type-C, 16 contacts, horizontal top mount, SMT contacts, four through-hole shell stakes and no locating pegs. Body depth is 6.50 mm. The 0.80 mm shell-stake feature is **protrusion length**, not hole diameter.

The exact recommended layout was retrieved from the [GCT-authored drawing, DigiKey mirror](https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/6328/USB4215-03-A.pdf), revision A, 26 April 2024, sheet 1/2. Canonical GCT PDF retrieval returned 403. Retrieved file: 154795 bytes; SHA-256 `1659ba00769b9b774a033fac72cb2f3bfc481a3272c53f34e87520f33635a9e1`. The dimensioned layout and pin table were visually inspected. No third-party footprint geometry was used.

All coordinates below are mm, component-side view. Origin: midpoint of front shell-slot centers; +Y toward the mating mouth. Rectangular signal lands:

| Physical land / contacts | X | Y | Copper W × H |
|---|---:|---:|---:|
| A1/B12 | -3.20 | −4.575 | 0.60 × 1.15 |
| A4/B9 | -2.40 | −4.575 | 0.60 × 1.15 |
| B8 | -1.75 | −4.575 | 0.30 × 1.15 |
| A5 | -1.25 | −4.575 | 0.30 × 1.15 |
| B7 | -0.75 | −4.575 | 0.30 × 1.15 |
| A6 | -0.25 | −4.575 | 0.30 × 1.15 |
| A7 | +0.25 | −4.575 | 0.30 × 1.15 |
| B6 | +0.75 | −4.575 | 0.30 × 1.15 |
| A8 | +1.25 | −4.575 | 0.30 × 1.15 |
| B5 | +1.75 | −4.575 | 0.30 × 1.15 |
| B4/A9 | +2.40 | −4.575 | 0.60 × 1.15 |
| B1/A12 | +3.20 | −4.575 | 0.60 × 1.15 |

Shell coordinates: `(±4.32,−4.00)` with oval copper 1.00×1.80 and plated oval slot 0.60×1.40; `(±4.32,0)` with oval copper 1.00×2.20 and plated oval slot 0.60×1.80. Four stakes, zero NPTH. Layout tolerance ±0.05. Body bounds reconstructed from the drawing: X ±4.47, Y −4.40…+2.10. Mouth line Y +2.10; mating direction +Y. These dimensions come directly from the manufacturer drawing, not a vendor library.

**No labeled PCB EDGE line or recommended courtyard is present.** The dashed component outline is not authority for a PCB-edge datum. For virtual analysis only, the mouth is assumed flush with the top board edge. Engineering courtyard: X ±5.32, Y −5.65…+2.60, using a 0.50 margin around copper/body extrema and a 0.05 stroke. Its provenance is engineering, not GCT.

Ask GCT to specify the recommended board edge relative to the front slot centers, permissible mouth overhang/setback, board thickness, and relevant layout/finished-slot tolerances. Also confirm whether shell and signal GND contacts are internally connected. This inquiry was not sent.

## Virtual architecture search

All tests start from the authoritative production board and the previously accepted *hypothetical* USB tab architecture. The in-memory USB4215 reconstruction never became a saved footprint or PCB. Rotation 180° gives `global_y = center_y − local_y`. Under the mouth-flush assumption, `center_y = 2.10 − tab_depth`; this is a conditional transform, not a proven manufacturer edge datum.

| Conditional candidate | Tab | Center / rotation | Outcome against tracks, vias and components |
|---|---|---|---|
| Accepted tab first | X31…43, Y−5.40…0 | (37.00,−3.30), 180° | PASS |
| Smaller sampled tab | X31.35…42.05, Y−4.70…0 | (36.70,−2.60), 180° | PASS |
| Refined fixed-packing candidate | X31.65…42.35, Y−4.65…0 | (37.00,−2.55), 180° | PASS |

USB-local virtual placement retained: U3001 (35.60,4.85),90°; R3001 (38.60,3.80),0°; R3002 (40.60,3.80),0°. All other footprints are fixed. Tab-depth search covered 2.5…5.4 on a 0.1 grid and center X36.0…37.5 on a 0.1 grid, then checked 4.65 depth and 10.7 width. Fixed packing fails courtyard separation at 4.50/4.60. **10.7×4.65 is a demonstrated conditional candidate, not a proven global minimum with arbitrary USB repacking.** A narrower 10.7 tab gives 0.53 conservative copper-to-side-edge clearance. Do not implement these dimensions before the missing datum is established.

On the 12×5.4 tab, signal centers are Y1.275 and X = `37 − local_x`; rear shell centers (32.68,0.70)/(41.32,0.70); front shell centers (32.68,−3.30)/(41.32,−3.30). Nominal body X32.53…41.47, Y−5.40…1.10. Courtyard including stroke X31.655…42.345, Y−5.925…2.375. Courtyard may extend beyond the mating edge; no solder land does. Minimum conservative copper-to-outline 1.00; hole-to-outline 1.20. Full pad coordinates and edge tests for each candidate are in JSON.

### Checks and their limits

| Check | Result |
|---|---|
| Foreign pads and every frozen track/via | PASS at 0.20 copper screen |
| Shell hole → foreign copper | PASS at project 0.25; separately screened at JLC 0.28 outer / 0.30 inner |
| Shell hole → other holes | PASS at project 0.25 and JLC pad-hole screen 0.45 |
| Intrinsic shell hole → signal copper | PASS at 0.30 screen; nearest nominal gap ≥0.52 |
| Intrinsic shell hole → shell hole | Closest same-side separation 2.40 |
| Annular ring | Nominal 0.20 throughout oval shell lands |
| Copper/hole → real tab outline | PASS; conservative bounding-box distance to each actual polygon segment |
| Body / courtyard → fixed components | PASS; also checked USB-local mutual courtyards and pad copper |
| RF antenna region | No connector body/copper overlap; footprint courtyard alone is not a forbidden RF object |
| Saved inner GND fills | **FAIL for shell isolation / clearance** |
| Updated zone fills, complete replacement DRC, assembly approval | **UNVERIFIED / not run** |

528 tracks and 151 vias were individually retained as obstacles; no movements are needed for the conditional fit. Zero non-USB placement movements. Project constraints were read from the existing .kicad_pro. Generic foreign-copper screening at 0.20 is conservative for the relevant 0.15/0.20 classes; it is not a claim that the entire board satisfies every unrelated custom rule.

The saved production plane fills contact the right rear virtual SH land on both In1.Cu and In2.Cu on the accepted tab; smaller candidates also have saved-fill contacts. JSON records zone UUIDs and affected positions. These fills were calculated for the old footprint, so they cannot establish replacement clearance. **Do not assign SH to GND to conceal this.** No zone was edited or refilled. A later authorized replacement must establish USB_SHIELD clearance from GND on every layer and rerun full DRC. If saved filled copper must also remain byte-for-byte frozen, these candidates are not viable.

The original 55×35 outline was assessed by continuous translation intervals along all four edge orientations under the same mouth-flush hypothesis. Unions of fixed-component courtyard exclusions cover each complete legal interval; thus no original-outline candidate survives mechanical screening. This is stronger than a sampling-only rejection for that frame, but says nothing about an unknown GCT edge datum.

[JLC rigid minimums](https://jlcpcb.com/capabilities/pcb-capabilities) are separate from project limits: routed copper-edge 0.20 versus project 0.50; PTH-to-track minimum 0.28/recommended 0.35; inner PTH-to-copper 0.30; pad-hole spacing 0.45; multilayer 1oz annulus recommended 0.20/absolute 0.15. The 0.60-wide slots exceed both the multilayer 0.35 row and generic 0.50 text; lengths exceed twice width. Standard four-layer mechanical drilling and F-side placement remain plausible; no HDI is geometrically required. JLC finished plated-slot tolerance +0.13/−0.08 is broader than the drawing's layout ±0.05, so process/tolerance qualification is outstanding. No separate generic hole-to-routed-edge minimum was established; the 0.25 hole-edge screen is conservative analysis, not a quoted JLC capability.

## Electrical representation

Contact mapping is compatible with the existing 16-pin ARTHUR USB_C topology. All four ground contacts remain GND; A4/A9/B4/B9 remain VBUS; A5 CC1, B5 CC2; A6/B6 D+, A7/B7 D−; A8 SBU1, B8 SBU2. Four physical paired lands share the existing same-net contacts. Preserve sixteen logical pad identifiers through coincident paired pads or explicit compound-pin mapping; do not silently omit pins.

GCT labels the stakes **SHELL**, with GND in its generic pin table, but does not assign an `SH` library pad number. Choose `SH` for all four shell pads and correct existing symbol number **S→SH** while retaining pin name **SHIELD** and board net **USB_SHIELD**. Number-only objects: ARTHUR.kicad_sym USB_C_1_1 shield pin; usb_c_interlock.kicad_sch cached ARTHUR:USB_C shield pin; J3001 instance pin UUID `cfe3b0a8-17c0-56f4-80cd-c5458b640262`. No topology change or external GND connection is authorized. Logical compatibility does not prove internal shell-contact isolation; request GCT continuity confirmation before promising physical isolation.

## Sourcing and cost

[LCSC exact listing](https://www.lcsc.com/product-detail/USB-Connectors_Global-Connector-Technology-USB4215-03-A_C37616412.html) identifies **C37616412 / USB4215-03-A**, with **130 pieces** in stock at observation. Unit USD: 1+ 0.9047; 10+ 0.7359; 30+ 0.6523; 100+ 0.5687; 500+ 0.5196; reel tier 1200+ 0.4933. MOQ/multiple one; full reel 1200. Stock and prices are observations, not guarantees.

[JLC Economic-PCBA capabilities](https://jlcpcb.com/capabilities/pcb-assembly-capabilities) support four layers and single-side mixed SMT/through-hole assembly; 0.50 signal pitch clears the published 0.40 process limit. That makes compatibility plausible. Exact JLC library stock, approved footprint/assembly handling, and reel eligibility remain **UNVERIFIED**; the attempted exact part lookup did not yield a verified part page. LCSC availability alone proves none of these. Part-specific quote/CAM acceptance is required.

Retaining USB4105 minimizes library/BOM work but leaves a sub-0.20 gap and depends on an unproven exception, with no guarantee the exposed lands survive CAM. USB4215 costs approximately a dollar in small quantities, removes locating pegs, and offers a shallower conditional tab. Its change cost is a new manufacturer-derived footprint, BOM qualification, placement and edge confirmation. No comparative USB4105 live price or guaranteed assembly saving is claimed.

## Final gate

```text
USB4105 OFFICIAL GEOMETRY CONFIRMED: YES
USB4105 0.1944 mm JLC ACCEPTANCE: UNVERIFIED
USB4105 RULE EXCEPTION JUSTIFIED: NO
USB4215 MANUFACTURER LAND PATTERN QUALIFIED: YES
USB4215 LOCATING PEGS: 0
USB4215 SHELL STAKES: 4
USB4215 FITS CURRENT TAB: UNVERIFIED
USB4215 MINIMUM TAB: UNVERIFIED globally; conditional tested 10.7 x 4.65 mm with fixed accepted USB packing and mouth-flush assumption
USB4215 FROZEN TRACK MOVES REQUIRED: 0
USB4215 FROZEN VIA MOVES REQUIRED: 0
USB4215 NON-USB MOVES REQUIRED: 0
USB4215 ELECTRICAL MAPPING COMPATIBLE: YES
LCSC PART: C37616412
CURRENT AVAILABILITY: LCSC 130 pieces observed 2026-09-27; JLC assembly inventory UNVERIFIED
UNIT PRICE: USD 0.9047 at 1; 0.7359 at 10; 0.6523 at 30; 0.5687 at 100
RECOMMENDED DFM PATH: USB4215 replacement, conditional on GCT edge datum / shell isolation and JLC process qualification; retain production unchanged
READY FOR A REVISED 3C-0 IMPLEMENTATION PLAN: NO
```

YES for manufacturer land-pattern qualification means its signal/stake dimensions and mapping are sourced and reconstructed; it does **not** include an absent edge datum, qualified fabrication tolerances, or final DRC. Zero movement counts apply to the conditional candidates and the 679 frozen track/via objects, not to immutable saved plane polygons. FITS CURRENT TAB is UNVERIFIED at the complete qualification level despite a geometric PASS. Revised-plan readiness remains NO until the missing manufacturer datum and process/isolation gates are resolved. Stop here; no PCB edit, rule edit, routing, or Phase3D.
