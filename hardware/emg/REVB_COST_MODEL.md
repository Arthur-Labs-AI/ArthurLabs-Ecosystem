# A.R.T.H.U.R EMG Rev B — Initial BOM & Cost Model (RB-00)

**All prices are estimates unless marked (V).**
- (V) means the price was verified in the prior architecture analysis on LCSC/JLC/Seeed. It was **not re-queried in RB-00**, so re-check it at order time.
- FX: 1 USD = €0.86.
- Excluded: shipping, customs/VAT, battery, electrode leads, enclosure.

## 1. Initial Rev B EMG-board BOM

| Group | Parts | Qty | Unit @1–10 (USD) | Unit @100 (USD) | JLC class (expected) |
|---|---|---|---|---|---|
| ADC | ADS131M04IPWR | 1 | 4.69 (V) / 4.18 @10 (V) | 3.54 (V) | Extended |
| Op-amps | TLV9064IPWR | 3 | 0.22 | 0.199 (V) | Extended |
| AFE LDO | TPS7A2030PDBVR | 1 | 0.12 | 0.091 (V) | Extended |
| Clock | YXC OT2JI-111-8.192M (C7425393), 3225 | 1 | 0.70 | 0.45 | Extended (price not captured in RB-00.5; estimate) |
| Clamps | BAV199 SOT-23 (8 input + **8 ADC-input**, RB-00.5) | 16 | 0.03 | 0.02 | Extended (likely), one line |
| Connectors | JST-PH 2p SMD (5 electrode + 1 battery) | 6 | 0.12 | 0.08 | Extended |
| FET | 2N7002 | 1 | 0.02 | 0.01 | Basic |
| Ferrite | 600 Ω 0603 | 1 | 0.01 | 0.005 | Basic |
| Resistors 0603/0805 | 32 channel + 3 VCM/RLD + ≈ 18 new (incl. R_VCMIN 10 k, R_VBUSLD 4.7 k) | ≈ 53 | 0.002 | 0.001 | Basic (10 M 0603: confirm basic) |
| Capacitors C0G | 100 pF ×8, 1 nF ×8, 10 nF ×4 | 20 | 0.004 | 0.002 | Basic/extended mix (10 nF C0G may be extended) |
| Capacitors X5R/X7R | 2.2 µF ×8, 1 µF ×5, 100 nF ×6, 10 µF ×1, 22 µF ×1 | 21 | 0.006 | 0.003 | Basic |
| **EMG board BOM total** | | ≈ 123 | **≈ $7.9** (@1–2) / **≈ $7.4** (@10) | **≈ $5.9** | ≈ 7 extended lines |
| **In EUR** | | | **≈ €6.8 / €6.4** | **≈ €5.1** | |

Brain: XIAO ESP32-S3 **$7.49 (V, Seeed store) ≈ €6.45**, unsoldered-header version. JLC C9900124959 is **not usable** below 445 pcs (0 stock, consign-only), so the XIAO is bought retail and **hand-soldered** (RB-00.6; + ≈ 6 mm AWG 24 wire, negligible).

**Combined component cost ≈ €11.5 (100 pcs) to €13.2 (1–2 pcs)**. This is consistent with the €11–13 prior estimate; RB-00.5 added ≈ +$0.3/board.

## 2. JLC fixed/variable fees (from the prior analysis, (V) on the JLC pricing page at that time)

| Fee | Value |
|---|---|
| Economic PCBA setup | $8.18 |
| Stencil | $1.53 |
| Extended-part loading | $3.07 per unique extended part → 8 lines ≈ $24.6 |
| Joint fee | $0.0016 per joint → ≈ 330 joints ≈ $0.53/board |
| **Fixed per order** | **≈ $34.3** |
| PCB 4L ~75 × 32 mm (RB-00.6 estimate) | ≈ $20 (5 pcs), $25 (10), $45 (50), $70 (100) |
| XIAO via JLC (option A) | + $3.07 line fee + module price (unknown) + ≈ 40 joints |

## 3. Order scenarios (EMG board assembled by JLC, XIAO bought from Seeed, hand-soldered)

| Scenario | BOM × n | Fixed | Joints | PCB | EMG order total | Per EMG board | + XIAO | **Per complete unit** |
|---|---|---|---|---|---|---|---|---|
| 5 PCB / 2 assembled | $15.2 | $34.3 | $1.1 | $20 | ≈ $71 | ≈ $35.3 | $7.49 | **≈ $42.8 ≈ €36.8** |
| 10 | $71 | $34.3 | $5.3 | $25 | ≈ $136 | ≈ $13.6 | $7.49 | **≈ $21.1 ≈ €18.1** |
| 50 | $300 (≈ $6.0/bd) | $34.3 | $26.5 | $45 | ≈ $406 | ≈ $8.1 | $7.49 | **≈ $15.6 ≈ €13.4** |
| 100 | $570 | $34.3 | $53 | $70 | ≈ $727 | ≈ $7.3 | $7.49 | **≈ $14.8 ≈ €12.7** |

This is $6–7 per unit higher at the 2-unit build than the prior analysis (~$36/unit), because the PCB cost is now included. The ≥ 10-unit numbers agree with the prior analysis within ±$1.5.

## 4. Target check: ≤ €25 complete electronics

| Qty | Electronics (EMG + XIAO) | + battery 500 mAh w/ PCM (est. €3) | Meets ≤ €25? |
|---|---|---|---|
| 2 | ≈ €37 | ≈ €40 | **No** (fixed fees dominate) |
| 10 | ≈ €18 | ≈ €21 | **Yes** |
| 50 | ≈ €13.4 | ≈ €16.4 | Yes |
| 100 | ≈ €12.7 | ≈ €15.7 | Yes, with ~€9 margin |

No special process (POFV, HDI, via-in-pad, castellation, THT, double-side) is assumed anywhere in this model. Adding POFV or double-side assembly would break the ≤ 10-unit economics.

## 5. Delta vs Rev A (per unit, BOM only)

| Line | Δ |
|---|---|
| Remove MDBT50Q + decoupling | −€8.0 (historical, not re-verified) |
| Remove BQ24074 + R/C | −€1.55 |
| Remove TPS63031 + L + 4 C | −€1.35 |
| Remove USB-C + TPD4E05U06 + CC R | −€0.6 |
| Remove Q3002/R3005, 21 TP stubs, J2001 3p→2p | ≈ −€0.05 |
| Add XO, RC, ferrite, dividers, pulls, series R | +€0.7 |
| Add XIAO ESP32-S3 | +€6.45 |
| Extended-line count | ≈ 14 → ≈ 8 (−$18 per order) |

**Net BOM saving vs a re-priced Rev A (~€17.5) is ≈ €4.5–5 per unit**, plus lower fixed fees and the elimination of the USB/DFM risk. The saving is smaller than the historical €21.34 figure suggests.

## 6. Cost risks

- Oscillator MPN/stock at JLC (R4). A non-JLC XO forces consignment/manual → breaks Economic PCBA.
- ADS131M04 price and stock volatility. It is ~60 % of the EMG BOM.
- XIAO JLC availability/price (option A).
- PCB price for a > 50 mm dimension (JLC promo tiers). Could be reduced by fitting within 50 × 50 mm only by stacking, which is rejected.

## 7. RB-00.6 direct-XIAO prototype estimate

| Item (5 PCB / 2 assembled) | USD |
|---|---|
| EMG BOM ×2 (≈ $7.9) | 15.8 |
| PCBA fixed: $8.18 setup + $1.53 stencil + 7 extended × $3.07 | 31.2 |
| Joints (≈ 340 × $0.0016 × 2) | 1.1 |
| PCB 4L 75 × 32 mm × 5 (estimate) | ≈ 22 |
| XIAO ESP32-S3 × 2 (Seeed) | 15.0 |
| BAT+ post wire, flux (consumables) | ≈ 0 |
| **Total** | **≈ $85 ≈ €73 (≈ €36.6 per completed unit)** |

Excludes shipping, VAT/customs and the batteries. **No second PCB, cable or GH connectors** (the carrier alternative was ≈ $122). This is an estimate, not a quote.

