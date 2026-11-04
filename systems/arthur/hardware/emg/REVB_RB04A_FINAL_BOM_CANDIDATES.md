# RB-04A / RB-04B — Final BOM Candidates (RB-04B update: 126 / 126) (126 factory-placed parts, 31 lines)

Date: 2026-10-11. Branch `hardware/emg-rev-b`. Nothing purchased, uploaded, ordered, committed or pushed. **These are candidates for owner approval, not an order.**
Source of every figure: LCSC / JLCPCB part pages read 2026-10-11 (WebFetch extracts) and the datasheets named in §4. Prices are **LCSC retail tiers, not a JLCPCB quotation**.
Machine-readable: `rev-b-xiao/tools/rb04a_selection.py`, `evidence/rb04a/bom_selection.json`. The selected MPN / LCSC / class / status are also written into the
schematic symbol fields (`MPN`, `Manufacturer`, `LCSC`, `JLC_Class`, `BOM_Status`, `Datasheet`); values, footprints and nets are untouched (parity 135/135, ERC 0).

## 1. Result

| Item | Result |
|---|---|
| BOM lines | 31 (29 JLC-placed, TP1–TP8 bare pads, U1 XIAO hand-soldered) |
| Parts qualified | **126 / 126** (RB-04B; was 118 in RB-04A) |
| Pending owner approval | none (RB-04B: exact-spec FH 0603B225K160NT C43922 replaces the 10 V downgrade) |
| Unresolved selections | none; conditions listed in §5 |
| Library class explicitly shown on the page | Extended: 12 lines · Basic: 1 line (C14663) · **not stated: 16 lines** (must be read in JLC's BOM tool) |
| Promotional / Preferred Extended | none seen on any page read (0 confirmed) |
| Dielectric substitutions | none (X7R stays X7R, C0G stays C0G; X5R only where the spec says X5R) |

## 2. Candidate table

DC-bias figures are **typical estimates for the stated rating and package, not the vendor curve** (vendor curves were not retrievable). Class is quoted as the page shows it
(`not stated on page` = the extract showed Economic/Standard assembly eligibility but no Basic/Extended label).

| # | Qty | Refs | Spec in schematic | Manufacturer / MPN | LCSC | Package | Rating / tolerance / temp | DC-bias effective C (estimate) | JLC class | LCSC stock | Unit price (need qty) | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 8 | C101, C102, C201, C202, C301 … (8) | 2.2uF 16V X7R 0603 MLCC | FH (Guangdong Fenghua) 0603B225K160NT | C43922 | C_0603 | 16 V X7R +-10 %, 1.6 x 0.8 x 0.8(+-0.2) mm, -55..125 C | typ. -10..-25 % at 1.5 V DC (estimate; NO manufacturer curve available -> uncertainty +-10 %) | Extended Parts | 305720 | $0.0271@20+ | QUALIFIED |
| 2 | 8 | C103, C104, C203, C204, C303 … (8) | 100pF 50V C0G 0603 MLCC | Samsung Electro-Mechanics CL10C101JB8NNNC | C14858 | C_0603 | 50 V C0G +-5 % | 0 % (C0G) | not stated on page | 290550 | $0.0087@50+ | QUALIFIED |
| 3 | 4 | C105, C205, C305, C405 | 10nF 50V C0G 0603 MLCC | TDK C1608C0G1H103JT000N | C76599 | C_0603 | 50 V C0G +-5 % | 0 % (C0G) | Extended Parts | 11740 | $0.0460@20+ | QUALIFIED |
| 4 | 8 | C106, C107, C206, C207, C306 … (8) | 1.0nF 50V C0G 0603 MLCC | FH (Guangdong Fenghua) 0603CG102J500NT | C1636 | C_0603 | 50 V C0G +-5 % | 0 % (C0G) | Extended Parts | 70500 | $0.0083@100+ | QUALIFIED |
| 5 | 1 | C4007 | 22uF 10V X5R 0805 MLCC | Samsung Electro-Mechanics CL21A226MAQNNNE | C45783 | C_0805 | 25 V X5R +-20 % (spec 10 V X5R: higher rating, same footprint) | typ. -20..-40 % at 3.0 V on a 25 V X5R 0805 (estimate; spec role assumes ~10 uF effective) | not stated on page | 138860 | $0.2227@20+ | QUALIFIED |
| 6 | 5 | C5001, C6007, C6008, C4005, C4006 | 1uF 16V X7R 0603 MLCC | Samsung Electro-Mechanics CL10B105KO8NNNC | C59782 | C_0603 | 16 V X7R +-10 % | typ. -10..-20 % at 3.0 V (estimate) | Extended Parts | 123400 | $0.0212@50+ | QUALIFIED |
| 7 | 7 | C501, C502, C503, C5002, C6010 … (7) | 100nF 16V X7R 0603 MLCC | YAGEO CC0603KRX7R9BB104 | C14663 | C_0603 | 50 V X7R +-10 % | typ. -0..-10 % at 3.0 V (estimate) | Basic (page) | 4000 | $0.0141@50+ | QUALIFIED |
| 8 | 1 | C6009 | 220nF 16V X7R 0603 MLCC | Samsung Electro-Mechanics CL10B224KO8NNNC | C160828 | C_0603 | 16 V X7R +-10 % | typ. -5..-12 % at 1.8 V (estimate) | not stated on page | 28600 | $0.0154@50+ | QUALIFIED |
| 9 | 1 | C7101 | 10uF 10V X5R 0603 MLCC | Samsung Electro-Mechanics CL10A106KP8NNNC | C19702 | C_0603 | 10 V X5R +-10 % | typ. -30..-50 % at 3.0 V on a 10 V X5R 0603 (estimate; effective 5-7 uF) | not stated on page | 885520 | $0.0308@20+ | QUALIFIED |
| 10 | 16 | D101, D102, D103, D104, D201 … (16) | Dual series low-leakage diode, IR <= 5 nA @ 75 V, SOT-23 | Nexperia BAV199,215 | C40919 | SOT-23 | 85 V, IR 5 nA max @ 75 V (80 nA @ 150 C), Cd 2 pF | n/a | Extended Parts | 17520 | $0.0429@10+ | QUALIFIED |
| 11 | 1 | FB1 | Ferrite bead 600 ohm @ 100 MHz, 0603, >= 200 mA, DCR <= 0.5  | Murata BLM18AG601SN1D | C19330 | L_0603 | 600 ohm@100 MHz +-25 %, 500 mA, DCR 380 mohm, -55..125 C | n/a | Extended | 400250 | $0.0128@50+ | QUALIFIED |
| 12 | 1 | J1 | JST PH 2.0 mm 2-pin side-entry SMD, 2 A / 100 V AC/DC (AWG24 | JST S2B-PH-SM4-TB(LF)(SN) | C295747 | JST_PH_S2B-PH-SM4-TB_1x02- | 100 V / 2 A, -25..85 C | n/a | Extended (per project field, page lists Economic+Standard) | 15180 | $0.2387@5+ | QUALIFIED |
| 13 | 5 | J101, J201, J301, J401, J5001 | JST PH 2.0 mm 2-pin vertical SMD, 2 retention pads | JST B2B-PH-SM4-TB(LF)(SN) | C160352 | JST_PH_B2B-PH-SM4-TB_1x02- | 100 V / 2 A, -25..85 C | n/a | Extended (per project field, page lists Economic+Standard) | 11170 | $0.2165@5+ | QUALIFIED |
| 14 | 1 | Q3001 | 60 V N-MOSFET SOT-23, VGS(th) >= 0.8 V | JSCJ (Jiangsu Changjing) 2N7002 | C8545 | SOT-23 | 60 V / 115 mA, VGS(th) <= 2.5 V | n/a | not stated on page | 665100 | $0.0179@50+ | QUALIFIED |
| 15 | 12 | R101, R102, R201, R202, R301 … (12) | 10k ±1% 0603 thick film, >=1/10 W | YAGEO RC0603FR-0710KL | C98220 | R_0603 | +-1 %, 100 mW, 75 V, +-100 ppm/C | n/a | Extended Parts | 5076700 | $0.0034@100+ | QUALIFIED |
| 16 | 14 | R103, R104, R203, R204, R303 … (14) | 100k ±1% 0603 thick film, >=1/10 W | UNI-ROYAL 0603WAF1003T5E | C25803 | R_0603 | +-1 %, 100 mW, 75 V | n/a | not stated on page | 11913200 | $0.0031@100+ | QUALIFIED |
| 17 | 8 | R105, R106, R205, R206, R305 … (8) | 10M ±5% 0603 thick film, >=1/10 W | YAGEO RC0603FR-0710ML | C114606 | R_0603 | +-1 %, 100 mW, 75 V (spec +-5 %: tighter) | n/a | not stated on page | 823600 | $0.0050@100+ | QUALIFIED |
| 18 | 8 | R107, R108, R207, R208, R307 … (8) | 1.0k ±1% 0603 thick film, >=1/10 W | UNI-ROYAL 0603WAF1001T5E | C21190 | R_0603 | +-1 %, 100 mW, 75 V | n/a | not stated on page | 1645900 | $0.0026@100+ | QUALIFIED |
| 19 | 1 | R3009 | 4.7k ±1% 0603 thick film, >=1/10 W | UNI-ROYAL 0603WAF4701T5E | C23162 | R_0603 | +-1 %, 100 mW, 75 V | n/a | not stated on page | 8483200 | $0.0028@100+ | QUALIFIED |
| 20 | 1 | R4001 | 4.7 ±1% 0603 thick film, >=1/10 W | YAGEO RC0603FR-074R7L | C137705 | R_0603 | +-1 %, 100 mW, 75 V, +-200 ppm/C | n/a | not stated on page | 19100 | $0.0077@100+ | QUALIFIED |
| 21 | 1 | R5002 | 100k ±1% 0805 thick film, >=1/10 W, 0805 for creepage | UNI-ROYAL 0805W8F1003T5E | C149504 | R_0805 | +-1 %, 125 mW, 150 V | n/a | not stated on page | 2011500 | $0.0060@100+ | QUALIFIED |
| 22 | 4 | R6001, R6002, R7101, R7102 | 33 ±1% 0603 thick film, >=1/10 W | UNI-ROYAL 0603WAF330JT5E | C23140 | R_0603 | +-1 %, 100 mW, 75 V | n/a | not stated on page | 2943400 | $0.0025@100+ | QUALIFIED |
| 23 | 1 | R6003 | 100 ±1% 0603 thick film, >=1/10 W | UNI-ROYAL 0603WAF1000T5E | C22775 | R_0603 | +-1 %, 100 mW, 75 V | n/a | not stated on page | 1944100 | $0.0032@100+ | QUALIFIED |
| 24 | 1 | R7106 | 150k ±1% 0603 thick film, >=1/10 W | UNI-ROYAL 0603WAF1503T5E | C22807 | R_0603 | +-1 %, 100 mW, 75 V | n/a | not stated on page | 502100 | $0.0045@100+ | QUALIFIED |
| 25 | 2 | R7107, R7108 | 1M ±1% 0603 thick film, >=1/10 W | UNI-ROYAL 0603WAF1004T5E | C22935 | R_0603 | +-1 %, 100 mW, 75 V | n/a | not stated on page | 3185200 | $0.0020@100+ | QUALIFIED |
| 26 | 8 | TP4, TP5, TP7, TP1, TP2 … (8) | Bare B.Cu pad, no via-in-pad, not assembled (size provisiona | — | — | — | not assembled by JLC | — | — | — | — | N/A |
| 27 | 1 | U1 | ESP32-S3 module, 21.0 x 17.8 mm, castellated. Headers NOT fi | — | — | — | not assembled by JLC | — | — | — | — | N/A |
| 28 | 1 | U4002 | 3.0 V 300 mA LDO, active discharge, SOT-23-5 | Texas Instruments TPS7A2030PDBVR | C963429 | SOT-23-5 | 300 mA, 140 mV dropout, EN 0.3/0.9 V, IQ 6.5 uA | n/a | not stated on page (page: Economic and Standard) | 1880 | $0.2332@5+ | QUALIFIED |
| 29 | 3 | U501, U502, U503 | Quad RRIO op-amp TSSOP-14 | Texas Instruments TLV9064IPWR | C779410 | TSSOP-14_4.4x5mm_P0.65mm | 1.8-5.5 V, en 16 nV/rtHz @1 kHz, IB 0.5 pA, -40..125 C | n/a | Extended | 18770 | $0.3927@5+ | QUALIFIED |
| 30 | 1 | U6001 | 4-ch 24-bit simultaneous delta-sigma ADC, TSSOP-20 | Texas Instruments ADS131M04IPWR | C2862562 | TSSOP-20_4.4x6.5mm_P0.65mm | -40..125 C, AIN abs -1.6 V .. AVDD+0.3 V | n/a | Extended | 1717 | $4.6900@1+ | QUALIFIED |
| 31 | 1 | X1 | 8.192 MHz CMOS XO, 1.62-3.63 V, +/-20 ppm @25C, +/-30 ppm -4 | SCTF (Asian Brands) SX3M8.192M20F30TNN | C2901557 | OSC_SCTF_SX3M_SMD3225-4P | 1.62-3.63 V, +-20 ppm @25 C, -40..85 C | n/a | Extended (per project field) | 1658 | $0.3482@1+ | QUALIFIED |

Economic eligibility: every selected part's JLC page lists "Economic and Standard" PCBA type (C1002's page lists it as an available SMT part; its LCSC stock is not retrievable).

## 3. Notes per line that is not a plain match

* **Line 1, 2.2 µF (resolved in RB-04B).** FH 0603B225K160NT, C43922: 2.2 µF / 16 V / X7R / ±10 % / 0603, Extended, Economic and Standard, 305,720 pcs, $0.0271@20+. Verified on the FH catalogue
  (fhcomp.com product row), JLC and LCSC pages, and the FH general-series sheet A0006 (see `REVB_RB04B_FINAL_BOM_RESOLUTION.md`). The 10 V FH C165991 fallback is dropped.
* **Line 2, 100 pF C0G (8×)** — filter capacitor of the high-impedance node, C0G required (no piezo noise, no bias change): Samsung C14858 is C0G ±5 %.
* **Line 3, 10 nF C0G (4×).** The RB-04 report said none was found; that was a search failure. TDK C1608C0G1H103JT000N, C76599, **Extended**, 50 V C0G ±5 %, 11,740 pcs. Cost: one more feeder line ($3.07). No electrical alternative is needed.
* **Line 5, 22 µF.** Spec 10 V X5R 0805; the stocked part is 25 V X5R ±20 % (Samsung C45783). Same dielectric and footprint, less DC-bias loss; a 10 V CL21A226MPQNNNE was not found on JLC.
* **Line 7, 100 nF.** 50 V X7R Yageo C14663 is the only listed "Basic"; stock 4,000 (≈ 14 needed). Alternate: Samsung CL10B104KB8NNNC C1591 (Extended, 7.8 M).
* **Line 11, ferrite FB1 (DVDD filter; RB-04B).** Murata BLM18AG601SN1D C19330 (Extended; 600 Ω @ 100 MHz ±25 %, **500 mA**, **380 mΩ**, −55…125 °C, 400,250 pcs, $0.0128@50+): exact-spec with margin (load ≈ 11.4 mA, drop 4.3 mV).
  The cheaper Sunlord GZ1608D601TF C1002 is **Basic** on its JLC page (200 mA / 450 mΩ = exactly at the spec limits) but has no LCSC page (404) and no stock figure; it can replace C19330 (−$3.07) if the JLC BOM tool shows stock and you accept zero margin.
* **Line 15, 10 k.** Preferred Basic Uniroyal C25804 is out of stock at LCSC; Yageo C98220 is stocked but shows **Extended** (+$3.07). Re-check C25804 in the JLC BOM tool before ordering.
* **Line 17, 10 MΩ ±5 %.** Selected ±1 % Yageo C114606 (tighter than the spec); Uniroyal C7250 and Meritek C4166728 are out of stock.
* **Line 20, 4.7 Ω** (R4001, supply filter): Yageo C137705, 19,100 pcs; Uniroyal / Meritek out of stock. ±200 ppm/°C.
* **Line 22, 2N7002.** Page shows JSCJ (Jiangsu Changjing) 60 V / 115 mA / VGS(th) ≤ 2.5 V; the lower VGS(th) bound was not shown. Gate is driven from a 3.0–3.3 V net.

## 4. Revalidation of the critical parts

| Part | Check | Result |
|---|---|---|
| BAV199 (Nexperia, C40919) | Datasheet read: IR ≤ 5 nA @ 75 V (25 °C), ≤ 80 nA @ 150 °C; Cd 2 pF; 85 V | Leakage into the 10 MΩ bias: at the 1.5 V node bias the worst-case leakage (≪ 5 nA at ≤ 3 V reverse) is < 0.05 V across 10 MΩ for ≤ 5 nA; matches RB-04 model |
| ADS131M04IPWR (C2862562) | AIN abs −1.6 V … AVDD+0.3 V; 300 kΩ Zin (gain 1–4); CAP 220 nF required for DVDD > 2.7 V | consistent with C6009 220 nF; TSSOP-20, −40…125 °C |
| TLV9064IPWR (C779410) | 1.8–5.5 V, en 16 nV/√Hz @ 1 kHz, IB 0.5 pA, −40…125 °C | as used in the RB-04 noise calculation |
| TPS7A2030PDBVR (C963429) | EN 0.3 / 0.9 V thresholds, IQ 6.5 µA, 300 mA, 140 mV dropout, stable with 1 µF | AFE_EN logic levels (3.0 V high through 100/110 divider = 3.0 V; inhibited 7.5 mV) satisfy it |
| SX3M8.192M20F30TNN (C2901557) | 1.62–3.63 V, ±20 ppm @ 25 °C, −40…85 °C, 3225-4P | rail 3.0 V (DVDD_F); datasheet PDF not retrievable from LCSC, class "Extended (per project field)" |
| JST B2B / S2B-PH-SM4-TB(LF)(SN) (C160352 / C295747) | 100 V / 2 A, −25…85 °C, SMD | JST datasheet PDF not retrievable; **reflow rating vs Economic 255 ± 5 °C is not confirmed** (JLC question Q6) |

## 5. Not established

* Basic/Extended for 16 lines (page extracts did not print it); promotional status for any line.
* DC-bias capacitance from vendor curves (estimates only).
* JLC stock (LCSC stock shown, except C1002 not used; JLC's own inventory view may differ) and JLC's price at the order quantity.
* Datasheets not read in this session: all passives, 2N7002, SCTF oscillator, JST connectors, Sunlord ferrite (parameters taken from the part page).
* Solder-profile compatibility (255 ± 5 °C) of JST connectors, SX3M oscillator and TPS7A2030.
