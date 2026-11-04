# Phase 3C-0 — USB connector correction preflight

Date: 2026-09-27. **Not ready for implementation.** Official geometry and edge datum are established, but the proposed mounting collides with fixed components and physically drills through frozen copper. No compliant minimal placement is established. Only these two reports were created; no production/design/frozen evidence file changed.

## Authority and sources

Production SHA-256 before/after: `d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005`. Production remains byte-identical to Phase3B FinalClean. All 1070 captured pre-existing project-file hashes match after analysis.

Manufacturer: [GCT USB4105 product drawing](https://gct.co/files/drawings/usb4105.pdf), revision B4 dated 18/12/23, page 1 visually inspected after Poppler rendering. SHA-256 `fb331fbabee8392ed2937ed757c1610cb0f174b84625147c0b580a18eea8c0e5`. It supplies four plated shell stakes, two locating posts and a recommended PCB layout with explicit PCB Edge. Exact plating/stake-length ordering suffix still is not selected in the project; these variants share this mounting footprint.

Footprint: [current official KiCad GitLab master](https://gitlab.com/kicad/libraries/kicad-footprints/-/raw/master/Connector_USB.pretty/USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal.kicad_mod). SHA-256 `3b8d7da3cae5114ec83022a759a78925113bc2eeec100ea447594f6d8687e4b8`. Downloaded directly from the primary library repository. The GitHub mirror lacks this footprint and was not used as authority. This report binds the retrieved bytes by hash; master is a moving reference.

## Embedded footprint delta

Comparison normalizes instance placement, net assignments and UUIDs before comparing footprint-local physical objects. All retained 19 pads are otherwise structurally identical to the official objects, including shapes, coordinates, drill shapes/sizes, mechanical pad property and layers. The embedded J3001 has 19 pad objects; official has 22: sixteen signal pads, four SH pads, two unnumbered NPTH holes.

| Item | Result |
|---|---|
| Missing fourth SH pad | YES: local (+4.32,+1.075), copper 1.0×1.8 mm, oval plated slot 0.6×1.4 mm |
| Other missing mechanical objects | Two NPTH locating holes, local (±2.89,−2.605), diameter 0.65 mm |
| Differing retained pad geometry | None |
| Differing retained drill geometry | None |
| Differing courtyard | None: local x=±5.32, y=−4.76…+4.18, stroke 0.05 mm |
| Differing F.Fab body rectangle | None: local x=±4.47, y=±3.675, stroke 0.10 mm |
| Differing PCB-edge marker line | None: local (−5,+3.675) ↔ (+5,+3.675), Dwgs.User, stroke 0.10 mm |
| Missing PCB-edge marker label | Official `PCB Edge` text at (0,+3.1) is absent |
| Missing Fab reference text | Official `${REFERENCE}` text at (0,0) is absent |
| Footprint attributes | Both `attr smd`; both duplicate_pad_numbers_are_jumpers=no |
| Metadata/presentation deltas | Description replaced by placement note; tags and 3D STEP model absent; reference/value text locations, sizes and values customized; field unlock/thickness details differ |

**Exactly one SH pad is missing, but that is not the entire footprint defect:** both NPTH holes are also missing. Raw object-by-object deltas, including metadata/field differences, are in the JSON. Existing signal lands must retain their numbers and net assignments in any future replacement.

## Exact shield mapping correction

The intended `S → SH` correction is required. Preserve pin name `SHIELD`, pin location/type/geometry, global label and net `USB_SHIELD`. Modify these exact future objects:

- `ARTHUR.kicad_sym`: symbol USB_C / USB_C_1_1 / passive SHIELD pin at (5.08,19.05), angle 270; pin number S -> SH; retain name SHIELD, pin type/position and geometry.
- `usb_c_interlock.kicad_sch`: lib_symbols / ARTHUR:USB_C / USB_C_1_1 / passive SHIELD pin at (5.08,19.05), angle 270; cached pin number S -> SH, retain name SHIELD.
- `usb_c_interlock.kicad_sch`: J3001 symbol uuid c2a80724-face-5425-a1b9-856009243bb3 / pin uuid cfe3b0a8-17c0-56f4-80cd-c5458b640262; instance (pin "S") -> (pin "SH"), preserve pin UUID and USB_SHIELD global label/wiring.
- `ARTHUR_EMG_RevA_Cost.kicad_pcb (future separately authorized update)`: J3001 shell pads; map all four SH pads to independent USB_SHIELD net after footprint restoration; do not connect to GND.

These are specifications only; no symbol/library/instance/PCB update was performed. USB_SHIELD remains independent of GND, consistent with the schematic’s unresolved EMC/enclosure termination note.

## Manufacturer edge datum and virtual geometry

Candidate: center **(37.000,3.675) mm**, rotation **180°**, F.Cu. Transformation is exactly `(xlocal,ylocal) → (37−xlocal,3.675−ylocal)`. Thus every point of the official edge marker at local y=+3.675 has global y=0; its endpoints become (32,0) and (42,0), exactly on the continuous top Edge.Cuts segment. Signal lands at local y=−3.680 become y=7.355, fully inside the existing substrate. This proves mounting datum agreement; it does not prove collision freedom.

Nominal body: x=32.530…41.470, y=0…7.350 mm. Nominal courtyard: x=31.680…42.320, y=−0.505…8.435 mm. Stroke-inclusive bounds: body [32.480,−0.050,41.520,7.400]; courtyard [31.655,−0.530,42.345,8.460]. The exterior courtyard fringe/body outline stroke at y<0 is drawing margin, not exterior solder copper. The mouth faces the top edge; all lands/stakes/locating holes are inward.

| Pad | Global center x,y mm | Copper extent xmin,ymin,xmax,ymax mm | Drill mm | Min copper-to-board-edge mm | Min hole-to-board-edge mm |
|---|---|---|---|---:|---:|
| NPTH | [39.89, 6.28] | [39.565, 5.955, 40.215, 6.605] | [0.65, 0.65] | N/A | 5.955 |
| NPTH | [34.11, 6.28] | [33.785, 5.955, 34.435, 6.605] | [0.65, 0.65] | N/A | 5.955 |
| A1 | [40.2, 7.355] | [39.9, 6.78, 40.5, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| A4 | [39.4, 7.355] | [39.1, 6.78, 39.7, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| A5 | [38.25, 7.355] | [38.1, 6.78, 38.4, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| A6 | [37.25, 7.355] | [37.1, 6.78, 37.4, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| A7 | [36.75, 7.355] | [36.6, 6.78, 36.9, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| A8 | [35.75, 7.355] | [35.6, 6.78, 35.9, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| A9 | [34.6, 7.355] | [34.3, 6.78, 34.9, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| A12 | [33.8, 7.355] | [33.5, 6.78, 34.1, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| B1 | [33.8, 7.355] | [33.5, 6.78, 34.1, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| B4 | [34.6, 7.355] | [34.3, 6.78, 34.9, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| B5 | [35.25, 7.355] | [35.1, 6.78, 35.4, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| B6 | [36.25, 7.355] | [36.1, 6.78, 36.4, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| B7 | [37.75, 7.355] | [37.6, 6.78, 37.9, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| B8 | [38.75, 7.355] | [38.6, 6.78, 38.9, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| B9 | [39.4, 7.355] | [39.1, 6.78, 39.7, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| B12 | [40.2, 7.355] | [39.9, 6.78, 40.5, 7.93] | [0.0, 0.0] | 6.78 | N/A |
| SH | [41.32, 6.78] | [40.82, 5.73, 41.82, 7.83] | [0.6, 1.7] | 5.73 | 5.93 |
| SH | [41.32, 2.6] | [40.82, 1.7, 41.82, 3.5] | [0.6, 1.4] | 1.7 | 1.9 |
| SH | [32.68, 6.78] | [32.18, 5.73, 33.18, 7.83] | [0.6, 1.7] | 5.73 | 5.93 |
| SH | [32.68, 2.6] | [32.18, 1.7, 33.18, 3.5] | [0.6, 1.4] | 1.7 | 1.9 |

All signal copper has y=6.780…7.930, hence 6.780 mm clearance to top edge. SH copper closest to the top edge is y=1.700, and its plated slot begins y=1.900: 1.700 mm copper-to-edge, 1.900 mm hole-to-edge. The other SH row is centered y=6.780 with drill y=5.930…7.630 and copper y=5.730…7.830. NPTH centers are (34.110,6.280) and (39.890,6.280), drill edges y=5.955…6.605. These edge distances exceed the stored 0.50 mm copper-edge threshold; board-edge geometry itself is no longer the problem.

## Mechanical and frozen-copper audit

Audit uses a detached official footprint transformed in memory; production objects are read only. Every existing component was checked using F.Fab body bounds where available and actual F.CrtYd bounds. KiCad effective pad/hole shapes were intersected with every saved track/via and every other component pad on all four common copper layers. Direct intersections are conclusive blockers; courtyard bounding rectangles are conservative exclusions. No speculative 3D clearance or routed DRC result is claimed.

| Required check | Result |
|---|---|
| J3001 vs U3001 body collision | YES |
| J3001 vs U3001 courtyard collision | YES |
| J3001 vs R3001 collision | YES: courtyard and land/shell-projection interference |
| J3001 vs R3002 collision | YES: courtyard and land/shell-projection interference |
| Frozen copper collision | YES: direct plated-pad and drill intersections |

U3001 body F.Fab bounds are [34.95,5.35,37.05,7.45] and courtyard [34.325,4.975,37.675,7.825], deeply intersecting J3001. R3001/R3002 local footprints have no F.Fab body drawing; body dimensions are therefore not invented. Their courtyard bounds [39.545,5.605,41.455,6.595] and [37.645,6.605,39.555,7.595] intersect the connector body region.

All courtyard interferences at candidate (stroke-inclusive):

| Component | Existing fab/body bounds mm | Existing courtyard bounds mm | Body overlap | Courtyard overlap |
|---|---|---|---|---|
| R3005 | no F.Fab | [39.545, 4.605, 41.455, 5.595] | UNVERIFIED | YES |
| Q3002 | [39.5, 7.9, 40.9, 10.9] | [38.245, 7.675, 42.155, 11.125] | NO | YES |
| U3001 | [34.95, 5.35, 37.05, 7.45] | [34.325, 4.975, 37.675, 7.825] | YES | YES |
| C2001 | [34.55, 8.325, 36.65, 9.675] | [33.875, 7.995, 37.325, 10.005] | NO | YES |
| R3004 | no F.Fab | [37.645, 4.605, 39.555, 5.595] | UNVERIFIED | YES |
| R3001 | no F.Fab | [39.545, 5.605, 41.455, 6.595] | UNVERIFIED | YES |
| R3002 | no F.Fab | [37.645, 6.605, 39.555, 7.595] | UNVERIFIED | YES |
| U502 | [27.75, 5.55, 32.25, 10.65] | [26.075, 5.225, 33.925, 10.975] | NO | YES |
| R3003 | no F.Fab | [37.645, 5.605, 39.555, 6.595] | UNVERIFIED | YES |

Critical drill/copper witnesses (actual hole shape overlap at zero clearance, not merely body projection):

| Hole center mm | Drill size mm | Frozen net | Layer | Copper UUID |
|---|---|---|---|---|
| [39.89, 6.28] | [0.65, 0.65] | Net-(U502D--) | B.Cu | `3cead671-1940-41ad-8c07-f950de391a48` |
| [39.89, 6.28] | [0.65, 0.65] | Net-(U502D--) | B.Cu | `79224891-4829-44ad-bb76-703b91882d77` |
| [34.11, 6.28] | [0.65, 0.65] | Net-(U502D--) | B.Cu | `79224891-4829-44ad-bb76-703b91882d77` |
| [41.32, 6.78] | [0.6, 1.7] | AFE_MISO | B.Cu | `4ca1d46c-5e96-4d2b-9c2f-5db712d25e4a` |
| [41.32, 6.78] | [0.6, 1.7] | AFE_DRDY_N | B.Cu | `cdf0ea0b-e800-44e5-ad9c-aaaf1c2bdd7f` |
| [41.32, 6.78] | [0.6, 1.7] | AFE_CLKIN | B.Cu | `befa75c9-0bd4-472f-8e70-e1694c79b6f6` |
| [32.68, 6.78] | [0.6, 1.7] | Net-(D402-COM) | F.Cu | `d25e03c7-7c43-4c0a-933f-edc6215fef1c` |
| [32.68, 6.78] | [0.6, 1.7] | Net-(D402-COM) | B.Cu | `051274eb-cd39-4ddb-b487-7aef5d4b4645` |
| [32.68, 6.78] | [0.6, 1.7] | Net-(U502D--) | F.Cu | `49bb1e84-5b07-45cf-a087-a7153abd5d8d` |
| [32.68, 6.78] | [0.6, 1.7] | Net-(U502D--) | F.Cu | `c10a9ad6-70ad-4cf1-a969-4ca4eb8954e9` |
| [32.68, 6.78] | [0.6, 1.7] | Net-(U502D--) | B.Cu | `79224891-4829-44ad-bb76-703b91882d77` |
| [32.68, 2.6] | [0.6, 1.4] | AFE_CLKIN | B.Cu | `e1409a1a-eea3-44f9-b320-e0f48eeb6700` |
| [32.68, 2.6] | [0.6, 1.4] | MCU_RESET_N_AFE | B.Cu | `967d0827-2713-4608-9468-f35188472515` |

For example, shell slot (41.320,6.780) would cut the three Phase 3A B.Cu diagonals AFE_MISO/AFE_DRDY_N/AFE_CLKIN. Slot (32.680,2.600) would cut AFE_CLKIN and MCU_RESET_N_AFE. Slot (32.680,6.780) and the two restored NPTH holes intersect frozen analog copper. These intersections remain if U3001/R3001/R3002 move. They cannot be solved with another layer, a blind via or HDI: the connector requires those physical holes.

No candidate connector pad intersects an AFE_3V0 track/via in the all-copper test, so no direct Phase 3B AFE_3V0 blocker is established at this location. Existing GND zone fill under new independent shield pads would require normal future clearance/refill; no plane definition or fill was changed here.

RF keepout: candidate courtyard extends into x=42…42.345,y=0…5.5; nominal body ends x=41.47. This is a courtyard proximity concern, **not a KiCad keepout violation**: all four saved rule areas allow pads/footprints and prohibit tracks/vias/copperpour. Any USB routing must still respect those areas and preserve the RF boundary.

## Minimal-correction options

| Option | Decision | Evidence |
|---|---|---|
| A. Rotate/move J3001 only | REJECT | Missing SH and two NPTH persist; at specified datum J3001 overlaps local components and frozen copper. |
| B. Rotate/move J3001 + move U3001 | REJECT | Footprint defects persist; R3001/R3002 and other fixed courtyards plus actual frozen-copper/drill intersections remain. |
| C. Update J3001 footprint + placement | REJECT | Restores missing mechanical objects but makes NPTH/drill conflicts explicit. Datum-correct x=37 fails component and frozen copper checks. |
| D. Update J3001 footprint + placement + USB-local component placement | REJECT | Moving U3001/R3001/R3002 cannot remove U502 courtyard, Phase1 analog and Phase3A shell/drill intersections. Continuous top-edge courtyard exclusion remains even with those three removed. |
| E. Local board-outline modification | REJECT | Outline alone does not restore missing footprint objects. Existing orientation needs substrate on negative-y side of its edge datum at y=4.075; simple extension of top edge does not make that marker the edge. A cutout/notch would intersect preserved top-band tracks/plane structure; no collision-free outline redesign is established. Outside minimal validated correction. |

Horizontal top-edge alternatives: sampled 887 centers from x=5.35 to49.65 mm in 0.05 mm steps at y=3.675,180°. Ignoring J3001 plus movable U3001/R3001/R3002, every sample overlaps at least one fixed component courtyard. For rejected positions, copper search was unnecessary and skipped.

A continuous bound strengthens the discrete scan. Candidate courtyard half-width is 5.345 mm including stroke. Fixed courtyard overlap excludes connector centers in these overlapping intervals:

| Fixed component | Forbidden center x mm |
|---|---|
| J2001 | [-8.07, 14.07] |
| U501 | [4.23, 22.77] |
| U6001 | [12.83, 30.77] |
| U502 | [20.73, 39.27] |
| U7001 | [37.38, 59.62] |

Their union is (−8.070,59.620), covering the entire usable x interval [5.345,49.655]. These five are non-USB components, so even moving the additional interlock resistors/MOSFETs does not open a top-edge courtyard-safe location. This proof covers the manufacturer top-edge mounting orientation with unchanged non-USB components; it does not claim exhaustive evaluation of bottom/side mounting, another connector or a larger outline.

**MINIMAL CORRECTION:** No admissible mechanical implementation identified under current frozen-copper/fixed-non-USB-placement constraints. Necessary independent footprint correction is add SH at (+4.32,+1.075), 1.0x1.8 copper, 0.6x1.4 plated slot, and two 0.65 NPTH at (+/-2.89,-2.605); restore PCB Edge label/reference text/model metadata as desired; correct symbol S->SH and assign separate USB_SHIELD. Do not implement mounting at (37,3.675),180 degrees: it collides with frozen copper. A separately scoped mechanical/layout redesign or explicit frozen-geometry exception is needed before selecting an executable placement.

## USB routing consequence

There is no best admissible virtual correction, so route distances after an imaginary safe U3001 relocation are not invented. For the manufacturer-datum-correct but mechanically rejected candidate, distances to current local pads are:

| From | To | Original Euclidean mm | Rejected datum-correct candidate mm |
|---|---|---:|---:|
| J3001.A6 | U3001.1 | 8.8571 | 2.9901 |
| J3001.B6 | U3001.1 | 9.1090 | 2.3272 |
| J3001.A7 | U3001.2 | 9.4547 | 2.2855 |
| J3001.B7 | U3001.2 | 9.2664 | 3.1222 |
| J3001.A5 | U3001.4 | 10.2085 | 3.2941 |
| J3001.A5 | R3001.1 | 10.2938 | 2.1454 |
| J3001.B5 | U3001.5 | 11.3234 | 0.2663 |
| J3001.B5 | R3002.1 | 10.4010 | 2.8514 |
| U3001.1 | U7001.35 | 20.1603 | 20.1603 |
| U3001.2 | U7001.34 | 20.2923 | 20.2923 |

Correcting the datum brings connector data lands closer to the present ESD pads and puts them on substrate. The ESD-to-MCU distance remains unchanged until ESD placement changes. This would make nominal escape distances shorter, but actual routing is **harder/blocked** because it consumes existing component space and drills through frozen copper. Euclidean improvement is not feasibility. A usable ESD/CC placement must be selected only after an admissible connector mounting solution exists. No copper was added.

## Final gate

Gate definitions: embedded footprint matching means physical/metadata equivalence with official, not merely finding its source. Corrected placement identified means executable, collision-free placement, not only a solved edge equation. Required moves/frozen changes below describe what would be needed to retain the specified rejected candidate; they are not approval to make those changes.

```text
OFFICIAL FOOTPRINT MATCHED: NO
EMBEDDED FOOTPRINT MISSING SH PAD: YES
S -> SH SYMBOL CORRECTION REQUIRED: YES
MANUFACTURER PCB EDGE DATUM ESTABLISHED: YES
J3001 CORRECTED PLACEMENT IDENTIFIED: NO
J3001-ONLY CORRECTION COLLISION FREE: NO
U3001 MOVE REQUIRED: YES
R3001/R3002 MOVE REQUIRED: YES
BOARD OUTLINE CHANGE REQUIRED: NO
FROZEN COPPER CHANGE REQUIRED: YES
SPECIAL FABRICATION REQUIRED: NO
READY FOR PHASE 3C-0 IMPLEMENTATION: NO

MINIMAL CORRECTION:
No compliant implementation identified. Restore missing footprint objects and
S -> SH mapping only as specifications; resolve mounting/layout conflicts before
selecting a placement. Reject (37.000,3.675),180 degrees under frozen-copper rules.
```

BOARD OUTLINE CHANGE REQUIRED: NO means the candidate datum aligns to the current edge; no outline remedy is proven. FROZEN COPPER CHANGE REQUIRED: YES means the specified mounting cannot be built without repairing its actual drill intersections; because those edits are prohibited, reject it and stop. SPECIAL FABRICATION REQUIRED: NO; ordinary plated slots/NPTH and standard four-layer fabrication suffice once a valid layout exists. The cost target was not requoted.

Authority/source/object comparison/preservation gates: PASS. Candidate component and frozen-copper collision gates: FAIL. An admissible replacement layout and post-relocation distances: UNVERIFIED. No implementation readiness claim is made.

Stopped after preflight. No production, schematic, library, footprint, placement, routing, outline or zone changed. No USB routing or Phase 3D work was started.
