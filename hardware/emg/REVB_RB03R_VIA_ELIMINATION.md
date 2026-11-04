# RB-03R — Via-in-Pad Elimination

> **Superseded in part by RB-03S (2026-10-11).** The board installed by RB-03R had a 14.3 mm ground wire on C6009 and an R7101 iron-access
> conflict; RB-03S replaced it (C6009 −0.18 mm, R7101 back, 0.3 mm ground tie, 0 via-in-pad, 0 DRC errors). See
> `REVB_RB03S_CAP_DECOUPLING_REPAIR.md` and `REVB_RB03S_VIA_MASK_AUDIT.md`. Numbers below describe the RB-03R board (archived in
> `rev-b-xiao/archive/rb03r_installed/`).


Date: 2026-10-10. Branch `hardware/emg-rev-b`. Nothing committed, nothing ordered, no manufacturing release.
Companion documents: `REVB_RB03R_ANALOG_ROUTING_AUDIT.md`, `REVB_RB03R_DRC_RULE_VALIDATION.md`. Predecessor: `REVB_RB03_ROUTING_REPORT.md`
(run 14, 17 via-in-pad, amended `hiz_leakage` rule).

## 1. Result

| Item | RB-03 run 14 | RB-03R (installed board) |
|---|---|---|
| Board | V1, 51.30 × 62.45 mm | **V1C placement, 51.30 × 64.95 mm** (+2.5 mm in y, see 5.1) |
| Via centres inside an SMD pad (true pad shape) | 17 | **0** |
| Via holes within 0.10 mm of a solder-mask opening | 11 | **0** |
| Vias, total | 228 | 200 |
| Tier B (annulus partly inside an opening, hole ≥ 0.10 mm clear) | 23 | 17 |
| Tier A- (annulus clear, mask web < 0.10 mm) | 53 | 60 |
| OK (web ≥ 0.10 mm) | 20 | 22 |
| KiCad DRC (errors / warnings, parity, unconnected) | 0 / 1 (with the amended rule) | **0 / 1 (`lib_footprint_mismatch` U1, accepted since RB-02), 0, 0** |
| ERC | 0 | 0 |
| Components / assembly | 135, F.Cu only | 135, F.Cu only (126 SMT + XIAO DNP + 8 test pads) |

No filled-and-capped via-in-pad is used or needed. All 200 vias are conventional 0.60 / 0.30 mm through vias, tented by the default
mask, none of them touching a solderable opening.

One earlier rule check changes status and is reported openly: **C17 (iron access 1.5 mm west of the XIAO toe ends) now FAILS on a
courtyard basis for R7101** (+0.3 mm east move; its pad copper is still 1.52 mm from the toe ends). See 6.

## 2. Independent geometric audit (before)

Tool: `rev-b-xiao/tools/rb03r_via_audit.py`. It does **not** use KiCad DRC. It loads the board with pcbnew and, for every through via
and every SMD pad, evaluates the true pad shape (rounded-rectangle / oval, rotation) with `HitTest` bisection:

* `centre_in_pad`: via centre inside pad copper → via-in-pad.
* distance via centre → pad copper, → solder-mask opening (pad + local/global mask expansion; U1 castellations carry +0.05 mm).
* hole (r = 0.15 mm) to opening and annulus (r = 0.30 mm) to opening.
* paste-aperture hit (is there paste under the via?).

Classes: **FAIL via-in-pad**; **FAIL hole < 0.10 mm to the mask opening** (hole edge too near solder: wicking risk, below JLC's own
0.10 mm mask-web minimum); **Tier B** annulus inside the opening but hole ≥ 0.10 mm clear; **Tier A-** annulus clear of the opening, web
< 0.10 mm; **OK** web ≥ 0.10 mm. The user's "7 pad-touching vias" are among the hole-within-0.10 mm cases; the audit finds 11 of them next to the 17
via-in-pad (28 offending vias in total).

### 2.1 Offending vias of run 14 (position, net, pad, centre-to-copper, centre-to-opening, class)

| Via (x, y) mm | Net | Pad | To pad copper | To mask opening | Class |
|---|---|---|---|---|---|
| 33.8, 29.1 | `/CH1/ACN_N` | C102.2 | 0.102 | 0.102 | hole < 0.10 mm to opening |
| 33.1, 28.6 | `/CH1/ACN_N` | R104.1 | 0.246 | 0.246 | hole < 0.10 mm to opening |
| 26.3, 34.6 | `GND` | C4006.2 | 0.000 | 0.000 | via-in-pad |
| 20.8, 35.0 | `GND` | U4002.2 | 0.000 | 0.000 | via-in-pad |
| 24.7, 46.5 | `GND` | C6009.2 | 0.000 | 0.000 | via-in-pad |
| 22.7, 38.8 | `GND` | R3008.2 | 0.176 | 0.176 | hole < 0.10 mm to opening |
| 24.6, 58.8 | `GND` | R7106.2 | 0.000 | 0.000 | via-in-pad |
| 30.0, 29.1 | `/CH2/ACN_P` | C201.2 | 0.102 | 0.102 | hole < 0.10 mm to opening |
| 25.9, 29.5 | `/CH2_P` | R207.2 | 0.078 | 0.078 | hole < 0.10 mm to opening |
| 33.3, 12.8 | `AFE_3V0` | D102.2 | 0.000 | 0.000 | via-in-pad |
| 46.4, 21.9 | `AFE_3V0` | C503.1 | 0.000 | 0.000 | via-in-pad |
| 9.8, 12.8 | `AFE_3V0` | D401.2 | 0.000 | 0.000 | via-in-pad |
| 35.2, 22.3 | `AFE_3V0` | C501.1 | 0.047 | 0.047 | hole < 0.10 mm to opening |
| 14.5, 12.8 | `AFE_3V0` | D302.2 | 0.000 | 0.000 | via-in-pad |
| 19.2, 12.8 | `AFE_3V0` | D301.2 | 0.000 | 0.000 | via-in-pad |
| 16.4, 22.3 | `AFE_3V0` | C502.1 | 0.047 | 0.047 | hole < 0.10 mm to opening |
| 38.0, 12.8 | `AFE_3V0` | D101.2 | 0.000 | 0.000 | via-in-pad |
| 28.6, 12.8 | `AFE_3V0` | D201.2 | 0.000 | 0.000 | via-in-pad |
| 23.9, 12.8 | `AFE_3V0` | D202.2 | 0.000 | 0.000 | via-in-pad |
| 16.0, 44.3 | `AFE_3V0` | C6007.1 | 0.000 | 0.000 | via-in-pad |
| 16.2, 46.3 | `AFE_3V0` | U6001.1 | 0.078 | 0.078 | hole < 0.10 mm to opening |
| 9.6, 28.6 | `/CH4/ACN_P` | R403.1 | 0.246 | 0.246 | hole < 0.10 mm to opening |
| 10.3, 29.1 | `/CH4/ACN_P` | C401.2 | 0.102 | 0.102 | hole < 0.10 mm to opening |
| 29.7, 27.7 | `/CH2/BUF_P` | C201.1 | 0.000 | 0.000 | via-in-pad |
| 24.1, 52.7 | `/CS_N` | R7103.2 | 0.246 | 0.246 | hole < 0.10 mm to opening |
| 49.4, 56.4 | `/DRDY_N` | U1.2 | 0.000 | -0.050 | via-in-pad |
| 24.7, 51.4 | `/DRDY_N` | R6003.2 | 0.000 | 0.000 | via-in-pad |
| 38.5, 27.9 | `/CH1/BUF_P` | C101.1 | 0.000 | 0.000 | via-in-pad |

Pads are standard SMD pads with zero mask expansion (U1: 0.05 mm) and a paste aperture, so the stencil would deposit paste over
the via hole. Why they existed: the greedy router's `relax_via_in_pad` fallback after the strict
passes failed. Causes found by per-net diagnosis (not assumed):

1. **Band row (CH1-CH4 ACN / BUF / ADC-input nets, 11 pads).** 24 parts at ≈ 1.6 mm pitch with hi-Z 0.40 mm keep-away; the 1.6 mm
   column pitch leaves 0.8 mm between pads: a 0.60 mm via plus 2 × 0.20 mm clearance (1.0 mm) cannot sit between them, so the via
   had to sit on or beside the pad.
2. **AFE_3V0 on the BAV199 clamps (8) and C501/C502/C503.** The rail pad of every clamp has no free neighbour cell inside 0.25 mm of a
   legal via position; the router chose the pad.
3. **GND pads of the USB-inhibit strip (U4002.2, C4006.2, R7106.2) and ADC cap C6009.2** enclosed by pads on four sides.
4. **XIAO castellation U1.2** near the board edge, DRDY_N.

## 3. JLCPCB rules used for the criteria

Source: JLCPCB PCB capabilities page (https://jlcpcb.com/capabilities/pcb-capabilities, read 2026-10-10).

| Rule | Published value | Use here |
|---|---|---|
| Solder-mask bridge / web | 0.10 mm (green, red, yellow, blue, purple; 1 oz); 0.13 mm black/white; 0.20 mm any colour at 2 oz | board is green, 1 oz outer: web ≥ 0.10 mm is the limit; below it the mask can disappear between opening and via |
| Mask expansion | 1:1 (0 mm), ≥ 0.09 mm between mask openings and neighbouring traces | pad openings = copper; track edge ≥ 0.09 mm from every opening |
| Via | 0.15 mm hole / 0.25 mm via minimum on 4 layers; annular ring ≥ 0.20 mm recommended | 0.30 / 0.60 mm via: radial annulus 0.15 mm (note below) |
| Track / space (4 layer, 1 oz) | 0.09 / 0.09 mm | project minimum 0.15 mm width, 0.20 mm clearance |
| Via-in-pad | accepted, no responsibility (T&C §5 item 6, RB-02E S23) | not used |
| Filled & capped vias | available (0.15–0.55 mm) | not used, not assumed |

Note on ring: 0.60 − 0.30 = 0.30 mm diameter difference → 0.15 mm radial annulus; above the 0.15 mm absolute minimum and below JLC's
0.20 mm recommendation for 1 oz PTH. This is unchanged since RB-02 and is listed under open items (7).

Policy applied to every via near an SMD pad: **hole edge ≥ 0.10 mm from the solder opening** ⇔ centre ≥ 0.25 mm from pad copper
(0.30 mm for U1, whose openings are 0.05 mm larger). Tier B and Tier A- are accepted (tented, hole clear) and listed; they are not
via-in-pad and no hole touches solder.

## 4. Repair — what was tried, in order, and what it did

All edits were made on scratch copies of the project (pcbnew rewrites `.kicad_pro`; see the DRC rule validation document).

| Step | Tool | Result |
|---|---|---|
| a. Reposition the eight BAV199 clamps | not done | not needed: their AFE_3V0 vias were relocated 0.4 mm along the clamp axis instead (step c); the clamps did not move |
| b. Strict re-route of the whole V1 board (no via-in-pad fallback) | `rb03_router.py --strict-vias [--via-ladder --gnd-front]` | 10 nets fail on V1 (AFE_3V0, CH1-CH3 ACN/BUF, CS_N, DRDY_N, XIAO_5V/3V3, ...). The greedy router is order-dependent and the V1 band row has no room: 17 vias remain |
| c. Short fan-out traces: local relocation of one via at a time, no rip-up | `rb03r_nudge.py` | 28 → 7 offenders on the run-14 board (21 moved: all eight clamp-rail vias 0.4 mm, C503/C501/C502 1.0-1.6 mm, ACN series pads 1.2 mm, ...); the remaining 7 have **no free F.Cu escape** (boxed in by neighbour pads) |
| d. Alternative channel / remove layer transitions | `rb03r_routenet.py` | CH3 BUF_N boxed in by CH3 HIZ_P and AFE_3V0; re-routing HIZ_P, HIZ_N, BUF_N, AFE_3V0 together in class-priority order solved it |
| e. Selective passive repositioning | `rb03r_movepart.py` | C4006 -0.2, Q3001 +0.1, U4002 +0.2, R7102 -0.1, R306 +0.3/-0.4 mm, R7101 +0.3 mm: each is the smallest offset (0.05-0.1 mm search grid, courtyards respected) that gives the neighbouring GND/signal pad a legal escape |
| f. Placement relief | `rb02g_variants.py` V1C | the lower block (ADC, X1, power strip, XIAO, J1, test pads: 60 parts) moves 2.5 mm south, widening the band between the buffer row and the ADC row; the eight 100 kΩ bias resistors R103/R104/R203/R204/R303/R304/R403/R404 move 3.0 mm. Board 62.45 → 64.95 mm. V1B (+2.5 mm applied differently) did **not** help |
| g. Post pass | `rb03r_nudge.py --via-audit --drc` | the via-to-mask-opening case at U1.9 (SCLK_MCU: via now 0.42 mm from the pad copper, +2.2 mm stub) |
| h. Orphan clean-up | `prune_gnd_spurs` | 8 dead B.Cu GND spur segments and 2 orphan vias created by relocations removed (per-layer, anchor-count based) |

`rb03r_repair_chain.sh <dir>` replays steps b-h from the placement.

### 4.1 What did NOT work (kept so the next attempt does not repeat it)

* Whole-board strict routing with the in-house greedy router on V1, V1B, V1C and V2: 4-10 nets fail every time. The result depends
  on net order; no ordering found that completes. A rip-up-and-reroute (negotiated) router would be the proper tool; Freerouting was
  **not** downloaded or run (no permission).
* C6009.2 (ADC CAP-pin capacitor, GND pad) is boxed in by four courtyard-touching neighbours (X1, R6001, R7101, U6001); a
  relocation search (R7101 ±1 mm/rotated, R6001, X1, U6001, C6009 itself ±4 mm) finds no offset that gives a **short** tie. With
  R7101 +0.3 mm the pad ties to an existing GND chain through a 14.3 mm, 0.15 mm F.Cu wire (best of 10 offsets: 9.3 mm at
  R7101 +0.7/-0.3 mm, which also breaks C17 worse). Shifting the R6001/R6002/R6003/R7103/R7104 column 0.4-0.6 mm south frees the
  pad but then /MISO cannot be routed. This is a **zero via-in-pad result obtained at an analog cost** (see the analog audit, 5).

## 5. Final geometry

### 5.1 Board and placement

* Outline 51.30 × 64.95 mm, 1.0 mm corners (RB-03: 62.45 mm). The 2.5 mm increase is the only outline change; it is what made the
  band row routable without via-in-pad (V1 at 62.45 mm failed 10 nets strictly). Enclosure thickness unchanged (17 mm). The USB end
  of the XIAO still sits on the south edge (C29).
* Parts moved relative to the RB-03 V1 board: 60 parts of the lower block +2.5 mm in y (rigid, five of them with the small additional moves below), the eight bias resistors
  3.0 mm; additional offsets: U4002 +0.2, Q3001 +0.1, C4006 −0.2, R7102 −0.1, R7101 +0.3 mm in x, and R306 (+0.3, −0.4) in the upper block
  69 parts differ from run 14 in total. No part changed rotation, side or value; 135 components kept, top-side Economic assembly
  kept (B.Cu carries only the eight bare test pads and the BAT+ post pad).
* Electrical topology unchanged: schematic untouched, 364 pad-net checks equal the netlist (C03), parity 0.

### 5.2 Via-near-pad classification (after)

`evidence/rb03r/via_audit.json` / `.csv`: 200 vias, 99 via-near-pad records:

| Class | Count |
|---|---|
| via-in-pad | **0** |
| hole < 0.10 mm to mask opening | **0** |
| Tier B (annulus partly in opening, hole clear) | 17 |
| Tier A- (annulus clear, web < 0.10 mm) | 60 |
| OK | 22 |

Tier B/A- records are 0.60 mm annuli sitting 0.25-0.30 mm from a pad: the mask web between opening and annulus is below 0.10 mm,
which only matters for the tenting quality of the **via**, not for the solder joint (hole ≥ 0.10 mm clear of solder). Whether JLC's
CAM agrees is a DFM-review question for RB-04 (listed in 7).

## 6. Checks that changed because of the repair

| Check | Result | Comment |
|---|---|---|
| RB-02 C06 board size | FAIL by definition | the check still compares to the RB-00.6 estimate; 51.30 × 64.95 mm is the approved V1 outline plus 2.5 mm |
| RB-02 C17 iron access (1.5 mm west of the toe ends) | **FAIL (courtyard basis): R7101** | courtyard overlaps the band by 0.325 mm; the pad copper of R7101 ends 1.52 mm from the toe ends and the body 1.6 mm, so the physical access distance is still ≥ 1.5 mm. Trade-off between C17, the C6009.2 via-in-pad and the C6009 ground wire: **owner decision** (open item 1) |
| C26 JLC process rails (parts within 3 mm of the long edges) | CONDITIONAL (unchanged) | 71 parts; JLC adds rails |
| All other 27 RB-02 checks | PASS | C01-C05, C07-C16, C18-C25, C27, C29, C30 (incl. XIAO castellation positions, BAT+ post, underside keep-outs, J1 corridor) |
| Economic edge audit | 126 PASS, 9 N/A (U1 and TP1-TP8) | minimum pad-to-edge 0.5 mm; body-to-edge ≥ 2.5 mm for all assembled parts |

## 7. V2 evaluation

The user asked for V2 only if V1 could not be repaired with ordinary manufacturable routing. V1 (V1C placement) was repaired, so V2
was **not** adopted. As a sanity check the same strict router was run on V2: 70 of 77 nets routed, 7 fail (MOSI_MCU, ADC_CLKIN,
MOSI, CH3/BUF_N, CH2 ACN_N/ACN_P, CH2_P), 17 unconnected items, 2 clearance errors, 4 GND pads unresolved. That is **not** a
comparison of V2's real routability (the greedy router is the limit), only evidence that V2 is not easier for it. The main PCB was
not replaced by V2.

## 8. Open items

1. **Owner decision on C6009.2 / R7101 (6, analog audit 5)**: (a) keep the installed board (0 via-in-pad, C17 courtyard conflict at
   R7101, 14.3 mm GND wire on the ADC CAP capacitor); (b) move R7101 back (C17 passes) and accept **one** via-in-pad at C6009.2
   (shortest ground, ≈ 1 nH); (c) change C6009 to a 0402 or move X1/R6001 in RB-04 so that a via fits, then neither compromise is
   needed (placement change, not done here).
2. 0.15 mm via annular radius vs JLC's 0.20 mm recommendation (unchanged since RB-02; listed for RB-04).
3. Tier B/A- annuli (77 vias) for the RB-04 JLC DFM review; filled vias not needed.
4. A negotiated router would remove the dependence on hand-ordered rip-up; not available here.
5. GND returns: 12 SMD GND pads have their nearest via > 2.0 mm away, 5 > 3.0 mm (RB-03: 17 and 4); see the analog audit.

## 9. Reproduction

```
RB03R_FROM_M7=1 bash hardware/emg/rev-b-xiao/tools/rb03r_repair_chain.sh <scratch dir>   # exact: reproduces the installed board's counts
bash hardware/emg/rev-b-xiao/tools/rb03r_repair_chain.sh <scratch dir>                    # whole chain from the placement (see below)
bash hardware/emg/rev-b-xiao/tools/rb03r_verify.sh <board.kicad_pcb> <evidence dir> --fill
python3 hardware/emg/rev-b-xiao/tools/rb03r_via_audit.py --pcb <board> --out via_audit.json --csv via_audit.csv
```

* `RB03R_FROM_M7=1` starts from the archived intermediate board `archive/rb03r_chain/step4_after_AFE_reroute_m7.kicad_pcb`
  (after routing, re-ordered hi-Z/AFE re-route, via relocations and four ≤ 0.2 mm moves) and replays the remaining steps; replay
  result: 200 vias, 1374 tracks, 0 via-in-pad, 0 hole-to-opening failures, DRC 0 errors, 0 unconnected, guard check and canary PASS
  (same counts as the installed board; segment/via UUIDs differ, they are random).
* The full chain from the placement is **not** bit-reproducible (the greedy router's output changed between code revisions while the
  tools were being written): a full replay on the final tool revision ended with exactly one via-in-pad (C6009.2), because the
  intermediate board differed. This is why the intermediate board is archived.
* Tool changes made late: `--gnd-cap` (ties up to 30 mm accepted for the one target, otherwise 4 mm), SPI stub cap (default 2.0 mm,
  8 mm for the U1.9 case), `rb03r_safe.safe_pcb` for every pcbnew loader.

Evidence: `rev-b-xiao/evidence/rb03r/` (`via_audit*.json/csv`, `drc.json/rpt`, `erc.json`, images in `images/`). Before images use the
archived run-14 board `rev-b-xiao/archive/rb03_run14/`; green circles mark the 28 former offenders.

## 10. Final gate

```
SELECTED BOARD:                  V1 (V1C placement; V2 not used, main PCB not replaced by V2)
FINAL PCB DIMENSIONS:            51.30 x 64.95 mm (RB-03: 51.30 x 62.45; +2.5 mm), 4 layers, 135 components
SMD VIA-IN-PAD:                  0  (geometric audit, true pad shape; KiCad no_via_in_smd_pad: 0)  -- see C6009.2 note
VIA HOLES TOUCHING SMD PADS:     0 (0 holes within 0.10 mm of a solder opening)
OTHER CRITICAL VIA/MASK RISKS:   77 vias with annulus inside / within 0.10 mm of a pad opening (17 tier B, 60 tier A-), all tented,
                                 hole clear >= 0.10 mm; 0.15 mm radial annulus vs JLC 0.20 mm recommendation (unchanged)
ROUTED NETS:                     78 / 78 (+ GND on In1)
UNCONNECTED NETS:                0
DRC ERRORS:                      0
DRC WARNINGS:                    1 (lib_footprint_mismatch U1, accepted since RB-02)
ERC ERRORS:                      0
HI-Z RULE EXEMPTIONS:            NARROWED (42 instances, all at U501/U502 pins, 0 foreign nets); UNRESOLVED: 0
HI-Z REGRESSION TESTS:           PASS (11 negative canaries fire, 3 positive controls silent, 9/9 guard mutations detected)
NETCLASS CONFIGURATION INTEGRITY: PASS (14 classes, 34 patterns, 90 nets vs reviewed baseline; fail-closed pipeline)
ANALOG ROUTING:                  CONDITIONAL (ACN P=N, hi-Z 0 vias F.Cu only 100 % over In1; ADC input runs 43-57 mm; C6009.2 GND
                                 wire 14.3 mm x 0.15 mm; not experimentally proven)
GROUND PLANE CONTINUITY:         PASS (In1 solid, 0 holes, 100 % return-path coverage except 4 % of VBAT under the BAT+ post keep-out)
POWER DISTRIBUTION:              PASS (max drop 7.5 mV VBAT at a 0.5 A estimate; 2.0 mV AFE_3V0 at 13.8 mA datasheet-bounded)
JLC ECONOMIC PCBA:               CONDITIONAL (126 SMT top, 0 bottom, DNP XIAO; edge audit 126 PASS; process rails by JLC; U1-U10 open items)
READY FOR RB-04 DFM REVIEW:      YES, with the owner decision in open item 1
MANUFACTURING RELEASE:           NO
BLOCKERS:                        owner decision on C6009.2 / R7101 (C17 courtyard conflict vs 14.3 mm ground wire vs one via-in-pad);
                                 JLC DFM confirmation of the via/mask tiers (RB-04); physical measurements (RB-05)
```
