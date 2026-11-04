# RB-04B — Final BOM Resolution

Date: 2026-10-11. Branch `hardware/emg-rev-b`. Nothing sent, uploaded, ordered, purchased, committed or pushed; **copper routing, vias and footprints unchanged** (PCB sha256 `111e1cd3…` identical to RB-04A).
No electrical-safety approval and no permission for human electrode use is implied; manufacturing release remains BLOCKED. Predecessors: `REVB_RB04A_*.md`.

## 1. The 2.2 µF part — independent verification (task 1–4)

| Item | Finding | Source |
|---|---|---|
| Part | FH (Guangdong Fenghua Advanced Technology) **0603B225K160NT**, LCSC / JLC **C43922** | LCSC, JLC page |
| Electrical | 2.2 µF, 16 V, X7R, ±10 %, 0603 | FH catalogue row (fhcomp.com, code 010121 p.25), LCSC, JLC — all three agree |
| JLC | **Extended**, PCBA type "Economic and Standard", MSL 1 | jlcpcb.com/partdetail C43922 |
| Stock / price | 305,720 pcs (LCSC); $0.0271@20, $0.0215@200, $0.0191@600, $0.0158@4,000 | LCSC page 2026-10-11 |
| Dimensions | L 1.60 ± 0.20, W 0.80 ± 0.20, **T 0.80 ± 0.20 mm** (code DB) → max 1.8 × 1.0 × 1.0 mm | FH catalogue + approval sheet A0006 p.8 |
| Temperature | X7R: ΔC ≤ ±15 % over −55…125 °C | A0006 p.3 |
| Reflow | J-STD-020 lead-free reflow compatible; MSL 1 | A0006, JLC |
| Manufacturer DC-bias curve | **Not published** in the FH general-series sheet A0006 (no bias table or curve; searched the extracted text) and not on the LCSC/JLC pages | — |

**Footprint / assembly fit.** The part is a standard 0603 body; the project footprint `C_0603_1608Metric` (pads 0.8 × 0.95 mm, 1.55 mm centres) accommodates the 1.8 mm maximum body length (termination overlap on each pad) and the part is
no wider than the 1.0 mm maximum of the standard 0603 family already used on every other 0603 line. Courtyard, paste and mask are unchanged (same footprint as the 7 other 0603 lines), no placement moves. The eight capacitors (C101/C102/… C401/C402) sit
25.6–42.7 mm from the XIAO, so the 1.0 mm maximum height has no relevance to the hand-solder iron-access rule (C18 ≤ 1.2 mm applies within 4 mm of the toes). Economic PCBA: top side, SMT, Extended → feeder fee $3.07 (one line replaces the C165991 line; no change in line count).

**Effective capacitance (no manufacturer curve → estimate with stated uncertainty).**

| Condition | Factor | C (µF) | HPF corner with 100 kΩ (Hz) |
|---|---|---|---|
| Nominal | 1.00 | 2.20 | 0.72 |
| Tolerance −10 % | 0.90 | 1.98 | 0.80 |
| DC bias at 1.5 V (VCM), typical thin-dielectric 0603 X7R, estimate | 0.75–0.90 | 1.65–1.98 | 0.80–0.96 |
| Worst case: −10 % tol × −15 % temp × −25 % bias | 0.57 | **1.26** | **1.26** |
| Best case: +10 % tol × +15 % temp | 1.27 | 2.78 | 0.57 |

The bias factor is an assumption: class-2 high-CV 0603 parts typically lose 10–25 % at 10 % of rated voltage; the true figure for this vendor is unknown and **±10 % uncertain** until measured with an LCR meter under 1.5 V DC bias.
Consequence: the high-pass corner stays 0.6–1.3 Hz against an EMG band of 20–500 Hz (attenuation at 20 Hz ≤ 0.2 %). Worst-case P/N mismatch (±20 % of fc ≈ 0.2 Hz) gives a 50 Hz common-mode-to-differential term of ≈ −48 dB (calculation),
comparable to the electrode-impedance-imbalance terms already in the RB-04 report (−45…−60 dB for 10–50 kΩ) and above the −86 dB bias-resistor term; this is a first-order calculation, not a measurement. The 16 V rating gives >10× voltage margin on the ≤ 1.5 V DC node
(vs 6.7× for the rejected 10 V part), so ageing and DC-bias are smaller than for the 10 V fallback.

**Decision: qualified; C43922 is used for all eight 2.2 µF capacitors** (C101, C102, C201, C202, C301, C302, C401, C402). The 10 V fallback (C165991) is withdrawn.

## 2. Ferrite bead FB1 (task 6)

| Candidate | Class | Spec check (≥ 200 mA, DCR ≤ 0.5 Ω, 600 Ω @ 100 MHz) | Availability |
|---|---|---|---|
| Sunlord GZ1608D601TF **C1002** | **Basic** (JLC page) | 200 mA, 450 mΩ → exactly at the limits (0 margin); −55…125 °C; MSL 1; Economic OK | JLC page shows no stock; LCSC page returns 404 → **stock unconfirmed** |
| Murata BLM18AG601SN1D **C19330** | **Extended** (JLC page) | 500 mA, 380 mΩ → 2.5× current margin; −55…125 °C; MSL 1; Economic OK | **400,250 pcs**, $0.0128@50+ |

Selected: **C19330** (qualified, stocked). Load is ≈ 11.4 mA, so both are electrically fine; the DC drop is 4.3 mV (C19330) vs 5.1 mV (C1002). Same 0603 footprint and pad, V06 (via near FB1.2) unaffected.
Cost of the choice: +$3.07 feeder fee vs Basic C1002; swap back is a one-line BOM edit if the JLC BOM tool shows C1002 in stock and you accept zero margin.

## 3. BOM qualification count (task 5/7)

| | RB-04A | **RB-04B** |
|---|---|---|
| Parts qualified | 118 / 126 | **126 / 126** |
| Lines qualified | 28 / 29 | **29 / 29** (+ TP pads and U1 not factory-placed) |
| Pending approval | 8 (2.2 µF) | **0** |
| Class shown on JLC page | 11 Extended, 2 Basic, 16 not stated | **12 Extended, 1 Basic (C14663), 16 not stated**, 0 Promotional |
| Two-unit parts + assembly | ≈ $64–$128 | **≈ $67–$132** (fabrication, shipping, taxes, XIAO OPEN) |

"Qualified" means: value / dielectric / voltage / tolerance / footprint match the schematic spec as printed on the vendor and JLC pages, part is listed Economic-and-Standard and in stock. It does **not** mean vendor DC-bias curves were seen (only estimates), nor that
datasheets of all passives, the oscillator and the JST connectors were read.

## 4. Remaining component issues

1. **Class not stated for 16 lines** (feeder-fee uncertainty $3.07 each; resolve in the JLC BOM tool or by the inquiry, Q9).
2. **DC-bias**: no manufacturer curve for any X5R/X7R line (including C43922); only estimates. Measure C101 type on a prototype at 1.5 V DC.
3. **C4007 22 µF** is a 25 V X5R ±20 % part (spec: 10 V X5R): same dielectric/footprint, safe, but not the spec voltage — approved as a higher-rating equivalent unless you object.
4. **JST PH connectors and SX3M oscillator**: reflow suitability at 255 ± 5 °C and datasheets unconfirmed (Q9b).
5. **C14663 100 nF** stock is only 4,000 pcs (14 needed); alternate C1591.
6. **10 k, 10 M, 4.7 Ω lines** use second-choice (stocked) parts because the Uniroyal Basic parts are out of stock; 10 k C25804 may restock.
7. **CPL rotations** for SOT-23, SOT-23-5, TSSOP, JST S-type remain CONDITIONAL (community offsets only).

## 5. Verification (task 7)

| Check | Result |
|---|---|
| PCB file | **identical** to RB-04A (sha256 prefix 111e1cd3d0c9fae1): no copper, via, footprint or netclass change |
| DRC (`--schematic-parity --severity-all`) | 0 errors, 1 accepted warning (`lib_footprint_mismatch` U1), 0 unconnected, 0 parity |
| ERC | 0 |
| Independent parity | 135/135, 357 pad nets (same two `{slash}` escaping notes) |
| Power continuity without TP | PASS (`conn.json`/`power.json` byte-identical to RB-04A) |
| Mask / geometry / electrical / iron-access audits | byte-identical to RB-04A; vias 201 (179/12/10/0), via-in-pad 0 |
| Guard + canary + 15 negative controls | PASS, 15/15 |
| Gerber ↔ source | 14/14 PASS; BOM export: 29 lines, quantity sum 126, all MPN/LCSC populated; refs C101–C402 → C43922, FB1 → C19330 |
| Project integrity | `rb04_lock.sh` hashes re-recorded and verified after the run; `.kicad_pro` untouched in this phase |
| Economic PCBA | 126 SMT top side, 0 bottom, 0 factory THT; every selected part lists "Economic and Standard"; **CONDITIONAL** (reflow of JST/oscillator/LDO, 2.5 mm edge note, class of 16 lines, unconfirmed by JLC) |

Evidence: `rev-b-xiao/evidence/rb04b_suite/`, `evidence/rb04a/bom_selection.json`, `cost_model.json`.

## 6. Unresolved manufacturer questions

Prepared as `REVB_RB04A_JLC_QUESTIONS.md` (revised in RB-04B, **not sent**): mask registration tolerance, tenting default and CAM behaviour for 10 class-3 + 12 class-2 vias (V01–V22), wicking / starved-joint risk, 0.15 mm ring,
C6009 via (V04), 0.25 mm drill price / yield, rotation conventions, 255 °C reflow of JST/oscillator/LDO, library classes of 16 lines, outline size. JLC ANSWER RECEIVED: NO.

```
BOM PARTS QUALIFIED:               126 / 126
UNRESOLVED PART SELECTIONS:        0
JLC INQUIRY:                       READY, NOT SENT
JLC ANSWER RECEIVED:               NO
ECONOMIC PCBA:                     CONDITIONAL
READY FOR JLC PRE-PRODUCTION DFM:  YES (on your explicit upload authorisation)
READY TO ORDER:                    NO
```
