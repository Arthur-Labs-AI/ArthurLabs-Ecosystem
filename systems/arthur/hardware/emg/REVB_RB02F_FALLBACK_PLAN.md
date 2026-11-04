# RB-02F — Minimal-Change Fallback Placement Plan (NOT APPLIED)

Date: 2026-10-10. Use only if JLCPCB answers that 2.5 mm body-to-edge is required for Economic PCBA, or if the owner prefers to
remove the question before routing. The project PCB is untouched. The plan was **built and checked on scratch copies** with
`rev-b-xiao/tools/rb02f_variant.py` (spec: `evidence/rb02f/fallback_F18_spec.json`, move list: `evidence/rb02f/fallback_moves.csv`).

## 1. Result of the scratch build (variant F18)

| Check | Current RB-02 | Fallback F18 |
|---|---|---|
| Board outline | 97.0 × 32.0 mm | **97.0 × 33.8 mm** (north edge 1.8 mm further north; area +5.6 %) |
| Parts with body < 2.5 mm to an edge | 37 | **0** (smallest body-to-edge 2.54 mm: R3009 / R5003) |
| Parts with copper < 0.3 mm | 0 | 0 |
| RB-02 placement checks (28) | 26 PASS, 1 CONDITIONAL | C06 "board size" now reports 97 × 33.8 (expected); all others PASS (C26 CONDITIONAL as before) |
| KiCad DRC + schematic parity | 0 errors, 0 parity, 273 unconnected, 1 warning | identical: 0 errors, 0 parity, 273 unconnected, 1 warning |
| Electrical connectivity | frozen | unchanged (same netlist; placement only) |
| XIAO position vs south edge / BAT+ post / USB-C | frozen | unchanged relative to the module and the south edge |

## 2. Moves

| # | Change | Parts | Why |
|---|---|---|---|
| 1 | Move the **north board edge 1.8 mm north**; every part keeps its absolute position (the outline simply starts at y = −1.8) | J1 (0.80 → 2.60 mm), R4001, R7107 and the 24-part 0603 row at y = 3.2 (2.40 → 4.20 mm) | The only way to give J1 its 2.5 mm body clearance with its plug opening facing the edge (see §4). Also clears 26 other north-edge parts for free |
| 2 | Rigidly translate the whole west block **1.35 mm east** (75 footprints: connector row J5001 + J101–J401, their cells, U501–U503, C501–C503, R5002–R5005, C5001/2, TP4/TP5). The gap to the ADC input-network clamps is 2.3 mm before and 0.95 mm after the move, so nothing collides | J5001 (1.23 → 2.58 mm), R5003 (1.19 → 2.54 mm) | Rigid translation keeps all P/N symmetry and per-leg geometry; no board growth in x |
| 3 | R7107, R7108, C7103: **0.9 mm west** | the three east-strip 0603s (1.69–1.70 → 2.59 mm) | East edge; the strip has room only because of change 1 |
| 4 | R7105 1.8 mm north, R7106 1.75 mm north (same column) | R7106 (1.64 → 3.39 mm) | South edge |
| 5 | R3009 0.05 mm north | R3009 (2.49 → 2.54 mm) | South edge |

Moves 2–5 are in the project's own placement table (`rb02_placement.py`); move 1 is a change of `BOARD_H` and the y-origin. Total:
81 footprints translated, 1 outline edge moved. Re-run RB-02 checks, DRC and `run_rb02e_checks.sh` afterwards (and update
`REVB_RB02_*` sizes: 97 × 33.8).

## 3. Why not smaller or different

| Alternative | Result |
|---|---|
| Nudge only the north 0603 row by 0.10–0.15 mm (+R4001, R3009, east strip, R7106) with **no** board growth (variant L) | 35 of 37 fixed; **J1 (0.8 mm) and R7107 (1.8 mm east) remain**: no room — see §4 |
| Grow the **west** edge by 1.35 mm instead of translating the west block | Zero part moves, but 98.35 mm wide; larger than the rigid translation which costs nothing before routing |
| Grow north only 1.7 mm | J1 body exactly 2.50 mm; zero margin; 1.8 mm gives 0.1 mm margin for the fab-outline rounding |
| Rotate J1 90° so the plug leaves toward the east edge (variant J1-E; found by the geometric search, not built as a PCB) | Board stays 97 × 32, J1 body 2.55 mm north / 4.5 mm east. But: (a) J1 courtyard overlaps the XIAO courtyard by 0.73 mm, (b) the housing/tabs end 0.27 mm from the module outline, (c) the plug corridor east covers R7107/R7108/C7103, which then need new homes. Not recommended unless the module underside at the north end is measured |
| Move J1 elsewhere on the board | A search of the whole board (rotations 0/90/180/270, 0.1 mm grid, 2.5 mm body margin, no courtyard overlap) found **no free position** for J1 |

## 4. Parts whose geometry inherently needs edge placement or defeats 2.5 mm

| Part | Inherent? | Reason |
|---|---|---|
| **J1** (JST S2B-PH-SM4-TB, battery) | **Yes** | Side-entry: the mating plug and cable travel in the PCB plane through the opening, so the opening must face a board edge (or a free corridor of ≈ 9 mm). The body is 7.6 mm deep plus 1.4 mm of tails; with 2.5 mm to the edge it needs ≈ 11.5 mm of strip depth above the XIAO outline (10.865 mm) — the north strip is 10.4 mm. Only an outline change (+1.7 mm) or a different orientation with a new corridor satisfies 2.5 mm |
| **U1** (XIAO, DNP) | Yes, but not a factory part | The USB-C receptacle overhangs the south edge by 1.508 mm by design; U1 is DNP and hand-soldered |
| **J101–J401, J5001** (JST B2B-PH-SM4-TB) | No | Top-entry; housing already 3.0 mm from the south edge. Tails run 2.5 mm beyond the housing to 0.5 mm from the edge by the connector's own pad geometry — copper, not body; the 0.3 mm note is met. J5001's west distance is a placement choice, solved by the west translation |
| Everything else (0603, SOT-23, TSSOP, oscillator) | No | Placed near edges only to pack Zone A; all are movable |

## 5. Effect on routing and cost

* Nothing is routed, so the translation costs only re-running the placement checks.
* The board grows 1.8 mm in one dimension. The Economic size limit is 10 × 10 … 470 × 500 mm; no JLC fee is documented as depending on
  area below 650 cm² (the board is 32.8 cm²). PCB fabrication price may change with area — a real quote is needed.
* No electrical change; `ELECTRICAL SCHEMATIC UNCHANGED` stays valid.
