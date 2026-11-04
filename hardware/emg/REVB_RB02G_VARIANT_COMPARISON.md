# RB-02G — Variant Comparison

Date: 2026-10-11. Source: `rev-b-xiao/evidence/rb02g/summary.json` (reproduce with
`python3 hardware/emg/rev-b-xiao/tools/rb02g_run.py --out <dir>`). All variants are scratch what-if boards; the project PCB
`ARTHUR_EMG_RevB.kicad_pcb` was not written (hash unchanged). Nothing routed.

## 1. Numbers

| | RB-02 current | **V1** | **V2** | V1R (sensitivity) |
|---|---|---|---|---|
| Outline (mm) | 97.0 × 32.0 | **51.3 × 62.5** | **60.4 × 58.9** | 48.6 × 62.5 |
| Area (mm²) / vs current | 3104 / – | 3204 / +3.2 % | 3558 / +14.6 % | 3035 / −2.2 % |
| Aspect (long / short) | 3.03 | 1.22 | 1.03 | 1.28 |
| Longest dimension | 97.0 | 62.5 (−36 %) | 60.4 (−38 %) | 62.5 |
| Components placed | 135 / 135 | 135 / 135 | 135 / 135 | 135 / 135 |
| Courtyard utilisation | 58 % | 56 % | 51 % | 60 % |
| KiCad DRC errors (schematic parity on) | 0 | 0 | 0 | 0 |
| DRC unconnected (no routing) / parity issues | 273 / 0 | 273 / 0 | 273 / 0 | 273 / 0 |
| RB-02 placement checks failed (C06 size excluded) | none | none | none | none |
| Body < 2.5 mm to outline | 37 | **0** | **0** | 9 |
| Copper/tail < 0.3 mm to outline | 0 | 0 | 0 | 0 |
| Nearest copper to outline | 0.50 mm | 0.50 mm | 0.50 mm | 0.50 mm |
| JLC-assembled parts on bottom | 0 | 0 | 0 | 0 |
| U1 in DNP-aware CPL | no | no | no | no |
| Total HPWL, all non-GND nets (mm) | 1270 | 1168 | 1171 | 1173 |
| HPWL, buffered EMG nets (mm) | 521 | 428 | 384 | 433 |
| Longest AC-coupled run, follower → ADC clamp (mm) | 51.9 | 40.7 | 38.3 | 42.0 |
| Largest P/N run mismatch (mm) | 8.6 | 8.6 | 8.6 | 8.6 |
| Nearest hi-Z node to the XIAO module (mm) | 30.6 | 18.1 | 16.2 | 18.1 |
| Electrode connectors on edge | south (all 5) | north (all 5) | north (all 5) | north (all 5) |
| Battery connector (plug) | north edge | above the module, plug leaves the east edge | NE corner, plug leaves the north edge (with the cables) | as V1 |

Common to V1/V2/V1R (placement-check results, module frame): XIAO castellations 0.0000 mm from CAD, BAT+ post at the CAD
position with drill Ø1.40, all 11 underside keep-outs present, no part within 1.5 mm of the toes, U.FL corridor and USB-C zone
free, oscillator OUT pad 3.61 mm from ADC CLKIN, decoupling ≤ 2.5 mm, P/N rotations identical, 1 nF caps ≤ 3.6 mm and clamps
≤ 6.8 mm from the ADC pins, USB end on the south edge (C29), J1 mating-plug corridor 7 × 9 mm free (C30), 4 copper layers, single ground plane (In1 full, In2 outline).
Edge-parts and CPL columns are from `rb02e_economic_audit.py` (rule set of RB-02E/F).

## 2. Rejected targets (squeezing the validated blocks into the requested envelopes)

| Probe (portrait equivalent) | Result |
|---|---|
| P50x60 (= 60 × 50) | **FAIL**: 21 DRC errors, courtyards overlap (J1/R4001/C101/R103…), 8 parts < 2.5 mm |
| P45x60 (= 60 × 45) | **FAIL**: 53 DRC errors, parts outside the outline (J5001 28 mm out), 11 parts < 0.3 mm |
| P45x55 (= 55 × 45) | **FAIL**: 104 DRC errors, courtyard overlaps, parts outside the outline |

These are the same V1 blocks with the outline reduced; the failures are physical overlaps of the footprints. A real 60 × 50
would need ≈ 6 % less area than V1 and a re-tiling of the power strip and battery connector (V1R shows the width can fall to
48.6 mm only by accepting 9 parts < 2.5 mm). Not pursued because the area bound (below) leaves no routing room.

Area bound: all courtyards sum to 1844 mm² (XIAO 497, five B2B 400, 52 R + 42 C 406, 17 SOT-23 223, TSSOP 181, J1 94 …).
At the 56–60 % utilisation V1/V1R already reach, the floor is ≈ 3050 mm²; 60 × 45 (2700) and 55 × 45 (2475) would need 68–74 %.

## 3. Assessment by candidate

| Criterion | V1 51.3 × 62.5 | V2 60.4 × 58.9 | V1R 48.6 × 62.5 |
|---|---|---|---|
| Placement DRC | PASS (0 errors, 0 parity) | PASS | PASS |
| Edge-clearance risk (RB-02F) | none by construction (0 < 2.5 mm) | none by construction | 9 parts 1.5–2.4 mm; same OPEN issue as today, smaller |
| Estimated routing difficulty | similar to current (util 56 % vs 58 %), HPWL -8 %, buffered runs −22 % | easiest (util 51 %, free pocket 10 × 27 mm bottom-left) | tightest |
| Analog layout risks | hi-Z cells unchanged (rigid); hi-Z → module 18 mm (was 31): watch item | hi-Z → module 16 mm: watch item; width 60 | as V1 |
| XIAO / connector accessibility | 5 connectors in one row on the north edge (9.4 mm pitch, unchanged); module USB-C at south edge; toes and post access unchanged | same; battery plug also leaves north | same as V1 |
| Battery / enclosure | one 51 × 62 footprint; battery under PCB; B.Cu has only 8 bare test pads (skin side) | 60 × 59; battery connector in NE corner, SW pocket free for strap lugs / retention | as V1 |
| Assembly feasibility | single top side, 126 SMT, same package set | same | same |
| Expected relative manufacturing cost | PCB area +3 % (bare-board price from a JLC quote); assembly fees unchanged (same parts, joints, extended lines) | PCB area +15 %; assembly unchanged | PCB area −2 % |
| Architecture changes | none | none | none |

## 4. Ranked recommendation

1. **V1 — 51.3 × 62.5 mm.** Smallest layout that is DRC-clean, has zero parts under 2.5 mm and keeps every RB-02 geometric check.
2. **V2 — 60.4 × 58.9 mm.** Choose instead if a square footprint matters more than 15 % extra area, or if routing in V1 proves
   cramped; most free space, but 60 mm is across the wrist.
3. **V1R — 48.6 × 62.5 mm.** Only if JLCPCB confirms in writing that the 2.5 mm note does not apply to Economic boards.
4. Current 97 × 32 mm. Superseded.

## 5. Correction log

* The first V1 draft kept the battery connector J1 in its RB-02 orientation above the module: its plug opening then faced the
  channel cells (0.3 mm away). The new check C30 (7 × 9 mm plug corridor) flagged it (blocked by C101, C503, C5001, C5002, R5004,
  R5005, U503). V1/V1R now turn J1 so the plug leaves through the east edge; R7107/R7108/C7103 (battery divider, same nets) were
  re-seated beside it. V2 keeps J1 facing the north edge. No schematic change.
