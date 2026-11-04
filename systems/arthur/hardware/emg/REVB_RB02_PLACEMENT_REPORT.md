# RB-02 — Footprint Authoring & Component Placement Report

> **Superseded by RB-03.** The 97 × 32 mm placement below is archived (`rev-b-xiao/archive/rb02_97x32/`). The main Rev B PCB is now the
> V1 51.3 × 62.45 mm board (RB-02G/H) routed in RB-03; see `REVB_RB03_ROUTING_REPORT.md`. Footprint audit and rule sets still apply.

Status: **placement-only PCB created; not routed; not for manufacturing.**
Date: 2026-10-10. Branch `hardware/emg-rev-b`. Nothing committed.

Scope honoured: digital design only; no hardware purchased, no PCB ordered, no test board; no routing, no zone fill,
no Gerbers/drill/pick-and-place files; Rev A untouched; electrical schematic untouched.

## 1. Phase 0 — RB-02A discrepancy closure

| ID | Finding (RB-02A) | RB-02 resolution | Where |
|---|---|---|---|
| D-1 | Castellation copper 1.626 mm along the edge vs RB-00.6 1.50 | Module copper is 1.626; host pad stays **1.50 along the edge** (frozen). Overlap ≥ 1.035 mm worst case (post tolerance stack). No geometry change. | MOUNTING_SPEC, tolerance stack |
| D-2 | Four USB-shell GND ovals missing from keep-outs | Added as four underside keep-outs (tracks/vias not allowed, pour allowed) in the XIAO footprint, hoisted to board-level rule areas, proven with seeded vias. | footprint, checks C16, F08 |
| D-3 | Small BAT+ cone-to-hole clearance | Cone target tightened to Ø ≤ 1.0 / h ≤ 0.4 (process control, option B). Worst-case cone margin 0.11 (A) → 0.16 (B). | MECHANICAL_RISKS |
| D-4 | Corrected module dimensions / datums | Module 17.78 × 21.135 mm; M2/M6/M7/M8 corrected in checklist; footprint origin = module outline centre. | MOUNTING_SPEC, CHECKLIST |
| D-5 | B2B connectors populated | Stated as populated on the single reference module (M10); no host keep-out change needed (they are under the module). | CHECKLIST |
| D-6..D-9 | Datum, 3.23 mm to TP7, 97 × 32 board, module north edge | Recorded in MOUNTING_SPEC / DIRECT_XIAO_ARCHITECTURE with `[RB-02, D-n]` markers. | docs |

Frozen host geometry (pad 2.90 × 1.50, toe 1.30, post hole Ø1.40, ring Ø1.90, mask Ø1.45, bottom pad Ø3.00) is
**unchanged**. The post tolerance trade-offs (options A–E) are shown, not implemented, in
`REVB_RB02_MECHANICAL_RISKS.md`.

## 2. Board

| Item | Value |
|---|---|
| Outline | 97.00 × 32.00 mm, 1.0 mm corner radius (RB-00.6 estimate was 75 × 32) |
| Why 97 mm | Zone A carries four 9.4 mm-pitch electrode connectors + protection cells, and the AIN network (1 nF caps, BAV199 clamps, ADC) needs ≈ 3 mm more than the estimate; the RB-00.6 75 mm figure had no connector pitch. Zone A is extended by 22 mm; Zones B/C/D keep their RB-00.6 relations. |
| Stack-up | 4 copper layers, JLC04161H-7628 style, F.Cu signal / In1 GND / In2 GND(A,B) + power / B.Cu test pads only. PCB thickness remains the one open item (1.6 mm assumed in the model). |
| Frame | KiCad x = x' + 22 (x' = RB-00.6 frame, XIAO east edge 72.78, USB end y = 32). |

## 3. Placement summary (135 footprints, all placed)

| Zone | Contents | Location (x' frame) |
|---|---|---|
| A (analog front end) | J501-J504 + J5001 electrode/bias connectors at y 28.25 (x' −16.8 … 20.8), series R, hi-Z diode/BAV199 protection, 100 pF / 10 M, AC-coupling and DC-bias parts per leg in cells | x' −19 … 30, y 3 … 29 |
| B (instrumentation) | U501/U502/U503 TLV9064 between legs and ADC, decoupling 2.1–2.5 mm from V+ pins, VCM reference | x' ≈ −8 … 26 |
| C (ADC) | U6001 ADS131M04 at (42.0, 19.0); 1 nF AIN caps in a horizontal column (x' 36.3), clamps at x' 28.9/32.8; C6007/C6008/C6009 2.1/1.5/2.2 mm from pins; X1 at (47.9, 14.1) | x' 28 … 52 |
| D (digital / power / RF) | SPI/DVDD filter columns (x' 47.6 / 50.7), U4002 / Q3001 / R4001 USB inhibit strip (north), J1 battery JST at (66.5, 5.2), XIAO U1 at (63.89, 21.43) rot 180 | x' 44 … 75 |
| Test | TP1–TP8 bare pads on B.Cu | south-west, ≥ 0.5 mm from edge |

Priority list outcome: connectors/protection (placed first, symmetric P/N rows, equal Rs→clamp hi-Z length 3.21 mm),
hi-Z inputs (no part crosses the P/N cell boundary), TLV9064, ADS131M04 + clamps, VCM/AFE power, oscillator (OUT pad
→ CLKIN 3.61 mm, ≤ 5 mm requirement), SPI/DVDD filter, USB inhibit, XIAO + solder access, battery/RF.

Single ground: In1 is one GND plane outline; In2 is two GND outlines (A/B) tied through the plane, no split.
Physical constraints for RB-03 are encoded in `ARTHUR_EMG_RevB.kicad_pro` (13 netclasses, 34 patterns, all 90 nets
classified) and `ARTHUR_EMG_RevB.kicad_dru` (8 custom rules: hi-Z outer-layer only ×2, no hi-Z vias, 0.40 mm hi-Z
leakage clearance, SPI→hi-Z 2.0 mm, SPI→buffer 1.0 mm, Zone A no digital, no via in SMD pad). Each rule was proven to
fire by seeded violations (`rb02_seed_drc_rules.py`: ALL RULES FIRE).

## 4. Verification

### 4.1 Placement checks — 28 checks: 26 PASS, 0 FAIL, 1 CONDITIONAL, 1 INFO

Evidence: `rev-b-xiao/evidence/rb02/placement_checks.json`.

| Requirement | Check | Result |
|---|---|---|
| PCB/schematic sync, pin-to-net | C01–C03 | 135/135 refs; 364 pad-net checks, 0 mismatch |
| Count / DNP | C01, C04 | DNP set = {U1} |
| Board size | C06 | 97 × 32 |
| Courtyards, edges | C07–C09 | no overlaps; pads ≥ 0.5 mm from edge; U1 crosses south edge only by the USB-C overhang |
| XIAO position, castellations, post | C10–C15 | 0.0000 mm deviation from CAD; post at CAD BAT+ position; nothing within 3 mm |
| Underside keep-outs | C16 | 11/11 present as board-level rule areas |
| Solder-iron access / heights | C17–C19 | clear |
| USB-C, U.FL | C20–C21 | clear |
| Oscillator ↔ ADC | C22 | 3.61 mm |
| Decoupling, symmetry, AIN network | C23–C25 | pass |
| JLC single side | C05, C27 | F.Cu only, TP bare B.Cu pads |
| JLC process rails | C26 | **CONDITIONAL** — 35 small parts within 3 mm of the long edges, JLC adds process rails |

### 4.2 KiCad DRC (10.0.6, `--schematic-parity --severity-all`)

| Class | Count | Verdict |
|---|---|---|
| Errors (geometry, clearance, courtyard, hole) | 0 | **PASS** |
| Schematic parity issues | 0 | PASS |
| Unconnected items | 273 | Expected: no routing yet |
| Warning `lib_footprint_mismatch` U1 | 1 | Accepted: board copy carries the hoisted rule areas and DNP attribute that the library copy keeps as footprint-embedded zones |
| Via-in-pad, silk/mask violations | 0 | — |

Verdict: **PARTIAL by definition** (unconnected pre-routing); zero geometry or parity errors.

### 4.3 Electrical schematic unchanged

`run_rb01r_checks.sh` re-run after footprints and PCB: ERC 0 violations; netlist audit all groups pass; mutation test
PASS; Rev A PCB hash and Rev A tree hash unchanged; 357-pin netlist identical to RB-01R; schematic sha256 equal to the
RB-01R scratch copy.

### 4.4 JLC assembly feasibility

Single-sided SMT (F.Cu). Package types are standard JLC basic/extended parts except the XIAO module (DNP, hand
solder). SCTF 3.2 × 2.5 mm oscillator with paste, 0603/0805 passives, TSSOP-16 / TSSOP-14, JST B2B-PH-SM4. Condition:
accept process rails or panelize with rails (C26). No via-in-pad, no thru-hole parts for the assembler.

## 5. Corrections to previous deliverables

RB-02A evidence (`evidence/rb02a/`, REVB_RB02A_*.md, 1:1 PDF) preserved unchanged. Mechanical docs edited with
`[RB-02, D-n]` markers (see §1). RB-01R footprint-qualification open items for the two custom footprints are now closed
by `REVB_RB02_FOOTPRINT_AUDIT.md`; footprint-link ERC warnings are 0.

## 6. Open items going into RB-03

1. PCB thickness and stack-up confirmation with the fabricator quote (design assumes 1.6 mm).
2. Accept or reject mechanical option B (cone ≤ 1.0) and optional E (mask 1.55) — owner decision.
3. JLC process rails (C26).
4. Plain-vs-Sense equality of the hi-Z legs still to be confirmed during routing.
5. Physical caliper measurements of one real module (see risks report).

## 7. Final gate

| Field | Value |
|---|---|
| RB-02 FOOTPRINTS | **PASS** (15/15) |
| XIAO CASTELLATIONS | **PASS** (0.0000 mm vs CAD) |
| BAT+ POST | **CONDITIONAL** — manufacturable, thin margins; option B recommended |
| UNDERSIDE KEEP-OUTS | **PASS** (11/11, proven by seeded vias) |
| PCB CREATED | YES |
| ALL COMPONENTS PLACED | YES (135/135) |
| PLACEMENT DRC | **PARTIAL** — 0 errors, 0 parity, 273 unconnected expected, 1 accepted warning |
| JLC ASSEMBLY FEASIBILITY | **CONDITIONAL** (process rails) |
| REV A UNCHANGED | YES |
| ELECTRICAL SCHEMATIC UNCHANGED | YES |
| READY FOR RB-03 ROUTING | YES, with conditions in §6 |
| READY FOR MANUFACTURING | **NO** |
| REMAINING PHYSICAL MEASUREMENTS | module thickness / outline / castellation pitch / BAT+ position (calipers, one module); B2B and shell-oval visual; first-article cone/hole fit |
| BLOCKERS | none for routing; manufacturing blocked by the items above |
