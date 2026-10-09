# Phase 3C — USB routing discovery / preflight only

Date: 2026-09-27. Discovery is complete; routing is blocked. No design file, placement, copper, footprint, symbol, outline, zone or frozen evidence was edited. No candidate PCB was created, no board was saved and no zone refill occurred.

PRODUCTION SHA VERIFIED: YES

Production and FinalClean are byte-identical before/after: `d7a585e8ae46299215d26c0aa58ea0ca5829d46ce72a45d279290263e94a0005`. All six Phase 3B manifest bindings pass. All 394 captured design-file hashes remain unchanged. Read AGENTS.md, Phase 3A freeze, Phase 3B discovery/freeze and manifest. AGENTS.md records the later production promotion; older freeze prose describes its pre-promotion snapshot.

## Evidence and baseline

Executed fresh `kicad-cli sch export netlist --format kicadxml` to `/tmp/phase3c_schematic.xml`, read the embedded and library USB_C symbols, local ESD footprint, board-embedded connector footprint, component selection/BOM, project/rules, and reconstructed all physical net components using KiCad 10.0.6 `BuildConnectivity` / `GetConnectedItems`, including saved zone fills. UUIDs, coordinates, pad extents and per-net partitions are in the JSON.

Executed on production:

```bash
kicad-cli pcb drc --severity-all --all-track-errors --format json \
  --output phase3c_usb_baseline_drc.json ARTHUR_EMG_RevA_Cost.kicad_pcb
```

**CURRENT UNCONNECTED PAIRS: 92**. All 92 physical net component deficits reconcile exactly, net by net, to fresh DRC. Exit 0 means successful report generation, not a clean board.

Fresh ordinary violations: **525**, versus frozen expected **548**. The absent 23 are `nonmirrored_text_on_back_layer` warnings emitted in saved freeze verification. Unchanged production bytes and equal remaining category totals establish no repair; warning serialization/emission differs. The raw report is retained unchanged.

| Category | Fresh | Frozen |
|---|---:|---:|
| copper_edge_clearance | 3 | 3 |
| silk_overlap | 199 | 199 |
| silk_over_copper | 199 | 199 |
| lib_footprint_issues | 57 | 57 |
| lib_footprint_mismatch | 55 | 55 |
| silk_edge_clearance | 12 | 12 |
| nonmirrored_text_on_back_layer | 0 | 23 |
| Ordinary total | 525 | 548 |

The three reported copper-edge violations concern U4002.3, U4002.4 and J2001.MP. Exterior J3001 pads are not represented by those three reports; absence of a DRC item does not qualify their mounting geometry.

## USB_SHIELD MAPPING

Status: FAIL. **Mapping valid: NO**.

- Schematic shield pin identifier: `S`; name `SHIELD`, exported function `SHIELD_S`.
- Schematic shield net: `USB_SHIELD`, sole endpoint `J3001.S`.
- Footprint shield pad identifiers: three distinct physical pads, all numbered `SH`.
- PCB shield pad nets: empty / empty / empty (net code 0); no physical `USB_SHIELD` PCB net.

Symbol/footprint pad-number mismatch; not a missing schematic pin or proven footprint-only mechanical NC. SH pads are plated slotted through-hole shell pads.

The schematic explicitly states: “USB_SHIELD coupling to circuit/chassis ground is intentionally unresolved pending enclosure and EMC design.” This supports deferred termination, not intentional removal of shield connectivity. Do not merge it into GND.

**Smallest correction if separately authorized:** Preferred mapping correction: rename USB_C shield pin number S to SH in ARTHUR.kicad_sym and cached ARTHUR:USB_C symbol / J3001 pin instance in usb_c_interlock.kicad_sch; keep pin name SHIELD and net USB_SHIELD. A separately authorized PCB update assigns USB_SHIELD to all three existing J3001.SH pads without changing their geometry. Alternative is rename all three footprint pad numbers SH to S in a maintained project footprint and J3001, with separate net assignment. No correction applied.

## J3001 BOARD-EDGE

**BOARD-EDGE COMPATIBILITY: UNVERIFIED**

Footprint: `Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal`. J3001 is at (37.000, 0.400) mm, rotation 0°, F.Cu. Identity: GCT USB4105-xx-A family indicated by footprint name only; exact ordering code/variant not established; component selection says shell TBD.

Edge.Cuts is one rectangle from (0,0) to (55,35) mm, including a continuous top edge y=0 beneath the connector. No connector cutout, notch or local edge feature exists.

All 16 numbered signal/power/GND SMT pads have center y=-3.280 and copper y=-3.855…-2.705 mm. These are solder lands in the PCB, not merely overhanging metal contacts. Their entire copper area is outside the saved board substrate. Pads on coincident A/B positions remain separate numbered endpoints but share physical copper.

| Pad | Net | Center x,y mm | Copper xmin,ymin,xmax,ymax mm | Drill x,y mm |
|---|---|---|---|---|
| J3001.A1 (6e3ebec7) | GND | [33.8, -3.28] | [33.5, -3.855, 34.1, -2.705] | [0.0, 0.0] |
| J3001.A4 (9f1945db) | USB_VBUS | [34.6, -3.28] | [34.3, -3.855, 34.9, -2.705] | [0.0, 0.0] |
| J3001.A5 (ed3ddd28) | CC1 | [35.75, -3.28] | [35.6, -3.855, 35.9, -2.705] | [0.0, 0.0] |
| J3001.A6 (70d62980) | USB_D+ | [36.75, -3.28] | [36.6, -3.855, 36.9, -2.705] | [0.0, 0.0] |
| J3001.A7 (5562e47b) | USB_D- | [37.25, -3.28] | [37.1, -3.855, 37.4, -2.705] | [0.0, 0.0] |
| J3001.A8 (6abb94fc) | unconnected-(J3001-SBU1-PadA8) | [38.25, -3.28] | [38.1, -3.855, 38.4, -2.705] | [0.0, 0.0] |
| J3001.A9 (595ae39d) | USB_VBUS | [39.4, -3.28] | [39.1, -3.855, 39.7, -2.705] | [0.0, 0.0] |
| J3001.A12 (202e60a7) | GND | [40.2, -3.28] | [39.9, -3.855, 40.5, -2.705] | [0.0, 0.0] |
| J3001.B1 (9186e189) | GND | [40.2, -3.28] | [39.9, -3.855, 40.5, -2.705] | [0.0, 0.0] |
| J3001.B4 (4437d973) | USB_VBUS | [39.4, -3.28] | [39.1, -3.855, 39.7, -2.705] | [0.0, 0.0] |
| J3001.B5 (a2d6e4a6) | CC2 | [38.75, -3.28] | [38.6, -3.855, 38.9, -2.705] | [0.0, 0.0] |
| J3001.B6 (3558908b) | USB_D+ | [37.75, -3.28] | [37.6, -3.855, 37.9, -2.705] | [0.0, 0.0] |
| J3001.B7 (e3da980a) | USB_D- | [36.25, -3.28] | [36.1, -3.855, 36.4, -2.705] | [0.0, 0.0] |
| J3001.B8 (dca3f9c4) | unconnected-(J3001-SBU2-PadB8) | [35.25, -3.28] | [35.1, -3.855, 35.4, -2.705] | [0.0, 0.0] |
| J3001.B9 (58847fd6) | USB_VBUS | [34.6, -3.28] | [34.3, -3.855, 34.9, -2.705] | [0.0, 0.0] |
| J3001.B12 (4cb58fa9) | GND | [33.8, -3.28] | [33.5, -3.855, 34.1, -2.705] | [0.0, 0.0] |
| J3001.SH (f5592606) | no net | [32.68, -2.705] | [32.18, -3.755, 33.18, -1.655] | [0.6, 1.7] |
| J3001.SH (35603db2) | no net | [32.68, 1.475] | [32.18, 0.575, 33.18, 2.375] | [0.6, 1.4] |
| J3001.SH (6a8af92a) | no net | [41.32, -2.705] | [40.82, -3.755, 41.82, -1.655] | [0.6, 1.7] |

Shell pads are plated slotted through-hole copper on all copper layers. Two front shell pads center y=-2.705, copper y=-3.755…-1.655, drill slot y=-3.555…-1.855: entirely outside the board. The rear shell pad center y=1.475 has copper y=0.575…2.375, drill y=0.775…2.175, hence 0.575 mm copper and 0.775 mm drilled-feature distance to the top edge. Those rear distances alone exceed the stored 0.50 mm copper-edge minimum. Only three SH pads are present; do not invent a fourth from the family name.

F.Fab body centerline bounds: x=32.530…41.470, y=-3.275…4.075 mm. F.CrtYd centerline bounds: x=31.680…42.320, y=-4.360…4.580 mm. Stroke-inclusive bounding boxes and silkscreen graphics are in JSON. Fab body overhang toward y<0 is 3.275 mm. A Dwgs.User horizontal line is at y=4.075, x=32…42; it coincides with the opposite fab-body end. It may mark intended board insertion geometry, but has no explicit board-edge label or manufacturer authority.

No exact connector datasheet/land-pattern file was found in repository or installed local footprint searches. The project datasheet field links a generic USB specification; component selection says shell TBD. The footprint family/name and body overhang do not prove intentionally supported edge-mounted solder lands. Exact insertion direction/edge datum therefore remains unverified.

**Manufacturing concern, separately:** ordinary SMT lands and two plated slots cannot be fabricated/assembled without substrate at their saved locations. A placement, footprint or outline correction is required for conventional assembly unless exact manufacturer evidence establishes another supported construction. The smallest correction and rotation cannot be chosen yet. Do not move J3001 on a guessed datum. This blocks connector escape planning; frozen copper changes are not established.

## Exact USB signal connectivity

### USB_D+

Schematic endpoints: `J3001.A6` (D+_A6); `J3001.B6` (D+_B6); `U3001.1` (D1+_1); `U7001.35` (D+_35).

PCB pads: `U3001.1` at [34.9875, 5.4] mm, `J3001.A6` at [36.75, -3.28] mm, `J3001.B6` at [37.75, -3.28] mm, `U7001.35` at [53.15, 14.15] mm.

Connected/isolated groups: {J3001.A6} | {J3001.B6} | {U3001.1} | {U7001.35}.

Groups: **4**; missing pairs: **3**; tracks: **0**; vias: **0**. Every group is isolated. Schematic and PCB numbered signal endpoints agree.

### USB_D-

Schematic endpoints: `J3001.A7` (D-_A7); `J3001.B7` (D-_B7); `U3001.2` (D1-_2); `U7001.34` (D-_34).

PCB pads: `U3001.2` at [34.9875, 5.9] mm, `J3001.A7` at [37.25, -3.28] mm, `J3001.B7` at [36.25, -3.28] mm, `U7001.34` at [53.15, 14.95] mm.

Connected/isolated groups: {J3001.A7} | {J3001.B7} | {U3001.2} | {U7001.34}.

Groups: **4**; missing pairs: **3**; tracks: **0**; vias: **0**. Every group is isolated. Schematic and PCB numbered signal endpoints agree.

### CC1

Schematic endpoints: `J3001.A5` (CC1_A5); `R3001.1` (1_1); `U3001.4` (D2+_4).

PCB pads: `U3001.4` at [34.9875, 6.9] mm, `J3001.A5` at [35.75, -3.28] mm, `R3001.1` at [39.99, 6.1] mm.

Connected/isolated groups: {J3001.A5} | {R3001.1} | {U3001.4}.

Groups: **3**; missing pairs: **2**; tracks: **0**; vias: **0**. Every group is isolated. Schematic and PCB numbered signal endpoints agree.

### CC2

Schematic endpoints: `J3001.B5` (CC2_B5); `R3002.1` (1_1); `U3001.5` (D2-_5).

PCB pads: `U3001.5` at [34.9875, 7.4] mm, `J3001.B5` at [38.75, -3.28] mm, `R3002.1` at [38.09, 7.1] mm.

Connected/isolated groups: {J3001.B5} | {R3002.1} | {U3001.5}.

Groups: **3**; missing pairs: **2**; tracks: **0**; vias: **0**. Every group is isolated. Schematic and PCB numbered signal endpoints agree.

U7001 is the MDBT50Q-1MV2 nRF52840 module: pin 35 D+, pin 34 D−. U3001 is TPD4E05U06DQAR, with channels 1/2 protecting D+/D− and 4/5 protecting CC1/CC2. R3001 and R3002 are 5.1 kΩ Rd pull-downs, pins 1 on CC and pins 2 on GND. No series resistor, USB testpoint, separate VBUS protection device or extra USB data net appears in this endpoint inventory.

Connector duplicate data lands occur in alternating order: B7(D−), A6(D+), A7(D−), B6(D+) from west to east. Connecting both polarities needs a deliberate compact fanout; four independent groups must become two nets. Zero-stub routing cannot be assumed from a schematic tie or overlap.

## USB LOCAL GND

Exact unresolved Phase-3C-owned pads: `J3001.A1`, `J3001.B12`, `J3001.A12`, `J3001.B1`, `U3001.3`, `U3001.8`, `R3001.2`, `R3002.2`.

Six groups: {J3001.A1,J3001.B12} | {J3001.A12,J3001.B1} | {U3001.3} | {U3001.8} | {R3001.2} | {R3002.2}. All eight pads are ordinary signal-return GND. None reaches either saved internal GND plane. Each of these six groups must join the existing GND core, reducing GND deficit by six, from 30 to 24. No local USB pad is already plane-connected.

The three unnetted J3001.SH shell pads are a distinct shield/chassis-like mapping issue. They are excluded from the six GND groups and from physical airwire counts. USB interlock GND endpoints Q3001.2/Q3002.2/R3004.2 belong to Phase 3D, despite sharing this schematic sheet; MCU supply/decoupling and global GND work are also excluded.

**PHASE 3C EXPECTED PAIR REDUCTION: 16** = D+ 3 + D− 3 + CC1 2 + CC2 2 + USB-local GND 6. Conditional remaining target: **76**. This is a component deficit target, not an approved route plan. Fixing shield mapping may introduce a separate shield net/deficit; it is not silently included in the current 92.

## Differential-pair rules and stored stackup

USB_D+/USB_D− explicitly belong to USB class: track width 0.20 mm, clearance 0.20 mm, differential width 0.20 mm, differential gap 0.25 mm, differential via gap 0.25 mm, via diameter/drill 0.80/0.40 mm. CC1/CC2 use Default: track width 0.25 mm, clearance 0.20 mm, via 0.80/0.40 mm. The separate router differential preset is width 0.20, gap **0.20**, via gap 0.25 mm; choosing it differs from the netclass gap.

Board minimums include track 0.10 mm, via diameter 0.50 mm, annulus 0.10 mm, through drill 0.30 mm, hole-to-copper/hole-to-hole 0.25 mm, copper-to-edge 0.50 mm. Microvia defaults exist as generic settings; their existence is not permission to use them. Ordinary through-vias remain the allowed process.

Custom usb_L1_only rule says track layer outer, allowing F.Cu/B.Cu; name/comment says L1-only but expression does not enforce F.Cu specifically. Sidecar documents GUI-import routing intent; effective enforcement not proved by this preflight.

Actual saved board: four copper layers F.Cu/In1.Cu/In2.Cu/B.Cu, total thickness 1.60 mm. In1 and In2 contain GND zones. **There is no saved setup/stackup block**, dielectric spacing, material/Er, copper thickness, impedance target or geometric impedance tuning profile. Generic KiCad defaults cannot qualify a manufacturer stackup.

**CONTROLLED IMPEDANCE RULE DEFINED: NO**  
**STACKUP SUFFICIENT: NO**  
**Current differential-pair rule usable: NO**, for qualified USB routing. Numeric router dimensions exist, but have no demonstrated impedance basis and disagree on gap. No 90 Ω geometry is calculated or invented.

## Geometric routing feasibility

**USB DIFFERENTIAL ROUTING FEASIBLE: UNVERIFIED**. The missing substrate at connector solder lands blocks a qualified end-to-end preflight. No route candidate, copper object or via was added, even in a saved test board.

Candidate regions after mounting is resolved:

1. F.Cu USB-local escape around x=34–41, then a trunk below the RF keepout (y>5.5), approaching the MCU right-side pads at x=53.15, y=14.15/14.95. This avoids the west-side switching converter, but ESD channels face west at x=34.9875, so short fanout around U3001 is required before heading east. Reserve CC and GND access simultaneously.
2. B.Cu trunk below the RF keepout with paired ordinary through-via transitions in open substrate, returning to F.Cu at MCU pads. Frozen Phase 3A diagonals from x≈38–39,y≈3–4 to MCU approaches y≈10–14 constrain this alternative. It must not cross those segments on the same layer.
3. East-perimeter approach below y=5.5, within x<54.5 to respect the 0.50 mm copper-edge rule. Existing MCU SCLK/MISO/DRDY/reset F.Cu escapes reach x=54, and module pads occupy the right side; available fanout width must be established at final pair geometry.

These are search regions, not clearance-qualified paths. With class dimensions, the parallel copper envelope is 2×0.20+0.25=0.65 mm and requires at least 1.05 mm between foreign copper boundaries at 0.20 mm side clearance. MCU USB pad pitch is 0.80 mm and ESD pad pitch 0.50 mm, so transitions from coupled trunk to endpoint pitch are unavoidable. Existing frozen approaches cannot be optimized away.

Centerline-only geometric probes (listed in JSON with crossing UUIDs) test straight corridors on both outer layers. They deliberately do not model a successful route or certify pad/via clearance:

| Probe | Layer | Existing centerline crossings |
|---|---|---|
| direct ESD-to-MCU trunk [35.0, 5.65] → [53.15, 14.55] | F.Cu | MCU_MOSI (0342d682); MCU_CS_N (f9bdd78a) |
| direct ESD-to-MCU trunk [35.0, 5.65] → [53.15, 14.55] | B.Cu | Net-(D402-COM) (051274eb); Net-(D402-COM) (1337da3c); MCU_SCLK (f852c28b); AFE_MISO (3925ca5d); AFE_MISO (4ca1d46c); AFE_DRDY_N (cdf0ea0b); AFE_DRDY_N (dbd98896); Net-(U502D--) (3cead671); Net-(U502D--) (79224891) |
| east trunk below RF [41, 6.5] → [52, 6.5] | F.Cu | none; pads/clearances still unverified |
| east trunk below RF [41, 6.5] → [52, 6.5] | B.Cu | AFE_DRDY_N (cdf0ea0b); AFE_CLKIN (befa75c9); MCU_RESET_N_AFE (6d1a8fa0) |
| east board-edge descent [54.3, 6.5] → [54.3, 14.55] | F.Cu | none; pads/clearances still unverified |
| east board-edge descent [54.3, 6.5] → [54.3, 14.55] | B.Cu | none; pads/clearances still unverified |

Keep the pair parallel on one outer layer where possible, with few separation changes, minimal matched ordinary vias, no avoidable ESD stubs and no unnecessary layer changes. F.Cu should reference In1 GND; B.Cu should reference In2 GND. Stay below/clear of the x=42…55,y=0…5.5 all-layer RF keepout. Actual filled-plane continuity underneath a final corridor and at via transitions must be checked; zone bounding boxes alone do not prove it. Keep clear of channel-4 high-impedance networks at x≈35–40,y≈8–19 and reference/VCM circuitry at x≈43–54,y≈18–25. Frozen switching power is to the west; no justified reason to enter that region is identified.

**FROZEN COPPER CHANGE REQUIRED: NO** — no such requirement has been established; this does not certify a complete route fits.  
**PLACEMENT CHANGE REQUIRED: YES** — conditional on conventional substrate-backed assembly; exact mounting geometry and whether placement versus footprint/outline is the minimal remedy remain unverified. No change applied.  
**SPECIAL FABRICATION REQUIRED: NO** — none proposed or shown to help; standard-process feasibility remains unverified.

Retain standard four-layer construction, single-sided assembly, ordinary through-vias, no HDI/microvias/blind/buried vias or new via-in-pad, and no special stackup without approval. Frozen Phase 3A via/pad overlaps remain deferred to whole-board manufacturing audit. The ~20–25 EUR assembled-board target is preserved as a constraint; no new quote was obtained.

## Blockers and readiness

BLOCKERS BEFORE 3C ROUTING:

1. J3001 symbol shield pin S does not map to the three footprint SH pads; no physical USB_SHIELD net exists. Shield coupling remains a separate unresolved EMC/enclosure decision.
2. Exact connector variant and manufacturer mounting/board-edge drawing are absent. All signal SMT lands and two shell slots are outside the saved substrate outline; establish mounting compatibility before any connector escape.
3. No explicit impedance target, dielectric thicknesses/material/Er, or copper thicknesses are saved. USB netclass gap 0.25 mm differs from routing preset gap 0.20 mm. Qualify ordinary four-layer geometry before pair routing.
4. End-to-end pair corridor is unverified: interleaved connector duplicates, ESD fanout, RF keepout, frozen SPI approaches and right-edge MCU fanout require geometric resolution after the connector blocker. No routed candidate was constructed.

| Gate | Status | Evidence |
|---|---|---|
| Production/checkpoint authority and preservation | PASS | SHA equality; all captured design hashes unchanged; manifest matches |
| Schematic/PCB signal inventory and pair target | PASS | Fresh export, all-net KiCad components, per-net DRC counts |
| Fresh baseline DRC reconciliation | PASS | 525 ordinary / 92 pairs; documented 23-warning emission difference |
| Shield mapping | FAIL | S versus SH; no pad net assignment |
| Board-edge mounting compatibility | UNVERIFIED | Exact variant/manufacturer drawing absent; exterior lands/slots documented |
| Controlled-impedance qualification | UNVERIFIED | Saved dielectric stackup and impedance target absent |
| End-to-end pair clearance/reference/standard-via feasibility | UNVERIFIED | Search regions and rejected straight probes only; connector blocker precedes routing |

**READY TO START PHASE 3C ROUTING: NO**

Stopped after discovery. USB_SHIELD was not fixed, J3001 was not moved, D+/D− and CC1/CC2 were not routed, and Phase 3D was not started.
