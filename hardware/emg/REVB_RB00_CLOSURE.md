# A.R.T.H.U.R EMG Rev B — RB-00.5 Architecture Closure

Status: closure of the four RB-01 blockers (R5, R6, R3/R9, R4). No schematic, PCB or Rev A edit was made.
The Rev A production PCB SHA-256 was re-checked and still matches `d7a585e8…0005`.
Date: 2026-09-28.

## Sources read in this pass

| Source | Used for |
|---|---|
| TI ADS131M04 SBAS890D | §6.1 absmax, §6.3 recommended AIN range per gain, Zin, input current |
| TI TPS7A20 SBVS338H | VOUT tolerance ±1.5 % (DBV, VOUT ≥ 2.8 V), active discharge |
| TI TLV906x | Input-pin absmax: current-limit to ≤ 10 mA when > 0.5 V beyond the rails |
| Nexperia BAV199 product data sheet (1 Apr 2023) | Pinning, VF, IR, Cd, trr, VFRM |
| Seeed wiki XIAO ESP32S3 + official files (downloaded) | `New_XIAO_Series_Footprints.zip` → `XIAO-ESP32-S3-SMD.kicad_mod`; KiCad project zip; schematic PDF |
| LRC LMBR4010BST5G datasheet | XIAO VBUS→VIN Schottky reverse leakage |
| JLCPCB part pages C9900124959, C7425393 | Stock, MOQ, PCBA class |
| YXC YSO110TR "Wide Voltage" datasheet (LCSC copy served for C7425393, 4 pp., image-only PDF, read visually) | X1 qualification |
| Rev A PCB (frozen) | J5001 / J101 pad nets incl. MP pads |

---

## R5 — J5001 reference connector → **CLOSED**

**Decision:** J5001 pin 1 = **NC** (no net, no copper connection); pin 2 = `RLD_SAFE` → R5002 100 k → `VCM`. MP (retention) pads = **no net**, as they are in Rev A. The mating cable for J5001 must leave pin 1 unpopulated; this goes on the assembly drawing.

**Verification: every patient-connected net and its minimum-impedance path to GND (Rev B topology)**

| Patient contact | First element | Path(s) to GND | Minimum series impedance |
|---|---|---|---|
| J101..J401 pin 1/2 (8 electrodes) | R1x1/R1x2 10 k | 10 k → BAV199 D1 (only if node < −0.6 V) → GND; 10 k → 100 pF → GND (AC); 10 k → 10 M → VCM → U503 → GND; 10 k → BAV199 D2 → AFE_3V0 → GND | **≥ 10 kΩ** (DC); AC ≥ 10 kΩ + 1/(jω·100 pF) |
| J5001 pin 2 | R5002 100 k 0805 | 100 k → VCM → U503 output / R5004 → GND | **≥ 100 kΩ** |
| J5001 pin 1 | — | **NC** | open |
| All J* MP pads | — | no net | open |

Result: **no direct (sub-10 kΩ) path exists from any patient contact to GND.** Rev A had one (J5001.1 = GND, 0 Ω). The ≈30 µA DC single-fault bound through R5002 is restored for the reference electrode. The USB rule and the "no isolation" statement still apply.

---

## R6 — ADC input power-down transient → **CLOSED**

### 1. The correction is accepted

ADS131M04 §6.3 absolute input range:
- gains 1/2/4: `AGND − 1.3 V … AVDD`
- gains 8–128: **`AGND − 1.3 V … AVDD − 1.8 V`**

With AVDD = 3.0 V ±1.5 % (TPS7A2030 DBV, 2.955–3.045 V), the upper limit at gain ≥ 8 is **1.155–1.245 V**.
- A VCM-referenced ADC input bias (1.5 V) is **invalid** at the intended gain.
- The earlier "return R1x3/R1x4 to VCM" option is **withdrawn**.

The existing **GND-referenced** AC-coupled input (AIN DC ≈ 0 V) sits almost exactly at the midpoint of the gain ≥ 8 window (−1.3 … +1.155 V). It is the correct bias and is kept.

### 2. The mechanism, from first principles

Per ADC input:
```
follower OUT ──C1x1 2.2µF──┬── N ── R1x7 1k ──┬── AIN (C1x6 1nF→GND, C1x5 10nF diff)
                           R1x3 100k→GND
```
- The cap holds `V_C = V_followerDC − V_N,DC`, with V_N,DC ≈ 0 V.
- When EN drops, the TPS7A20 150 Ω discharge collapses AFE_3V0 in ≈ 0.3–1 ms. The follower output is pulled down with its rail (it cannot exceed V+).
- τ_N = 100 k × 2.2 µF = 0.22 s ≫ 1 ms, so N (and AIN, through 1 k/1 nF with τ = 1 µs) steps to **−V_C**.

Worst-case V_C (tolerances included):

| Case | V_followerDC | V_C,max | AIN if unprotected |
|---|---|---|---|
| Nominal, electrodes on | VCM = 1.50 V | 1.50 V | −1.50 V |
| VCM max (AVDD +1.5 %, divider 1 %) + 300 mV electrode DC offset | 1.54 + 0.30 | **1.84 V** | −1.84 V |
| Follower saturated high (lead-off / large offset) | AVDD,max = 3.045 V | **3.05 V** | −3.05 V |

Absmax is AGND − 1.6 V, and SBAS890D has **no** "current-limited" exemption. **Rev A (and an unprotected Rev B) violates absmax** in both non-nominal cases, so R6 was a real latent defect, not a margin issue.

### 3. Options evaluated

| Option | Result | Verdict |
|---|---|---|
| **A1** Negative clamp at N (before 1 k) | Clamp current = C·dV/dt, which is uncontrolled: tens of mA through the op-amp output and diode. VF at 10–50 mA = 1.0–1.1 V max | Rejected (higher current, less margin) |
| **A2** Negative clamp at AIN (after existing 1 k) | The existing 1 k limits the current to ≤ 3.1 mA; margins below | **CHOSEN** |
| B Slower rail decay | Must be ≫ τ_N = 0.22 s to reduce the step, which conflicts with the < 10 ms USB-inhibit response. Cannot bound the saturated case | Rejected |
| C Alternative bias | VCM bias violates the gain ≥ 8 window. A DVDD-derived bias (always on) puts AIN > AVDD + 0.3 V while AVDD = 0 (absmax violation). AFE-rail-derived biases collapse with the rail and don't reduce the step. GND is already optimal | Rejected |
| D Keep as is | −1.84 V / −3.05 V worst case vs −1.6 V absmax | **Rejected (violates absmax)** |

### 4. Chosen circuit

- **8 × BAV199** (same MPN and JLC line as the input clamps D101–D402), one per ADC input `CH1_P … CH4_N`:
  - pin 1 (A1) → **GND**
  - pin 3 (K1/A2) → **CHx_y** (ADC side of R1x7/R1x8, at the ADC pin)
  - pin 2 (K2) → **NC**
- Proposed refs D103/D104, D203/D204, D303/D304, D403/D404.
- Pinning is verified against the Nexperia table: 1 = A1, 2 = K2, 3 = K1/A2. Diode 1 conducts only when AIN < 0.

Pin 2 is deliberately left NC:
- The positive direction needs no clamp. AIN ≤ follower output ≤ AVDD in every state, and at power-up VCM (τ = 55 ms) lags AVDD (< 1 ms).
- Tying K2 to AFE_3V0 would only add a reverse-leakage path from the rail.

A dual common-anode part (BAW156, same Nexperia low-leakage family) would halve the placements. It is an **allowed RB-02 substitute if area is tight**, at the cost of one extra extended line.

### 5. Worst-case transient with the clamp

| Quantity | Value | Basis |
|---|---|---|
| Peak clamp current | ≤ (3.05 V − 0) / 990 Ω = **3.1 mA** (ignoring VF, conservative) | R1x7 1 k −1 % |
| VF (Nexperia max, 25 °C) at 3.1 mA | 0.90 V @1 mA, 1.00 V @10 mA → log-interp. **0.95 V** | Table 7 |
| Temperature (−2 mV/°C), design floor −20 °C | +0.09 V | Silicon junction; operating range 0–45 °C, so this is conservative |
| Forward recovery (VFRM 1.75 V @ 10 mA, tr = 20 ns) | Not applicable. AIN has 1 k × 1 nF = 1 µs edge limiting, and the current is ≤ 3.1 mA | Table 7 |
| **Worst-case AIN** | **≥ −1.04 V** | — |
| Margin to recommended minimum (−1.3 V) | **0.26 V**: the transient stays inside the *recommended* range | — |
| Margin to absmax (−1.6 V) | **0.56 V** | — |
| ADC pin current | ≤ 3.1 mA total (the ADC's own ESD cell can only share it) vs 10 mA absmax | — |
| Op-amp output current during the event | ≤ 3.1 mA; the output is not driven beyond its rails | TLV906x |
| Node N | Swings to ≈ −V_C, but only passives are attached (C, 100 k, 1 k) | — |
| Recovery | AIN ≈ −0.5 V → 0 V with τ ≈ 0.22 s after an inhibit | Within range |

### 6. Normal-acquisition impact

Normal operating point: AIN ≈ 0 V ± a few mV DC, ≤ ±150 mV signal at gain ≥ 8.

| Effect | Worst case | Typical | Verdict |
|---|---|---|---|
| DC leakage | IR ≤ 5 nA is specified at **75 V**. At ~0 V bias the zero-bias conductance is ≤ Is/nVT → r0 ≥ 5 MΩ (25 °C); ≥ 1.3 MΩ even at IR×4 (45 °C) | IR typ 3 pA → r0 ≈ GΩ | Negligible |
| HPF corner (2.2 µF with 100 k ∥ r0) | 0.72 → 0.78 Hz | unchanged | Irrelevant to the 20–450 Hz band |
| CM→DM conversion from P/N HPF mismatch at 50 Hz | ≈ −58 dB (one diode at extreme leakage, one typical) | > 100 dB | Worst case is equal to the existing ±10 % C / 1 % R mismatch floor (≈ −57 dB). No new floor |
| Noise | i_n = √(4kT/r0) ≤ 56 fA/√Hz × ~1.7 kΩ source → **≤ 0.1 nV/√Hz** vs 4 nV/√Hz from the 1 k | ≪ | Negligible |
| Capacitance | Cd ≈ 2 pF (VR = 0) ∥ 1 nF C0G → +0.2 % | — | Inside the C0G ±5 % tolerance |
| Forward conduction on signal | Is ≤ 4.4 pA (derived from VF max, n ≈ 1.8). At −150 mV: 0.1 nA; at −300 mV: 2.7 nA → ≤ 5 µV error | — | Negligible **for |AIN| ≤ 0.3 V** |

**Contract added:** with the clamps fitted, **PGA gain ≥ 4** (FS ≤ ±0.3 V). Gains 1/2 would put the clamp into conduction on large negative swings. EMG operation is planned at gain 8–32.

### 7. Related finding closed in the same pass (R6b)

At power-down, C5001/C5002 (1.1 µF at 1.5 V) back-drive U503A +IN through its input clamp into the collapsing AFE_3V0. Estimated **5–24 mA** transient, depending on rail slew. TLV906x absmax requires ≤ 10 mA once an input is > 0.5 V beyond the rail.

**Fix:** add a **10 kΩ series resistor between the divider node (C5001/C5002 stay at the node) and U503A +IN**. This bounds the current to ≤ 1.55 V/10 k = **0.16 mA** in all cases.
- Cost: 12.9 nV/√Hz of common-mode noise on VCM. It is rejected as common mode, and 0.5 pA × 10 k = 5 nV of offset.

The follower hi-Z inputs are already safe: they sit behind 10 M, the 100 pF charge is small, and BAV199 D2 carries it to the rail.

---

## R3/R9 — XIAO ESP32-S3 → **OPEN (mechanical sub-item only; does not block RB-01)**

### 1. What is frozen

| Item | Frozen value |
|---|---|
| Model | **Seeed Studio XIAO ESP32S3, plain** (not Sense, not Plus). Seeed board PN **202003751**, wiki-stated schematic revision **v1.4** |
| Footprint | **Seeed official `Seeed_Studio_XIAO_Series:XIAO-ESP32-S3-SMD`** from `New_XIAO_Series_Footprints.zip` (library archive dated 2026-06-22), imported unmodified into the Rev B library, with the documented courtyard/anchor edits below |
| Mounting | ~~Hand/hot-plate reflow after JLC PCBA~~ **Superseded by RB-00.6:** hand-soldered castellations on extended pads + BAT+ post; XIAO = DNP in the JLC BOM ([REVB_XIAO_MOUNTING_SPEC.md](REVB_XIAO_MOUNTING_SPEC.md)) |

### 2. Official-files gap (the reason this stays OPEN)

The wiki's "XIAO ESP32S3 **v1.4** SCH & KiCad" links, which are the plain-board resources:
- `202003751_XIAO ESP32S3_v1.4_SCH&PCB_260226.zip`
- `…_v1.4_SCH_260226.pdf`

both actually contain **`202003753_XIAO ESP32S3 Sense_v1.5`**. The title block reads "XIAO ESP32-S3-Sense", the revision log runs v1.0–v1.3, and the latest entry is 2025-10-21 (R5 → 24 nH). **No plain-v1.4 design data was obtainable from Seeed.**

All geometry below is therefore verified against the Sense v1.5 main-board PCB (same main-board layout; the Sense B2B `J3` sits on the **top** side). Per your instruction, a retail SKU name is not taken as proof of identical bottom geometry.

### 3. Geometry verification: official footprint vs Seeed's module PCB

Module PCB transformed into the footprint frame: X = Xpcb − 148.501 + 8.9175, Y = Ypcb − 115.477.

| Footprint pad | Size (mm) | Module feature | Net on module | Δ position |
|---|---|---|---|---|
| 1–7 (x = 0.835, y = −18.12 … −2.88, pitch 2.54) | 2.75 × 2.0 | Castellations D0–D6 | D0…D6 | ≤ 0.03 |
| 8–14 (x = 17.0) | 2.75 × 2.0 | D7, D8, D9, D10, **3V3**, **GND**, **5V** | D7…D10, VCC_3V3, GND, **VBUS** | ≤ 0.03 |
| 15 / 16 | Ø1.7 | TP3 / TP4 | MTDI(IO41) / MTDO(IO40) | 0.03 |
| 17 / 18 | Ø1.7 | TP6 / TP1 | **EN** / GND | 0.03 |
| 19 / 20 | Ø1.7 | TP2 / TP5 | MTMS(IO42) / MTCK(IO39) | 0.03 |
| 21 / 22 | Ø1.7 | TP7 / TP8 | ESP_USB_D− / ESP_USB_D+ | 0.03 |
| **23** | 2.5 × 1.1 | BAT0 (2.03 × 1.02) | **VBAT (BAT+)** | 0.03 |
| **24** | 2.5 × 1.1 | GND0 | **GND (BAT−)** | 0.03 |
| **25** | 2.75 × 2.5 | Bottom solder-mask window 2.75 × 2.5 over the B.Cu GND pour | **GND** (exposed) | 0.03 |

- **All 14 castellations and all 11 bottom pads are accounted for**; no exposed bottom copper is unmapped.
- The module outline is 17.78 × 21.14 mm.
- The castellation landing pads extend 0.54 mm beyond the module edge on both sides.

Mechanical features (from the module PCB):

| Feature | Value |
|---|---|
| USB-C receptacle | Centred on the long axis (x = 8.92), 9.0 mm wide. **Overhangs the module edge by 1.51 mm** (fp y = −22.53) |
| U.FL (`ANT1`) | Top side, fp (4.07, −1.64): the **far end from USB, D0–D6 side** |
| Sense B2B (`J3`) | Top side, fp (11.08, −1.64): not on the bottom, so SMD mounting is compatible |
| Official F.CrtYd | x −0.003 … 17.787, y −21.022 … −0.074. It **excludes** the ±0.54 mm landing-pad overhang and the 1.51 mm USB-C overhang |
| Anchor / centroid | Footprint origin is the module's bottom-left corner (far end, D6/D7 corner), not the body centre |

Required edits in the Rev B library copy (geometry of the copper is unchanged):
1. **Courtyard** → x −0.80 … 18.60, y −22.80 … +0.25.
2. **Anchor/centroid** → move the footprint origin to the body centre (8.89, −10.55) so that the CPL/placement centroid = body centre. Rotation 0° = USB toward −Y.
3. **Pad nets**: 13/18/24/25 = GND; 23 = VBAT; 14 = XIAO_5V; 12 = XIAO_3V3. **15, 16, 17 (EN), 19, 20, 21, 22 (USB D±) = no-connect**, with no traces or vias under or within 0.3 mm of them. Paste stays on all 25 pads for uniform stand-off.
4. **Board-edge rule:** the module's USB-end edge (fp y = −21.02) sits **on our board edge (0 … +0.2 mm inside)**. Nothing of ours may extend beyond it, because a mated USB-C plug overmold would collide with it.
5. Under the module: solder mask everywhere except pads. Tented vias are allowed only outside the pad-15–25 field. No copper pour openings.

**Superseded by RB-00.6:** the frozen orientation is **180°** (USB-C → south edge, east end; U.FL at the north-east corner) and the footprint is the new hand-solder footprint. The RB-00.5 −90° text below is kept for history only.

Orientation for the Rev B floorplan (RB-00.5, superseded): rotate **−90°** (USB → east board edge). Then:
- D0–D6, the BAT pads and the U.FL are on the **north** side. The U.FL is at the north-west corner, so the antenna cable leaves north, away from the Zone A electrodes on the south edge.
- D7–D10 SPI are at the **south-west** (closest to the ADC). 3V3/GND/5V are at the south-east.
- DRDY (D1) lands on the north-east side, so it gets a ~15–20 mm CTRL_SLOW route. Accepted.

### 4. Electrical facts learned from the official module netlist (these change earlier RB-00 assumptions)

1. **XIAO 3V3 is a switching regulator**: SGM6029 buck, 470 nH, fed from VIN. It is *not* an LDO. The RB-00 docs said "XIAO LDO". Consequences:
   - MHz ripple (and possible PFM bursts) on 3V3 and on VBAT (buck input current).
   - The DVDD ferrite filter and the VBAT → 4.7 Ω/22 µF RC in front of the TPS7A20 are now **required, not precautionary**. Bench-measure the PFM burst spectrum.
2. **Power path:**
   - VBUS → **D2 LMBR4010 Schottky** → VIN.
   - VBAT → **Q1 PMOS** (gate = VBUS, R9 100 k VBUS → GND) → VIN.
   - Charger SGM40567 VIN = VBUS, BAT = VBAT.
3. **5V pin = raw VBUS net** (also R9, the charger VIN, the Q1 gate and the D2 anode). On battery only it is held at 0 V by R9 **except for D2's reverse leakage** from VIN (≈ VBAT).
   - LMBR4010 IR ≤ **30 µA at VR = 10 V**; design allowance **100 µA** (temperature + charger reverse leakage).
   - With RB-00's loads (R9 ∥ 110 k ∥ 250 k ≈ 43 kΩ), VBUS could float to 1–4 V and **falsely trip Q3001**. That is fail-safe, but the AFE would never enable. **Risk R1 is real.**
   - **Fix (adopted): R_VBUSLD 4.7 kΩ from XIAO 5V to GND on our board.**
     - Worst case on battery: 100 µA × (4.7 k ∥ 43 k = 4.2 kΩ) = **0.42 V** → Q3001 gate 0.38 V, below the 2N7002 VGS(th) min of ≈ 0.8–1.0 V (with temperature derating).
     - Cost: 1.1 mA from USB when plugged.
   - R1 is downgraded from a blocker to a bring-up check.

### 5. JLCPCB C9900124959 cross-check

| Field | JLC listing (read 2026-09-28) |
|---|---|
| MPN / mfr | "XIAO-ESP32-S3" / "JLCPCB Assembly" (a placeholder entry, not a Seeed MPN) |
| Package | LCC-14 |
| Class / PCBA | Extended; Economic + Standard |
| Stock | **0**; **Minimum 445, full reel 500**; "Consign Part" offered |
| Price | Placeholder $0.0203 (not a real module price) |
| Footprint | EasyEDA only; the API was not accessible (403). The name "LCC-14" suggests the **bottom pads (BAT/GND/TP) may not be modelled**. **Not verified** |

**Decision:** C9900124959 is **not used** for Rev B builds under ~450 units. The listing gives no hardware revision and its footprint could not be checked; JLC placement would require either a 445-piece buy or consignment.
- The XIAO is **DNP** in the JLC BOM and mounted in-house. RB-00.6: hand-soldered on its 14 castellations + BAT+ post; no hot plate.
- Revisit only for a ≥ 500-unit build, after checking JLC's footprint against the table above.

### 6. What keeps R3/R9 OPEN

1. **Incoming inspection gate (before the RB-02 layout freeze):**
   - measure 2 purchased plain modules (label/PCB silk revision, BAT0/GND0/TP positions ±0.1 mm, presence of L4 470 nH, J3 not populated)
   - compare against §3
2. Ask Seeed for the real **202003751 v1.4** KiCad files (the wiki link serves Sense v1.5).

Neither item affects the RB-01 schematic. The pin and pad electrical contract is frozen from the official footprint and module netlist.

---

## R4 — ADC clock X1 → **CLOSED**

Candidate: **YXC OT2JI-111-8.192M**, JLCPCB **C7425393**, SMD3225-4P.

- JLC listing: "−40…+85 °C, 1.8–3.3 V, 8.192 MHz, CMOS, ±10 ppm / ±20 ppm, SMD3225-4P", Economic + Standard PCBA, MSL 1.
- Datasheet served by LCSC for C7425393: YXC **YSO110TR "Wide Voltage"** family.

| Check | Datasheet | Requirement (ADS131M04 / Rev B) | Result |
|---|---|---|---|
| Supply | 1.8–3.3 V | DVDD_F = XIAO 3V3 (SGM6029, nominal 3.3 V) | **PASS**. At the top of the stated range; no absmax published, see residual |
| Output | CMOS, VOH ≥ 90 % VDD, VOL ≤ 10 % VDD | CLKIN VIH ≥ 0.8·DVDD, VIL ≤ 0.2·DVDD, same rail | **PASS** (10 % margin each side) |
| Duty cycle | 45–55 % | 40–60 % | **PASS** |
| Frequency | 8.192 MHz | HR mode 0.3–8.4 MHz, nominal 8.192 | **PASS** |
| Pinout | 1 = Tri-state (OE), 2 = GND, 3 = OUTPUT, 4 = VDD | — | Frozen. Pin 1 is bottom-left in the top-view dimension drawing (the pin-assignment sketch is "for function description only") |
| OE / ST | Enable = high or floating (≥ 70 % VDD); disable ≤ 30 % VDD (tri-state) | Always on | **Tie pin 1 to DVDD_F** (do not leave floating) |
| Start-up | ≤ 3 ms | Clock must run before the SYNC/RESET release (≥ 250 µs pulse); XO powers with the XIAO seconds earlier | **PASS** |
| Supply current | ≤ 5 mA (3225, 1–40 MHz, 3.3 V, 15 pF) | DVDD_F budget | **PASS**. DVDD_F total ≤ 5.5 mA; FB1 rating ≫ |
| Output load | 15 pF | 33 Ω + ≤ 6 mm trace + CLKIN pin ≈ 5–8 pF | **PASS** |
| Rise/fall | ≤ 4 ns | 33 Ω source term at X1 pin 3 | **PASS** |
| Stability | ±10 ppm @25 °C; ±20 ppm over −40…85 °C; aging ±3 ppm/yr; jitter ≤ 0.7 ps | EMG timing (non-critical) | **PASS** |
| Decoupling | 10 nF–100 nF required VDD–GND | 100 nF at pin 4 | **PASS** |
| Footprint | 3.2 × 2.5 × 1.2 mm max. Land pattern: pads 1.3 × 1.2 mm, gaps 0.8 mm (x) / 0.7 mm (y), overall 3.4 × 3.1 mm | New KiCad footprint from this land pattern (not a generic Oscillator lib guess) | **Defined** |
| PCBA | Economic + Standard, MSL 1 | Economic PCBA | **PASS** |

**Frozen as X1:** YXC OT2JI-111-8.192M / LCSC-JLC C7425393.

Residuals (non-blocking):
1. The datasheet is a family sheet; the OT2JI ordering code is not decoded in it. Identity rests on the JLC/LCSC listing attributes, which match every row.
2. 3.3 V is the stated upper supply. The XIAO 3V3 tolerance (SGM6029, a few %) may sit marginally above it, and no absolute max is published. Accept as normal wide-voltage-XO practice, or ask YXC for a VDD max confirmation before the production order.
3. The JLC CPL rotation must be checked in the JLC preview (pin 1 marker).

---

## Consequential changes to the RB-00 documents

| Doc | Change |
|---|---|
| ARCHITECTURE_PROPOSAL | J5001 pin 1 NC; ADC-input clamps; R_VCMIN; R_VBUSLD; XIAO 3V3 = buck; U.FL orientation; risk table closed/updated |
| MIGRATION_MATRIX | J5001, R103 (review → keep), U503 row; new rows: 8× BAV199, R_VCMIN, R_VBUSLD, X1 MPN, XIAO DNP |
| POWER_ARCHITECTURE | XIAO buck + power path; R6 section rewritten; DVDD_F budget with X1 5 mA max; R1 mitigated |
| INTERFACE_SPEC | 5V row + truth-table case 15; X1 frozen; XIAO 25-pad map; gain ≥ 4 contract |
| MANUFACTURING_CONSTRAINTS | XIAO mounting decision (Option B); footprint edits; board-edge rule; X1 footprint |
| COST_MODEL | +8 BAV199, +2 R; XIAO not JLC-placed; X1 line |

---

## Closure summary

```
R5 J5001:
CLOSED
decision: pin 1 = NC, pin 2 = RLD_SAFE via R5002 100 k 0805, MP pads no net.
          Every patient contact is ≥ 10 kΩ (electrodes) / ≥ 100 kΩ (reference) from GND.

R6 POWER-DOWN TRANSIENT:
CLOSED
chosen circuit: GND-referenced AC-coupled bias retained. 8 × BAV199 (same MPN/line)
                negative clamps at the ADC inputs behind the existing 1 k
                (pin 1 GND, pin 3 AIN, pin 2 NC). Plus 10 k in series with U503A +IN.
                PGA gain ≥ 4 contract.
worst-case ADC input voltage: ≥ −1.04 V (3.1 mA, VF max, −20 °C).
                              Margin 0.26 V to the recommended −1.3 V, 0.56 V to absmax −1.6 V.
                              Unprotected Rev A worst case: −1.84 V … −3.05 V.
normal-operation leakage/noise impact: r0 ≥ 1.3–5 MΩ worst (GΩ typ) → HPF 0.72 → ≤ 0.78 Hz;
                              CM→DM at 50 Hz ≤ −58 dB worst (equal to the existing
                              tolerance floor), > 100 dB typ; noise ≤ 0.1 nV/√Hz;
                              +2 pF on the 1 nF CM caps. Negligible.

R3/R9 XIAO:
OPEN — mechanical residual only; does not block RB-01
exact model/revision: Seeed XIAO ESP32S3 plain, Seeed PN 202003751, v1.4
                      (Seeed's published v1.4 files actually contain Sense v1.5;
                      geometry verified against those; confirm on purchased modules before RB-02)
official footprint: Seeed_Studio_XIAO_Series:XIAO-ESP32-S3-SMD (25 pads, all mapped ≤ 0.03 mm;
                    courtyard/anchor corrected; pads 15–17, 19–22 NC; 23 VBAT; 13/18/24/25 GND)
JLC part: C9900124959 cross-checked but NOT used (0 stock, MOQ 445, consign-only,
          footprint unverifiable). XIAO = DNP at JLC, mounted in-house.

R4 CLOCK:
CLOSED
MPN: YXC OT2JI-111-8.192M (X1; OE tied to DVDD_F)
JLC part: C7425393 (Extended, Economic + Standard PCBA)

RB-00 ARCHITECTURE FROZEN:
YES

READY FOR RB-01 SCHEMATIC:
YES
```
