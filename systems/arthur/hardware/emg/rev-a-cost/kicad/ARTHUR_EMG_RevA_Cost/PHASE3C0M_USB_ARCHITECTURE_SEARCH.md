# Phase 3C-0M — USB mechanical architecture search

2026-09-27. **Recommend Option C: retain USB4105, restore its complete official footprint, add a local 12 × 5.4 mm top tab, and repack only U3001/R3001/R3002.** The virtual mounting clears fixed components, frozen tracks/vias and drilled features. It is ready for a concrete correction plan; routing, refilled DRC, plane topology and price are not yet qualified.

Production SHA-256 remains `d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005`. The frozen Phase 3B checkpoint remains byte-identical. All 1,072 captured pre-existing project files are unchanged. Only these two requested reports were created. No schematic, footprint library, placement, copper, Edge.Cuts, zone or frozen evidence was edited. No USB routing or Phase 3D work was started.

## Inputs and method

Read AGENTS.md, PHASE3C_USB_DISCOVERY.md, PHASE3C0_USB_MECHANICAL_PREFLIGHT.md and PHASE3B_ROUTING_FREEZE.md. Their established top-edge infeasibility, incomplete embedded footprint and S→SH requirement are accepted inputs, not repeated investigations.

The complete USB4105 model has sixteen signal pads, four SH plated slots and two Ø0.65 mm NPTH holes. Manufacturer edge datum is local y=+3.675 mm. The [GCT official drawing](https://gct.co/files/drawings/usb4105.pdf) and [official KiCad footprint](https://gitlab.com/kicad/libraries/kicad-footprints/-/blob/master/Connector_USB.pretty/USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal.kicad_mod) establish this geometry. Source hashes and complete alternative-footprint pad coordinates are in the JSON.

Read-only KiCad 10.0.6 shape checks use detached footprints against all 528 retained segments, 151 vias and fixed component pads. Copper is checked on every common layer, including both internal layers for drilled pads/holes. Thresholds: 0.20 mm foreign copper, 0.25 mm hole–copper and hole–hole, 0.50 mm copper–edge, conservative 0.25 mm hole–edge. Mechanical body/courtyard envelopes are checked independently from copper and hole interference. Courtyard bounding boxes are conservative for nonrectangular footprints; an overlap is not itself electrical collision evidence.

Only J3001/U3001/R3001/R3002 are omitted from fixed obstacles because this study permits their virtual relocation. All other components stay fixed. Saved zone fills are excluded from this collision test: holes and new shield lands need ordinary clearance refill during a later concrete verification. No zone definition or fill was changed here. This is a mechanical architecture screen, not full-board DRC or route completion.

## A — USB4105 on existing edges

Mouth-outward, all solder lands inward, F-side mounting gives bottom 0°, left 270° (KiCad reports −90°), right 90°. Opposite orientations put the mouth inward and/or lands outside substrate; quarter-turn alternatives do not face the selected edge. Backside flips are excluded by assembly intent.

| Edge | Datum-correct centers | Search interval / step | Candidates | Mechanical rejects | Copper rejects | Drill–copper rejects | Result |
|---|---|---|---:|---:|---:|---:|---|
| Bottom | (s,31.325), 0° | s=5.345…49.655; 0.05 mm | 887 | 887 | 887 | 887 | NOT VIABLE |
| Left | (3.675,s), 270° | s=5.345…29.655; 0.05 mm | 487 | 487 | 487 | 487 | NOT VIABLE |
| Right | (51.325,s), 90° | s=5.345…29.655; 0.05 mm | 487 | 487 | 487 | 487 | NOT VIABLE |

Every sampled candidate received independent mechanical and electrical tests. Hole–hole rejection counts are 377 left and 234 right; 94 right-edge positions put the body in the RF aperture. These are overlapping rejection categories, not mutually exclusive totals. All four SH slots, both NPTH, every signal land and edge distance are included.

Continuous courtyard exclusion intervals merge across the entire usable tangential domain on each edge, so there is no missed narrow mechanically free interval between samples. Bottom is blocked by J101/J201/J301/J401/J5001; left by power and analog components including J2001 and J101; right by U7001 and AFE/RLD components. This continuous proof concerns component envelopes; the independent dense copper results supply electrical evidence.

Least-conflicted sampled examples still fail:

| Edge / center | Fixed courtyard conflicts | Foreign copper conflicts | Drill–copper conflicts |
|---|---|---:|---:|
| Bottom (48.5,31.325) | J5001 | 14 | 3 |
| Left (3.675,29.05) | D102, D101, J101 | 31 | 16 |
| Right (51.325,10.7) | U7001 | 15 | 12 |

Counts in this table are pad/obstacle collision records, not necessarily distinct copper objects. JSON includes obstacle UUIDs, nets, layers, physical-overlap flags, and summaries for all 1,861 samples. Together with accepted top-edge evidence, no executable USB4105 mounting exists on the original rectangle under fixed non-USB placement.

## B — alternative receptacles

No USB-C footprint is installed in the local KiCad libraries or project ARTHUR.pretty. The official current KiCad Connector_USB library was searched remotely; nine alternatives were loaded for geometry inspection. Dimensions below are **F.Fab/courtyard envelopes including line stroke**, not substituted manufacturer dimensions. All shell and NPTH coordinates, sizes and drills are enumerated per candidate in JSON.

| Manufacturer / family; official footprint suffix | Fab W×D / courtyard W×D mm | Shell / locating holes | Datum and disposition |
|---|---|---|---|
| GCT USB4110; `GCT_USB4110` | 9.04×7.45 / 13.45×8.99 | 4 SMT anchors at x=±5.11, y=−3.105,+0.825; 2 Ø0.65 NPTH | KiCad edge y=3.675; manufacturer mounting UNVERIFIED. Removes shell drilling but broadens courtyard. |
| JAE DX07S016JA1R1500 | 9.04×7.00 / 10.99×8.48 | 4 PTH slots x=±4.32, y=−2.675,+1.15; NPTH at (±3,−1.95), Ø0.6/0.85×0.6 | KiCad edge y=3.1; manufacturer mounting UNVERIFIED. Shorter depth, larger shell lands. |
| HRO TYPE-C-31-M-12 | 9.04×7.40 / 10.69×9.47 | 4 PTH slots x=±4.32, y=−3.13,+1.05; NPTH (±2.89,−2.6), Ø0.65 | No explicit edge marker; drawing unavailable. No space advantage. |
| G-Switch GT-USB-7010ASV | 9.04×7.45 / 10.69×9.08 | 4 slots x=±4.32, y=−3.125,+1.075; 2 NPTH | No explicit edge marker; UNVERIFIED; nearly USB4105 geometry. |
| XKB U262-16XN-4BVC11 | 9.04×7.45 / 10.69×8.98 | 4 slots x=±4.32, y=−3.105,+1.075; 2 NPTH | No explicit edge marker; UNVERIFIED; nearly USB4105 geometry. |
| GCT USB4085 | 9.05×9.27 / 10.60×10.22 | 4 slots x=−1.35,+7.3, y=0.98,4.36; no NPTH | Larger envelope; edge datum UNVERIFIED. |
| HRO TYPE-C-31-M-17 | 9.04×6.90 / 10.69×8.43 | 4 slots; no NPTH | REJECT: six power/CC pads, no D+/D−. |
| G-Switch GT-USB-7051x | 9.04×4.40 / 9.99×6.45 | 4 PTH stakes; 2 locating holes | REJECT: vertical connector, no horizontal edge access. |
| Amphenol 12401610E4-2A | 9.30×10.55 / 10.83×11.65 | 4 slots; 2 NPTH | Deprioritized: 24 contacts, deeper envelope; no reduced-pin space benefit. |

The official footprints are [KiCad primary library sources](https://gitlab.com/kicad/libraries/kicad-footprints/-/tree/master/Connector_USB.pretty). Lack of a verified manufacturer datum is a qualification gap, not a guessed mounting offset.

USB4110 and JAE were screened at their nominal KiCad datums on all four edges at 0.10 mm spacing: no free courtyard envelope. Because their envelope screening is conservative, it does not prove exact nonrectangular courtyard impossibility; their current-outline status remains UNVERIFIED, not accepted. No claim that frozen copper is clear or that the existing ESD/CC placements can remain is made for an unqualified alternative. JAE's extended nominal placements do pass the frozen-copper checks described below.

**Best promising smaller alternative: GCT USB4215-03-A.** [GCT's product page](https://gct.co/connector/usb4215) and the [manufacturer brochure hosted by DigiKey](https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/6346/USB4215-03-A_Datasheet2.pdf) establish horizontal top mounting, sixteen USB2 SMT contacts, 6.50 mm body depth, four Ø0.8 mm PTH shell stakes and no locating pegs. This avoids two NPTH and reduces body depth versus USB4105's 7.35 mm. However, the exact mounting drawing could not be retrieved, no matching official footprint was found, and stake locations, body width, lands, courtyard and edge datum remain UNVERIFIED. Consequently its frozen-copper intersections, ESD/CC compatibility, board-space requirement and minimum extension cannot honestly be calculated. Product existence/features are verified; executable mounting evidence is not. No supplier quote or stock commitment was obtained. It is a follow-up procurement candidate, not the selected architecture.

## C — additive outline extension

A refined all-edge USB4105 search scanned extension depth and tangential placement in 0.10 mm steps, retaining fixed non-USB components/copper. At every depth all tangential positions in the original usable envelope were mechanically screened; mechanically free candidates received full copper/drill/edge checks.

| Edge | First passing depth on this grid | Approximate bounding dimensions | Consequence |
|---|---:|---|---|
| Top | **5.4 mm** | **55×40.4 mm** | Seven passing x values 36.7…37.3; selected x=37 |
| Bottom | 7.8 mm | 55×42.8 mm | Further from ESD/MCU, near analog connectors; local repacking not demonstrated |
| Left | 7.6 mm | 62.6×35 mm | Longer digital paths through/around analog/power; local repacking not demonstrated |
| Right | 7.6 mm | 62.6×35 mm | RF/enclosure implications and larger extension; local repacking not demonstrated |

These depths are grid minima within the scanned tangential domain, not global continuous optima, fabrication tolerances or proof over every undocumented connector. The proposed 12 mm tab width is a practical rounded width encompassing the 10.69 mm courtyard lateral envelope; a tighter width would save little and reduce margin. A uniform rectangle of 55×40.4 mm could use the same placement but adds 297 mm² instead of 64.8 mm²; the simple local tab is preferred for actual area, subject to panelization pricing.

For the best **screenable** smaller footprint, JAE, fixed-center nominal extension probes at x=36 top/bottom or y=17.5 left/right first passed at 7.1/6.8/6.6/6.8 mm. These are fixed-center probes, not optimized minima, and manufacturer datum remains UNVERIFIED. They do not beat the qualified USB4105 result. For the best promising smaller part USB4215, minimum extension and dimensions remain UNVERIFIED; no number can be derived safely from its 0.85 mm shallower body alone.

### Exact recommended virtual correction

| Object | Proposed center mm | Rotation / side |
|---|---|---|
| J3001, complete official USB4105 | (37.000,−1.725) | 180°, F-side |
| U3001, existing TPD4E05U06 land pattern | (35.600,4.850) | 90°, F-side |
| R3001 | (38.600,3.800) | 0°, F-side |
| R3002 | (40.600,3.800) | 0°, F-side |

Hypothetical outline is the original rectangle plus x=31…43, y=−5.4…0 mm. Closed polygon vertices: `(0,0),(31,0),(31,−5.4),(43,−5.4),(43,0),(55,0),(55,35),(0,35)`. It removes no original substrate and adds **64.8 mm² (3.37%)**. Bounding dimensions become **55×40.4 mm**, increasing bounding-box area **15.43%**. Manufacturer edge marker endpoints become `(32,−5.4)` and `(42,−5.4)`, exactly on the new tab's top edge: global y=−1.725−3.675=−5.400.

Signal-pad centers all have y=1.955 mm; x positions and duplicated contact numbers are in JSON. Four SH centers: `(32.68,1.38),(41.32,1.38),(32.68,−2.80),(41.32,−2.80)`. NPTH centers `(34.11,0.88),(39.89,0.88)`, Ø0.65. Both SH rows retain official 0.6×1.7 or 0.6×1.4 plated slots and their original annular lands. All solder lands and all holes lie on substrate in the **actual stepped polygon**, not merely its enclosing rectangle. Conservative minimum copper–edge is **1.18 mm**; minimum hole–edge **1.38 mm**, including tab sidewalls and concave shoulders.

F.Fab stroke-inclusive bounds are x=32.48…41.52, y=−5.45…2.00; courtyard bounds x=31.655…42.345, y=−5.93…3.06. The physical manufacturer body is approximately x=32.53…41.47, y=−5.4…1.95; slight Fab stroke/courtyard projection beyond the connector mouth edge is intentional. Body and lands avoid the x≥42 RF aperture. Courtyard can overlap the RF region permitted for footprints by the saved rule; this is not copper clearance permission for future tracks, vias or pours. Radio/enclosure qualification remains a later check.

All four transformed footprints pass independent checks against fixed component courtyards/bodies, pads, tracks, vias, holes and the RF aperture. The six inter-component pairs have no courtyard overlap and pass 0.20 mm pad-clearance tests. The proposed USB-local moves are architecture choices; retaining them at their current coordinates is not qualified by this passing pack. Frozen object moves required: **0 tracks, 0 vias, 0 non-USB components**, across Phase 1/2/3A/3B.

Restore the missing fourth SH land and both NPTH in J3001 through the complete official footprint, preserving all signal-pad numbers/net mappings. The future schematic correction changes shield pin number S→SH in the project library, cached USB symbol and J3001 instance; preserve pin name SHIELD and net USB_SHIELD. USB_SHIELD must remain separate from GND. These accepted requirements are inputs to the later plan, not applied here.

### Planes, fabrication and cost

This is a simple routed exterior tab with ordinary plated slots and NPTH. No connector change, added assembly side, HDI, blind/buried vias or via-in-pad process is required by the mounting architecture. Whole-board fabrication readiness is not certified; frozen baseline via/pad overlaps remain outside this study.

The proposed outline adds substrate rather than cutting through existing copper. Every original frozen track/via can remain. Signal lands remain inside the original rectangle, so extension of the internal zone polygons is not inherently required for the data escape. Restored NPTH/slots and shield lands require changed **derived clearance voids** on normal refill; preserving byte-identical fill polygons would be impossible. Preserve zone definitions, core GND continuity and no-island topology, and verify these during the concrete plan. No fill/topology PASS is claimed here. Do not pour GND onto USB_SHIELD lands.

Four-layer construction and F-side component intent are preserved. Board handling/panelization and PTH insertion already belong to USB4105 construction. Price is an estimate/risk: 3.37% actual area and 15.43% bounding-box area increase may affect panel yield, stencil/assembly setup or supplier brackets. The ~20–25 EUR assembled target was **not requoted**, so it is not a PASS gate.

## USB-local routing consequences

The passing pack keeps connector→ESD center distances approximately 4.1–4.7 mm and CC connections within a compact local region. Straight-line lower bounds from actual net assignments:

| Path | Approximate mm |
|---|---:|
| J3001 D+ A6/B6 → U3001.1 | 4.72 / 4.24 |
| J3001 D− A7/B7 → U3001.2 | 4.24 / 4.72 |
| U3001.1 → U7001.35 D+ | 20.32 |
| U3001.2 → U7001.34 D− | 20.21 |
| J3001 CC1 A5 → U3001.4 / R3001.1 | 4.46 / 1.85 |
| J3001 CC2 B5 → U3001.5 / R3002.1 | 4.13 / 5.18 |
| U3001.4/.5 → respective Rd pad | 2.87 / 4.05 |

These are Euclidean pad-center distances, not routed lengths. Duplicate D contacts still need correct merging, pair ordering and matched routing. The ESD→MCU path remains roughly 20 mm and must avoid frozen Phase 3A geometry. The tab removes the proven connector mounting blocker; it does not prove an F-only escape corridor. Ordinary through-vias and off-pad ground returns may be used in a future route if needed, but their precise sites, return path, impedance and ESD performance are UNVERIFIED. No signal or ground copper was added.

## D — frozen-geometry exception

**Not invoked.** Option C provides a viable mechanical architecture without any frozen track/via movement. No analog/reference exception, Phase 3A reroute or Phase 3B AFE_3V0/GND edit is proposed. U3001/R3001/R3002 relocation is USB-local placement work, not frozen digital or analog copper relocation.

## Ranking and certainty

| Rank / option | Frozen copper edits | USB-local moves | Area / process / side | Route complexity | Evidence / cost risk |
|---|---:|---|---|---|---|
| 1 — USB4105 top tab | 0 | J3001 + U3001 + both Rd | +64.8 mm²; standard four layers; F-side | Short local ESD, ~20 mm MCU path | Verified mounting and passing pack; price unquoted |
| 2 — qualify USB4215 before selecting | Unknown | Unknown | Potentially smaller; nominal standard/F-side | Unknown until drawing/footprint | Features verified; mounting unverified; sourcing/price unquoted |
| 3 — JAE nominal extension | 0 in passing connector probes | Repack not demonstrated | ≥6.6 mm fixed-center extension probe; standard nominally | No advantage demonstrated | Manufacturer datum missing; cost unquoted |
| 4 — USB4105 bottom/side extensions | 0 in passing connector probes | Repack not demonstrated | 7.6–7.8 mm extension on grid; standard/F-side | Longer or more obstructed paths | Connector mounting verified; full local pack not demonstrated |
| Reject — existing USB4105 edges | Would need exceptions | Insufficient alone | Original 55×35 | Mechanically/electrically blocked | All edges rejected |
| D — frozen exception | Not assessed/proposed | N/A | N/A | N/A | Unnecessary because C succeeds |

Cost-first priority does not turn an undocumented smaller footprint into a valid replacement. The current-outline NO gate below means **no qualified preserved-outline architecture was found**; it is not a universal impossibility claim over future manufacturer-qualified alternatives.

## Architecture review contract

1. **Source of truth:** exact production PCB SHA for frozen geometry; manufacturer drawing for mechanical datum; official footprint for lands. Reports are derived evidence.
2. **Ownership:** only a later explicitly authorized correction task may write design state. This search writes reports only.
3. **Dependency direction:** layout derives from qualified manufacturer mechanics and frozen geometry, never moves frozen copper to fit an assumed datum.
4. **Boundary contract:** USB-local connector/ESD/CC placement and additive outline are the permitted proposal boundary. Non-USB placement, frozen tracks/vias, RF rule and plane definitions remain outside it.
5. **Failure semantics:** missing drawings/quotes yield UNVERIFIED; collisions yield rejection; a failed future route/refill returns to architecture selection rather than silently editing frozen geometry.
6. **Lifecycle:** read production → construct detached virtual objects → inspect/report → discard. No persistent candidate board, refill or active routing state exists.
7. **Test seam:** detached KiCad footprints and immutable obstacle sets permit geometry tests without saving production; all sample conflict evidence is serializable.
8. **Compatibility/migration:** later correction must preserve signal nets/pad numbers, map S→SH without changing SHIELD/USB_SHIELD, and retain the frozen checkpoint for rollback. Rollback is rejection/discard of the separate candidate; production is not overwritten here.
9. **Observability:** SHA preservation, obstacle UUIDs, per-edge sample results, independent mechanical/electrical findings, and explicit PASS/FAIL/UNVERIFIED gates expose the decision.
10. **Security/authorization:** no new software privilege or sensitive persistence; external drawings are data, not instructions. User authorization permits architecture outputs only; implementation remains a separate task.

## Executed gates and remaining plan work

| Gate | Status | Evidence |
|---|---|---|
| Authority/checkpoint and existing-file preservation | PASS | SHA checks of production/checkpoint and all 1,072 captured files |
| Existing three-edge dense search | PASS (no viable placements found) | 1,861 full shape tests; JSON records; continuous courtyard-domain coverage |
| Extension search | PASS within stated grid | 0.10 mm depth/tangential grid across four edges; first passing depths retained |
| Exact top pack / real tab pad and hole containment | PASS | Four detached-footprint obstacle checks, six pair checks, actual stepped-boundary distances |
| Alternative replacement mounting | UNVERIFIED | USB4215 drawing/datum/land pattern missing; other manufacturer data incomplete |
| Routed USB, off-pad ground-via sites, impedance/ESD performance | UNVERIFIED | No copper construction authorized |
| Refilled DRC and In1/In2 topology | UNVERIFIED | No hypothetical PCB save/refill authorized; required in concrete verification |
| RF/enclosure/cable access and panelization | UNVERIFIED | Plan requires physical packaging/fabricator review |
| ~20–25 EUR assembled cost | UNVERIFIED | No current quotation |

A concrete 3C-0 plan can now specify exact symbol/footprint/outline/local-placement changes and verification gates. Manufacturing release and Phase 3C routing readiness are not claimed. Keep frozen copper identities and compare refilled DRC separately from existing violations during later authorized work.

## Required final summary

```text
EXISTING USB4105 / TOP EDGE: NOT VIABLE
USB4105 / BOTTOM EDGE: NOT VIABLE
USB4105 / LEFT EDGE: NOT VIABLE
USB4105 / RIGHT EDGE: NOT VIABLE

ALTERNATIVE CONNECTOR FOUND: YES
BEST ALTERNATIVE: GCT USB4215-03-A (promising; mounting qualification incomplete)
MANUFACTURER EVIDENCE: UNVERIFIED

CURRENT 55x35 OUTLINE CAN BE PRESERVED: NO
BOARD EXTENSION REQUIRED: YES
MINIMUM PROPOSED DIMENSION CHANGE: top tab x=31..43 mm, y=-5.4..0 mm; bounding dimensions 55 x 40.4 mm

USB-LOCAL COMPONENT MOVE REQUIRED: YES
FROZEN PHASE 3A COPPER MOVE REQUIRED: NO
FROZEN PHASE 1 ANALOG MOVE REQUIRED: NO

SPECIAL FABRICATION REQUIRED: NO
SINGLE-SIDED ASSEMBLY PRESERVED: YES

RECOMMENDED ARCHITECTURE:
Option C: complete official USB4105 footprint on a 12 x 5.4 mm additive top tab; J3001=(37,-1.725),180deg; U3001=(35.6,4.85),90deg; R3001=(38.6,3.8),0deg; R3002=(40.6,3.8),0deg; S->SH mapping; preserve SHIELD/USB_SHIELD and every frozen track/via.

READY FOR A CONCRETE 3C-0 IMPLEMENTATION PLAN: YES
```

Stopped after architecture search. No implementation, routing or Phase 3D.
