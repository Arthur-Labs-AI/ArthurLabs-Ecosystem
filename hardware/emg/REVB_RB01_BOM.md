# A.R.T.H.U.R EMG Rev B — RB-01 BOM

Source: `kicad-cli sch export bom` on `hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_sch`, grouped by Value + Footprint + MPN + DNP (10.0.6).
**Prices are not re-quoted in RB-01**; see REVB_COST_MODEL.md. No component was substituted to reduce cost.

## Summary

| Metric | Count |
|---|---|
| Components in the netlist | 135 |
| **Populated (JLC-assembled) components** | **126** (R 53, C 43, D 16, J 6, U 5, X 1, Q 1, FB 1) |
| **DNP** | **1** (U1 XIAO ESP32S3: bought retail, hand-soldered per REVB_XIAO_ASSEMBLY_PROCEDURE.md) |
| Bare test pads (not in BOM, not in CPL) | 8 (TP1–TP8) |
| BOM lines | 30 (29 populated + 1 DNP) |
| **Unique exact MPNs (populated)** | **8**: ADS131M04IPWR, TLV9064IPWR, TPS7A2030PDBVR, OT2JI-111-8.192M, BAV199, B2B-PH-SM4-TB(LF)(SN), S2B-PH-SM4-TB(LF)(SN) *(provisional)*, 2N7002 *(generic MPN, any maker)*. Plus Seeed 202003751 (DNP) |
| Generic spec-defined lines | 21 (20 R/C value groups + FB1) |
| **Expected JLC Basic lines** | **21** firm (20 generic R/C/FB + 2N7002); **22** if 10 nF C0G 0603 is Basic |
| **Expected JLC Extended lines** | **7** firm (ADS131M04, TLV9064, TPS7A2030P, X1 C7425393, BAV199 ×16, JST B2B vertical ×5, JST S2B side-entry ×1); **8** if 10 nF C0G is Extended |
| Components with unresolved exact MPN | 21 generic lines (97 parts: 53 R + 43 C + FB1) + J1 provisional + Q3001 maker open + BAV199 packing suffix |

JLC classes are **expected**, taken from REVB_MANUFACTURING_CONSTRAINTS.md §2 and REVB_COST_MODEL.md §1; they are confirmed only when the RB-03 BOM is uploaded.

## BOM lines

| # | References | Qty | Value | Spec | Footprint | MPN | Manufacturer | LCSC | JLC class (expected) | DNP |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | C101, C102, C201, C202, C301, C302, C401, C402 | 8 | 2.2uF | 2.2uF 16V X7R 0603 MLCC | `Capacitor_SMD:C_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 2 | C103, C104, C203, C204, C303, C304, C403, C404 | 8 | 100pF | 100pF 50V C0G 0603 MLCC | `Capacitor_SMD:C_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 3 | C105, C205, C305, C405 | 4 | 10nF | 10nF 50V C0G 0603 MLCC | `Capacitor_SMD:C_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic or Extended (10 nF C0G - confirm) |  |
| 4 | C106, C107, C206, C207, C306, C307, C406, C407 | 8 | 1.0nF | 1.0nF 50V C0G 0603 MLCC | `Capacitor_SMD:C_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 5 | C501, C502, C503, C5002, C6010, C7102, C7103 | 7 | 100nF | 100nF 16V X7R 0603 MLCC | `Capacitor_SMD:C_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 6 | C4005, C4006, C5001, C6007, C6008 | 5 | 1uF | 1uF 16V X7R 0603 MLCC | `Capacitor_SMD:C_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 7 | C4007 | 1 | 22uF | 22uF 10V X5R 0805 MLCC | `Capacitor_SMD:C_0805_2012Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 8 | C6009 | 1 | 220nF | 220nF 16V X7R 0603 MLCC | `Capacitor_SMD:C_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 9 | C7101 | 1 | 10uF | 10uF 10V X5R 0603 MLCC | `Capacitor_SMD:C_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 10 | D101, D102, D103, D104, D201, D202, D203, D204, D301, D302, D303, D304, D401, D402, D403, D404 | 16 | BAV199 | Dual series low-leakage diode, IR <= 5 nA @ 75 V, SOT-23 | `Package_TO_SOT_SMD:SOT-23` | BAV199 | Nexperia | — | Extended (expected), 1 line for all 16 |  |
| 11 | FB1 | 1 | 600R@100MHz | Ferrite bead 600 ohm @ 100 MHz, 0603, >= 200 mA, DCR <= 0.5 ohm | `Inductor_SMD:L_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 12 | J1 | 1 | S2B-PH-SM4-TB | JST PH 2.0 mm 2-pin side-entry SMD. Pin 1 = BAT+, pin 2 = BAT- (verify cell lead polarity) | `Connector_JST:JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal` | S2B-PH-SM4-TB(LF)(SN) (provisional - 'e.g.' in RB-00.6 mounting spec; final at RB-02) | JST | — | Extended (expected) |  |
| 13 | J101, J201, J301, J401, J5001 | 5 | B2B-PH-SM4-TB | JST PH 2.0 mm 2-pin vertical SMD, 2 retention pads | `Connector_JST:JST_PH_B2B-PH-SM4-TB_1x02-1MP_P2.00mm_Vertical` | B2B-PH-SM4-TB(LF)(SN) | JST | — | Extended (expected) |  |
| 14 | Q3001 | 1 | 2N7002 | 60 V N-MOSFET SOT-23, VGS(th) >= 0.8 V | `Package_TO_SOT_SMD:SOT-23` | 2N7002 | Any (JLC Basic, e.g. Nexperia/CJ) | — | Basic (expected) |  |
| 15 | R101, R102, R201, R202, R301, R302, R401, R402, R3006, R3007, R5005, R7104 | 12 | 10k | 10k ±1% 0603 thick film, >=1/10 W | `Resistor_SMD:R_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 16 | R103, R104, R203, R204, R303, R304, R403, R404, R3004, R3008, R5003, R5004, R7103, R7105 | 14 | 100k | 100k ±1% 0603 thick film, >=1/10 W | `Resistor_SMD:R_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 17 | R105, R106, R205, R206, R305, R306, R405, R406 | 8 | 10M | 10M ±5% 0603 thick film, >=1/10 W | `Resistor_SMD:R_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 18 | R107, R108, R207, R208, R307, R308, R407, R408 | 8 | 1.0k | 1.0k ±1% 0603 thick film, >=1/10 W | `Resistor_SMD:R_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 19 | R3009 | 1 | 4.7k | 4.7k ±1% 0603 thick film, >=1/10 W | `Resistor_SMD:R_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 20 | R4001 | 1 | 4.7 | 4.7 ±1% 0603 thick film, >=1/10 W | `Resistor_SMD:R_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 21 | R5002 | 1 | 100k | 100k ±1% 0805 thick film, >=1/10 W, 0805 for creepage | `Resistor_SMD:R_0805_2012Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 22 | R6001, R6002, R7101, R7102 | 4 | 33 | 33 ±1% 0603 thick film, >=1/10 W | `Resistor_SMD:R_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 23 | R6003 | 1 | 100 | 100 ±1% 0603 thick film, >=1/10 W | `Resistor_SMD:R_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 24 | R7106 | 1 | 150k | 150k ±1% 0603 thick film, >=1/10 W | `Resistor_SMD:R_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 25 | R7107, R7108 | 2 | 1M | 1M ±1% 0603 thick film, >=1/10 W | `Resistor_SMD:R_0603_1608Metric` | GENERIC (spec-defined; JLC Basic part selected at RB-03) | Any (JLC Basic) | — | Basic (expected) |  |
| 26 | U1 | 1 | XIAO_ESP32S3 | ESP32-S3 module, 21.0 x 17.8 mm, castellated. Headers NOT fitted | `ARTHUR:XIAO_ESP32S3_HANDSOLDER` | Seeed PN 202003751 (XIAO ESP32S3 plain, v1.4, unsoldered-header version) | Seeed Studio | — | N/A - DNP at JLC (bought retail, hand-soldered) | DNP |
| 27 | U501, U502, U503 | 3 | TLV9064IPWR | Quad RRIO op-amp TSSOP-14 | `Package_SO:TSSOP-14_4.4x5mm_P0.65mm` | TLV9064IPWR | Texas Instruments | — | Extended (expected) |  |
| 28 | U4002 | 1 | TPS7A2030PDBVR | 3.0 V 300 mA LDO, active discharge, SOT-23-5 | `Package_TO_SOT_SMD:SOT-23-5` | TPS7A2030PDBVR | Texas Instruments | — | Extended (expected) |  |
| 29 | U6001 | 1 | ADS131M04IPWR | 4-ch 24-bit simultaneous delta-sigma ADC, TSSOP-20 | `Package_SO:TSSOP-20_4.4x6.5mm_P0.65mm` | ADS131M04IPWR | Texas Instruments | — | Extended (expected) |  |
| 30 | X1 | 1 | OT2JI-111-8.192M | 8.192 MHz CMOS XO, 1.8-3.3 V, +/-20 ppm, 45-55 % duty, <= 5 mA, SMD3225-4P | `ARTHUR:OSC_YXC_SMD3225-4P` | OT2JI-111-8.192M | YXC | C7425393 | Extended (expected), Economic PCBA eligible |  |

Not on the BOM (by design):
- **TP1–TP8**: bare copper pads (`in_bom no`, `in_pos_files no`).
- **BAT+ post**: 6 mm AWG 24 solid tinned copper, a hand-assembly consumable (REVB_XIAO_ASSEMBLY_PROCEDURE.md), not a schematic part. The plated Ø1.40 hole is part of the U1 footprint (pad 23).
- LiPo cell with PCM, electrode leads, enclosure.

## Comparison with REVB_COST_MODEL.md §1

| Group | Cost model | RB-01 | Δ | Reason |
|---|---|---|---|---|
| ADS131M04 | 1 | 1 | 0 | |
| TLV9064 | 3 | 3 | 0 | |
| TPS7A2030P | 1 | 1 | 0 | |
| X1 | 1 | 1 | 0 | |
| BAV199 | 16 | 16 | 0 | 8 input + 8 ADC-input |
| JST-PH 2p | 6 | 6 | 0 | 5 electrode + J1 |
| 2N7002 | 1 | 1 | 0 | |
| Ferrite | 1 | 1 | 0 | |
| Resistors | ≈ 53 | 53 | 0 | 32 channel + 3 VCM/RLD + 18 interlock/sense/SPI/clock/LDO (incl. R3004) |
| C0G (100 pF ×8, 1 nF ×8, 10 nF ×4) | 20 | 20 | 0 | |
| X5R/X7R | 21 | 23 | **+2** | C6009 220 nF (ADC CAP; KEEP in the migration matrix) and C7103 100 nF (C_VB; migration matrix §6) are missing from the cost-model list |
| **Total populated** | ≈ 123 (items sum to 124) | **126** | +2 vs the item sum | as above; cost impact ≈ +$0.01 |
| Extended lines | "≈ 7–8" | 7 (+1 conditional) | 0 | |

## Comparison with REVB_MIGRATION_MATRIX.md

| Item | Matrix | RB-01 | Note |
|---|---|---|---|
| Carried Rev A parts (KEEP / MODIFY / REPLACE, excl. TPs) | 95 | 95 | 72 channel + U501/U502 + 10 VCM/RLD + 4 ADC + 5 power + R3003 → R3008 + J2001 → J1 |
| New populated parts | ≈ 33 incl. R_EN_PD and J1 | 33 (31 + R3008 + J1) | exact match with the §6 row list |
| Populated SMT placements | ≈ 128 (est.) | 126 | |
| KEEP TPs → bare pads | TP601, TP602, TP402 (+ TP603 → DVDD_F, TP201 → VBAT) | TP1–TP8 renumbered per Interface Spec §6 | 8 pads, no stubs |
| REMOVE | U7001, C7001/2, U2001, C2001–3, R2001/2, U4001, L4001, C4001–4, J3001, U3001, R3001/2, J8001, Q3002, R3005, 16 TPs | all absent | audit D1 |
| DNP options R_OPT0, U_ID, R_SDA, R_SCL | listed | **not instantiated** | reviewer decision (schematic report §7.1) |

## Unresolved exact MPNs (for RB-03)

| Line | What is fixed | What is open |
|---|---|---|
| 20 R/C value groups | value, tolerance, voltage, dielectric, package | JLC Basic part number (select at RB-03; 10 M 0603 and 10 nF C0G 0603 Basic status to confirm) |
| FB1 | 600 Ω @ 100 MHz, 0603, ≥ 200 mA | part number |
| J1 | JST PH 2p SMD side entry | S2B-PH-SM4-TB is provisional; final pads/part at RB-02 |
| Q3001 | 2N7002 SOT-23 | manufacturer |
| D101–D404 | Nexperia BAV199 | orderable packing suffix on the JLC line |
