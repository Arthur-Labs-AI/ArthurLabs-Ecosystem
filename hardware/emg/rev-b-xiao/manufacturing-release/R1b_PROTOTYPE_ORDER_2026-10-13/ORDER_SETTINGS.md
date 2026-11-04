# A.R.T.H.U.R EMG Rev B (R1b) — JLCPCB order settings (prepared, NOT submitted)

Prepared 2026-10-13 on the owner's authorization to prepare the manufacturing release for five prototype PCBs, two assembled. **Nothing was uploaded, ordered or paid.**
Source: frozen canonical PCB `ARTHUR_EMG_RevB.kicad_pcb` sha256 `7fda8d9c6fa568d703dfdf91c5fbd35bc0b9001164543d38d661ca0690ae75a9`, footprint `c8703292766625345f78a221ab7682acadf4131a4296d330a8a2671e67d7a36e`.
The option names below follow JLCPCB's order form as I know it; **confirm each label on the live page** (I did not open it).

## 1. Files to upload

| Use | File |
|---|---|
| PCB (Gerber/drill) | `ARTHUR_EMG_RevB_R1b_RELEASE_Gerbers.zip` |
| PCBA BOM | `ARTHUR_EMG_RevB_R1b_RELEASE_BOM.csv` |
| PCBA CPL | `ARTHUR_EMG_RevB_R1b_RELEASE_CPL.csv` (fallback if the viewer shows wrong rotations: `alternate/…_CPL_raw_KiCad_rotation.csv`) |
| Remarks | paste `MANUFACTURING_REMARKS.txt` |

## 2. PCB settings

| Option | Value | Note |
|---|---|---|
| Base material / layers | FR-4, **4 layers** | |
| Dimensions | **51.3 × 64.95 mm** (JLC reads it from the Gerbers) | Edge.Cuts is a 0.1 mm line: file bbox 51.40 × 65.05 mm; centre line 51.30 × 64.95 mm |
| Quantity | **5** | |
| Different design / delivery format | 1 / single pieces | |
| Thickness | **1.6 mm**, 4-layer stack-up JLC04161H-7628 (the design's stackup) | |
| Impedance control | No | |
| Outer / inner copper | **1 oz / 0.5 oz** | |
| Min via hole size / diameter | **0.3 mm / 0.4 mm (default tier)** — the design's vias are 0.30 mm / 0.60 mm | |
| Via covering | **Tented** (default). Applies to the 201 vias; the BAT+ hole is a component hole — see remark 1 | |
| Solder mask / silkscreen | **Green / white** | |
| Surface finish | **ENIG** (JLC's recommendation; the PCB job metadata says HASL-with-lead, but the finish is an order option and does not change the Gerbers) | keeps the Ø1.9 hole size uncontaminated by solder levelling; flat pads under the XIAO |
| Castellated holes / edge plating | No / No | the module carries its own castellations |
| Board outline tolerance | regular (±0.2 mm) | |
| Gold fingers, impedance, flying probe | no / no / default | |
| Remove order number | optional (JLC places an order number in a silkscreen-free spot unless a location is specified) | cosmetic |
| **Confirm production file / engineering preview** | **YES, if offered** | this is the pre-payment CAM evidence required by RB-04J condition 1 |

## 3. PCBA settings

| Option | Value |
|---|---|
| Assembly | **Economic**, **top side only** |
| PCBA quantity | **2** (of the 5 boards) |
| Tooling holes | added by JLCPCB (default) |
| Confirm parts placement | YES (recommended; $0.45 in the RB-04 fee list) |
| Parts | JLC sourcing with the supplied LCSC numbers; **U1 is not in the BOM/CPL** |

## 4. BAT+ hole — to be recorded and checked

```
BAT+ Ø1.90 mm PLATED COMPONENT HOLE (U1 pad 23, X 44.635 / Y 54.790):  OPEN - NOT TENTED, PLUGGED OR FILLED
```
Pre-payment checks in JLC's viewer / engineering preview: (a) the hole is shown as a drill with a pad, not as a via with mask coverage; (b) top mask opening ≈ Ø1.95, bottom mask opening Ø3.00; (c) no "tented/plugged" or "via" flag on it; (d) no automatic change to the 0.20 mm ring. Any deviation: stop and ask; the mask-only fallback (Ø2.10 openings) is described in RB-04J §5.

## 5. Facts to expect on the order page (from the verified files)

| Item | Value |
|---|---|
| Holes | 201 × 0.30 mm + 1 × 1.90 mm (PTH); no NPTH, no slots |
| SMT placements | **126**, all Top; 29 BOM lines; 340 solder joints |
| Extended-part feeder lines | 12 confirmed Extended + up to 16 whose class was not shown → fee uncertain ($3.07 each, RB-04A/B estimate: parts + assembly ≈ $67–$132 for two boards; fabrication, shipping and tax not estimated) |
| Stock risks | C14663 (100 nF) only 4,000 pcs; 10 k / 10 M / 4.7 Ω use second-choice stocked parts |
| Rotation check | after the CPL import inspect the 2D preview for SOT-23, SOT-23-5, TSSOP-14/20, JST S2B (offsets are community values) |

## 6. Known open items accepted for a prototype order (RB-04J)

22 mask/via cases and the 0.15 mm via ring (JLC reported "generally acceptable"); module bottom-pad tolerance and thickness (Seeed: unavailable); charge current; mask registration tolerance (unpublished); cone size is controlled in assembly.
After receipt: incoming inspection (Ø1.7 mm pin through the hole from both sides, mask openings visible, continuity J1.1 ↔ B.Cu land, no short VBAT↔GND) and the assembly controls of RB-04J §6.
