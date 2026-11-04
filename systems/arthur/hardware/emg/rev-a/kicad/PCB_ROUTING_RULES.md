# ARTHUR EMG Rev A — Routing Rules Freeze (Audit 13 / Routing Preparation Audit 1)

Status: rules freeze only. NO tracks drawn, NO vias added, NO copper zones added.
Placement is FROZEN (Audit 12 state). Input geometry (Audit 6) untouched.

Baseline (this audit, measured with `kicad-cli pcb drc`, KiCad 10.0.6):

- board: 45 x 30 mm, 4 layers (F.Cu / In1.Cu / In2.Cu / B.Cu)
- footprints: 106 (F.Cu 72 / B.Cu 34)
- bottom-side support trio: C4006 (15.0,3.5), C6001 (6.0,19.0), C6002 (2.5,19.0)
- routes (segments): 0, vias: 0, zones: 0
- short-type DRC violations: 0
- DRC total 617: silk_over_copper 199 (warning), silk_overlap 167 (warning),
  lib_footprint_issues 76 (warning, env missing stock libs), courtyards_overlap 73
  (error, placement-adjudicated per Audit 3/10/12), nonmirrored_text_on_back 35
  (warning), silk_edge_clearance 20 (warning), copper_edge_clearance 16 (error,
  fixed JST/battery edge-connector geometry per Audit 10), clearance 14 (error,
  bench/DNP + U4001-pin + C4002-J2001 proximities, listed in \u00a75/\u00a78),
  lib_footprint_mismatch 12 (warning, env), solder_mask_bridge 3 (error:
  J3001-SH vs CM101/CM102/CM202 bench DNP pads + U7001-NC56 vs C7002),
  pth_inside_courtyard 2 (error, J3001-SH vs CM101/CM202 bench DNP).
  269 unconnected items = expected unrouted-net report (routes: 0).
- ERC context (Audit 10): no errors; warnings are environment + 1 isolated label.

## 1. Layer stack and function (STACKUP FREEZE)

Intended stack (standard low-cost 4-layer FR-4, manufacturer nominal):

- L1 = F.Cu — components + critical signals + local power fanout.
- L2 = In1.Cu — continuous GND reference plane. NO SPLIT (no AGND/DGND islands).
- L3 = In2.Cu — power distribution (polygons/local pours) + limited secondary
  signals ONLY where justified (short, non-sensitive, orthogonal to L1/L4 jumps).
- L4 = B.Cu — secondary signals + bottom support trio (C4006/C6001/C6002) +
  bench DNP grid (CM/D) + B.Cu test points.

Manufacturing target (to confirm at order; provisional until fab stackup chosen):

- FR-4, 4 layers, ~1.0 mm finished thickness (JLCPCB-class standard 4-layer).
- Outer copper 1 oz, inner copper 0.5 oz (standard manufacturer offering).
- Standard manufacturer stackup preferred; NO exotic / impedance-controlled
  laminate order. Dielectric thicknesses per manufacturer nominal
  (see \u00a715 unresolved: exact prepreg/core build depends on chosen fab).

Validated architecture (not blindly accepted — checked against this placement):

- L2-GND continuity is the single most important routing asset: ADS1294 sits at
  (14.5,17.5) with inputs on the west edge (pads 9-16), VREF/VCAP on the north
  edge (pads 24-30), SPI on the east edge (pads 34-47), VCM/RLD on the south
  edge (pads 60-63). Every critical group gets an unbroken L2 reference if L2
  stays a plane. Splitting it would force return currents around islands and
  directly hurt EMG noise — hence the no-split rule.
- L3 power polygons are acceptable BECAUSE L2 stays continuous: return currents
  for L1 signals ride L2 directly under the trace; L3 copper is on the far side
  of L2 and does not interrupt that loop. L3 signals are tolerated only as
  short jumpers that do not carve L2 (they don't — different layer) and do not
  cross the analog input region on L3 without reason.
- L4 is NOT allowed for sensitive analog routing (EMG P/N, VREFP, VCAPx, VCM,
  RLDINV/RLDOUT). L4's reference is L3 (power, fragmented) instead of L2, so
  analog on L4 would have a dirty/uncertain return. L4 carries: MCU/SWD/digital
  overflow, USB short jumpers if needed, power stitching, B.Cu test-point
  fanout. Exception: the two bottom caps' own pads (unavoidable) + their
  dedicated vias up (\u00a76).
- Return-current rule: every L1 signal's return stays on L2 directly beneath the
  trace. No L2 copper cut is permitted under: CHx_P/N (electrode->R_SER->
  C_DIFF->ADC west edge), VREFP/VCAP corridor (ADC north edge), VCM/RLD south
  edge. L3 polygon edges must keep >= 0.5 mm clearance from these corridors'
  projection where practical, and L3 must never force an L2 cutout.

Antenna region (Raytac MDBT50Q-1MV2 U7001 at (36.25,15.0) rot -90):

- Keepout: NO copper (any layer), NO ground, NO traces, NO vias, NO battery,
  NO enclosure metal in the module datasheet keepout zone. Planned L2/L3 planes
  MUST be cut back out of that keepout. The keepout is documented here and must
  be drawn as a KiCad keepout before routing (\u00a715: exact keepout dimensions
  pending datasheet figure confirmation at routing start).
- Cmts.User text already marks "ANT KEEPOUT" near (43.25,8.4) and "RF EDGE".

## 2. Fabrication assumptions (JLCPCB-class, conservative)

Absolute JLCPCB-class 4-layer minima are ~0.09-0.1 mm trace/space and 0.2 mm
mechanical drill / 0.45 mm via diameter. This project does NOT route at the
minima. Density permits comfort (45x30, 106 footprints, only QFP-0.5 mm fine
pitch at the ADC), so defaults sit well above the floor:

| Parameter | Fab minimum (reference) | Project default | Preferred analog | Preferred power |
|---|---|---|---|---|
| trace width | 0.10 mm | 0.20 mm | 0.25 mm (EMG/ref) | 0.40-0.60 mm (rails), polygons for high-I |
| trace spacing (clearance) | 0.10 mm | 0.20 mm | 0.25 mm (0.30 mm to clocks/switch) | 0.20 mm |
| via diameter | 0.45 mm | 0.80 mm | 0.80 mm (avoid vias; see \u00a74-6) | 0.80 mm, arrays for high-I |
| via drill | 0.20 mm | 0.40 mm | 0.40 mm | 0.40 mm |
| copper-to-edge | 0.30 mm | 0.50 mm | 0.50 mm | 0.50 mm |
| via-to-via (hole edge) | 0.25 mm | 0.50 mm | 0.50 mm | 0.50 mm |
| via-to-pad | 0.25 mm | 0.40 mm | 0.50 mm | 0.40 mm |

Notes:

- The 0.20 mm project default equals the existing board `min_clearance` /
  `min_track_width` setup and the Default net_class (0.20/0.25 mm) already in
  the files — so the freeze is consistent with the current DRC baseline.
- Do NOT set every signal to the manufacturer minimum. 0.10-0.127 mm geometry
  is reserved for neck-downs inside the 0.5 mm-pitch ADC fanout ONLY if needed,
  and must widen back to default immediately outside the fanout.
- Soldermask bridge DRC (3) and 0.5 mm-pitch ADC pads are the binding density
  constraint, not trace width.

## 3. Net classes (KiCad `net_settings.classes` + PCB `net_class`)

Implemented in `ARTHUR_EMG_RevA.kicad_pro` (`net_settings.classes`,
`netclass_assignments`, `netclass_patterns`) and mirrored into
`ARTHUR_EMG_RevA.kicad_pcb` (`net_class` blocks). Each class has an
electrical reason — none exist for naming aesthetics.

| Class | Nets | Width / clearance / via dia / drill | Layers | Prio | Reason + constraints |
|---|---|---|---|---|---|
| EMG_INPUT | CH1_P CH1_N CH2_P CH2_N CH3_P CH3_N CH4_P CH4_N | 0.25 / 0.20 (*0.25 track-to-track, §4*) / 0.8 / 0.4 | L1 only | 2 (after ref) | Highest-sensitivity group. Symmetry + loop area dominate (\u00a74). No vias; >= 3 mm to SCLK (1 mm min hard floor); >= 5 mm to SW nodes. |
| EMG_FRONT | ELECTRODE_P ELECTRODE_N | 0.25 / 0.20 (*0.25 track-to-track*) / 0.8 / 0.4 | L1 only | 2 | JST->R_SER field wiring side; same symmetry rules as EMG_INPUT. |
| ANALOG_REF | VREFP_2V4 VCAP1 VCAP2 VCAP3 VCAP4 | 0.30 / 0.20 (*0.25 track-to-track, guarded*) / 0.8 / 0.4 | L1 only | 1 (first) | ADC charge-reservoir/reference; shortest-path, L1-only, guarded by GND (\u00a75). |
| ANALOG_VCM_RLD | VCM RLDINV RLDOUT RLD_SAFE | 0.30 / 0.20 (*0.25 track-to-track, guarded*) / 0.8 / 0.4 | L1 only | 1 | Driven-reference loop; RLDOUT guarded, >= 3 mm to SCLK (\u00a75). RLD_SAFE is the electrode-side tail after 100 k safety R. |
| ADC_DIGITAL | AFE_SCLK AFE_MOSI AFE_MISO AFE_CS_N AFE_DRDY_N AFE_START AFE_RESET_N AFE_PWDN_N | 0.20 / 0.20 (SCLK 0.25 clr) / 0.8 / 0.4 | L1, L4 short jumps | 6 | Buffer-to-ADC group incl. direct MISO/DRDY (\u00a77). SCLK is aggressor: separation rules apply to IT, not extra width. |
| MCU_DIGITAL | MCU_SCLK MCU_MOSI MCU_CS_N MCU_START MCU_RESET_N_AFE MCU_RESET_N MCU_PWDN_N AFE_ENABLE CHG_N PGOOD_N PACK_NTC ICHG_SET_TBD ILIM_SET_TBD | 0.20 / 0.20 / 0.8 / 0.4 | L1/L4, L3 short jumps ok | 9 | Slow control/status; no length matching; keep out of analog region. |
| SWD_DEBUG | SWDCLK SWDIO | 0.20 / 0.20 / 0.8 / 0.4 | L1/L4 | 9 | Debug only; route late, keep away from inputs. |
| USB | USB_D+ USB_D- | 0.20 w / 0.20 gap prov. / 0.8 / 0.4 | L1 only | 7 | Provisional geometry; 90 ohm NOT claimed (\u00a712). CC1 CC2 USB_SHIELD stay in DEFAULT. |
| POWER_BATTERY | BAT+ | 0.60 / 0.20 / 0.8 / 0.4 | L1 + L3 polygon | 8 | Battery current; polygon where possible. |
| POWER_5V_VBUS | USB_VBUS | 0.60 / 0.20 / 0.8 / 0.4 | L1 + L3 polygon | 8 | Charger input; keep loop tight at U2001. |
| POWER_3V3 | 3V3 | 0.40 / 0.20 / 0.8 / 0.4 | L1 + L3 polygon | 8 | Digital rail; local pours, not full plane. |
| POWER_AFE_3V0 | AFE_3V0 | 0.40 / 0.20 / 0.8 / 0.4 | L1 + L3 polygon | 5 (decoupling early) | Quiet analog rail; star from U4002, decoupling first (\u00a79). |
| POWER_SWITCHING | SYS_RAW SW_L1 SW_L2 | 0.60 / 0.20 (*0.25 to victims, sidecar rule*) / 0.8 / 0.4 | L1 + local L3 copper | 4 | High-di/dt; small switch copper, via arrays (\u00a78). |
| GND | GND | 0.40 / 0.20 / 0.8 / 0.4 | L2 plane + short L1/L4 links | 11 (pour last) | Reference plane net; L2 continuous (\u00a710). |
| DEFAULT | CC1 CC2 USB_SHIELD + all unconnected-* singletons | 0.25 / 0.20 / 0.8 / 0.4 | L1/L4 | 10 | Leftover/slow/singleton nets; unconnected-* pads stay isolated copper islands (NC decision, Audit 10). |

Diff-pair definitions: USB_D+/D- declared as a differential pair in the USB
class (provisional 0.20/0.20 mm, \u00a712). EMG P/N pairs are routed as a
symmetric pair group, NOT as an impedance-controlled diff pair (\u00a74) —
no diff-pair impedance entry is created for them.

## 4. EMG input routing rules (CH1-CH4, highest sensitivity)

Chain (per channel): JST electrode P/N -> R_SER pair (2.2 k 0603, rot90 row
y=22.0) -> C_DIFF (4.7 nF 0603, y=21.2) -> ADS1294 west-edge pads 9-16
(CH4_N 9 … CH1_P 16). R_BIAS 390 k (rot90, y=20.4) flanks each channel to VCM.

- Philosophy: symmetric P/N pair routing for common-mode rejection, NOT
  controlled-impedance RF routing. At EMG frequencies (DC–500 Hz, sampled kHz)
  trace impedance is irrelevant; what matters is P/N symmetry, small loop area,
  and a clean GND reference. Do NOT over-engineer 50/90/100-ohm geometry here.
- Geometry: 0.25 mm traces, 0.25 mm intra-pair gap held constant along the
  route; pair pitch must reproduce the placement pitch (2.0 mm R_SER pairs).
- Symmetry target: P/N length match <= 0.5 mm per channel (tighten to 0.25 mm
  if layout allows without detours); route as a pair from C_DIFF to ADC pads,
  no necking one leg.
- Loop area: keep P and N adjacent for the whole run (<= 0.5 mm edge-to-edge);
  R_SER->C_DIFF already ~0.9 mm centers — do not spread the pair to dodge
  obstacles, reroute the obstacle instead.
- Layer/via policy: L1 ONLY, ZERO vias on P/N between R_SER and ADC pads.
  No layer transitions in the input corridor (west edge x in [8.8,9.0] pads,
  y in [17.75,21.25]).
- Separation: >= 3.0 mm from SCLK/MCU clocks (1.0 mm absolute floor where the
  ADC east edge forces proximity — then cross at 90\u00b0 and guard with GND);
  >= 5.0 mm from SW_L1/SW_L2/inductor/switch copper (2.0 mm floor, with L2 GND
  between and orthogonal crossing only).
- Reference: unbroken L2 GND under the entire input corridor; no L3 copper
  edge within 0.5 mm of the corridor projection; no digital trace crossing the
  corridor on any layer (route digital around, never over/under it).
- R_BIAS/VCM tails: 0.25 mm, short, L1, hugging the pair back to the VCM star;
  TP111-118 connections are short stubs off the pair pads (\u00a713).
- Audit-6 placement stays untouched: no R_SER/C_DIFF/R_BIAS moves to ease
  routing. If a route cannot close, the route changes — not the placement.

## 5. ADS1294 reference / VCAP / RLD rules

Pins (U6001 at (14.5,17.5)): VREFP pad 24 @ (14.25,23.16); GND pads 25/31;
VCAP4 pad 26 @ (15.25,23.16); VCAP1 pad 28 @ (16.25,23.16); VCAP2 pad 30 @
(17.25,23.16); VCAP3 pad 55 (south); VCM pads 60/62 + RLDINV 61 + RLDOUT 63
(south edge y=11.84).

- Priority: route FIRST (order #1, \u00a714). These are charge-reservoir and
  reference nodes — every mm of loop adds noise/spur risk.
- VCAP1 (C6003, top, (14.55/16.45,25.0)): pad-to-pad L1, shortest path to pad
  28/GND31, 0.30 mm, no vias. Companion to bottom C6001 (\u00a76).
- VCAP2 (C6004, top, (17.65/19.55,25.0)): L1 to pad 30/GND31, 0.30 mm, no vias.
- VCAP4 (top, near pad 26): L1 shortest, 0.30 mm, no vias.
- VCAP3 (south, pad 55): L1 shortest to local GND, 0.30 mm; at most 1 via only
  if the south-edge breakout forces it, then back to L1 immediately.
- VREFP_2V4 (pad 24): L1 star to C6002-top-side landing + bottom C6001/C6002
  vias (\u00a76); 0.30 mm; guard both sides with GND copper tied to L2 at both
  ends; >= 3 mm to SCLK along the whole run.
- VCM (pads 60/62): L1 star south to R_BIAS tails + TP602; 0.30 mm; short
  branch stubs only (no daisy-chain through noisy regions).
- RLDINV (pad 61) / RLDOUT (pad 63): L1 pair south to RLD feedback network
  (1 M + 1.5 nF) then RLDOUT to R_RLD_SAFETY 100 k -> RLD_SAFE -> J5001;
  0.30 mm; RLDOUT guarded by adjacent GND; >= 3 mm to SCLK; no vias on the
  INV node (op-amp summing node — keep parasitic C minimal).
- Plane: solid L2 GND under the whole north-edge VREF/VCAP corridor and the
  south-edge VCM/RLD network. No L3 polygon edge under either corridor.

## 6. Bottom-side capacitor via strategy (NO vias placed in this task)

### C6001 (10 uF 0805, B.Cu (6.0,19.0); pads (5.05,19.0)=VREFP / (6.95,19.0)=GND)

Supports the VREFP network, directly below/near the ADS1294 VREF region
(VREFP pad 24 @ (14.25,23.16) — ~8.6 mm east-north of the cap).

- Per-pad vias: DEDICATED via per pad (do not share): 1x 0.8/0.4 via at
  ~0.9 mm north of each pad — VREFP via lands ~(5.05,19.9), GND via lands
  ~(6.95,19.9) — then L1 pair east to pad 24 / GND25. Electrically clean
  geometry beats via-count saving on a reference node.
- Loop estimate: via-to-pin L1 run ~8.7 mm for VREFP, ~7.9 mm for GND return;
  comparable to the old top-side arrangement (which also spanned the
  R104/ADC-west gap) and shorter in Z (no long top-side dodge around R104).
  Loop area is bounded by the P/N-adjacent L1 pair over continuous L2.
- Alternative rejected: shared single via pair midway between pads would save
  one drill hit but forces a B.Cu split current path and wider loop — worse
  for reference noise. Short top-side fanout + via is exactly what is
  specified (fanout lives on L1, not on B.Cu).

### C6002 (0.1 uF 0603, B.Cu (2.5,19.0); pads (1.725,19.0)=VREFP / (3.275,19.0)=GND)

High-frequency VREFP bypass companion to C6001.

- Per-pad vias: DEDICATED via per pad: VREFP via ~(1.725,19.9), GND via
  ~(3.275,19.9), then L1 east joining the C6001 VREFP/GND pair (C6002 merges
  into the C6001 trunk, not a separate run to the ADC).
- Loop estimate: C6002 trunk joins within ~3.4 mm; total VREFP path stays
  dominated by the C6001 trunk above. HF loop (C6002-vias-ADC) is the smaller
  nested loop — correct bypass hierarchy (0.1 u close, 10 u bulk).
- Alternative rejected: shared via with C6001's GND pad (3.7 mm away) would
  lengthen the HF return — rejected for the same loop-area reason.

### C4006 (1 uF 0603, B.Cu (15.0,3.5); pads (14.225,3.5)=AFE_3V0 / (15.775,3.5)=GND)

LDO bypass for the U4002 AFE_3V0 rail (U4002 at (28.4,6.2), AFE_3V0 pad 5).

- Per-pad vias: DEDICATED via per pad: AFE_3V0 via ~(14.225,4.4), GND via
  ~(15.775,4.4), then L1 fanout to the AFE_3V0 polygon edge / L2 GND.
  C4006 sits behind the charger cluster (C4003 @ (13.5,4.0)), so the fanout
  must thread south of C4003 — L1 short, no L3 transit for the cap itself.
- Loop estimate: via-to-rail < 2 mm; local HF loop closed through L2 directly
  above the cap. No dependency on the U4002 distance (bulk comes from C4005/
  rail polygon; C4006 is the local HF anchor).

All vias in this section are PLANNED ONLY — none placed. Via count estimate:
2 per cap x 3 caps = 6 signal vias at routing time.

## 7. ADS1294 SPI / control routing (buffers respected)

Architecture (frozen): MCU_* -> SN74LVC1G125 U901-U906 (B.Cu column x=24.7,
VCC=AFE_3V0, OE=GND) -> AFE_* -> ADS1294 east edge pads 34-47. MISO (pad 43)
and DRDY_N (pad 47) are DIRECT ADC->MCU (no buffer). Nets: SCLK, MOSI/DIN,
MISO/DOUT, CS_N, DRDY_N, START, RESET_N (via MCU_RESET_N_AFE), PWDN_N.

- Preferred layer: L1 for the AFE_* trunk (buffer Y-pins -> ADC east edge);
  MCU_* tails (MCU -> buffer A-pins) on L4/L1, short. At most 1 via per line
  on the MCU side; ZERO vias on the AFE_* trunk between buffer and ADC.
- Grouping: route SCLK + MOSI + CS_N as a loose group (0.20 mm, >= 0.30 mm
  intra-group to limit crosstalk); DRDY_N/MISO as a quiet return pair kept
  >= 1.0 mm from SCLK where parallel, crossing SCLK only at 90\u00b0.
- Clock priority: SCLK first inside the group; keep its return on L2
  unbroken; no stubs (TP604 sits on AFE_SCLK — branch <= 2 mm, \u00a713).
- Separation: >= 3.0 mm (1.0 mm floor) from EMG P/N corridor and VREF/VCAP
  corridor; >= 1.5 mm from VCM/RLD south network.
- Damping: NO extra series termination footprints — buffers already isolate
  the MCU side (Ioff, OE=GND per Audit 1); SCLK edge rates at ADS1294 SPI
  speeds over < 15 mm do not need source termination on FR-4. Do not add
  resistors without measured overshoot evidence.
- Return: continuous L2 under the whole buffer->ADC trunk; do not cross the
  trunk over any L2 cutout (there are none planned — keep it that way).

## 8. Switching power routing (TPS63031 + charger/power-path)

High-current / high-di/dt loops (U4001 TPS63031 at (18.0,4.5), L4001 at
(24.0,4.5), charger U2001 at (5.7,12.0)):

- VIN loop: C4002 (12.9,2.0) -> U4001 SYS_RAW pins 5/6/8; short fat L1 + local
  L3 assist; via array 2x at each end where layer hops.
- Switch loop: U4001 SW_L1 pin 4 -> L4001 pad 1; L4001 pad 2 -> U4001 SW_L2
  pin 2; DELIBERATELY SMALL copper (0.60 mm traces, minimal pad extensions —
  switch nodes radiate; area is the enemy). No polygons on SW_L1/SW_L2. L1 only.
- Output loop: L4001/U4001 3V3 pins 1/10 -> C4003 (13.5,4.0) -> L2 GND; then
  3V3 polygon on L3 east to loads. Keep the inductor->cap loop < 10 mm perimeter.
- Charger paths: USB_VBUS -> U2001 pin 13; U2001 SYS_RAW pins 6/10/11 -> rail;
  BAT+ pins 2/3 -> J2001; CHG_N/PGOOD_N are status (MCU_DIGITAL class, thin).
- Widths: SYS_RAW/SW_L1/SW_L2/USB_VBUS/BAT+ 0.60 mm min; SYS_RAW trunk and
  battery tails prefer L3 polygon assist + 0.80 mm via arrays at transitions.
  3V3/AFE_3V0 distribution 0.40 mm min + polygons (\u00a79).
- Distance: NO switch copper within 8 mm of the ADS1294 input corridor or the
  VREF/VCAP corridor (measured: U4001/L4001 sit y<=5.5, ADC input y>=17.75 —
  ~12 mm clear — compliant by placement). Charger switch currents keep west
  (x < 10), analog keeps east-center.
- Return: high-current returns close LOCALLY through L2 vias at the caps
  (C4001/C4002/C4003 GND pads get dedicated L2 stitch vias adjacent); these
  local loops must NOT route return current under/through the analog input
  region — place stitch vias so the loop closes at the power cluster.

## 9. Power distribution (traces vs pours vs L3 polygons)

No full-board power planes. L2 stays GND. Each rail gets a bounded L3 polygon
(or local pour) + L1 fanout:

- VBAT (BAT+, 5 pads, battery/charger current): L3 polygon west (charger <->
  J2001 tail) + 0.60 mm L1 tails. Current estimate: charge <= 500 mA + system
  load; 0.60 mm/1 oz carries this with wide margin; polygon is for loop area,
  not ampacity.
- VBUS (USB_VBUS, 9 pads): L1 0.60 mm from J3001 to U2001 pin 13, short; local
  L3 assist only at the connector entry. USB current <= 500 mA nominal.
- 3V3 (18 pads): L3 polygon central-east (U4001 -> U4002/MCU/ADC-3V3 pins) +
  0.40 mm L1 fanout to each load pin; decoupling (C4003 + per-pin 0.1 u) first.
- AFE_3V0 (25 pads): L3 polygon center (U4002 pad 5 -> ADC AVDD pins 1-8/19/21/
  22 + buffer VCC + C4006/C6007 vias) + 0.40 mm L1 star fanout; QUIET rail —
  polygon edges keep >= 1.0 mm from switch copper and >= 0.5 mm from input/
  reference corridors' projections.
- SYS_RAW (9 pads): L1 0.60 mm + local L3 copper at the TPS63031 cluster only
  (part of the switching loop, \u00a78 — not a distribution rail).

Current margins are comfortable by inspection (rail currents 10s-100s of mA vs
0.40-0.60 mm 1 oz capacities ~1-2 A with < 20 \u00b0C rise). Exact drop/loss
calculation is deferred to post-route review — widths already carry 3-5x margin.

## 10. Ground strategy (FROZEN)

- One continuous GND reference plane on L2. No AGND/DGND split, no islands,
  no moats, no neck-downs under critical corridors.
- Decoupling returns: every ADC/mcu/buffer bypass GND pad gets a short L1 link
  to an adjacent L2 stitch via (<= 2 mm pad-to-via). No shared long GND tails.
- Regulator returns localized at the power cluster (\u00a78): switch-current
  loops close through dedicated L2 vias at C4001/C4002/C4003 — they do not
  travel across the board on L2 in a way that threads the analog region
  (current spreads, but the dominant loop is pinned by via placement).
- ADC input region protection: no digital trace on ANY layer crosses the input
  corridor; no L3 polygon edge approaches within 0.5 mm of its projection;
  digital return current cannot cut through it because digital routes stay
  east/south of the ADC while inputs stay west.
- Stitching vias (PLANNED ONLY — none placed): perimeter ring ~5 mm pitch
  (inside 0.5 mm edge clearance); USB connector shell + VBUS entry cluster;
  ADC/digital boundary row east of U6001 (x ~21.5, y 11-24, ~2 mm pitch,
  guards SPI from inputs); power cluster ring around U4001/L4001; RFôpital —
  RF-area stitching ONLY outside the antenna keepout (stitching inside the
  keepout is forbidden). All stitching deferred until after critical routes.

## 11. nRF52840 RF constraints (Raytac MDBT50Q-1MV2, FROZEN)

- Module U7001 (36.25,15.0, rot -90) carries an integrated antenna — no RF
  matching network is invented in this design (frozen per schematic).
- Keepout (explicit): in the antenna region defined by the module datasheet,
  there shall be NO copper on ANY layer (including L2/L3 planes), NO traces,
  NO vias, NO battery, NO enclosure metal. Planes cut back to the keepout edge.
- Planned L2/L3 pours MUST respect the keepout (pour exclusions, not DRC
  exclusions — no broad DRC exclusions are added in this task).
- Battery region (bottom, TBD per placement text) must not extend under the
  antenna keepout.
- Unresolved (\u00a715): exact keepout polygon dimensions require the module
  datasheet figure at routing start; the keepout aucune-trace rule is already
  binding regardless.

## 12. USB routing (J3001 USB-C, TPD + interlock)

Usage in this design: USB 2.0 Full-Speed (nRF52840 USB device) + VBUS charge
input + CC/SBU interlock. D+/D- matter for signal integrity but are NOT a
high-speed (480 Mbps) risk driver.

- Pair geometry (PROVISIONAL until fab stackup is selected and calculated):
  0.20 mm traces, 0.20 mm gap, L1 only, over continuous L2. 90-ohm
  differential is NOT claimed — JLCPCB 4-layer 1.0 mm stackup with this
  geometry lands near enough for FS; exact Zo needs the real prepreg build.
- Matching: P/N length match <= 0.25 mm; total pair length <= 40 mm (J3001 at
  (38.0,1.2) to MCU nearby — placement already keeps this short).
- Vias: ZERO vias on D+/D- (no layer change). ESD (TPD4E05U06, if placed in
  path) sits INLINE adjacent to J3001 with the pair passing through it —
  protection FIRST, then route to MCU.
- Reference: unbroken L2 under the pair; no L3 copper edge within 0.5 mm of
  the pair projection; keep >= 2 mm to switch copper.
- VBUS/CC/SHIELD: 0.60 mm VBUS (POWER_5V_VBUS), CC1/CC2 thin DEFAULT, SHIELD
  to chassis/GND per interlock schematic at the connector (short, fat).

## 13. Test-point routing priority

Test points (measured nets/positions, \u00a7verification source):

- Power/GND: TP201 BAT+, TP401 3V3, TP402 GND, TP601 AFE_3V0 — route with the
  rail fanout (priority with power distribution, order #8).
- Sensitive analog: TP602 VCM, TP603 RLDOUT (+VREF net access): SHORT branch
  stubs (<= 3 mm) off the main trunk, never inline daisy-chains; no stubs
  crossing guard copper. VCM/REF trunks keep priority over their TPs.
- SPI/control: TP604 SCLK, TP605 MOSI, TP606 MISO, TP607 CS_N, TP608 DRDY_N,
  TP609 START, TP610 RESET_N, TP611 PWDN_N — branch <= 2 mm off the trunk;
  SCLK TP placed so the stub does not lengthen the clock (back-stub, not
  mid-route T unless short).
- CHx: TP111/112 (CH1), TP113/114 (CH2), TP115/116 (CH3), TP117/118 (CH4) —
  short stubs off the R_SER/C_DIFF pads; keep P/N stub lengths symmetric
  (match to 0.5 mm) so the TPs don't unbalance the pair.
- SWD: SWDCLK/SWDIO test/debug header J8001 — route late with digital.

## 14. Routing order (FROZEN)

1. ADS1294 reference / VCAP / RLD (ANALOG_REF + ANALOG_VCM_RLD south/north).
2. CH1-CH4 EMG differential inputs (EMG_INPUT + EMG_FRONT tails).
3. Bottom-cap via fanout (C6001/C6002 VREFP trunks, C4006 AFE_3V0 fanout).
4. Critical power-regulator loops (POWER_SWITCHING: VIN/SW/output, charger).
5. ADS1294 + buffer + MCU decoupling (POWER_AFE_3V0/3V3 cap returns, L2 stitches).
6. SPI / control trunks (ADC_DIGITAL then MCU_DIGITAL tails).
7. USB D+/D- pair + VBUS/CC.
8. Power distribution polygons (L3 BAT/VBUS/3V3/AFE_3V0) + rail fanout.
9. MCU / debug / general digital (SWD_DEBUG, status, NTC, J8001).
10. Remaining low-priority nets (CC, SHIELD, singletons as needed).
11. GND pours / stitching vias AFTER critical routes (L2 plane fill, L1/L4
    GND links, perimeter + boundary stitching per \u00a710).

This validates the candidate order from the task brief unchanged: reference
first (charge reservoirs gate everything), inputs second (sensitivity), bottom
caps third (they complete the reference), switching fourth (loops must be
small before they get boxed in), decoupling fifth, digital after analog is
safe. No adjustment needed for this placement.

## 15. KiCad rule implementation (this task)

Configured (reviewable, deterministic):

- `ARTHUR_EMG_RevA.kicad_pro`: `net_settings.classes` (15 classes incl.
  Default), `netclass_assignments` + `netclass_patterns` (net->class map),
  `board.design_settings.rules` (min_track_width 0.2, min_clearance 0.2,
  min_via_diameter 0.8→ project default, via drill 0.4, copper-edge 0.5,
  hole clearances 0.25) + `track_widths` / `via_dimensions` presets and
  `diff_pair_dimensions` (USB provisional 0.20/0.20).
- `ARTHUR_EMG_RevA.kicad_pcb`: `setup.stackup` dielectric target 1.0 mm FR4
  (paren-balanced; DRC-loadable) + `net_class` blocks mirroring the pro classes
  (all clearances at the 0.20 mm footprint floor; the 0.25 mm analog intent is a
  track-to-track routing rule, since 0.5 mm-pitch QFP pads sit 0.20 mm apart by
  design). NO tracks, NO vias, NO zones added.
- `ARTHUR_EMG_RevA.kicad_dru` (new sidecar): deterministic custom-rule source
  (analog/USB L1-only intent, SCLK 1.0 mm / switch 2.0 mm separation vs EMG) for
  import at routing start. It lives OUTSIDE the board file so `pl_place.py
  --check` stays byte-identical (the generator rebuilds head+tail; inline rules
  would break its identity check).
- NO broad DRC exclusions added (`drc_exclusions\) stays empty).

Placement-intact guarantee: the edit path rewrites ONLY setup/netclass head metadata;
footprint blocks are byte-preserved and `pl_place.py --check` reports identical.

## Verification (this audit)

- footprints 106; board 45x30; routes 0; vias 0; zones 0 (recounted post-edit).
- real shorts 0; clearance error count back at the 14 pre-existing (bench-DNP adjacency +
  U4001-pin + C4002-J2001 proximities) — no new copper, DRC total identical at 617.
- DRC re-run + top/bottom renders regenerated post-edit.
- Placement blocks byte-identical except rule/setup metadata (hash check).

## Unresolved fabrication-dependent parameters

- Exact dielectric thicknesses (prepreg/core) for the 1.0 mm 4-layer build —
  pending fab selection (JLCPCB nominal at order).
- USB 90-ohm validation for 0.20/0.20 mm geometry — pending real stackup calc.
- Antenna keepout polygon dimensions — pending Raytac datasheet figure check.
- Final soldermask/paste swell + annular-ring review — at Gerber stage.

---

STACKUP FREEZE: PASS
ROUTING-RULE FREEZE: PASS
READY TO ROUTE: YES
