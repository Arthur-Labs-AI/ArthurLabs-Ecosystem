# RB-04A — TP2 Power-Path Repair (D1)

Date: 2026-10-11. Branch `hardware/emg-rev-b`. Nothing ordered, uploaded, committed or pushed. No electrical-safety approval and no permission for human electrode use is implied.
Evidence: `rev-b-xiao/evidence/rb04a/` (suite/, tp2_proof/, images/, power_no_tp*.json); the pre-repair board is archived as
`rev-b-xiao/archive/rb04_candidates/canonical_before_rb04a_tp2.kicad_pcb`.

## 1. The problem

On the RB-04 board the AFE_3V0 rail reached 15 pads (C501–C503, D101/D102/D201/D202/D301/D302/D401/D402 pin 2, R5003.1, U501–U503 pin 4) only **through the copper of bare test pad TP2**.
Removing TP2 from the connectivity graph split the net (independent solver: 15 pads unreached; KiCad DRC with the TP2 footprint deleted: 1 unconnected item).

## 2. The change (the only copper change in RB-04A)

Two new B.Cu segments, net AFE_3V0, width 0.30 mm (same width as the neighbouring supply stubs), placed **outside the TP2 pad and outside its mask opening**:

| Segment | From (x, y mm) | To (x, y mm) | Length |
|---|---|---|---|
| S1 | 30.50, 33.90 | 30.50, 35.70 | 1.8 mm |
| S2 | 30.50, 35.70 | 27.80, 35.70 | 2.7 mm |

It joins the existing AFE_3V0 B.Cu stub that ends at (30.5, 33.9) with the existing B.Cu track at (27.8, 35.7), which already leads to the AFE_3V0 via. 4.5 mm of 0.3 mm copper, **no new via, no via-in-pad, no layer change**.
Everything else (parts, nets, keep-outs, planes, other tracks, vias, netclasses, custom rules) is byte-identical: a text diff of the two boards contains only these two `(segment …)` blocks (18 lines) plus the title block.
The segments carry no mask aperture (B.Mask flashes 10 → 10), so the new copper is **covered by mask**; no extra skin-facing exposed conductor appears. Geometry:

* before / after images: `evidence/rb04a/images/tp2_before_Bcu.png`, `tp2_after_Bcu.png` (B.Cu + B.Mask; green ring marks the stub end), `tp2_*_allcu.png` (both copper layers);
* the route passes all rules of the board (KiCad DRC with the project's custom rules and the independent class-aware clearance check: 0 violations); the In1 GND plane under it is untouched (1 fill, 3057 mm², 0 holes).

## 3. Verification

| Check | Before | After |
|---|---|---|
| Own connectivity (union-find over copper, TP pads excluded) | 1 net split | **0 nets not one component (71 nets)** — `suite/conn.json` |
| Own supply-resistance solver `--no-tp` | 15 pads unreached | **0 unreached**; AFE_3V0 worst 140.8 mΩ @ U502.4, 13.8 mA → **1.94 mV** (`power_no_tp.json`) |
| Same solver with TP2 present | 138.8 mΩ / 1.915 mV | 138.8 mΩ / 1.915 mV (unchanged: the pad path stays the shortest; the new copper only adds a parallel path) |
| KiCad-native DRC on a copy with TP2 deleted | 1 unconnected | **0 unconnected** (`tp2_proof/`; the two stub-end `track_dangling` warnings appear only because the pad was deleted for the test) |
| Current capacity / thermal | — | 0.3 mm × 35 µm Cu: 4.5 mm ≈ 7.4 mΩ; at 13.8 mA (datasheet-bounded AFE load) 0.10 mV and 1.4 µW; external-layer ampacity of a 0.3 mm 1 oz track is ≈ 0.9 A at +10 K (IPC-2221 chart value, not measured) |
| DRC (`--schematic-parity --severity-all`) | 0 errors, 1 warning (`lib_footprint_mismatch` U1, accepted since RB-02) | **0 errors, 1 warning, 0 unconnected, 0 parity** |
| ERC | 0 | **0** |
| Independent netlist parity | 135/135, 357 pad nets | **135/135, 357 pad nets** (the 2 "mismatches" are the same KiCad `/` → `{slash}` net-name escaping of unconnected U1 pins, unchanged) |
| Ground plane / return path | 99.87 % | **99.87 %** (6009 samples vs 5990: +19 samples on the new tracks; VBAT 94 % under the BAT+ post as before) |
| Critical analog routing audit (`analog.json`), mask audit (`mask.json`), electrical (`electrical.json`), iron access | — | **byte-identical** to RB-04 |
| Via-in-pad | 0 | **0** (201 vias; classes 179 / 12 / 10 / 0) |
| Guard check + canary, negative controls (15 mutations incl. netclass, custom-rule, via ring/hole clearance, mask-to-copper severities, tenting, stack-up, layer count, outline) | PASS | **PASS, 15/15 expected results** |
| Gerber ↔ source (14 checks: pad/track/via flashes, mask openings, paste, drill, CPL rows, BOM quantity sum 126) | PASS | **PASS 14/14** |
| Economic top-side assembly | 126 SMT on F.Cu, 0 on B.Cu | **unchanged** (B.Cu: 8 bare test pads + the XIAO PTH) |
| Rev A / XIAO mechanical interfaces, board outline 51.30 × 64.95 mm | — | **unchanged** (no footprint moved; outline bbox identical in the guard baseline) |

## 4. Project integrity actions

* `.kicad_pro` unchanged except the text variable `REVISION` ("B / RB-01" → "B / RB-04A"); netclasses and the 10 custom DRC rules verified by the guard (PASS) after the edit; hashes re-recorded in `tools/baseline/canonical_files.sha256` and re-verified (PASS) after the suite.
* Title blocks updated: PCB "B / RB-04A, routed + filled candidate … NOT RELEASED"; the "PLACEMENT ONLY: no routing, no vias, no fill" comment removed; six schematic title blocks "B / RB-04A", 2026-10-11 (schematic content otherwise unchanged except BOM fields, see the BOM document).
* DFM exports for the audit were generated only in a scratch directory and are **not** release files; nothing was uploaded.

## 5. Residual limits

The repair removes the dependence of AFE_3V0 on a probe pad. It does not change the TP2 pad itself (still a bare skin-side pad, see D7). Resistances are calculated from copper geometry at 1 oz / 20 °C, not measured.
