# PHASE3C-0Q — USB4215 final qualification

**READY = NO.** This check closes the exact JLC library-status blocker and demonstrates that the prior placements' shell clearances can be carved from the saved GND planes without disconnecting them. The manufacturer PCB-edge datum and internal receptacle shell/GND relationship remain **UNVERIFIED**. A fully specified, manufacturer-correct replacement placement is therefore unavailable.

Scope: decision/qualification only, 2026-09-27. All four requested inputs and project AGENTS.md were read. Authoritative production SHA-256 `d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005`; 528 tracks, 151 vias, four copper layers, 1.60 mm thickness. No design/footprint/zone/rule edits, saved candidate, refill or routing. The failed candidate is not a base. All 2169 preexisting files are hash-preserved; only the two requested qualification reports are added.

## 1. Manufacturer edge and mechanical requirements

The current direct [GCT drawing](https://gct.co/files/drawings/usb4215.pdf) and [GCT specification](https://gct.co/files/specs/usb4215-spec.pdf) both downloaded successfully (HTTP 200). Their hashes match the manufacturer-authored distributor copies: drawing `1659ba00769b9b774a033fac72cb2f3bfc481a3272c53f34e87520f33635a9e1`, specification `df4c8de86a682a3262d1006fe4b60d8930b133a4ee6402263922507474bfe178`. Both are revision A, 26 April 2024. JSON binds byte counts and URLs.

Search coverage included both drawing sheets, all twelve specification pages, the [GCT product page](https://gct.co/connector/usb4215), [release notice](https://gct.co/news/usb4215), [GCT Essential Knowledge Guide #1](https://gct.co/files/productbrochures/gct-essential-knowledge-guide-usb-type-c.pdf) and focused manufacturer-site searches. The drawing has a recommended PCB layout and component outline, but no labeled recommended PCB edge or setback. The specification directs mechanical dimensions back to the drawing. No product-specific board-thickness range or edge mounting tolerance was found. This establishes a search result, not proof that GCT has no unpublished guidance.

```text
PCB EDGE DATUM: UNVERIFIED
Exact manufacturer-defined board-edge relation: not found
Setback / overhang limits: UNVERIFIED
Board thickness requirement: UNVERIFIED
```

The component-side layout is dimensioned ±0.05 mm. Nominal rear plated slots are 0.60×1.40 and front slots 0.60×1.80. Whether that tolerance governs finished plated dimensions and what production variation GCT accepts remain unanswered. The 0.80±0.20 stake dimension is length below the mounting plane, not drill diameter. On a 1.60 board it can remain recessed; this is a solder-process qualification question, not evidence for changing board thickness.

The generic GCT guide discusses through-hole stakes and pin-in-paste reflow, with thickness examples for **USB4140**. It does not qualify USB4215 on 1.60 mm or define USB4215's edge. Dashed body geometry and generic guidance cannot substitute for that missing datum.

### GCT question — prepared, not sent

> Please qualify GCT USB4215-03-A using drawing revision A dated 26 April 2024. In component-side view, use the midpoint between the two front shell-slot centers as (0,0), with +Y toward the mating mouth. The rear slot centers are Y=-4.00 mm, the signal-land centers Y=-4.575 mm, and the depicted mouth is Y=+2.10 mm. What is the exact recommended PCB edge Y coordinate, its tolerance, and allowed connector overhang/setback? Please supply a manufacturer-defined dimensioned edge drawing or application note; do not merely identify the dashed Component Outline. Specify supported PCB thickness range and explicitly confirm 1.60 mm four-layer FR-4 with the 0.80±0.20 mm stakes: is pin-in-paste with stakes recessed within plated slots approved, and what solder fill/retention requirements apply? Confirm finished plated slot dimensions 0.60×1.40 rear and 0.60×1.80 front, width/length/position tolerances and whether the layout ±0.05 applies to finished slots. Can nominal +0.13/-0.08 mm finished-slot tolerance be accepted, or what tighter capability is required?

A written dimensioned manufacturer response is needed before restarting the placement search.

## 2. Internal shell relation

**SHELL → SIGNAL GND INTERNAL CONNECTION: UNVERIFIED.** The drawing's SHELL/GND designation is not a continuity schematic. Product specification §6.1.4 and its repeat on page 8 test **plug side latches** against GND contacts; neither explicitly describes the four receptacle shell stakes. The general insulation test does not identify shell-to-GND pairs. Applying either result to the receptacle would be an inference, which is insufficient here. [GCT specification, manufacturer-authored mirror](https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/6328/USB4215-03-A1.pdf)

Retain `SHIELD → USB_SHIELD`, `USB_SHIELD != GND`. A library net name cannot prevent an internal metal bond. Even if the unmated receptacle is isolated, plugged-state continuity must be clarified separately.

### GCT electrical question — prepared, not sent

> For an UNMATED, UNSOLDERED USB4215-03-A receptacle, are the four shell stakes electrically common with one another and internally bonded to any A1/B1/A12/B12 contact or the midplate? Please provide the internal continuity matrix and maximum DC resistance for bonded pairs, or minimum isolation resistance for isolated shell-to-contact pairs. Does this relationship change when a compliant plug is inserted? The drawing labels SHELL as GND, while product specification section 6.1.4 refers to plug side latches. Does either statement describe an internal receptacle connection, or only the USB plug/interface recommendation? We intend all four SH PCB pads on USB_SHIELD, separate from signal GND; confirm whether this is physically realizable with this exact part, without altering the connector.

## 3. Detached canonical model

A KiCad FOOTPRINT and PAD model was constructed **in RAM only**, including sixteen individual logical contact numbers on twelve physical signal lands and four `SH` plated pads. Executed assertions verified the exact set A/B {1,4,5,6,7,8,9,12}, sixteen logical pads, twelve unique land locations and four SH pads. JSON records every pad, coordinate, copper size, drill and semantic net mapping. No .kicad_mod or board was saved.

The following geometry is reconstructed from the GCT drawing, with origin at the midpoint of front shell-slot centers and +Y toward the mouth. That origin is an analysis convention, **not an approved pick-and-place centroid**.

| Logical contact | X | Y | Copper W×H | Existing function |
|---|---:|---:|---:|---|
| B12 | -3.20 | -4.575 | 0.60 × 1.15 | GND |
| B9 | -2.40 | -4.575 | 0.60 × 1.15 | VBUS |
| A9 | +2.40 | -4.575 | 0.60 × 1.15 | VBUS |
| A12 | +3.20 | -4.575 | 0.60 × 1.15 | GND |
| B1 | +3.20 | -4.575 | 0.60 × 1.15 | GND |
| B4 | +2.40 | -4.575 | 0.60 × 1.15 | VBUS |
| B5 | +1.75 | -4.575 | 0.30 × 1.15 | CC2 |
| A8 | +1.25 | -4.575 | 0.30 × 1.15 | SBU1 |
| B6 | +0.75 | -4.575 | 0.30 × 1.15 | USB_D+ |
| A7 | +0.25 | -4.575 | 0.30 × 1.15 | USB_D- |
| A6 | -0.25 | -4.575 | 0.30 × 1.15 | USB_D+ |
| B7 | -0.75 | -4.575 | 0.30 × 1.15 | USB_D- |
| A5 | -1.25 | -4.575 | 0.30 × 1.15 | CC1 |
| B8 | -1.75 | -4.575 | 0.30 × 1.15 | SBU2 |
| A4 | -2.40 | -4.575 | 0.60 × 1.15 | VBUS |
| A1 | -3.20 | -4.575 | 0.60 × 1.15 | GND |

The coincident pairs are A1/B12, A4/B9, B4/A9 and B1/A12. Each pair has matching nets and full identical physical land geometry; no logical endpoint is discarded. A6/B6 and A7/B7 remain separate physical lands with their existing common D+/D− functions.

| Shell centers | Oval copper | Plated oval slot |
|---|---|---|
| (±4.32,−4.00) | 1.00×1.80 | 0.60×1.40 |
| (±4.32,0.00) | 1.00×2.20 | 0.60×1.80 |

Nominal body envelope X±4.47, Y−4.40…+2.10; mouth local Y+2.10; mating +Y. Fab is a rectangular dimension-derived envelope, not an assertion of undimensioned shell corner detail. Engineering courtyard centerline X±5.32, Y−5.65…+2.60 with 0.05 stroke and 0.50 margin is explicitly **non-manufacturer**. Mask/paste layer membership is an engineering convention; shell paste volume is not yet qualified. PCB-edge datum is `null`, not a guessed graphic. Therefore **CANONICAL FOOTPRINT FULLY SPECIFIED = NO**.

`SH` is the ARTHUR mapping choice, not a manufacturer stake number. It is consistent with a later number-only S→SH change in the ARTHUR USB_C library pin, schematic cache and J3001 instance. Preserve name SHIELD and net USB_SHIELD. No symbol changes were applied.

## 4. Placement qualification

**No geometry search using a VERIFIED edge datum was run**, because no such datum was established. Both requested fit gates and the minimum qualified tab remain UNVERIFIED. Prior Phase3C0R mouth-flush results are retained as conditional evidence, not relabeled as qualification.

| Prior hypothetical tab | Connector origin / rotation | Prior conditional evidence |
|---|---|---|
| X31…43, Y−5.40…0 | (37,−3.30),180° | Copper, holes, RF, fixed/USB-local placement screen passed |
| X31.65…42.35, Y−4.65…0 | (37,−2.55),180° | Same screens passed; 0.53 copper-to-side-edge margin |

Prior USB-local packing: U3001 (35.60,4.85),90°; R3001 (38.60,3.80),0°; R3002 (40.60,3.80),0°. Zero frozen track/via or non-USB moves were demonstrated for those conditional locations. Required moves for an unknown manufacturer edge cannot yet be proved; final zero counts refer only to that demonstrated conditional architecture.

Once GCT supplies the datum, rerun against every one of the 528 track and 151 via obstacles, every fixed footprint and hole, USB-local mutual geometry, RF keepout, the actual tab polygon, project copper/hole clearances, intrinsic shell-to-signal copper and hole separation. No saved PCB candidate is authorized by this task.

## 5. GND plane projection

The saved In1/In2 fills intersect the virtual right rear SH pad at both prior placements. These are **stale-fill intersections**, not evidence of an unavoidable metal collision. Frozen foreign tracks/vias were already screened separately in Phase3C0R; no impossible overlap was identified in those conditional locations.

A new execution copied the saved polygons into detached `SHAPE_POLY_SET` objects and subtracted all four SH copper envelopes expanded by each zone's actual **0.50 mm** clearance. KiCad's polygon conversion used 0.001 mm maximum error with conservative outside approximation. No ZONE setter or zone filler was called, and no board was altered.

| Conditional tab | Layer | Connected polygons before→after | GND anchor points tested / lost | Removed area mm² |
|---|---|---:|---:|---:|
| 12×5.4 | In1.Cu | 1 → 1 | 57 / 0 | 2.464449 |
| 12×5.4 | In2.Cu | 1 → 1 | 57 / 0 | 2.464449 |
| 10.7×4.65 | In1.Cu | 1 → 1 | 57 / 0 | 3.648820 |
| 10.7×4.65 | In2.Cu | 1 → 1 | 57 / 0 | 3.648820 |

For every projection: one connected GND polygon, zero GND islands, zero lost tested GND anchor points, and no shell-envelope collision at a 0.499 mm check (one micron below nominal to avoid boundary rounding). Tested anchors are frozen GND track endpoints/midpoints and via/PTH pad centers already inside the saved plane, not arbitrary newly claimed connections. JSON records zones and results.

**SHIELD/GND ISOLATION GEOMETRICALLY FEASIBLE: YES, at the two conditional placements.** Normal refill should carve those foreign-net SH clearances while preserving a connected residual plane. The projection is a constructive geometric feasibility check, not an executed KiCad refill, complete electrical connectivity audit or proof of connector internal isolation. It does not model new thermal decisions, island removal, minimum-thickness filters or a future changed edge datum. Actual refill/DRC remains UNVERIFIED and is required in the next authorized implementation candidate.

Keep SH assigned to USB_SHIELD on every copper layer, retain GND zone nets/outline/priority, retain RF keepouts, then verify no cross-net contact and no islands after actual refill. Clearing stale fill must not move any frozen track/via or silently redefine GND scope. If someone requires saved filled polygons themselves to remain immutable, the local clearance cannot be created; that is a different constraint from preserving zone structure and frozen tracks/vias.

## 6. JLC / LCSC qualification

The [exact JLC part page](https://jlcpcb.com/partdetail/39339856-USB4215_03A/C37616412) was found through the live official MPN search, then inspected directly. It identifies C37616412 / GCT USB4215-03-A as **Extended**, **SMT Assembly**, **Economic and Standard**, MSL1. Live stock was **232**; displayed USD 1+ **0.8965**, 1200+ **0.4889**. This is direct assembly-library evidence, distinct from LCSC stock. **JLC ASSEMBLY STATUS = VERIFIED at the library/service-eligibility level.** It is not a job acceptance or stock reservation.

[LCSC](https://www.lcsc.com/product-detail/USB-Connectors_Global-Connector-Technology-USB4215-03-A_C37616412.html) separately shows 130 pieces, MOQ/multiple one, USD 1+0.9047, 10+0.7359, 30+0.6523, 100+0.5687, 500+0.5196, 1200+0.4933. Both observations are dated 2026-09-27 and may change.

[JLC process capabilities](https://jlcpcb.com/capabilities/pcb-assembly-capabilities) support single-side four-layer Economic assembly and mixed SMT/through-hole work. This exact connector is listed SMT, but the public details do not state how all shell stakes are soldered on a 1.60 board. No part-specific solder-paste, recessed-stake or angular-offset instruction was found in its Assembly Tips. Those job details remain UNVERIFIED.

The [rigid fabrication table](https://jlcpcb.com/capabilities/pcb-capabilities) supports nominal 0.60 plated oval slots in a four-layer process, a 0.20 annulus at 1oz and ordinary mechanical drilling. Published slot tolerances +0.13/−0.08 are broader than the GCT layout tolerance; interpretation needs confirmation. No HDI, blind vias or special holes are introduced by this model.

[JLC orientation guidance](https://jlcpcb.com/help/article/pcb-assembly-faqs-part-2) warns that library zero-degree orientation may differ from the customer's. The CPL must use an approved centroid/top side and match the mouth direction/contact ordering in the assembly preview and reviewed DFM image. The model's front-slot origin is not automatically that centroid; no part-specific rotation offset was invented.

### Part-specific JLC process query — prepared, not sent

> Please review exact library part C37616412 / GCT USB4215-03-A, currently listed Extended, SMT Assembly, Economic and Standard. For a 1.60 mm standard four-layer FR-4 board with F-side assembly, will your SMT process solder all 16 signal contacts (12 physical lands) AND all four through-hole shell stakes? Stakes protrude 0.80±0.20 mm, into plated oval slots 0.60×1.40 mm (rear) and 0.60×1.80 mm (front), with oval copper 1.00×1.80 and 1.00×2.20 mm respectively. Please confirm pin-in-paste versus a secondary/manual process, shell-slot paste/annulus requirements, finished-slot and registration tolerances, board-thickness restrictions, and all part-specific charges or Economic-PCBA restrictions. Confirm your approved centroid and zero-degree/reel orientation against a component-side drawing (mouth direction and A1/B12 land), rather than adopting our front-slot midpoint as the pick-and-place centroid. Confirm availability and feeder/setup status for our eventual quantity. All shell lands must remain on USB_SHIELD, electrically separate from GND on every layer; can CAM retain this geometry without changing holes/lands? Written job approval must refer to the eventual manufacturer-qualified edge datum and submitted Gerber/drill/BOM/CPL hashes; no job files are being submitted with this inquiry.

## 7. Cost impact

| Outline assumption | Added area | Total area | Increase vs 55×35 |
|---|---:|---:|---:|
| Accepted 12×5.4 tab | 64.800 mm² | 1989.800 mm² | 3.366% |
| Conditional 10.7×4.65 tab | 49.755 mm² | 1974.755 mm² | 2.585% |

The smaller tab saves 15.045 mm² versus the accepted tab. These are polygon areas, not enclosing-rectangle pricing estimates, qualified dimensions or a fabrication quote.

The part is Extended, so an Economic feeder-loading charge is probable: approximately USD3–3.07 per distinct extended part type/order, allocated across the lot. [JLC FAQ](https://jlcpcb.com/help/article/pcb-assembly-faqs) quotes $3; the [current detailed price page](https://jlcpcb.com/help/article/pcb-assembly-price) shows $3.07. Do not treat it as per-board cost, assume a preferred-part waiver, or infer the connector's secondary soldering charges. Quantity, setup, stencil, assembly/inspection, other BOM costs, shipping and taxes remain quote-dependent.

The **~20–25 EUR assembled-board target is a constraint only**. No order quote was obtained and the target does not pass this qualification.

## Final gate

```text
USB4215 MANUFACTURER PCB EDGE DATUM: UNVERIFIED
USB4215 SHELL/GND INTERNAL RELATION: UNVERIFIED
CANONICAL USB4215 FOOTPRINT FULLY SPECIFIED: NO
USB4215 12x5.4 TAB FIT: UNVERIFIED
USB4215 SMALLER TAB FIT: UNVERIFIED
MINIMUM QUALIFIED TAB: NONE — no verified manufacturer edge datum
FROZEN TRACK MOVES REQUIRED: 0
FROZEN VIA MOVES REQUIRED: 0
NON-USB COMPONENT MOVES REQUIRED: 0
USB_SHIELD/GND ISOLATION FEASIBLE AFTER REFILL: YES
JLC ASSEMBLY STATUS: VERIFIED
STANDARD FOUR-LAYER PROCESS: PRESERVED
READY FOR REVISED PHASE 3C-0 IMPLEMENTATION PLAN: NO
```

Scope of YES for isolation: constructive PCB-plane geometry at the prior hypothetical placements, with actual refill and internal metal isolation UNVERIFIED. Scope of JLC VERIFIED: exact public part-library and advertised service status; job-specific approval remains pending. PRESERVED means four-layer production is unchanged and the nominal model introduces no HDI; USB4215 board-thickness compatibility is still unqualified.

Remaining manufacturer blockers prevent a concrete manufacturer-correct implementation plan. The GCT and JLC questions above are ready to send, but **no messages were sent**. Stop: no design/rule/zone edits, routing or Phase3D.
