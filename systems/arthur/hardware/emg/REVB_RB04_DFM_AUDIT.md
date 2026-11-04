# RB-04 — DFM Audit (JLCPCB fabrication, vias and solder mask, configuration, exports)

Date: 2026-10-11. Board: Rev B, 51.30 × 64.95 mm, 4 layers, HASL (with lead) as set in the file, 1.6 mm. Nothing was uploaded, ordered or committed.
JLCPCB figures were read from https://jlcpcb.com/capabilities/pcb-capabilities and https://jlcpcb.com/help/article/pcb-assembly-price on 2026-10-11
with a text-extraction tool (WebFetch); the three readings are consistent except where marked. They are **not** a factory review.

> **RB-04A update.** Superseded by RB-04A (2026-10-11): board is now `B / RB-04A`; the TP2 dependence is repaired (R1 closed), the BOM candidates are selected (R5 reduced to the 2.2 µF approval), the JLC inquiry is prepared and **not sent**. Details: `REVB_RB04A_*.md`.
> Re-run of the complete suite on the repaired board: DRC 0 errors / 1 accepted warning / 0 unconnected, ERC 0, parity 135/135, via-in-pad 0, vias 201 (179 / 12 / 10 / 0), B.Mask apertures unchanged, Gerber↔source 14/14, guard + canary + 15 negative controls PASS. Evidence `evidence/rb04a/suite/`.

## 1. Result

| Item | Result |
|---|---|
| JLC fabrication limits (published) | **CONDITIONAL** — all limits met; two margins are at the published minimum / unpublished (§2) |
| Vias: in-pad / hole touching an opening | **0 / 0** (independent audit, 201 vias) |
| Class 1 / 2 / 3 / 4 vias | **179 / 12 / 10 / 0** (RB-03S, different method: 11 class 2; the 12th is C406.2 at 0.087 mm vs the 0.09 mm line) |
| Minimum hole-edge to mask opening | 0.101 mm (U1.3) — ≥ 0.10 mm but with no usable margin |
| Project configuration | **PASS** — effective settings equal; 15/15 negative controls detected |
| Exports (local DFM only) | **PASS** — 14/14 read-back checks against the KiCad source |

## 2. Published JLCPCB limits vs the board

Source column: V = quoted from the capabilities page, I = my interpretation. Where a number is a "recommended" value that is not a
manufacturing requirement this is stated.

| Parameter | JLCPCB (published) | Board (independent measurement) | Status |
|---|---|---|---|
| Track / space, 1 oz outer, multilayer | 0.10 / 0.10 mm; inner 0.09 / 0.09 mm (V) | track ≥ 0.15 mm, gaps ≥ 0.205 mm | PASS |
| Via hole / diameter min | 0.15 mm / 0.25 mm (V) | 0.30 / 0.60 mm | PASS |
| Via diameter vs hole | "0.1 mm (0.15 mm preferred) larger" (V) | 0.30 mm larger | PASS |
| PTH annular ring, 1 oz multilayer | recommended ≥ 0.20 mm, **absolute minimum 0.15 mm** (V; row is for PTH pads, applied to vias by I) | vias 0.150 mm; post PTH 0.25 mm | **at the absolute minimum** (CONDITIONAL) |
| Via hole to via hole | 0.2 mm (V) | ≥ 0.5 mm | PASS |
| Via hole to track | 0.2 mm (V) | ≥ 0.25 mm | PASS |
| PTH hole to track | 0.28 mm, 0.35 recommended (V) | post hole: 1.165 mm | PASS |
| Pad hole to hole | 0.45 mm (V) | 1 PTH | PASS |
| Copper to routed edge | ≥ 0.2 mm (V) | ≥ 0.50 mm (outer), inner pours 0.30 mm inset | PASS |
| Solder-mask bridge (1 oz, green) | 0.10 mm (V) | 0 openings closer than 0.10 mm (excluding same-footprint pin gaps ≥ 0.25 mm) | PASS |
| Mask expansion | 1:1; ≥ 0.09 mm between openings and neighbouring traces (V) | opening = pad (U1: +0.05); 0 foreign tracks within 0.09 mm of an opening | PASS |
| Tenting | "Vias are filled with soldermask … no soldermask openings on either side; ≤ 0.5 mm" is the **plugged** option; default of the plain order not stated on the page | `(tenting (front yes) (back yes))`, no via in any mask layer (0 via apertures in F/B.Mask) | **Inquiry** (§5) |
| Plugged-via condition | "≥ 0.35 mm clearance from other soldermask openings (e.g. pads)" (V) | none of the 47 near-opening vias satisfies it | plugging is **not** a usable fix |
| Via-in-pad | epoxy / copper-paste filled & capped, 0.15–0.55 mm (V) | 0 via-in-pad | not used |
| Board thickness / stack-up | 1.6 mm ±10 % (V); JLC04161H-7628 values not on the page | 1.606 mm computed: 0.035 / 0.2104 / 0.0152 / 1.065 / 0.0152 / 0.2104 / 0.035 mm | I: matches the JLC04161H-7628 construction used in RB-02; confirm at order |
| Mask registration tolerance | not found on the page | — | **unknown** |

Distinction between requirement and interpretation: the only hard failures JLC would raise automatically are the minimum figures above;
"recommended 0.20 mm ring" and "0.09 mm opening-to-trace" are recommendations or CAM-adjustment triggers, and whether a via annulus counts as a
"neighbouring trace" is my interpretation, which is why §5 asks.

## 3. All 201 vias

Method (`rb04_mask.py`): for each via, exact distance from the via centre to the polygon of every pad opening (pad copper + mask expansion) within 3 mm;
hole edge = distance − 0.15 mm, annulus edge = distance − 0.30 mm. Classes: **1** annulus ≥ 0.09 mm from every opening (or no opening within 0.6 mm);
**2** annulus outside an opening, dam 0.00–0.09 mm; **3** annulus overlaps an opening (hole still ≥ 0.10 mm clear); **4** hole < 0.10 mm to an opening
or via-in-pad. All 201 are plain 0.30 / 0.60 mm tented through vias; every near-opening via is on the **same net** as the pad it touches (22 of 22).

| Class | Vias | Meaning for manufacturing |
|---|---|---|
| 1 | 179 | ordinary tented via |
| 2 | 12 | mask dam < 0.09 mm; CAM may re-size the aperture; no process change |
| 3 | 10 | annulus partly exposed; hole covered by ≥ 0.101 mm of mask |
| 4 | 0 | would need plug / fill-and-cap |

### 3.1 The 22 vias that are not class 1

| ID | Via (x, y) mm | Net | Class | Worst pad | Hole edge → opening (mm) | Annulus edge → opening (mm, − = overlap) |
|---|---|---|---|---|---|---|
| V01 | (11.1, 53.2) | `/CH3_P` | 3 | C306.1 | 0.125 | -0.025 |
| V02 | (23.0, 56.4) | `DVDD_F` | 3 | R7104.1 | 0.125 | -0.025 |
| V03 | (24.1, 54.5) | `/DRDY_N` | 3 | R6003.2 | 0.110 | -0.040 |
| V04 | (25.2, 49.1) | `GND` | 3 | C6009.2 | 0.110 | -0.040 |
| V05 | (26.3, 59.3) | `DVDD_F` | 3 | C7102.1 | 0.125 | -0.025 |
| V06 | (28.5, 56.7) | `DVDD_F` | 3 | FB1.2 | 0.125 | -0.025 |
| V07 | (30.3, 55.5) | `/XIAO_Brain_Interface/MOSI_MCU` | 3 | U1.11 | 0.141 | -0.009 |
| V08 | (31.7, 16.5) | `/VCM` | 3 | R106.1 | 0.125 | -0.025 |
| V09 | (36.4, 16.5) | `/VCM` | 3 | R105.1 | 0.125 | -0.025 |
| V10 | (49.4, 58.0) | `/SYNC_RESET_N` | 3 | U1.3 | 0.101 | -0.049 |
| V11 | (7.2, 36.7) | `GND` | 2 | TP8.1 | 0.231 | +0.081 |
| V12 | (11.1, 48.4) | `/CH1_N` | 2 | C107.1 | 0.164 | +0.013 |
| V13 | (11.1, 49.9) | `/CH2_N` | 2 | C207.1 | 0.164 | +0.013 |
| V14 | (13.4, 36.7) | `GND` | 2 | TP7.1 | 0.231 | +0.081 |
| V15 | (14.2, 57.5) | `GND` | 2 | C406.2 | 0.237 | +0.087 |
| V16 | (14.3, 18.7) | `GND` | 2 | C304.2 | 0.175 | +0.025 |
| V17 | (14.6, 20.1) | `/CH3/BUF_N` | 2 | U502.7 | 0.200 | +0.050 |
| V18 | (22.4, 60.7) | `/XIAO_Brain_Interface/USB_PRESENT` | 2 | R7106.1 | 0.157 | +0.006 |
| V19 | (26.8, 54.6) | `/XIAO_Brain_Interface/MOSI_MCU` | 2 | R7102.1 | 0.175 | +0.025 |
| V20 | (28.7, 37.8) | `/Analog_Power_Interlock/AFE_EN` | 2 | Q3001.3 | 0.150 | +0.000 |
| V21 | (30.3, 48.2) | `/XIAO_Brain_Interface/SCLK_MCU` | 2 | U1.9 | 0.179 | +0.029 |
| V22 | (34.5, 39.7) | `GND` | 2 | R7108.2 | 0.226 | +0.076 |

### 3.2 Specific items requested

* **Class 3 (10):** V01–V10. Hole web 0.101–0.141 mm. Three (V03 R6003.2 0.110, V04 C6009.2 0.110, V10 U1.3 0.101) are within 0.01 mm of JLC's 0.10 mm figure, i.e. **no
  margin for registration error that is not published**. If the mask moves toward the hole by more than the web the hole is exposed to the pad's solder.
* **Class 2 (12):** V11–V22; dams 0.000–0.087 mm (V20 Q3001.3 exactly 0.000 mm: tangent). Two are bare B.Cu test pads (TP7/TP8, 0.081 mm) where no solder is applied.
* **C6009's GND via (V04):** annulus overlaps C6009.2's opening by 0.040 mm, hole web 0.110 mm. Placement window 0.11 mm (RB-03S). It cannot move east (R7101 limited by C17) or west
  (U6001 courtyard 0.005 mm).
* **Minimum 0.105 mm (RB-03S) vs 0.101 mm (here):** a different polygon approximation of the rounded pad corner; both are above 0.10 mm. The honest statement is
  "0.10 ± 0.005 mm".
* **0.15 mm radial ring:** at JLC's absolute minimum for PTH pads, unchanged since RB-02; the project rule `min_via_annular_width` is 0.15 mm so DRC has zero margin there too.

### 3.3 Is the same net a mitigation?

Electrically yes (no short). For solder it is **not**: molten solder on the exposed annulus is the same alloy regardless of net. What matters is an open hole. With a tented hole under ≥ 0.10 mm of mask
the barrel cannot be fed by the joint. Real risks that remain, none quantified by JLC: (a) CAM merges or opens the via mask because it touches a pad opening → the hole becomes open → wicking/starved joint on that 0603/SOT-23 pad;
(b) registration moves the opening onto the hole; (c) a sliver of mask between opening and via flaking during HASL. These are exactly the questions in the inquiry package. For HASL the exposed annulus of a class-3 via is also coated by solder, which is
harmless but changes the fillet slightly (a 0.04 mm sliver on a 0.8 × 0.95 mm pad is < 0.5 % of the pad area).

## 4. Ordinary corrections evaluated (none installed)

| Option | Result in a scratch copy | Verdict |
|---|---|---|
| Move single neighbouring 0603 parts 0.05–0.20 mm to open the dam (11 candidate parts from `mask_class23.csv`) | DRC clean in 8 of 11 trials, but the re-routed ties re-place the vias: classes 2/3 change from 12/10 to 11–15 / 8–12 (`shift_trials.json`); 3 trials create courtyard/clearance errors | **no systematic gain**; needs hand placement per cluster |
| Batch of all feasible shifts | 2 DRC errors, classes 20/10, 208 vias (worse) | rejected |
| Via 0.70 / 0.30 mm (ring 0.20, JLC recommended) | 9 clearance + 2 items-not-allowed errors; classes 26 / 17 | rejected: wins ring, loses mask margin and routing |
| **Via 0.60 / 0.25 mm** (ring 0.175 mm, same copper) | DRC 0 errors, 0 unconnected; classes 12/10 unchanged; hole web +0.025 mm (min 0.126 mm); needs `min_through_hole_diameter` 0.30 → 0.25 and a baseline update | **proposal P2**, not applied: JLC's order form may price smaller drills (I: unverified), aspect ratio 6.4:1 not published → inquiry Q4 |
| Shrink pad opening (negative mask expansion) at the 10 class-3 pads | not tried | JLC publishes 1:1; not assumed |
| Plug / fill-and-cap | not possible / not authorised | out of scope |

## 5. Factory inquiry (precise, ready to send after approval)

The package is in `rev-b-xiao/evidence/rb04/jlc_inquiry/`: `via_list.csv` (22 vias with coordinates and distances), `images/overview.png` (numbered), `images/V01.png … V22.png`
(4 × 4 mm crops, F.Cu + F.Mask, 120 px/mm, the via circled). The text is in `REVB_RB04_OPEN_RISKS_AND_DECISIONS.md` §3. **Gerber files are not part of it and must not be sent without your approval.**

## 6. Project configuration integrity (Phase 4)

Compared: the regenerated `ARTHUR_EMG_RevB.kicad_pro` (hash `69d9d2a1…`, 347 keys) against the pcbnew-serialised file of the end of RB-03R (`babc896c…`, 545 keys) and against the HEAD stub.

| Effective setting | Reviewed (RB-02/03) | Current | Result |
|---|---|---|---|
| Net classes (14) and every class parameter | reviewed baseline | identical by name (0 differences; only list order / `priority` numbers differ) | PASS |
| 34 netclass patterns; 90 nets → classes | baseline | identical; independent re-matching (`fnmatch`, first match) reproduces the baseline map | PASS |
| Track widths / via list | 0.15/0.2/0.25/0.3/0.5; 0.6/0.3, 0.8/0.4 | identical | PASS |
| Design rules | min clearance 0.15, track 0.15, via ⌀ 0.5, hole 0.30, edge 0.50, connection 0.15, via ring 0.15, hole clearance 0.25, hole-to-hole 0.5, mask-to-copper 0.0 | identical (baseline now records the last four as well) | PASS |
| Rule severities | KiCad defaults (all geometric rules `error`) | block absent → defaults; `solder_mask_bridge`, `clearance`, `hole_clearance`, `courtyards_overlap`, `copper_edge_clearance`… = error | PASS (effective); note below |
| 10 custom DRC rules | `.kicad_dru` hash `21c0e803…` | identical; canary 11/11 fire, 3/3 exemptions silent | PASS |
| Layer stack-up, 4 Cu, finish, tenting, `pad_to_mask_clearance` 0, outline box | board file | now in the baseline (`pcb_setup`) and compared on every verify | PASS |
| Fabrication constraints in the file | JLC04161H-7628 values | match §2 | PASS |

Note: the regenerated file does not contain an explicit `rule_severities` block (KiCad supplies defaults). The effective values are equal to the previously dumped ones; the guard now treats a missing key as `error` and
fails if any of 24 rule types is lowered. A project written by KiCad later will re-add the block; the guard handles both.

**Negative controls** (`rb03r_guard_selftest.py`, `guard_selftest.json`): 15 mutations of a scratch copy — netclasses removed, patterns removed, one pattern re-assigned, rule deleted, rule disabled, severity ignored,
mask-bridge severity ignored, courtyard overlap lowered, via ring lowered to 0.05, hole clearance lowered to 0.05, extra rule, DRU missing, via tenting switched off, prepreg thickness changed — plus the unmutated baseline:
**16/16 behave as expected**. Pipeline-level (RB-03R): stripped netclasses → KiCad DRC prints no error, guard fails, `rb03r_verify.sh` exits 1.

**Protection** (`rb04_lock.sh`): the nine canonical files (project, rules, 6 schematics, symbol library) are made read-only and their sha256 recorded in `tools/baseline/canonical_files.sha256`;
`verify` runs at the start and end of `rb04_run_all.sh` and `rb03r_verify.sh`. **Limits:** read-only bits do not stop a program that replaces the file (write-temp + rename in a writable directory);
the hash check is the actual protection. `.kicad_prl` (UI state) is not covered. Every RB-03R/RB-04 tool that opens a board with pcbnew or kicad-cli does so on a scratch copy.

## 7. DFM-only exports (isolated scratch; not release files)

Exported with kicad-cli 10.0.6 into `/tmp/…/dfm` from a scratch copy: 4 copper layers, F.Mask, B.Mask, F.Paste, F/B silkscreen, Edge.Cuts, Excellon drill, position file (`--exclude-dnp`), BOM.
Read back with an independent RS-274X / Excellon reader (`rb04_gerber.py`), no KiCad code involved:

| Check | Gerber / file | KiCad source |
|---|---|---|
| F.Cu SMD pad flashes | 354 | 354 |
| F.Cu / B.Cu conductor length | 1235.18 / 356.60 mm | 1235.18 / 356.60 mm |
| Via pad flashes F.Cu / In1 / B.Cu | 201 / 201 / 201 | 201 |
| F.Mask openings (SMD + PTH) | 355 | 355 |
| F.Mask / B.Mask via openings (tented ⇒ 0) | 0 / 0 | 0 |
| F.Paste apertures | 340 | 340 (126 parts, XIAO excluded) |
| Drill 0.30 mm / 1.40 mm | 201 / 1 | 201 vias / 1 PTH |
| Outline | 51.300 × 64.950 mm | 51.30 × 64.95 mm |
| CPL rows | 126, all top | 126 |
| BOM (KiCad, grouped, DNP and test pads excluded) | 29 lines, quantity sum 126 | 126 assembled SMT parts |

Renders produced by the same reader (`evidence/rb04/images/gerber_render_*.png`) were compared by eye with the KiCad view of the board; they agree. **Limits:** no third-party Gerber
viewer is installed in this environment and none was downloaded; the reader is mine, so a systematic misunderstanding of the format would be common to the parser and its checks (mitigated by the numeric
agreement with the source). The files carry the title-block revision "B / RB-02" and must not be treated as a release.

## 8. Reproduction

```
bash hardware/emg/rev-b-xiao/tools/rb04_run_all.sh <scratch dir>
python3 hardware/emg/rev-b-xiao/tools/rb04_mask.py --pcb <board> --out mask.json --csv mask.csv
python3 hardware/emg/rev-b-xiao/tools/rb04_gerber.py --gerber <dir> --pcb <board> --pos pos.csv --bom bom.csv --out report.json --svg-dir svg
```
