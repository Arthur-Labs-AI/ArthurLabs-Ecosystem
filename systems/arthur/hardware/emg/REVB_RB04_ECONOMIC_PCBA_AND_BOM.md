# RB-04 — Economic PCBA and BOM Review

Date: 2026-10-11. Board 51.30 × 64.95 mm, 4 layers, 126 factory-placed SMT parts on F.Cu, XIAO hand-soldered. No order, no upload, no quote requested.
JLCPCB pages read 2026-10-11: https://jlcpcb.com/help/article/pcb-assembly-price ("last updated September 9, 2026"), part pages jlcpcb.com/partdetail/Cxxxx.
**Factory acceptance is not claimed**: no JLCPCB response or DFM review exists for this design.

> **RB-04A update.** Superseded by RB-04A (2026-10-11): board is now `B / RB-04A`; the TP2 dependence is repaired (R1 closed), the BOM candidates are selected (R5 reduced to the 2.2 µF approval), the JLC inquiry is prepared and **not sent**. Details: `REVB_RB04A_*.md`.
> BOM: 118 / 126 parts qualified, 8 (2.2 µF) pending approval; 10 nF C0G exists (TDK C76599, Extended). Cost: parts + assembly ≈ $64–$128 for two units, fabrication / shipping / taxes OPEN (`REVB_RB04A_COST_ANALYSIS.md`).
>
> **CPL orientation / pin-1 (CONDITIONAL — JLC viewer not consulted, D5 not approved).** Pin-1 coordinates below are computed from the PCB (KiCad frame, mm, y down; the CPL file negates y). The last column applies the *community* KiBot rotation corrections
> (+180 SOT-23, +270 TSSOP/SOIC, +180 S-type JST); these are a hypothesis, not JLC data. Each KiCad rotation is consistent with its footprint: pin 1 position matches `cpl_check.json` (e.g. D101 rot 180°: pin 1 east-south).
>
> | Ref | Footprint | x, y | KiCad rot | Pin-1 pad x, y | Community corr. | Expected JLC rot |
> |---|---|---|---|---|---|---|
> | D101 | SOT-23 | 37.40, 14.00 | 180° | 38.337, 14.950 | +180° | 0° |
> | D102 | SOT-23 | 32.70, 14.00 | 180° | 33.638, 14.950 | +180° | 0° |
> | D103 | SOT-23 | 9.10, 46.15 | 0° | 8.162, 45.200 | +180° | 180° |
> | D104 | SOT-23 | 5.20, 46.15 | 0° | 4.263, 45.200 | +180° | 180° |
> | D201 | SOT-23 | 28.00, 14.00 | 180° | 28.938, 14.950 | +180° | 0° |
> | D202 | SOT-23 | 23.30, 14.00 | 180° | 24.238, 14.950 | +180° | 0° |
> | D203 | SOT-23 | 5.20, 49.75 | 0° | 4.263, 48.800 | +180° | 180° |
> | D204 | SOT-23 | 9.10, 49.75 | 0° | 8.162, 48.800 | +180° | 180° |
> | D301 | SOT-23 | 18.60, 14.00 | 180° | 19.538, 14.950 | +180° | 0° |
> | D302 | SOT-23 | 13.90, 14.00 | 180° | 14.838, 14.950 | +180° | 0° |
> | D303 | SOT-23 | 9.10, 53.35 | 0° | 8.162, 52.400 | +180° | 180° |
> | D304 | SOT-23 | 5.20, 53.35 | 0° | 4.263, 52.400 | +180° | 180° |
> | D401 | SOT-23 | 9.20, 14.00 | 180° | 10.137, 14.950 | +180° | 0° |
> | D402 | SOT-23 | 4.50, 14.00 | 180° | 5.438, 14.950 | +180° | 0° |
> | D403 | SOT-23 | 5.20, 56.95 | 0° | 4.263, 56.000 | +180° | 180° |
> | D404 | SOT-23 | 9.10, 56.95 | 0° | 8.162, 56.000 | +180° | 180° |
> | FB1 | L_0603_1608Metric | 27.00, 56.95 | 0° | 26.212, 56.950 | +0° | 0° |
> | J1 | JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.0 | 44.40, 38.30 | 90° | 41.550, 39.300 | +180° | 270° |
> | J101 | JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.0 | 35.05, 3.75 | 180° | 36.050, 3.250 | +0° | 180° |
> | J201 | JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.0 | 25.65, 3.75 | 180° | 26.650, 3.250 | +0° | 180° |
> | J301 | JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.0 | 16.25, 3.75 | 180° | 17.250, 3.250 | +0° | 180° |
> | J401 | JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.0 | 6.85, 3.75 | 180° | 7.850, 3.250 | +0° | 180° |
> | J5001 | JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.0 | 44.45, 3.75 | 180° | 45.450, 3.250 | +0° | 180° |
> | Q3001 | SOT-23 | 28.80, 37.75 | 0° | 27.863, 36.800 | +180° | 180° |
> | U4002 | SOT-23-5 | 22.50, 37.55 | 0° | 21.363, 36.600 | +180° | 180° |
> | U501 | TSSOP-14_4.4x5mm_P0.65mm | 30.35, 22.60 | 180° | 33.212, 24.550 | +270° | 90° |
> | U502 | TSSOP-14_4.4x5mm_P0.65mm | 11.55, 22.60 | 180° | 14.413, 24.550 | +270° | 90° |
> | U503 | TSSOP-14_4.4x5mm_P0.65mm | 41.45, 22.60 | 180° | 44.312, 24.550 | +270° | 90° |
> | U6001 | TSSOP-20_4.4x6.5mm_P0.65mm | 18.30, 51.95 | 0° | 15.438, 49.025 | +270° | 270° |
> | X1 | OSC_SCTF_SX3M_SMD3225-4P | 24.20, 47.05 | 180° | 25.300, 46.175 | +0° | 180° |
>
> Note: the KiBot table lists no correction for SX3M 3225-4P, JST B-type and FB1 (non-polar).

> **RB-04B update.** BOM 126 / 126 qualified: 2.2 µF → FH C43922 (16 V X7R, verified), FB1 → Murata C19330. See `REVB_RB04B_FINAL_BOM_RESOLUTION.md`; the RB-04A 118/126 figures above are superseded.

## 1. Verdict

| Item | Result |
|---|---|
| Economic assembly compatibility | **CONDITIONAL** — nothing found that forces Standard; unresolved items listed in §6 |
| Assembly sides / placements | **PASS** — 126 SMT on F.Cu, 0 on B.Cu, 0 THT by JLC, XIAO absent from CPL/BOM |
| BOM and CPL | **CONDITIONAL** — CPL consistent with the PCB; **BOM incomplete: only 3 of 31 lines (7 of 126 parts: 5 × JST B2B, 1 × JST S2B, 1 × oscillator) carry an LCSC number in the project**; the 5 IC / diode / MOSFET lines have MPNs but no LCSC number (found today, §2); the 21 generic passive lines have neither |
| Cost for two prototypes | **OPEN** — JLC assembly fees documented ($32.74); part prices not retrieved for all lines |

## 2. Placement and assembly side

* 135 footprints: 126 `smd` placed by JLC (top), U1 `dnp,through_hole` (XIAO, hand-soldered, absent from `--exclude-dnp` CPL and from the BOM), 8 bare B.Cu test pads
  (`exclude_from_bom,exclude_from_pos_files`). The BAT+ post pad (PTH 1.40 mm / pad 1.90 mm) belongs to U1 and is not a factory THT job.
* Solder joints for the fee model: 340 (paste apertures), single side; 0 pads under a part on the bottom; paste only on F.Paste.
* Parts fully verified as "Economic and Standard" on their JLC part page (library class as stated by the page):

| Ref | MPN | LCSC | Package | JLC status |
|---|---|---|---|---|
| U6001 | ADS131M04IPWR | C2862562 | TSSOP-20 | Extended (page: "Extended"), Economic and Standard |
| U501–U503 | TLV9064IPWR | C779410 | TSSOP-14 | Extended, Economic and Standard |
| U4002 | TPS7A2030PDBVR | C963429 | SOT-23-5 | listed Economic and Standard (library class not shown) |
| D101–D404 (16) | BAV199,215 Nexperia | C40919 | SOT-23 | Extended, Economic and Standard, MSL 1 |
| X1 | SX3M8.192M20F30TNN | C2901557 | SMD3225-4P | Economic and Standard |
| J101…J5001 (5) | B2B-PH-SM4-TB(LF)(SN) | C160352 | SMD vertical | Economic and Standard |
| J1 | S2B-PH-SM4-TB(LF)(SN) | C295747 | SMD side entry | Economic and Standard |

* JLC "global sourcing": none of these items depends on it as far as the pages show; stock and price were not extracted for most (a stock-out would force a part change).

## 3. BOM lines (31) and part numbers

`bom_lines.json` is the grouped export of the frozen schematic fields (`MPN`, `Spec`, `LCSC`, `JLC_Class`). Candidate numbers below were
looked up on JLC part pages today; they are **candidates for the BOM freeze**, not selections, and the page extracts did not always state Basic/Extended.

| Qty | Refs | Spec (schematic) | Footprint | MPN field | LCSC / candidate |
|---|---|---|---|---|---|
| 8 | C101, C102, C201, C202… | 2.2uF 16V X7R 0603 MLCC | C_0603 | GENERIC (spec-defined; JLC | candidate C23630 — CL10A225KO8NNNC Samsung 2.2µF 16V **X5R**; not stated; **dielectric differs from the spec (X7R)** |
| 8 | C103, C104, C203, C204… | 100pF 50V C0G 0603 MLCC | C_0603 | GENERIC (spec-defined; JLC | candidate C14858 — CL10C101JB8NNNC Samsung 100pF 50V C0G ±5 %; listed Economic+Standard; OK |
| 4 | C105, C205, C305, C405 | 10nF 50V C0G 0603 MLCC | C_0603 | GENERIC (spec-defined; JLC | candidate (not found) — only X7R 10 nF (C1589, CL10B103KB8NNNC) appeared; no C0G 10 nF on JLC found; unknown, likely Extended or absent; **decision needed (D4)** |
| 8 | C106, C107, C206, C207… | 1.0nF 50V C0G 0603 MLCC | C_0603 | GENERIC (spec-defined; JLC | candidate (not retrieved) — CL10C102JB8NNNC exists; the JLC number was not found (C1588 / C51203 are X7R); unknown; open |
| 1 | C4007 | 22uF 10V X5R 0805 MLCC | C_0805 | GENERIC (spec-defined; JLC | no LCSC number; none looked up |
| 5 | C5001, C6007, C6008, C4005… | 1uF 16V X7R 0603 MLCC | C_0603 | GENERIC (spec-defined; JLC | candidate C15849 — CL10A105KB8NNNC Samsung 1µF 50V **X5R**; not stated on the page; **dielectric differs from the spec (X7R)** |
| 7 | C501, C502, C503, C5002… | 100nF 16V X7R 0603 MLCC | C_0603 | GENERIC (spec-defined; JLC | candidate C14663 — CC0603KRX7R9BB104 Yageo 100nF 50V X7R ±10 %; Basic (page says Basic); value/dielectric OK (50 V ≥ 16 V) |
| 1 | C6009 | 220nF 16V X7R 0603 MLCC | C_0603 | GENERIC (spec-defined; JLC | candidate (not retrieved) — CL10B224KO8NNNC (16 V X7R) exists at distributors; JLC number not found (C21120 = CL10B224KA8NNNC, 25 V?); unknown; open |
| 1 | C7101 | 10uF 10V X5R 0603 MLCC | C_0603 | GENERIC (spec-defined; JLC | no LCSC number; none looked up |
| 16 | D101, D102, D103, D104… | Dual series low-leakage diode, IR <= 5 nA @ 75 V, SOT-23 | SOT-23 | BAV199 | no LCSC number; none looked up |
| 1 | FB1 | Ferrite bead 600 ohm @ 100 MHz, 0603, >= 200 mA, DCR <= 0.5 oh | L_0603 | GENERIC (spec-defined; JLC | no LCSC number; none looked up |
| 1 | J1 | JST PH 2.0 mm 2-pin side-entry SMD, 2 A / 100 V AC/DC (AWG24), | JST_PH_S2B-PH-SM4-TB_1x02-1MP_ | S2B-PH-SM4-TB(LF)(SN) | C295747 (in BOM) |
| 5 | J101, J201, J301, J401… | JST PH 2.0 mm 2-pin vertical SMD, 2 retention pads | JST_PH_B2B-PH-SM4-TB_1x02-1MP_ | B2B-PH-SM4-TB(LF)(SN) | C160352 (in BOM) |
| 1 | Q3001 | 60 V N-MOSFET SOT-23, VGS(th) >= 0.8 V | SOT-23 | 2N7002 | candidate C8545 — 2N7002 Changjiang SOT-23 60 V 115 mA, VGS(th) ≤ 2.5 V; EasyEDA library part; OK (maker is open in the BOM) |
| 12 | R101, R102, R201, R202… | 10k ±1% 0603 thick film, >=1/10 W | R_0603 | GENERIC (spec-defined; JLC | candidate C25804 — 0603WAF1002T5E Uniroyal 10k ±1 % 100 mW; Basic (page says Basic); OK |
| 14 | R103, R104, R203, R204… | 100k ±1% 0603 thick film, >=1/10 W | R_0603 | GENERIC (spec-defined; JLC | candidate C25803 — 0603WAF1003T5E Uniroyal 100k ±1 %; not stated (Uniroyal 0603 series); OK |
| 8 | R105, R106, R205, R206… | 10M ±5% 0603 thick film, >=1/10 W | R_0603 | GENERIC (spec-defined; JLC | no LCSC number; none looked up |
| 8 | R107, R108, R207, R208… | 1.0k ±1% 0603 thick film, >=1/10 W | R_0603 | GENERIC (spec-defined; JLC | candidate C21190 — 0603WAF1001T5E Uniroyal 1k ±1 %; Economic+Standard; OK |
| 1 | R3009 | 4.7k ±1% 0603 thick film, >=1/10 W | R_0603 | GENERIC (spec-defined; JLC | no LCSC number; none looked up |
| 1 | R4001 | 4.7 ±1% 0603 thick film, >=1/10 W | R_0603 | GENERIC (spec-defined; JLC | no LCSC number; none looked up |
| 1 | R5002 | 100k ±1% 0805 thick film, >=1/10 W, 0805 for creepage | R_0805 | GENERIC (spec-defined; JLC | no LCSC number; none looked up |
| 4 | R6001, R6002, R7101, R7102 | 33 ±1% 0603 thick film, >=1/10 W | R_0603 | GENERIC (spec-defined; JLC | no LCSC number; none looked up |
| 1 | R6003 | 100 ±1% 0603 thick film, >=1/10 W | R_0603 | GENERIC (spec-defined; JLC | candidate C22775 — 0603WAF1000T5E Uniroyal 100 Ω ±1 %; not stated; OK |
| 1 | R7106 | 150k ±1% 0603 thick film, >=1/10 W | R_0603 | GENERIC (spec-defined; JLC | no LCSC number; none looked up |
| 2 | R7107, R7108 | 1M ±1% 0603 thick film, >=1/10 W | R_0603 | GENERIC (spec-defined; JLC | no LCSC number; none looked up |
| 8 | TP4, TP5, TP7, TP1… | Bare B.Cu pad, no via-in-pad, not assembled (size provisional, | TestPoint_Pad_D1.5mm | N/A (bare copper pad) | no LCSC number; none looked up |
| 1 | U1 | ESP32-S3 module, 21.0 x 17.8 mm, castellated. Headers NOT fitt | XIAO_ESP32S3_HANDSOLDER | Seeed PN 202003751 (XIAO E | no LCSC number; none looked up |
| 1 | U4002 | 3.0 V 300 mA LDO, active discharge, SOT-23-5 | SOT-23-5 | TPS7A2030PDBVR | no LCSC number; none looked up |
| 3 | U501, U502, U503 | Quad RRIO op-amp TSSOP-14 | TSSOP-14_4.4x5mm_P0.65mm | TLV9064IPWR | no LCSC number; none looked up |
| 1 | U6001 | 4-ch 24-bit simultaneous delta-sigma ADC, TSSOP-20 | TSSOP-20_4.4x6.5mm_P0.65mm | ADS131M04IPWR | no LCSC number; none looked up |
| 1 | X1 | 8.192 MHz CMOS XO, 1.62-3.63 V, +/-20 ppm @25C, +/-30 ppm -40. | OSC_SCTF_SX3M_SMD3225-4P | SX3M8.192M20F30TNN | C2901557 (in BOM) |

Findings:
* **Dielectric mismatches:** the spec says X7R for 1 µF and 2.2 µF but the common JLC Basic parts are X5R (C15849 50 V, C23630 16 V). C6009 220 nF is X7R by spec; its candidate was not retrieved.
  For the 2.2 µF AC-coupling capacitors (1.5 V DC) an X5R part changes capacitance by less than 20 % at 16 V rating; the 0.72 Hz corner moves with it. Decision D4.
* **10 nF C0G (4 pcs, differential AAF):** no C0G part found on JLC (only X7R 10 nF). Either accept X7R, use 2 × 4.7 nF C0G, or buy the part as an Extended / global-sourced line.
* **R5002 100 kΩ 0805** is a different footprint from the 0603 100 kΩ line and needs its own part; **R7108/R7107 1 MΩ, R7106 150 kΩ, R6001 etc. 33 Ω, R4001 4.7 Ω, 10 MΩ ±5 %**: numbers not looked up.
* **MPN field** says "GENERIC (spec-defined; JLC Basic part selected at RB-03)" for 128 parts: the selection at "RB-03" never happened. This is the BOM-freeze task.

## 4. Basic vs Extended, cost for two units

Fee schedule (JLC page, Economic): setup $8.18 per order; stencil $1.53; SMT assembly $0.0016 per joint; feeder loading $3.07 **per unique Extended part**; "confirm parts placement" $0.45;
panel fee $8.21 only if the order contains more than one design; hand-soldering labour $3.58 per order and manual-assembly per-joint fees not applicable (no THT job, XIAO not factory soldered).

| Item | Basis | Amount |
|---|---|---|
| Setup | 1 order | $8.18 |
| Stencil | 1 | $1.53 |
| SMT joints | 340 × 2 boards × $0.0016 | $1.09 |
| Extended lines | 7 verified (ADS131M04, TLV9064, TPS7A2030, BAV199, SX3M oscillator, JST B2B, JST S2B) × $3.07 | $21.49 |
| Confirm placement | listed; whether charged by default is unknown | $0.45 |
| **Documented assembly fees** | | **$32.74** |
| Possible additions | each further Extended line +$3.07 (10 nF C0G, X7R/C0G caps, 2N7002 if Extended …) | +$3.07 each |

Parts: documented unit prices found today — ADS131M04IPWR $6.5014 (LCSC), TPS7A2030PDBVR $0.1341, SX3M oscillator $0.3482 (RB-01R, 2026-10-10). Not retrieved: TLV9064 (6 pcs for two units),
BAV199 (32), JST connectors (12), all passives. Two units need 2 × (1 ADS + 3 TLV + 1 LDO + 16 BAV199 + 1 X1 + 6 JST) plus passives; passive minimum purchase quantities are typically in the tens.
**Cost estimate: OPEN** — fees documented, parts unknown; PCB fabrication, shipping, tax and the XIAO module ($, retail) are outside this table.

## 5. CPL / rotation consistency

`rb04_cpl.py` (126 rows): all top side; positions equal footprint origins to 0.01 mm; Y negative in the file (KiCad convention, matches the Gerber frame). Rotations present in the KiCad position file: 0 ×44, 90 ×8, 180 ×17, −90 ×57 (= 270).
Polarised / oriented parts (KiCad rotation, pin-1 side) are in `cpl_check.json`: BAV199 ×16 SOT-23 at 0°/180° (pin 1 W/N or E/S), Q3001 0°, U4002 SOT-23-5 0°, U501–503 TSSOP-14 180°, U6001 TSSOP-20 0°,
X1 180°, J101…J5001 180°, J1 90°, FB1 0° (non-polar). BAV199 pinout checked against the schematic: pin 1 = GND (anode), pin 2 = AFE_3V0 (cathode), pin 3 = signal; consistent with the Nexperia SOT-23 pinout.
**JLC may expect different rotation offsets for SOT-23, SOT-23-5, TSSOP and the JST parts.** That cannot be validated locally; the JLC 2D viewer after upload is the only check (open item D5).

## 6. Conditions that could force Standard PCBA or a rejection

| Trigger (RB-02E list) | Status now |
|---|---|
| Two-sided placement | none |
| Layers other than 2/4/6 | 4 |
| Thickness > 1.6 mm | 1.606 mm computed for the stack-up (1.6 mm nominal ordered) — confirm on the order form |
| Castellated holes / edge plating on the PCB | none (XIAO's castellations are on the module, host pads are plain) |
| Package < 0402 / pitch < 0.4 mm | 0603 minimum, 0.65 mm pitch |
| Quantity 2–50 | 2 |
| A part listed Standard-only | the 7 Extended lines are all "Economic and Standard"; the 21 generic lines are not selected |
| 2.5 mm body-to-edge note (RB-02E U1) | unresolved: 126 parts pass the 0.3 mm FAQ figure (min pad-to-edge 0.5 mm); the 2.5 mm T&C DFM note applicability to Economic is unknown |
| Reflow profile 255 ± 5 °C (fixed for Economic) | not checked for the JST PH SM4 connectors, the SX3M oscillator or the LDO (vendor reflow ratings not retrieved): **open U7** |
| Outline / depanelling | single PCB; JLC adds rails/tooling by default; tab positions near the south edge (the XIAO USB-C overhangs 1.5 mm there once hand-fitted) unknown |
| Finish | file says HASL (with lead); lead-free or ENIG are other options; the JLC option available with Economic for 4 layers was not verified |

## 7. Connector orientation

J101/J201/J301/J401/J5001 are top-entry vertical JST PH B2B (rotation 180°, pin 1 NE); J1 is a side-entry S2B-PH (90°, opening toward the board interior side per C30: plug corridor 7 × 9 mm clear).
PH is not a polarity standard (BOM note): cell lead polarity must be verified before first connection. J5001 pin 1 is NC by design (reference electrode on pin 2).

## 8. Reproduction

```
bash hardware/emg/rev-b-xiao/tools/rb04_run_all.sh <scratch>          # regenerates CPL/BOM exports in the scratch dir and checks them
python3 hardware/emg/rev-b-xiao/tools/rb04_cpl.py --pcb <board> --pos pos.csv --out cpl_check.json
```
