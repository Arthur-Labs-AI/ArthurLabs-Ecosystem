# Phase 3B routing discovery — inventory only
Date: 2026-09-26. No PCB edits, routing, saving or zone refill occurred. This document proposes scope; it does not authorize a routing implementation.

## Authority and evidence
Analyzed `ARTHUR_EMG_RevA_Cost.kicad_pcb`, read `AGENTS.md`, `PHASE3A_ROUTING_FREEZE.md`, freeze manifest, accepted DRC/verification evidence, hierarchical schematics, stored KiCad netlist and a newly exported schematic XML netlist. The production PCB is byte-identical to the accepted ThreeNetClean checkpoint. All seven freeze-manifest hashes match, including the checkpoint, its two sidecars and four accepted evidence files. The stored netlist and fresh schematic export agree on every net/pin membership (93 schematic nets). Historical architecture prose still refers to ADS1294; actual schematic/PCB U6001 is ADS131M04 and U503 is TLV9064. This inventory follows the actual design.

Production and frozen checkpoint SHA-256 before and after discovery:
```
7a7a70d78e1e191e13251e24b882b7eeb3df1153912a4168850515c8ac8201f9
```

Method: load the production board with KiCad 10.0.6 pcbnew, build connectivity in memory, and use `GetConnectedItems(pad)` to enumerate electrically connected pad components, including saved filled-zone copper. Match source/destination pin functions to the schematic export. Count tracks and vias separately. Every multi-component net is explicitly inventoried. For every net, disconnected-component count minus one exactly matches its DRC airwire-pair count; all 126 pairs reconcile. Completion is not inferred from the global unconnected count. Connectivity includes physical pad overlap; an overlap does not establish a routed subsystem.

## Read-only DRC and baseline distinction
Executed successfully (exit 0 means report generated, not DRC clean):
```bash
kicad-cli pcb drc --severity-all --all-track-errors --format json \
  --output /tmp/phase3b_discovery_drc.json \
  ARTHUR_EMG_RevA_Cost/ARTHUR_EMG_RevA_Cost.kicad_pcb
```
A second invocation added `--schematic-parity` and wrote `/tmp/phase3b_parity_drc.json`. Schematic export used `kicad-cli sch export netlist --format kicadxml`, output `/tmp/phase3b_schematic.xml`. No `--save-board` or `--refill-zones` was used. Discovery checks stored fills; newly refilled routing/manufacturing verification remains outside this task.

| Baseline violation category | Current count |
|---|---:|
| copper_edge_clearance | 3 |
| silk_overlap | 199 |
| silk_over_copper | 199 |
| lib_footprint_issues | 57 |
| lib_footprint_mismatch | 55 |
| silk_edge_clearance | 12 |
| **Total ordinary DRC violations** | **525** |
| **Unconnected-item pairs, reported separately** | **126** |
| **Schematic parity issues, reported separately** | **45** |

The accepted saved DRC has 548 violations: the same category totals for these 525 violations plus 23 `nonmirrored_text_on_back_layer` warnings not emitted by this invocation. 514 current violation identities match the accepted report; 11 silkscreen pair identities differ (7 silk_over_copper, 4 silk_overlap), with unchanged category counts. All three copper-edge identities match; no new copper violation identity appears. Of 126 airwire-pair identities, 112 match and 14 differ, but every per-net pair count is identical. Byte-identical board geometry and the independently reconstructed pad components establish unchanged electrical scope; individual report pair selection is not treated as stable identity evidence. Do not interpret the 23-count reduction as a repaired board. Current reports contain no shorts, copper-to-copper clearance, crossing, dangling-track or dangling-via categories. This is not a clean full-board manufacturing result.

Existing copper-edge violations: U4002.3 (`AFE_ENABLE`) and U4002.4 (intentional NC) each have 0.30 mm versus required 0.50 mm clearance; J2001.MP (no net) has 0.00 mm versus 0.50 mm. These are pre-existing placement/footprint constraints and were left untouched.

## Geometry and unresolved scope boundaries
Nominal outline: x=0–55 mm, y=0–35 mm. Coordinates below are KiCad board coordinates, y increasing downward. RF keepout covers x=42–55, y=0–5.5 mm on all four copper layers. GND zones occupy In1.Cu/In2.Cu; there are no power zones. The converter is at x≈12/y≈2, ADC x≈22/y≈7, channel analog networks x≈2–41/y≈8–25, USB/ESD/interlock x≈32–41 near the top, MCU x≈44–53/y≈5–16, reference buffer x≈46–51/y≈19–22, debug connector x≈10–14/y≈19–25, and most testpoints y=27.5. Frozen Phase 3A routes already occupy approaches to the ADC and MCU; all remaining routes must fit around them.

Two net/pad mismatches are confirmed by schematic parity, not ordinary airwires:

- **U2001.17 GND:** charger schematic exposed-pad terminal has no PCB pad 17. It cannot be counted as an existing routable pad or silently treated as plane-connected. Needs a separately authorized footprint/design review before charger implementation; placement and the PCB remain untouched here.
- **USB_SHIELD / J3001.S:** one schematic shield pin exists, but the PCB has three unnetted `SH` pads instead of `S`. No physical `USB_SHIELD` PCB net exists. This is unresolved shield mapping/termination, not a proven intentional no-connect. It is excluded from the 41 physical-net count and must be resolved before USB sign-off.

Other parity issues include the U4001 footprint-name mismatch and metadata/BOM differences; record these separately from routing. The connector signal pad centers are y=-3.28 mm, outside the nominal y=0 edge. Review connector/edge compatibility before defining executable USB escape routing; no placement or outline corrections are permitted in this discovery. Phase 3B reference planning itself can proceed, but discovery does not establish that every later phase is routable under frozen placement.

## Proposed coherent phases

### Phase 3B
Sensitive reference/electrode unit and AFE supply branches. Establish the U503 divider/filter, follower terminations, missing VCM branches, reference electrode link and quiet AFE power delivery first. Include local GND access for U503/C5001/C5002/R5004/C503 and missing op-amp decoupling. Keep existing VCM/channel/ADC and LDO copper unchanged; the AFE_3V0 discharge-resistor branch depends on Phase 3D interlock completion.
Nets (7): `Net-(U503A-+)`, `VCM`, `Net-(U503B--)`, `Net-(U503C--)`, `Net-(U503D--)`, `RLD_SAFE`, `AFE_3V0`.

### Phase 3C
USB connector/ESD/MCU data pair and CC attachment unit. Place this before bulk ordinary digital/power completion because the fixed east-side MCU approach below the RF keepout and beside frozen SPI routes constrains the pair. This uses the high-edge-rate priority exception ahead of ordinary USB/debug order. Include ESD, Rd and connector ground access. Resolve connector/shield mapping and edge compatibility before executing this phase.
Nets (4): `USB_D+`, `USB_D-`, `CC1`, `CC2`.

### Phase 3D
Battery/charger, upstream supply, 3V3 distribution and USB-present hardware interlock. Complete current-carrying paths and their local returns, then pack sensing/program resistors and disable/discharge branches. Add to frozen converter/LDO islands without moving existing copper. Resolve missing charger exposed pad before charger completion.
Nets (9): `BAT+`, `SYS_RAW`, `USB_VBUS`, `3V3`, `PACK_NTC`, `ICHG_SET_TBD`, `ILIM_SET_TBD`, `AFE_ENABLE`, `Net-(Q3002-D)`.

### Phase 3E
Ordinary charger status plus coherent SWD/debug interface and target reset. Complete long west-to-east status/debug links after sensitive and current paths reserve their space; include debug GND/VTREF completion from the power phase.
Nets (5): `CHG_N`, `PGOOD_N`, `SWDCLK`, `SWDIO`, `MCU_RESET_N`.

### Phase 3F
Remaining analog and frozen digital testpoint branches. Fifteen nets have complete primary paths and isolated TP pads only. Analog taps and clock/SPI stubs require careful attachment even though access branches are last in priority. Mixed power/GND testpoints on other nets may also be deferred to this phase; their parent nets are counted only once.
Nets (15): `CH1_P`, `CH1_N`, `CH2_P`, `CH2_N`, `CH3_P`, `CH3_N`, `CH4_P`, `CH4_N`, `AFE_CLKIN`, `MCU_SCLK`, `MCU_MOSI`, `AFE_MISO`, `MCU_CS_N`, `AFE_DRDY_N`, `MCU_RESET_N_AFE`.

**GND is a shared completion unit across 3B–3F, counted once.** Complete local plane access with its owning subsystem, then audit remaining connector/testpoint access in 3F. Preserve zone definitions, saved frozen copper, RF keepout and In1/In2 structure. Plane copper itself needs no replacement track network; missing surface-pad access still requires new local connections in a future authorized task. Ground completion cannot be postponed wholesale until after signal routing.

## Exhaustive unfinished-net inventory
`A.n` means reference A, pin n. Pin functions are from the schematic. Connected groups are enclosed in braces; different braces require electrical connection. Source/destination lists are electrical membership, not a requirement to connect pins in the printed order. Region gives the endpoint extent, not a proposed routing path. Counts partition uniquely: UNROUTED = no tracks/vias (coincident connector pads may touch); PARTIAL = functional/power/ground groups remain disconnected; MAIN PATH COMPLETE + BRANCH MISSING = only an isolated TP remains. No intentional NC is in these counts.

### Inventory for Phase 3B

#### `Net-(U503A-+)`
- **SOURCE / DESTINATION PINS:** `C5001.2` (2_2); `U503.3` (+_3); `C5002.2` (2_2); `R5004.2` (2_2); `R5003.1` (1_1)
- **SUBSYSTEM:** analog auxiliary/reference
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=43.10–53.60 mm, y=17.99–25.01 mm
- **SIGNAL TYPE:** analog
- **ROUTING SENSITIVITY:** high
- **REASON:** The 100k/100k divider and 1 µF/0.1 µF filters feeding U503A + are all separate; keep the high-impedance reference input quiet.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 5 pad groups; 4 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {C5001.2} | {U503.3} | {C5002.2} | {R5004.2} | {R5003.1}

#### `VCM`
- **SOURCE / DESTINATION PINS:** `R105.1` (1_1); `R306.1` (1_1); `R305.1` (1_1); `R205.1` (1_1); `R5002.1` (1_1); `R206.1` (1_1); `R106.1` (1_1); `U503.1` (output); `U503.2` (-_2); `U503.5` (+_5); `U503.10` (+_10); `U503.12` (+_12); `R405.1` (1_1); `R406.1` (1_1)
- **SUBSYSTEM:** analog auxiliary/reference
- **CURRENT STATE:** PARTIAL
- **APPROXIMATE BOARD REGION:** x=4.05–51.35 mm, y=18.55–24.40 mm
- **SIGNAL TYPE:** analog
- **ROUTING SENSITIVITY:** high
- **REASON:** U503A output/feedback and all eight channel bias resistors are connected; R5002.1 and U503B/C/D + inputs remain separate. Complete only these branches; preserve the Phase 1 distribution.
- **EXISTING COPPER / CONNECTIVITY:** 17 track segments, 5 vias; 5 pad groups; 4 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {R105.1, R306.1, R305.1, R205.1, R206.1, R106.1, U503.1, U503.2, R405.1, R406.1} | {R5002.1} | {U503.5} | {U503.10} | {U503.12}

#### `Net-(U503B--)`
- **SOURCE / DESTINATION PINS:** `U503.6` (-_6); `U503.7` (output)
- **SUBSYSTEM:** reference buffer support
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=45.65–45.65 mm, y=21.80–22.45 mm
- **SIGNAL TYPE:** analog
- **ROUTING SENSITIVITY:** medium
- **REASON:** Unused amplifier follower output-to-inverting-input tie is missing; its + input also needs the VCM branch.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U503.6} | {U503.7}

#### `Net-(U503C--)`
- **SOURCE / DESTINATION PINS:** `U503.8` (output); `U503.9` (-_9)
- **SUBSYSTEM:** reference buffer support
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=51.35–51.35 mm, y=21.80–22.45 mm
- **SIGNAL TYPE:** analog
- **ROUTING SENSITIVITY:** medium
- **REASON:** Unused amplifier follower output-to-inverting-input tie is missing; its + input also needs the VCM branch.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U503.8} | {U503.9}

#### `Net-(U503D--)`
- **SOURCE / DESTINATION PINS:** `U503.13` (-_13); `U503.14` (output)
- **SUBSYSTEM:** reference buffer support
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=51.35–51.35 mm, y=18.55–19.20 mm
- **SIGNAL TYPE:** analog
- **ROUTING SENSITIVITY:** medium
- **REASON:** Unused amplifier follower output-to-inverting-input tie is missing; its + input also needs the VCM branch.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U503.13} | {U503.14}

#### `RLD_SAFE`
- **SOURCE / DESTINATION PINS:** `R5002.2` (2_2); `J5001.2` (GND_2)
- **SUBSYSTEM:** reference electrode
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=49.91–50.00 mm, y=24.40–31.00 mm
- **SIGNAL TYPE:** analog
- **ROUTING SENSITIVITY:** high
- **REASON:** Safety resistor output does not reach J5001.2. This design uses buffered VCM through R5002, not an ADS1294 RLD feedback loop.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {R5002.2} | {J5001.2}

#### `AFE_3V0`
- **SOURCE / DESTINATION PINS:** `R3005.2` (2_2); `U4002.5` (OUT_5); `D202.2` (K2_2); `C502.2` (2_2); `C503.2` (2_2); `D201.2` (K2_2); `C501.2` (2_2); `D302.2` (K2_2); `C4006.1` (1_1); `U501.4` (V+_4); `D401.2` (K2_2); `D402.2` (K2_2); `D102.2` (K2_2); `U503.4` (V+_4); `C6007.1` (1_1); `D301.2` (K2_2); `D101.2` (K2_2); `U6001.1` (AVDD_1); `U502.4` (V+_4); `R5003.2` (2_2); `TP601.1` (1_1)
- **SUBSYSTEM:** AFE supply distribution/ADC support
- **CURRENT STATE:** PARTIAL
- **APPROXIMATE BOARD REGION:** x=2.21–53.60 mm, y=2.50–27.50 mm
- **SIGNAL TYPE:** power
- **ROUTING SENSITIVITY:** high
- **REASON:** LDO/C4006/C502 and ADC/C6007 form separate routed groups; op-amp supplies, divider feed, clamp rail pins, other decouplers, discharge resistor and TP601 remain disconnected. No AFE power plane exists.
- **EXISTING COPPER / CONNECTIVITY:** 8 track segments, 2 vias; 18 pad groups; 17 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {R3005.2} | {U4002.5, C502.2, C4006.1} | {D202.2} | {C503.2} | {D201.2} | {C501.2} | {D302.2} | {U501.4} | {D401.2} | {D402.2} | {D102.2} | {U503.4} | {C6007.1, U6001.1} | {D301.2} | {D101.2} | {U502.4} | {R5003.2} | {TP601.1}

### Inventory for Phase 3C

#### `USB_D+`
- **SOURCE / DESTINATION PINS:** `U3001.1` (D1+_1); `J3001.A6` (D+_A6); `J3001.B6` (D+_B6); `U7001.35` (D+_35)
- **SUBSYSTEM:** USB data/ESD
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=34.99–53.15 mm, y=-3.28–14.15 mm
- **SIGNAL TYPE:** USB
- **ROUTING SENSITIVITY:** high
- **REASON:** No routed connector-to-ESD-to-MCU path; both reversible connector pads must join the same differential leg. Reserve the constrained east-side approach below the RF keepout.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 4 pad groups; 3 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U3001.1} | {J3001.A6} | {J3001.B6} | {U7001.35}

#### `USB_D-`
- **SOURCE / DESTINATION PINS:** `U3001.2` (D1-_2); `J3001.A7` (D-_A7); `J3001.B7` (D-_B7); `U7001.34` (D-_34)
- **SUBSYSTEM:** USB data/ESD
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=34.99–53.15 mm, y=-3.28–14.95 mm
- **SIGNAL TYPE:** USB
- **ROUTING SENSITIVITY:** high
- **REASON:** No routed connector-to-ESD-to-MCU path; both reversible connector pads must join the same differential leg. Route coherently with USB_D+ and its ground return.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 4 pad groups; 3 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U3001.2} | {J3001.A7} | {J3001.B7} | {U7001.34}

#### `CC1`
- **SOURCE / DESTINATION PINS:** `U3001.4` (D2+_4); `J3001.A5` (CC1_A5); `R3001.1` (1_1)
- **SUBSYSTEM:** USB-C attach/ESD
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=34.99–39.99 mm, y=-3.28–6.90 mm
- **SIGNAL TYPE:** USB
- **ROUTING SENSITIVITY:** medium
- **REASON:** Connector CC1, ESD channel and 5.1k Rd termination are all separate.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 3 pad groups; 2 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U3001.4} | {J3001.A5} | {R3001.1}

#### `CC2`
- **SOURCE / DESTINATION PINS:** `U3001.5` (D2-_5); `J3001.B5` (CC2_B5); `R3002.1` (1_1)
- **SUBSYSTEM:** USB-C attach/ESD
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=34.99–38.75 mm, y=-3.28–7.40 mm
- **SIGNAL TYPE:** USB
- **ROUTING SENSITIVITY:** medium
- **REASON:** Connector CC2, ESD channel and 5.1k Rd termination are all separate.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 3 pad groups; 2 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U3001.5} | {J3001.B5} | {R3002.1}

### Inventory for Phase 3D

#### `BAT+`
- **SOURCE / DESTINATION PINS:** `C2003.1` (1_1); `J2001.1` (BAT+_1); `U2001.2` (BAT_2); `U2001.3` (BAT_3); `TP201.1` (1_1)
- **SUBSYSTEM:** charging/battery
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=0.94–6.00 mm, y=3.25–27.50 mm
- **SIGNAL TYPE:** power
- **ROUTING SENSITIVITY:** high
- **REASON:** Battery connector, both charger BAT pins, storage capacitor and TP201 are separate; prioritize the current path and local return before the testpoint.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 5 pad groups; 4 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {C2003.1} | {J2001.1} | {U2001.2} | {U2001.3} | {TP201.1}

#### `SYS_RAW`
- **SOURCE / DESTINATION PINS:** `C4001.1` (1_1); `C2002.1` (1_1); `U4001.5` (VIN_5); `U4001.6` (EN_6); `U4001.8` (VINA_8); `C4002.1` (1_1); `U2001.6` (EN1_6); `U2001.10` (OUT_10); `U2001.11` (OUT_11)
- **SUBSYSTEM:** charger-to-regulator power distribution
- **CURRENT STATE:** PARTIAL
- **APPROXIMATE BOARD REGION:** x=2.15–13.45 mm, y=0.65–10.16 mm
- **SIGNAL TYPE:** power
- **ROUTING SENSITIVITY:** high
- **REASON:** Frozen buck-boost input network is complete locally but isolated from C2002 and charger OUT/EN1 pins. Preserve the converter island and add its upstream supply.
- **EXISTING COPPER / CONNECTIVITY:** 10 track segments, 3 vias; 5 pad groups; 4 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {C4001.1, U4001.5, U4001.6, U4001.8, C4002.1} | {C2002.1} | {U2001.6} | {U2001.10} | {U2001.11}

#### `USB_VBUS`
- **SOURCE / DESTINATION PINS:** `Q3001.1` (G_1); `Q3002.1` (G_1); `J3001.A4` (VBUS_A4); `J3001.A9` (VBUS_A9); `J3001.B4` (VBUS_B4); `J3001.B9` (VBUS_B9); `U7001.32` (VBUS_32); `C2001.1` (1_1); `U2001.13` (IN_13); `R3004.1` (1_1)
- **SUBSYSTEM:** USB input/charger/interlock/MCU supply
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=3.15–52.50 mm, y=-3.28–16.46 mm
- **SIGNAL TYPE:** power
- **ROUTING SENSITIVITY:** high
- **REASON:** Only coincident connector pad pairs touch; no tracks or vias. Charger input, input capacitor, MCU VBUS and MOSFET gate/pulldown branches are separate. Wide current path competes with the USB escape.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 8 pad groups; 7 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {Q3001.1} | {Q3002.1} | {J3001.A4, J3001.B9} | {J3001.A9, J3001.B4} | {U7001.32} | {C2001.1} | {U2001.13} | {R3004.1}

#### `3V3`
- **SOURCE / DESTINATION PINS:** `U4002.1` (IN_1); `C4004.1` (1_1); `C4003.1` (1_1); `C6008.1` (1_1); `C4005.1` (1_1); `U4001.1` (VOUT_1); `U4001.10` (FB_10); `U7001.28` (VDD_28); `U7001.30` (VDDH_30); `C7002.1` (1_1); `C7001.1` (1_1); `U6001.20` (DVDD_20); `R3003.1` (1_1); `TP401.1` (1_1); `J8001.1` (VTREF_1); `TP603.1` (1_1)
- **SUBSYSTEM:** MCU/ADC/debug power distribution
- **CURRENT STATE:** PARTIAL
- **APPROXIMATE BOARD REGION:** x=11.15–53.60 mm, y=1.50–27.50 mm
- **SIGNAL TYPE:** power
- **ROUTING SENSITIVITY:** high
- **REASON:** Frozen regulator/LDO-input/ADC-DVDD group is connected, but C6008, MCU VDD/VDDH and decouplers, enable pull-up, debug VTREF and two testpoints are separate. No 3V3 plane exists.
- **EXISTING COPPER / CONNECTIVITY:** 16 track segments, 3 vias; 10 pad groups; 9 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U4002.1, C4004.1, C4003.1, C4005.1, U4001.1, U4001.10, U6001.20} | {C6008.1} | {U7001.28} | {U7001.30} | {C7002.1} | {C7001.1} | {R3003.1} | {TP401.1} | {J8001.1} | {TP603.1}

#### `PACK_NTC`
- **SOURCE / DESTINATION PINS:** `J2001.2` (NTC_2); `U2001.1` (TS_1)
- **SUBSYSTEM:** battery temperature sensing
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=0.94–3.00 mm, y=3.25–7.95 mm
- **SIGNAL TYPE:** analog
- **ROUTING SENSITIVITY:** medium
- **REASON:** Pack NTC connector does not reach charger TS input; keep clear of switch/power noise.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {J2001.2} | {U2001.1}

#### `ICHG_SET_TBD`
- **SOURCE / DESTINATION PINS:** `R2001.1` (1_1); `U2001.16` (ISET_16)
- **SUBSYSTEM:** charger programming
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=1.65–6.69 mm, y=4.80–7.24 mm
- **SIGNAL TYPE:** analog
- **ROUTING SENSITIVITY:** medium
- **REASON:** Charger ISET-to-R2001 link missing. Despite the legacy net name, schematic value is 3.57k for the stated 250mA target.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {R2001.1} | {U2001.16}

#### `ILIM_SET_TBD`
- **SOURCE / DESTINATION PINS:** `U2001.12` (ILIM_12); `R2002.1` (1_1)
- **SUBSYSTEM:** charger programming
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=3.86–6.69 mm, y=6.00–7.95 mm
- **SIGNAL TYPE:** analog
- **ROUTING SENSITIVITY:** medium
- **REASON:** Charger ILIM-to-R2002 link missing. Despite the legacy net name, schematic value is 3.24k for the stated 500mA USB target.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U2001.12} | {R2002.1}

#### `AFE_ENABLE`
- **SOURCE / DESTINATION PINS:** `U4002.3` (EN_3); `Q3001.3` (D_3); `R3003.2` (2_2)
- **SUBSYSTEM:** USB analog-disable interlock
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=25.86–39.11 mm, y=0.60–18.34 mm
- **SIGNAL TYPE:** digital
- **ROUTING SENSITIVITY:** medium
- **REASON:** LDO EN, Q3001 drain and 3V3 pull-up are separate. The LDO pin also has an existing edge-clearance violation; no MCU GPIO is on this net.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 3 pad groups; 2 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U4002.3} | {Q3001.3} | {R3003.2}

#### `Net-(Q3002-D)`
- **SOURCE / DESTINATION PINS:** `R3005.1` (1_1); `Q3002.3` (D_3)
- **SUBSYSTEM:** USB AFE discharge interlock
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=39.99–41.14 mm, y=5.10–9.40 mm
- **SIGNAL TYPE:** power
- **ROUTING SENSITIVITY:** medium
- **REASON:** R3005 active-discharge resistor is isolated from Q3002 drain; needed alongside USB_VBUS gate drive and ground return.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {R3005.1} | {Q3002.3}

### Inventory for Phase 3E

#### `CHG_N`
- **SOURCE / DESTINATION PINS:** `U7001.45` (P0.23_45); `U2001.9` (CHG_N_9)
- **SUBSYSTEM:** charger status/MCU control
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=3.86–52.25 mm, y=9.45–9.75 mm
- **SIGNAL TYPE:** digital
- **ROUTING SENSITIVITY:** low
- **REASON:** Charger open-drain status does not reach MCU GPIO. Long west-to-east route; use current schematic endpoints without inventing additional pull-up components.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U7001.45} | {U2001.9}

#### `PGOOD_N`
- **SOURCE / DESTINATION PINS:** `U7001.48` (P0.24_48); `U2001.7` (PGOOD_N_7)
- **SUBSYSTEM:** charger status/MCU control
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=2.65–53.15 mm, y=8.55–10.16 mm
- **SIGNAL TYPE:** digital
- **ROUTING SENSITIVITY:** low
- **REASON:** Charger open-drain status does not reach MCU GPIO. Long west-to-east route.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U7001.48} | {U2001.7}

#### `SWDCLK`
- **SOURCE / DESTINATION PINS:** `U7001.53` (SWDCLK_53); `J8001.4` (SWCLK/TCK_4)
- **SUBSYSTEM:** SWD/debug
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=10.05–53.15 mm, y=6.15–20.73 mm
- **SIGNAL TYPE:** debug/programming
- **ROUTING SENSITIVITY:** medium
- **REASON:** MCU SWD clock and J8001.4 are separate; long cross-board route needs a continuous return.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U7001.53} | {J8001.4}

#### `SWDIO`
- **SOURCE / DESTINATION PINS:** `U7001.51` (SWDIO_51); `J8001.2` (SWDIO/TMS_2)
- **SUBSYSTEM:** SWD/debug
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=10.05–53.15 mm, y=6.95–19.46 mm
- **SIGNAL TYPE:** debug/programming
- **ROUTING SENSITIVITY:** medium
- **REASON:** MCU SWD data and J8001.2 are separate; route as a coherent debug interface below the RF keepout.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U7001.51} | {J8001.2}

#### `MCU_RESET_N`
- **SOURCE / DESTINATION PINS:** `U7001.40` (P0.18_40); `J8001.10` (nRESET_10)
- **SUBSYSTEM:** SWD/debug reset
- **CURRENT STATE:** UNROUTED
- **APPROXIMATE BOARD REGION:** x=10.05–52.25 mm, y=12.15–24.54 mm
- **SIGNAL TYPE:** debug/programming
- **ROUTING SENSITIVITY:** medium
- **REASON:** MCU reset and J8001.10 are separate. This is a different net from frozen MCU_RESET_N_AFE.
- **EXISTING COPPER / CONNECTIVITY:** 0 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U7001.40} | {J8001.10}

### Inventory for Phase 3F

#### `CH1_P`
- **SOURCE / DESTINATION PINS:** `C105.2` (2_2); `R107.2` (2_2); `C106.2` (2_2); `U6001.3` (AIN0P_3); `TP111.1` (1_1)
- **SUBSYSTEM:** EMG testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=2.00–20.18 mm, y=9.85–27.50 mm
- **SIGNAL TYPE:** analog / testpoint
- **ROUTING SENSITIVITY:** high
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Avoid loading/noise pickup on the differential input and preserve channel symmetry.
- **EXISTING COPPER / CONNECTIVITY:** 6 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {C105.2, R107.2, C106.2, U6001.3} | {TP111.1}

#### `CH1_N`
- **SOURCE / DESTINATION PINS:** `R108.2` (2_2); `C107.2` (2_2); `C105.1` (1_1); `U6001.4` (AIN0N_4); `TP112.1` (1_1)
- **SUBSYSTEM:** EMG testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=4.00–20.82 mm, y=9.85–27.50 mm
- **SIGNAL TYPE:** analog / testpoint
- **ROUTING SENSITIVITY:** high
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Avoid loading/noise pickup on the differential input and preserve channel symmetry.
- **EXISTING COPPER / CONNECTIVITY:** 13 track segments, 4 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {R108.2, C107.2, C105.1, U6001.4} | {TP112.1}

#### `CH2_P`
- **SOURCE / DESTINATION PINS:** `C206.2` (2_2); `R207.2` (2_2); `C205.2` (2_2); `U6001.6` (AIN1P_6); `TP211.1` (1_1)
- **SUBSYSTEM:** EMG testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=8.00–22.12 mm, y=9.85–27.50 mm
- **SIGNAL TYPE:** analog / testpoint
- **ROUTING SENSITIVITY:** high
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Avoid loading/noise pickup on the differential input and preserve channel symmetry.
- **EXISTING COPPER / CONNECTIVITY:** 8 track segments, 2 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {C206.2, R207.2, C205.2, U6001.6} | {TP211.1}

#### `CH2_N`
- **SOURCE / DESTINATION PINS:** `R208.2` (2_2); `C205.1` (1_1); `U6001.5` (AIN1N_5); `C207.2` (2_2); `TP212.1` (1_1)
- **SUBSYSTEM:** EMG testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=10.00–21.48 mm, y=9.85–27.50 mm
- **SIGNAL TYPE:** analog / testpoint
- **ROUTING SENSITIVITY:** high
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Avoid loading/noise pickup on the differential input and preserve channel symmetry.
- **EXISTING COPPER / CONNECTIVITY:** 7 track segments, 4 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {R208.2, C205.1, U6001.5, C207.2} | {TP212.1}

#### `CH3_P`
- **SOURCE / DESTINATION PINS:** `C306.2` (2_2); `U6001.7` (AIN2P_7); `C305.2` (2_2); `R307.2` (2_2); `TP311.1` (1_1)
- **SUBSYSTEM:** EMG testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=12.00–26.75 mm, y=9.85–27.50 mm
- **SIGNAL TYPE:** analog / testpoint
- **ROUTING SENSITIVITY:** high
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Avoid loading/noise pickup on the differential input and preserve channel symmetry.
- **EXISTING COPPER / CONNECTIVITY:** 6 track segments, 0 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {C306.2, U6001.7, C305.2, R307.2} | {TP311.1}

#### `CH3_N`
- **SOURCE / DESTINATION PINS:** `R308.2` (2_2); `U6001.8` (AIN2N_8); `C307.2` (2_2); `C305.1` (1_1); `TP312.1` (1_1)
- **SUBSYSTEM:** EMG testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=14.00–29.15 mm, y=9.85–27.50 mm
- **SIGNAL TYPE:** analog / testpoint
- **ROUTING SENSITIVITY:** high
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Avoid loading/noise pickup on the differential input and preserve channel symmetry.
- **EXISTING COPPER / CONNECTIVITY:** 8 track segments, 2 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {R308.2, U6001.8, C307.2, C305.1} | {TP312.1}

#### `CH4_P`
- **SOURCE / DESTINATION PINS:** `C405.2` (2_2); `R407.2` (2_2); `C406.2` (2_2); `U6001.10` (AIN3P_10); `TP411.1` (1_1)
- **SUBSYSTEM:** EMG testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=20.00–37.50 mm, y=9.85–27.50 mm
- **SIGNAL TYPE:** analog / testpoint
- **ROUTING SENSITIVITY:** high
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Avoid loading/noise pickup on the differential input and preserve channel symmetry.
- **EXISTING COPPER / CONNECTIVITY:** 11 track segments, 2 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {C405.2, R407.2, C406.2, U6001.10} | {TP411.1}

#### `CH4_N`
- **SOURCE / DESTINATION PINS:** `C405.1` (1_1); `C407.2` (2_2); `R408.2` (2_2); `U6001.9` (AIN3N_9); `TP412.1` (1_1)
- **SUBSYSTEM:** EMG testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=22.00–39.90 mm, y=9.85–27.50 mm
- **SIGNAL TYPE:** analog / testpoint
- **ROUTING SENSITIVITY:** high
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Avoid loading/noise pickup on the differential input and preserve channel symmetry.
- **EXISTING COPPER / CONNECTIVITY:** 12 track segments, 3 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {C405.1, C407.2, R408.2, U6001.9} | {TP412.1}

#### `AFE_CLKIN`
- **SOURCE / DESTINATION PINS:** `U7001.43` (P0.21_43); `U6001.17` (CLKIN_17); `TP609.1` (1_1)
- **SUBSYSTEM:** frozen Phase 3A testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=20.82–52.25 mm, y=4.15–27.50 mm
- **SIGNAL TYPE:** digital / testpoint
- **ROUTING SENSITIVITY:** high
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Clock/SPI branches introduce stubs; choose attachment geometry only in a later plan, with no main-path optimization.
- **EXISTING COPPER / CONNECTIVITY:** 8 track segments, 2 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U7001.43, U6001.17} | {TP609.1}

#### `MCU_SCLK`
- **SOURCE / DESTINATION PINS:** `U7001.37` (P0.13_37); `U6001.14` (SCLK_14); `TP604.1` (1_1)
- **SUBSYSTEM:** frozen Phase 3A testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=22.77–53.15 mm, y=4.15–27.50 mm
- **SIGNAL TYPE:** digital / testpoint
- **ROUTING SENSITIVITY:** high
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Clock/SPI branches introduce stubs; choose attachment geometry only in a later plan, with no main-path optimization.
- **EXISTING COPPER / CONNECTIVITY:** 19 track segments, 2 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U7001.37, U6001.14} | {TP604.1}

#### `MCU_MOSI`
- **SOURCE / DESTINATION PINS:** `U7001.36` (P0.14_36); `U6001.16` (DIN_16); `TP605.1` (1_1)
- **SUBSYSTEM:** frozen Phase 3A testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=21.48–52.25 mm, y=4.15–27.50 mm
- **SIGNAL TYPE:** digital / testpoint
- **ROUTING SENSITIVITY:** high
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Clock/SPI branches introduce stubs; choose attachment geometry only in a later plan, with no main-path optimization.
- **EXISTING COPPER / CONNECTIVITY:** 20 track segments, 2 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U7001.36, U6001.16} | {TP605.1}

#### `AFE_MISO`
- **SOURCE / DESTINATION PINS:** `U7001.39` (P0.15_39); `U6001.15` (DOUT_15); `TP606.1` (1_1)
- **SUBSYSTEM:** frozen Phase 3A testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=22.12–53.15 mm, y=4.15–27.50 mm
- **SIGNAL TYPE:** digital / testpoint
- **ROUTING SENSITIVITY:** high
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Clock/SPI branches introduce stubs; choose attachment geometry only in a later plan, with no main-path optimization.
- **EXISTING COPPER / CONNECTIVITY:** 15 track segments, 2 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U7001.39, U6001.15} | {TP606.1}

#### `MCU_CS_N`
- **SOURCE / DESTINATION PINS:** `U7001.38` (P0.16_38); `U6001.12` (~{CS}_12); `TP607.1` (1_1)
- **SUBSYSTEM:** frozen Phase 3A testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=24.07–52.25 mm, y=4.15–27.50 mm
- **SIGNAL TYPE:** digital / testpoint
- **ROUTING SENSITIVITY:** medium
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Clock/SPI branches introduce stubs; choose attachment geometry only in a later plan, with no main-path optimization.
- **EXISTING COPPER / CONNECTIVITY:** 12 track segments, 2 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U7001.38, U6001.12} | {TP607.1}

#### `AFE_DRDY_N`
- **SOURCE / DESTINATION PINS:** `U7001.41` (P0.17_41); `U6001.13` (~{DRDY}_13); `TP608.1` (1_1)
- **SUBSYSTEM:** frozen Phase 3A testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=23.43–53.15 mm, y=4.15–27.50 mm
- **SIGNAL TYPE:** digital / testpoint
- **ROUTING SENSITIVITY:** medium
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Clock/SPI branches introduce stubs; choose attachment geometry only in a later plan, with no main-path optimization.
- **EXISTING COPPER / CONNECTIVITY:** 7 track segments, 2 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U7001.41, U6001.13} | {TP608.1}

#### `MCU_RESET_N_AFE`
- **SOURCE / DESTINATION PINS:** `U7001.44` (P0.20_44); `U6001.11` (~{SYNC}/~{RESET}_11); `TP610.1` (1_1)
- **SUBSYSTEM:** frozen Phase 3A testpoint branches
- **CURRENT STATE:** MAIN PATH COMPLETE + BRANCH MISSING
- **APPROXIMATE BOARD REGION:** x=2.00–53.15 mm, y=4.15–25.50 mm
- **SIGNAL TYPE:** digital / testpoint
- **ROUTING SENSITIVITY:** medium
- **REASON:** All primary-device/filter endpoints are in one connected group; only the listed TP is isolated. Preserve the frozen main path. Clock/SPI branches introduce stubs; choose attachment geometry only in a later plan, with no main-path optimization.
- **EXISTING COPPER / CONNECTIVITY:** 8 track segments, 2 vias; 2 pad groups; 1 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {U7001.44, U6001.11} | {TP610.1}

### Inventory for shared GND access

#### `GND`
- **SOURCE / DESTINATION PINS:** `C306.1` (1_1); `R404.1` (1_1); `C404.1` (1_1); `U4002.2` (GND_2); `D202.1` (A1_1); `C502.1` (1_1); `R204.1` (1_1); `C4001.2` (2_2); `Q3001.2` (S_2); `C2002.2` (2_2); `C503.1` (1_1); `D201.1` (A1_1); `C501.1` (1_1); `C203.1` (1_1); `Q3002.2` (S_2); `C103.1` (1_1); `C107.1` (1_1); `C206.1` (1_1); `C2003.2` (2_2); `U3001.3` (GND_3); `U3001.8` (GND_8); `C4004.2` (2_2); `D302.1` (A1_1); `C4003.2` (2_2); `C4006.2` (2_2); `J3001.A1` (GND_A1); `J3001.A12` (GND_A12); `J3001.B1` (GND_B1); `J3001.B12` (GND_B12); `U501.11` (V-_11); `R304.1` (1_1); `C6008.2` (2_2); `C204.1` (1_1); `C4005.2` (2_2); `U4001.3` (PGND_3); `U4001.7` (PS/SYNC_7); `U4001.9` (GND_9); `U4001.11` (PAD_11); `U7001.1` (GND_1); `U7001.2` (GND_2); `U7001.15` (GND_15); `U7001.33` (GND_33); `U7001.55` (GND_55); `R2001.2` (2_2); `C407.1` (1_1); `C2001.2` (2_2); `C6009.2` (2_2); `C4002.2` (2_2); `D401.1` (A1_1); `J2001.3` (GND_3); `U2001.4` (CE_N_4); `U2001.5` (EN2_5); `U2001.8` (VSS_8); `C403.1` (1_1); `R3004.2` (2_2); `C7002.2` (2_2); `R104.1` (1_1); `C5001.1` (1_1); `D402.1` (A1_1); `R3001.2` (2_2); `D102.1` (A1_1); `U503.11` (V-_11); `C104.1` (1_1); `R403.1` (1_1); `C6007.2` (2_2); `C5002.1` (1_1); `C106.1` (1_1); `C7001.2` (2_2); `D301.1` (A1_1); `C406.1` (1_1); `R203.1` (1_1); `R303.1` (1_1); `R2002.2` (2_2); `D101.1` (A1_1); `U6001.2` (AGND_2); `U6001.19` (DGND_19); `R3002.2` (2_2); `C307.1` (1_1); `R103.1` (1_1); `C304.1` (1_1); `C303.1` (1_1); `C207.1` (1_1); `R5004.1` (1_1); `J5001.1` (RLD_ELECTRODE_1); `U502.11` (V-_11); `TP402.1` (1_1); `J8001.3` (GND_3); `J8001.5` (GND_5); `J8001.9` (GNDDetect_9); `TP602.1` (1_1)
- **SUBSYSTEM:** plane access across all subsystems
- **CURRENT STATE:** PARTIAL
- **APPROXIMATE BOARD REGION:** x=0.94–53.60 mm, y=-3.28–31.00 mm
- **SIGNAL TYPE:** ground
- **ROUTING SENSITIVITY:** high
- **REASON:** Two filled internal GND zones connect the existing core, but 37 other pad groups lack electrical access. Add local return/stitching connections in each owning phase; do not redraw or reroute the frozen plane structure.
- **EXISTING COPPER / CONNECTIVITY:** 16 track segments, 53 vias; 38 pad groups; 37 DRC missing-connection pairs.
- **CONNECTED GROUPS:** {C306.1, R404.1, C404.1, U4002.2, D202.1, C502.1, R204.1, C4001.2, D201.1, C203.1, C103.1, C107.1, C206.1, C4004.2, D302.1, C4003.2, C4006.2, U501.11, R304.1, C6008.2, C204.1, C4005.2, U4001.3, U4001.7, U4001.9, U4001.11, C407.1, C6009.2, C4002.2, D401.1, C403.1, R104.1, D402.1, D102.1, C104.1, R403.1, C6007.2, C106.1, D301.1, C406.1, R203.1, R303.1, D101.1, U6001.2, U6001.19, C307.1, R103.1, C304.1, C303.1, C207.1, U502.11} | {Q3001.2} | {C2002.2} | {C503.1} | {C501.1} | {Q3002.2} | {C2003.2} | {U3001.3} | {U3001.8} | {J3001.A1, J3001.B12} | {J3001.A12, J3001.B1} | {U7001.1} | {U7001.2} | {U7001.15} | {U7001.33} | {U7001.55} | {R2001.2} | {C2001.2} | {J2001.3} | {U2001.4} | {U2001.5} | {U2001.8} | {R3004.2} | {C7002.2} | {C5001.1} | {R3001.2} | {U503.11} | {C5002.1} | {C7001.2} | {R2002.2} | {R3002.2} | {R5004.1} | {J5001.1} | {TP402.1} | {J8001.3} | {J8001.5} | {J8001.9} | {TP602.1}
- **PLANE-CONNECTED CORE:** the first group contains 51 pads connected through existing tracks/vias and saved In1/In2 fills. The other 37 groups contain 39 pads, including two already-overlapping connector pairs; these need access, not a new board-wide ground bus. U2001.17 is absent and not among the 90 physical GND pads. TP402/TP602 are only two of the missing groups; GND is not a testpoint-only net.

## Completed nets excluded from remaining routing
35 PCB nets have all physical pads in one connected group. Their presence is checked independently of the global DRC count. No routing changes are proposed:

| Net | All connected pins | Tracks / vias |
|---|---|---:|
| `AFE_CAP` | C6009.1, U6001.18 | 2 / 0 |
| `Net-(C101-Pad2)` | C101.2, R107.1, R103.2 | 3 / 0 |
| `Net-(C102-Pad2)` | R108.1, R104.2, C102.2 | 3 / 0 |
| `Net-(C201-Pad2)` | R207.1, R203.2, C201.2 | 3 / 0 |
| `Net-(C202-Pad2)` | R204.2, R208.1, C202.2 | 3 / 0 |
| `Net-(C301-Pad2)` | C301.2, R303.2, R307.1 | 3 / 0 |
| `Net-(C302-Pad2)` | C302.2, R308.1, R304.2 | 3 / 0 |
| `Net-(C401-Pad2)` | C401.2, R407.1, R403.2 | 3 / 0 |
| `Net-(C402-Pad2)` | R404.2, C402.2, R408.1 | 3 / 0 |
| `Net-(D101-COM)` | R105.2, C103.2, U501.3, R101.2, D101.3 | 11 / 2 |
| `Net-(D102-COM)` | U501.5, R106.2, D102.3, C104.2, R102.2 | 11 / 2 |
| `Net-(D201-COM)` | D201.3, C203.2, U501.10, R205.2, R201.2 | 10 / 2 |
| `Net-(D202-COM)` | D202.3, U501.12, C204.2, R202.2, R206.2 | 13 / 2 |
| `Net-(D301-COM)` | R301.2, R305.2, D301.3, C303.2, U502.3 | 11 / 2 |
| `Net-(D302-COM)` | R306.2, D302.3, R302.2, C304.2, U502.5 | 11 / 2 |
| `Net-(D401-COM)` | R401.2, D401.3, C403.2, R405.2, U502.10 | 11 / 2 |
| `Net-(D402-COM)` | C404.2, R402.2, D402.3, R406.2, U502.12 | 13 / 2 |
| `Net-(J101-IN+)` | R101.1, J101.1 | 4 / 0 |
| `Net-(J101-IN-)` | R102.1, J101.2 | 4 / 0 |
| `Net-(J201-IN+)` | R201.1, J201.1 | 4 / 0 |
| `Net-(J201-IN-)` | R202.1, J201.2 | 4 / 0 |
| `Net-(J301-IN+)` | R301.1, J301.1 | 4 / 0 |
| `Net-(J301-IN-)` | J301.2, R302.1 | 4 / 0 |
| `Net-(J401-IN+)` | J401.1, R401.1 | 4 / 0 |
| `Net-(J401-IN-)` | J401.2, R402.1 | 4 / 0 |
| `Net-(U501A--)` | C101.1, U501.1, U501.2 | 5 / 2 |
| `Net-(U501B--)` | U501.6, U501.7, C102.1 | 5 / 2 |
| `Net-(U501C--)` | U501.8, U501.9, C201.1 | 4 / 2 |
| `Net-(U501D--)` | U501.13, U501.14, C202.1 | 7 / 2 |
| `Net-(U502A--)` | C301.1, U502.1, U502.2 | 6 / 2 |
| `Net-(U502B--)` | C302.1, U502.6, U502.7 | 5 / 2 |
| `Net-(U502C--)` | C401.1, U502.8, U502.9 | 5 / 2 |
| `Net-(U502D--)` | C402.1, U502.13, U502.14 | 5 / 2 |
| `SW_L1` | U4001.4, L4001.1 | 3 / 0 |
| `SW_L2` | U4001.2, L4001.2 | 3 / 2 |

AFE_CAP is fully connected U6001.18–C6009.1; SW_L1/SW_L2 are fully connected converter-to-inductor nets. No separate unfinished external oscillator/crystal net exists. The seven Phase 3A ADC–MCU primary paths are all connected, with exactly two frozen vias each (14 total), but their testpoints remain isolated as inventoried. The eight CH*_P/N primary analog paths are also connected; only testpoints remain. No power net can be excluded on a plane-connection assumption because only GND zones exist.

## Intentionally unrouted / no-connect nets
Sixteen PCB nets each have one pad, no tracks/vias, and a matching schematic `+no_connect` pin. These require no routing. Slash escapes in PCB names match the same schematic debug pins. This is schematic evidence of intentional NC, not an inference from a single-pad net name.

| PCB net | Pin | Intentional status |
|---|---|---|
| `unconnected-(J3001-SBU1-PadA8)` | J3001.A8 | Explicit schematic no-connect |
| `unconnected-(J3001-SBU2-PadB8)` | J3001.B8 | Explicit schematic no-connect |
| `unconnected-(J8001-KEY-Pad7)` | J8001.7 | Explicit schematic no-connect |
| `unconnected-(J8001-NC{slash}TDI-Pad8)` | J8001.8 | Explicit schematic no-connect |
| `unconnected-(J8001-SWO{slash}TDO-Pad6)` | J8001.6 | Explicit schematic no-connect |
| `unconnected-(U2001-ITERM-Pad15)` | U2001.15 | Explicit schematic no-connect |
| `unconnected-(U2001-TMR-Pad14)` | U2001.14 | Explicit schematic no-connect |
| `unconnected-(U3001-NC-Pad10)` | U3001.10 | Explicit schematic no-connect |
| `unconnected-(U3001-NC-Pad6)` | U3001.6 | Explicit schematic no-connect |
| `unconnected-(U3001-NC-Pad7)` | U3001.7 | Explicit schematic no-connect |
| `unconnected-(U3001-NC-Pad9)` | U3001.9 | Explicit schematic no-connect |
| `unconnected-(U4002-NC-Pad4)` | U4002.4 | Explicit schematic no-connect |
| `unconnected-(U7001-DCCH-Pad31)` | U7001.31 | Explicit schematic no-connect |
| `unconnected-(U7001-P0.19-Pad42)` | U7001.42 | Explicit schematic no-connect |
| `unconnected-(U7001-P0.22-Pad46)` | U7001.46 | Explicit schematic no-connect |
| `unconnected-(U7001-P0.25-Pad49)` | U7001.49 | Explicit schematic no-connect |

Unnetted connector/mechanical pads are not ordinary signal nets. In particular J3001.SH needs the shield decision described above; do not merge it into GND by assumption. U2001 TMR/ITERM and U7001 DCCH are explicit schematic no-connects in this design, not discovery-approved changes to their electrical requirements.

## Reconciled totals and final status
92 physical PCB nets = 41 unfinished + 35 fully connected + 16 intentional NC. Schematic has one additional net, USB_SHIELD, with no mapped PCB pad; missing U2001.17 belongs to existing GND. These mapping issues are separately flagged rather than added as invented routing nets. There are 40 unfinished non-ground nets and one unfinished GND-access net. Of the five partial nets, four are power/reference nets and one is GND. The 15 testpoint-only nets are a disjoint category; mixed power/reference/GND branches are included in their parent partial/unrouted nets.
```text
TOTAL REMAINING NETS REQUIRING ROUTING: 41 (40 non-ground + 1 GND access)
COMPLETELY UNROUTED: 21
PARTIALLY ROUTED: 5
TESTPOINT/BRANCH-ONLY: 15

PROPOSED PHASE 3B NETS: Net-(U503A-+), VCM, Net-(U503B--), Net-(U503C--), Net-(U503D--), RLD_SAFE, AFE_3V0; local GND access
PROPOSED PHASE 3C NETS: USB_D+, USB_D-, CC1, CC2; local GND access
PROPOSED LATER PHASES: 3D (BAT+, SYS_RAW, USB_VBUS, 3V3, PACK_NTC, ICHG_SET_TBD, ILIM_SET_TBD, AFE_ENABLE, Net-(Q3002-D)); 3E (CHG_N, PGOOD_N, SWDCLK, SWDIO, MCU_RESET_N); 3F (CH1_P, CH1_N, CH2_P, CH2_N, CH3_P, CH3_N, CH4_P, CH4_N, AFE_CLKIN, MCU_SCLK, MCU_MOSI, AFE_MISO, MCU_CS_N, AFE_DRDY_N, MCU_RESET_N_AFE); GND access shared across all phases

PHASE 3A VERIFIED UNCHANGED: YES
PCB MODIFIED DURING DISCOVERY: NO

READY TO DEFINE PHASE 3B ROUTING PLAN: YES
```
Readiness here means the discovery scope is defined. It is not full-board DRC/release acceptance or permission to route. Footprint/edge issues remain unresolved for the later affected units. Only this report is written in the project; transient extraction/DRC artifacts are in `/tmp`. Stop after discovery.
