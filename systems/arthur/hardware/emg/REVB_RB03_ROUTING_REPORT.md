# RB-03 — Routing and Verification Report (Rev B V1, 51.3 × 62.45 mm)

> **Superseded in part by RB-03R (2026-10-10).** The via-in-pad blocker (section 7.2: 17 via-in-pad) and the amended `hiz_leakage`
> rule (7.1) are replaced: the installed board is the V1C placement, 51.30 × 64.95 mm, 0 via-in-pad, narrowed TLV9064 exemptions.
> See `REVB_RB03R_VIA_ELIMINATION.md`, `REVB_RB03R_ANALOG_ROUTING_AUDIT.md`, `REVB_RB03R_DRC_RULE_VALIDATION.md`. The run-14 board is
> archived in `rev-b-xiao/archive/rb03_run14/`.


Date: 2026-10-11. Branch `hardware/emg-rev-b`. **Not committed. No manufacturing release files. No order.**
Main PCB: `hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_pcb` (sha256 `c393c9b3619c89a7…`).
Evidence: `rev-b-xiao/evidence/rb03/` (DRC/ERC JSON, audit, router log, board images). Reproduce:
`bash hardware/emg/rev-b-xiao/tools/run_rb03_route.sh <scratch>`.

## 1. Final gate

```
FINAL PCB DIMENSIONS:           51.3 x 62.45 mm, 4 copper layers (was 97 x 32)
ROUTED NET COUNT:               77 / 77 signal nets + GND (73 pads tied to the In1 plane); 0 failed
UNCONNECTED NETS:               0
DRC ERRORS / WARNINGS:          0 / 1  (the one warning is the accepted U1 lib_footprint_mismatch: board copy carries the hoisted rule areas)
SCHEMATIC PARITY ISSUES:        0
ERC ERRORS:                     0
GROUND-PLANE CONTINUITY:        PASS: In1 is one filled outline (2906 mm2, 91 % of the board); 100 % of every signal track length lies over it
ANALOG SIGNAL-INTEGRITY RISKS:  CONDITIONAL: see section 7 (AIN runs 42-62 mm with up to 14 mm P/N mismatch, hi-Z P/N length differences up to 3.9 mm, 17 vias inside SMD pads)
POWER-DISTRIBUTION:             PASS: worst DC drop 6.1 mV (assumed loads, section 6)
ECONOMIC PCBA:                  COMPATIBLE by design: 126 SMT top, 0 bottom, 0 THT, U1 absent from CPL, 0 parts < 2.5 mm to the edge; via-in-pad items need a decision
BAT+ POST:                      geometry PASS (CAD position, drill 1.40, 11 keep-outs, no violation); VBAT joins the ring on F.Cu (0.5 mm), see section 7
ENCLOSURE THICKNESS (<= 17 mm): FEASIBLE with 0.4 mm margin on assumed wall/bend values (16.6 mm over the connector strip, 11-14 mm elsewhere)
REMAINING MECHANICAL MEASUREMENTS: section 8
READINESS FOR FINAL DFM REVIEW: CONDITIONAL (open items in section 9)
MANUFACTURING RELEASE:          BLOCKED
```

## 2. Phase 0: V1 promotion and re-verification

* Archived references (unchanged): `rev-b-xiao/archive/rb02_97x32/ARTHUR_EMG_RevB_RB02_97x32.kicad_pcb` (RB-02 board) and
  `…_RB02G_V2_60x59_scratch.kicad_pcb`; V1/V2/V1R scratch boards remain in `evidence/rb02g/variants/`.
* The main PCB was regenerated from the approved V1 block placement with the unchanged `rb02_build_pcb.py` (135 / 135 footprints,
  same libraries, nets, DNP flag, XIAO rule areas) and is identical to `RB02G_V1_whatif.kicad_pcb` apart from UUIDs.
* RB-02 suite (30 checks in the module frame, `rb02g_check.py`): **27 PASS**, C06 board size (expected: V1 is not
  97 × 32), C26 JLC rail screening CONDITIONAL (information only), C28 INFO. Module position/rotation, castellation positions
  (0.0000 mm), BAT+ post, 11 keep-outs, iron-access bands, USB-C/U.FL/J1-plug corridors, X1 OUT-to-CLKIN 3.61 mm, decoupling, analog
  symmetry and AIN-network proximity all PASS on the routed board. `run_rb02_checks.sh` (which rebuilds the 97 × 32 board) is
  superseded and now refuses to run.
* Edge audit (RB-02E rule set): 126 top-side SMT, 0 bottom, 0 THT, U1
  absent in the DNP-aware CPL; **0 parts with body < 2.5 mm** and 0 with copper < 0.3 mm to the edge
  (nearest copper 0.5 mm, the JST tails).
* RB-01R suite (`run_rb01r_checks.sh`) re-run on the schematic: ERC clean, 23 / 23 audit checks, mutation test PASS, Rev A PCB and
  tree hashes unchanged. The schematic files were not touched.

## 3. Routing method

* Autorouter choice: Freerouting was **not** used (downloading and executing a third-party binary needs explicit approval). A
  project-specific router was written instead (`tools/rb03_router.py`, pure Python + the KiCad `pcbnew` API for reading pads and
  writing tracks): orthogonal routing on a 0.1 mm grid; F.Cu, B.Cu and In2.Cu (In2 only in the module/RF half where RB-02 left the
  In2 ground zone out); per-net netclass width and clearance with the larger of the two classes on each pair; hi-Z nets on F.Cu only,
  no vias, 0.4 mm to foreign tracks/vias; SPI-to-hi-Z 2 mm and SPI-to-buffer 1 mm in both routing orders; SPI/control tracks
  excluded from ZONE_A; XIAO underside rule areas, 0.5 mm copper-to-edge, 0.6/0.3 mm vias, power connections to ICs necked to 0.2 mm,
  narrow 0.15/0.15 mm east channel for the XIAO signals; rip-up/reorder of failed nets and a local GND repair.
* Not a general autorouter: no 45° routing, no differential-pair coupling, no length tuning, greedy net order. Quality figures
  below are measured on the result, not assumed.
* pcbnew rewrites `ARTHUR_EMG_RevB.kicad_pro` when it saves a board and drops the netclasses (the custom DRC rules then become
  inert without a message). The pipeline therefore runs pcbnew only in a scratch copy of the project and copies back the `.kicad_pcb`.
  An earlier "clean" DRC in this session was invalid for that reason and was discarded; every number here is from a run with the
  netclasses verified.

## 4. Result

| Item | Value |
|---|---|
| Tracks / vias | 1324 / 228 (through vias 0.6 / 0.30 mm) |
| Track length F.Cu / B.Cu / In2.Cu | 1089 / 470 / 122 mm |
| Track widths | 0.15 mm × 29, 0.2 mm × 859, 0.25 mm × 73, 0.3 mm × 326, 0.5 mm × 37 |
| GND | 73 pads, each with its own via to In1 (no GND pour on F.Cu/B.Cu) |
| Zones | In1 GND plane (full board), In2 GND (zones A/B region), zone clearance 0.30 mm |

Length by netclass (mm, vias): ADC_CAP 3 (0), ANALOG_REF 115 (14), CTRL_SLOW 272 (24), EMG_BUF 546 (60), EMG_ELECTRODE 59 (0), EMG_HIZ 138 (0), GND 146 (69), NC 57 (10), PWR_AFE 132 (27), PWR_DVDD 52 (6), PWR_VBAT 57 (5), SPI_FAST 68 (10), VBUS_SENSE 35 (3).

## 5. Priorities and how they were met

| Priority | Result |
|---|---|
| Low-noise 4-channel acquisition | 8 electrode nets 7.4 mm each (P = N), 8 hi-Z nets F.Cu only, 0 vias, over In1 100 % |
| Minimal hi-Z lengths | 15.5-19.6 mm per leg (cell chain Rs → clamp → 100 pF / 10 M → follower); the P and N leg of a channel differ by 2.6-3.9 mm because the TLV9064 P and N input pins sit at different positions |
| Symmetric input networks | electrode 0.0 mm difference; hi-Z 2.6-3.9 mm; buffered 2.1-4.5 mm; AC-coupled 0-3.6 mm; ADC-input runs 0-14.2 mm (CH2) — see risks |
| Input protection / ADC clamps | clamps and 1 nF caps untouched by routing distance changes: caps 2.1-3.6 mm, clamps 5.7-10.5 mm from their AIN pins (placement checks C24/C25 PASS) |
| Continuous In1 GND plane | one filled outline; no tracks on In1; 8 hi-Z/electrode nets never leave F.Cu |
| Clean AFE_3V0 / DVDD_F | AFE_3V0 132 mm tree (0.3 mm, 0.2 mm at IC pins), DVDD_F 45 mm; worst path 204 / 58 mΩ |
| Short ADS131M04 oscillator connection | X1 OUT net 4.7 mm, 0 vias, F.Cu |
| Controlled SPI and digital | 8 SPI nets 68 mm, kept out of ZONE_A, 2 mm from hi-Z and 1 mm from buffered nets (rule-checked) |
| USB power-interlock integrity | VBUS_GATE / AFE_EN / VBAT_AFE routed, parity 0; no change to the interlock topology |
| XIAO access, BAT+ post, keep-outs | no track or via in any of the 11 rule areas (DRC 0 keep-out items); no part within 1.5 mm of the toes |
| Via-in-pad | **not fully avoided: 17 via centres lie inside SMD pads** (section 7) |

## 6. Verification (phase 2)

| # | Check | Result |
|---|---|---|
| 1 | KiCad 10.0.6 DRC, `--schematic-parity`, custom rules active | 0 errors, 1 warning (U1 lib mismatch) |
| 1 | ERC (frozen schematic) | 0 violations |
| 2 | Unconnected items | 0 |
| 3 | Clearances (netclass + 8 custom rules) / via placement | pass; vias [[0.6, 0.3]] only; no via in the 11 via keep-outs; 0 shorts |
| 3 | Plane continuity | In1: 1 outline, 91 % copper (anti-pads of 228 vias); In2 GND: 1 outline |
| 4 | Return paths | share of sampled track length over In1 copper: EMG_HIZ 100 %, EMG_ELECTRODE 100 %, EMG_BUF 100 %, ANALOG_REF 100 %, ADC_CAP 100 %, SPI_FAST 100 %, CTRL_SLOW 100 %, PWR_AFE 100 %, PWR_DVDD 100 %, PWR_VBAT 96 % (VBAT shortfall = the post anti-pad) |
| 5 | Critical electrode / ADC nets | table below |
| 6 | Economic PCBA | 126 top, 0 bottom, 0 THT, 0 < 2.5 mm, 0 < 0.3 mm; 228 through vias are ordinary 0.6/0.3 mm |
| 7 | Mechanical | keep-outs clean, copper ≥ 0.5 mm from the edge, BAT+ post C14/C15/C16 PASS |
| 8 | Against the frozen schematic | parity 0, every pad net equals the netlist (C03 PASS), 0 unconnected, 0 shorts |

Critical nets (single-layer F.Cu, no vias unless stated):

| Net | Class | Length mm | Vias | Layers | Width mm |
|---|---|---|---|---|---|
| /ADC/AFE_CAP | ADC_CAP | 2.9 | 0 | F.Cu | 0.25 |
| /CH1/ELEC_N | EMG_ELECTRODE | 7.4 | 0 | F.Cu | 0.25 |
| /CH1/ELEC_P | EMG_ELECTRODE | 7.4 | 0 | F.Cu | 0.25 |
| /CH1/HIZ_N | EMG_HIZ | 15.5 | 0 | F.Cu | 0.2 |
| /CH1/HIZ_P | EMG_HIZ | 18.1 | 0 | F.Cu | 0.2 |
| /CH2/ELEC_N | EMG_ELECTRODE | 7.4 | 0 | F.Cu | 0.25 |
| /CH2/ELEC_P | EMG_ELECTRODE | 7.4 | 0 | F.Cu | 0.25 |
| /CH2/HIZ_N | EMG_HIZ | 19.6 | 0 | F.Cu | 0.2 |
| /CH2/HIZ_P | EMG_HIZ | 15.7 | 0 | F.Cu | 0.2 |
| /CH3/ELEC_N | EMG_ELECTRODE | 7.4 | 0 | F.Cu | 0.25 |
| /CH3/ELEC_P | EMG_ELECTRODE | 7.4 | 0 | F.Cu | 0.25 |
| /CH3/HIZ_N | EMG_HIZ | 15.5 | 0 | F.Cu | 0.2 |
| /CH3/HIZ_P | EMG_HIZ | 18.1 | 0 | F.Cu | 0.2 |
| /CH4/ELEC_N | EMG_ELECTRODE | 7.4 | 0 | F.Cu | 0.25 |
| /CH4/ELEC_P | EMG_ELECTRODE | 7.4 | 0 | F.Cu | 0.25 |
| /CH4/HIZ_N | EMG_HIZ | 19.6 | 0 | F.Cu | 0.2 |
| /CH4/HIZ_P | EMG_HIZ | 15.7 | 0 | F.Cu | 0.2 |

Per-channel length differences (P − N, mm): CH1_HIZ 2.6, CH1_ELEC 0.0, CH1_BUF 4.5, CH1_ACN 3.3, CH1_ADCIN 1.4, CH2_HIZ 3.9, CH2_ELEC 0.0, CH2_BUF 2.1, CH2_ACN 3.6, CH2_ADCIN 14.2, CH3_HIZ 2.6, CH3_ELEC 0.0, CH3_BUF 3.9, CH3_ACN 0.0, CH3_ADCIN 6.4, CH4_HIZ 3.9, CH4_ELEC 0.0, CH4_BUF 2.3, CH4_ACN 2.9, CH4_ADCIN 0.0.

### Power distribution (resistance from source pad to worst pad; copper 35 µm, via 1.2 mΩ; loads are budget values)

| Net | Source | Length mm | Vias | Width mm | Worst R mΩ | Load mA | Drop mV |
|---|---|---|---|---|---|---|---|
| AFE_3V0 | U4002.5 | 131.6 | 27 | 0.2/0.3 | 204 | 30 | 6.1 |
| DVDD_F | FB1.2 | 45.2 | 6 | 0.3 | 58 | 11 | 0.7 |
| /XIAO_Brain_Interface/XIAO_3V3 | U1.12 | 7.1 | 0 | 0.3 | 7 | 11 | 0.1 |
| VBAT | J1.1 | 35.2 | 3 | 0.5 | 15 | 350 | 5.2 |
| /Analog_Power_Interlock/VBAT_AFE | R4001.2 | 22.0 | 2 | 0.5 | 19 | 20 | 0.4 |
| /XIAO_5V | U1.14 | 35.1 | 3 | 0.25 | 49 | 1 | 0.0 |

Loads: DVDD_F 11.4 mA (RB-01R budget), VBAT 350 mA (BAT+ post rating), AFE_3V0 30 mA, VBAT_AFE 20 mA and XIAO_5V 1 mA are
*assumed* upper bounds, not datasheet-derived. Every drop is below 15 mV.

## 7. Exceptions, amendments and unresolved risks

### 7.1 Amended custom DRC rule (`hiz_leakage`)

The RB-02 rule demanded 0.4 mm between a hi-Z item and any foreign track, via, **pad** or zone. At TSSOP-14 pin pitch (0.65 mm,
0.25 mm gap between pads) this is physically impossible, and it failed 100+ times in the first routing pass. Amended: pads are
exempt (the 0.2 mm netclass clearance still applies), and track-to-track inside the courtyards of U501-U503 is exempt. Proof
(`rb03_seed_hiz_rule.py`): a seeded foreign track 0.2 mm from a hi-Z track outside the courtyards raises the rule (1 violation in the
recorded run, `evidence/rb03/seed_hiz_rule.json`); the same seed inside a TLV9064 courtyard raises 0. This is a project guideline change that needs your acceptance.

### 7.2 Via-in-pad (open blocker for a fully clean layout)

With a strict "no via within 0.25 mm of any pad" rule V1 does **not** route (10-12 nets fail in the dense AIN/ADC and clamp
rows). The router therefore falls back to via-in-pad only for the nets listed below; hi-Z, electrode and ADC_CAP nets never use it.

| Pad | Net | Via position (mm) |
|---|---|---|
| C201.1 | /CH2/BUF_P | (29.70,27.70) |
| U4002.2 | GND | (20.80,35.00) |
| D401.2 | AFE_3V0 | (9.80,12.80) |
| R6003.2 | /DRDY_N | (24.70,51.40) |
| D201.2 | AFE_3V0 | (28.60,12.80) |
| C6009.2 | GND | (24.70,46.50) |
| D202.2 | AFE_3V0 | (23.90,12.80) |
| C4006.2 | GND | (26.30,34.60) |
| C101.1 | /CH1/BUF_P | (38.50,27.90) |
| D301.2 | AFE_3V0 | (19.20,12.80) |
| C503.1 | AFE_3V0 | (46.40,21.90) |
| C6007.1 | AFE_3V0 | (16.00,44.30) |
| D101.2 | AFE_3V0 | (38.00,12.80) |
| D102.2 | AFE_3V0 | (33.30,12.80) |
| D302.2 | AFE_3V0 | (14.50,12.80) |
| U1.2 | /DRDY_N | (49.40,56.40) |
| R7106.2 | GND | (24.60,58.80) |

Vias whose hole touches a pad (centre outside the copper):

| Pad | Net | Via position (mm) |
|---|---|---|
| C401.2 | /CH4/ACN_P | (10.30,29.10) |
| C201.2 | /CH2/ACN_P | (30.00,29.10) |
| U6001.1 | AFE_3V0 | (16.20,46.30) |
| C102.2 | /CH1/ACN_N | (33.80,29.10) |
| C502.1 | AFE_3V0 | (16.40,22.30) |
| C501.1 | AFE_3V0 | (35.20,22.30) |
| R207.2 | /CH2_P | (25.90,29.50) |

Seven of the 17 are the AFE_3V0 supply pin (pad 2) of the BAV199 hi-Z clamps in the top row; the hi-Z 0.4 mm keep-away and the
GND vias around them leave no other place for the via. Four are ground pads (LDO U4002.2 / C4006.2, ADC reference cap C6009.2, R7106.2); the others are signal pads of buffered / DRDY nets and the XIAO castellation U1.2. JLCPCB accepts open via-in-pad but states it
takes no responsibility for the solder loss it causes (assembly T&C section 5, item 6). **Minimal adjustment options (not applied):**
(a) accept the 17 and request resin-plugged vias for them (extra fabrication cost, not Economic-documented); (b) move the eight
BAV199 clamps 0.8 mm outward and re-route (placement change, no electrical change); (c) fall back to V2 (60.4 × 58.9 mm), which
has 2× the channel width. Recommendation: (b), then re-run the pipeline.

### 7.3 Other deviations and risks

| # | Item | Detail |
|---|---|---|
| 1 | BAT+ connection | Spec asked for a ≥ 1.0 mm B.Cu/In2 VBAT trace to the bottom pad. VBAT joins the F.Cu ring with a 0.5 mm track that runs under the module in the free strip at x = 43.2 mm (0.4 mm outside the pad 15-22 keep-out). 0.35 A peak needs ≈ 0.3 mm of 1 oz copper. B.Cu copper of other nets must stay ≥ 0.5 mm from the Ø3.0 bottom pad: **see 7.4** |
| 2 | AIN runs | The 1 kΩ-source runs from the AC band to the ADC are 42-62 mm; P and N are not routed as a coupled pair (CH2 differs by 14 mm). Common-mode pickup is not cancelled as well as with pair routing; low-frequency EMG makes the delay skew irrelevant, interference pickup is the concern |
| 3 | Hi-Z P/N length difference | up to 3.9 mm (≈ 0.4 pF at 0.2 mm over In1); inherent to the amplifier pin positions |
| 4 | Via count on buffered nets | EMG_BUF 60 vias in 24 nets (B.Cu used for buffered signals) |
| 5 | CTRL_SLOW | 272 mm across 9 nets, some 30-50 mm runs in the digital half (slow signals; outside ZONE_A) |
| 6 | Hi-Z-to-XIAO distance | 18.1 mm (V1), unchanged; verify at bring-up with BLE active |
| 7 | Skin-side pads | TP1-TP8 and the Ø3.0 VBAT pad remain bare on B.Cu; routing added B.Cu copper (≈ 470 mm of tracks, all under solder mask) facing the skin side: enclosure partition required |
| 8 | Router quality | greedy, no length matching, no 45°; results are valid but not optimal. Re-running with a different order can change which nets use B.Cu |
| 9 | JLC acceptance | not tested with JLC's DFM tool (no Gerbers were generated) |

### 7.4 B.Cu clearance of the post pad

Nearest B.Cu copper of any other net to the edge of the Ø3.0 bottom pad: **0.53 mm** (spec ≥ 0.5 mm; enforced in the router as a
keep-out; the first routing pass had a DRDY_N track at 0.24 mm and was corrected). No B.Cu copper of another net lies within
0.5 mm of the post. On F.Cu only the VBAT track and ring are near it; the nearest foreign F.Cu item is the VBAT_SENSE track at 1.87 mm.


## 8. Enclosure thickness and remaining mechanical measurements

Thickness (assumed 1.2 mm walls, battery 5.3 mm max for a 503035-class cell, 4 mm wire-bend allowance; PCB 1.606 mm, JST mated
height 8.6 mm per JST reference):

| Zone | Stack | Total |
|---|---|---|
| Electrode connector strip (north 9.4 mm) | floor 1.2 + PCB 1.6 + plug 8.6 + bend 4.0 + lid 1.2 | **16.6 mm** (≤ 17: margin 0.4 mm) |
| Battery pocket (under the module west part) | floor 1.2 + cell 5.3 + foam 0.5 + PCB 1.6 + module 4.5 + lid 1.2 | 14.3 mm |
| Elsewhere | floor + PCB + parts ≤ 1.45 mm + lid | ≈ 6 mm |

Routing added no component height. The 17 mm target holds only if the wire-bend allowance stays ≤ 4.4 mm and the walls ≤ 1.3 mm.

Remaining physical measurements (unchanged, none can be done by calculation): XIAO PCB thickness, outline, castellation pitch,
BAT+ pad position (calipers on one module); B2B connectors and USB shell ovals (visual); solder cone / hole first-article;
U.FL plug and cable height; actual JST plug-with-wire envelope; battery model and PCM size; enclosure wall and strap lug design.

## 9. Open items before a final DFM review

1. Decision on the 17 via-in-pad pads (7.2) and on the amended hiz_leakage rule (7.1).
2. B.Cu clearance of the post pad (7.4).
3. AIN P/N pair coupling (7.3 #2): optional manual re-route in KiCad.
4. Bring-up noise check (hi-Z to XIAO).
5. Skin-side enclosure partition; battery/lead selection; verified polarity of the cell leads against J1.
6. JLCPCB DFM check on a real manufacturing package (not generated here).
