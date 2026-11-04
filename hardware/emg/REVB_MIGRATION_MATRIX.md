# A.R.T.H.U.R EMG Rev B — Component Migration Matrix (RB-00)

Source of truth: Rev A production PCB pad→net map (`ARTHUR_EMG_RevA_Cost.kicad_pcb`, SHA `d7a585e8…0005`), cross-checked against `ARTHUR_EMG_RevA_Cost.csv`.
Rev A has 138 footprints: 117 in the CSV BOM plus 21 `TP*` footprints missing from the CSV.

Actions:
- **KEEP**: same function, value and part. Footprint re-validated; geometry is *not* copied.
- **MODIFY**: same role, but the value, connection or part changes.
- **REPLACE**: a different part does the job.
- **REMOVE**: the function is gone, or the XIAO provides it.

"Geometry" is never inherited. Every KEEP means the schematic intent is kept, and parts are re-placed on a new outline with new routing.

## 1. EMG channels (×4, references shown for CH1; CH2..CH4 = 2xx/3xx/4xx)

| Reference (per ch) | Rev A value | Function | Rev B action | Reason |
|---|---|---|---|---|
| J101, J201, J301, J401 | JST-PH B2B-PH-SM4-TB 2p vertical | Bipolar electrode connector | **KEEP** | SMD, single-side, keyed. Placed on the analog-edge. Re-check SM4 footprint pad-to-edge clearance for the new outline |
| R101/R102 (…R402) | 10 k 1 % 0603 | Input series limiter + RFI R | **KEEP** | Limits clamp current (3.3 V/10 k = 0.33 mA), and with the 100 pF sets an ≈160 kHz RFI pole |
| D101/D102 (…D402) | BAV199 SOT-23 | Low-leakage clamp to GND / AFE_3V0 | **KEEP** | Low leakage (pA-class) is required next to the 10 M bias. Clamps to AFE_3V0, which is 0 V when inhibited, so the inputs are pinned near GND when off |
| C103/C104 (…C404) | 100 pF 50 V C0G | RFI shunt at the hi-Z node | **KEEP** | 2.4 GHz rectification risk rises with ESP32 (see Architecture §5 N4) |
| R105/R106 (…R406) | 10 M 5 % 0603 | DC bias of the follower input to VCM | **KEEP** | Sets input impedance. Must get a dedicated `EMG_HIZ` netclass and guard (not `Default`, as in Rev A) |
| U501, U502 | TLV9064IPWR TSSOP-14 | 8 unity-gain followers | **KEEP** | Verified: 0.5 pA IB, RRIO, 1.8–5.5 V, 538 µA/amp typ. Footprint `ARTHUR:TSSOP-14`: re-validate vs TI PW land pattern; no vias in pads |
| C101/C102 (…C402) | 2.2 µF 16 V 0603 | AC coupling, follower → ADC | **KEEP** | HPF 0.72 Hz with 100 k. Power-down transient (R6) is bounded by the new ADC-input clamps D1x3/D1x4. Require X7R, 16 V |
| R103/R104 (…R404) | 100 k 1 % | AC-coupling DC return to GND | **KEEP** | GND return confirmed in RB-00.5. AIN ≈ 0 V is inside the recommended window at every gain (AGND − 1.3 … AVDD, or AVDD − 1.8 V at gain ≥ 8). A VCM return is **invalid** at gain ≥ 8 (1.5 V > 1.155 V) |
| R107/R108 (…R408) | 1.0 k 1 % | AAF series R | **KEEP** | AAF with 1 nF / 10 nF: ≈ 7.6 kHz differential pole |
| C106/C107 (…C407) | 1.0 nF C0G | CM AAF shunt | **KEEP** | Match tolerance → CMRR; C0G mandatory |
| C105 (…C405) | 10 nF 50 V C0G | Differential AAF | **KEEP** | — |
| TP111/TP112, TP211/212, TP311/312, TP411/412 | TP_SMD B.Cu | Probe on `CHx_P/N` (ADC inputs) | **REMOVE** | Each added a via + stub on the most sensitive ADC input nets. Probe on the 1 nF cap pads instead |

## 2. VCM / reference / RLD_SAFE

| Reference | Rev A value | Function | Rev B action | Reason |
|---|---|---|---|---|
| R5003, R5004 | 100 k / 100 k 1 % | AFE_3V0 ÷ 2 → 1.5 V | **KEEP** | 15 µA divider; VCM tracks AVDD (ratiometric to the TLV/ADC range) |
| C5001, C5002 | 1 µF, 100 nF | VCM divider filter | **KEEP** | τ = 50 k × 1.1 µF = 55 ms. Firmware waits ≥ 300 ms after enable. They stay at the divider node, ahead of the new 10 k |
| U503 | TLV9064IPWR | Section A: VCM buffer; B/C/D: unused followers tied to VCM | **MODIFY** | Keep the same MPN (no extra JLC extended line). Tie the unused sections as followers of VCM *or* GND-referenced per TI's unused-amp guidance. Optional future: use the spare sections for a true driven-right-leg (inverting CM feedback). Not required for RB-01. The ~1.6 mA spent in the 3 idle amps is accepted (a TLV9061 would cost one extended line) |
| C503 | 100 nF | U503 decoupling | **KEEP** | — |
| R5002 | 100 k 1 % 0805 | Safety resistor VCM → RLD_SAFE electrode | **KEEP** | Bounds DC single-fault current to ≈ 30 µA at 3 V. Keep 0805 for creepage |
| J5001 | JST-PH 2p SM4 | Reference/bias electrode; Rev A **pin 1 = GND**, pin 2 = RLD_SAFE | **MODIFY** | **Pin 1 = NC, MP pads no net** (RB-00.5 R5 closed). Pin 2 = RLD_SAFE. Cable pin 1 unpopulated |

## 3. ADC

| Reference | Rev A value | Function | Rev B action | Reason |
|---|---|---|---|---|
| U6001 | ADS131M04IPWR TSSOP-20 | 4-ch 24-bit ΔΣ ADC | **KEEP** | Pinout re-verified (SBAS890D Table 5-1). Footprint `ARTHUR:TSSOP-20`: re-validate; **5 Rev A vias were in its pads**, all removed |
| C6007 | 1 µF | AVDD decoupling (AFE_3V0) | **KEEP** | Datasheet: 1 µF AVDD→AGND |
| C6008 | 1 µF | DVDD decoupling | **KEEP** | Now on `DVDD_F` (filtered XIAO 3V3) |
| C6009 | 220 nF | CAP pin (digital LDO) | **KEEP** | Datasheet: 220 nF when DVDD > 2.7 V |
| TP601 | — | AFE_3V0 probe | **KEEP** (bare pad) | Bring-up essential |
| TP602 | — | GND | **KEEP** (bare pad) | — |
| TP603 | — | 3V3 | **MODIFY** | Moves to `DVDD_F` |
| TP604–TP608 | — | SCLK, MOSI, MISO, CS_N, DRDY_N | **REMOVE** | Probe at the XIAO castellations / series resistors instead; no stubs on SPI |
| TP609 | — | AFE_CLKIN | **REMOVE** | Probe at the oscillator output pad; no stub on the clock |
| TP610 | — | MCU_RESET_N_AFE | **REMOVE** | Probe at the XIAO D2 castellation |

## 4. Analog power and interlock

| Reference | Rev A value | Function | Rev B action | Reason |
|---|---|---|---|---|
| U4002 | TPS7A2030PDBVR | AFE_3V0 LDO (IN = 3V3 in Rev A) | **MODIFY** | Same part; **IN moves to VBAT via an RC pre-filter**. VIN 1.6–6.0 V covers 3.0–4.2 V LiPo. Active discharge (P) confirmed |
| C4005 | 1 µF | LDO input cap | **MODIFY** | Now on `VBAT_AFE` (post-RC). Keep 1 µF at the pin. The bulk 22 µF comes from the new RC |
| C4006 | 1 µF | LDO output cap | **KEEP** | Minimum per datasheet; total AFE_3V0 capacitance ≈ 1 + 1 + 3×0.1 + clamp C |
| C501, C502 | 100 nF | U501/U502 decoupling | **KEEP** | — |
| Q3001 | 2N7002 SOT-23 | VBUS → pull EN low | **MODIFY** | Gate is now driven from **XIAO 5V pin** through 10 k series + 100 k to GND (Rev A: VBUS direct + R3004) |
| R3004 | 100 k | Q3001 gate pull-down | **KEEP** (role) | Same value; now on the `VBUS_GATE` node |
| R3003 | 100 k 3V3 → AFE_ENABLE (**pull-UP**) | Default-ON enable | **REPLACE** | Becomes 100 k **pull-down** EN → GND, plus a new 10 k series from D3 (AFE_EN_REQ). Default state is OFF |
| Q3002 | 2N7002 | AFE_3V0 discharge on VBUS | **REMOVE** | Redundant: TPS7A2030**P** 150 Ω internal output discharge whenever EN < 0.3 V |
| R3005 | 100 Ω | Q3002 discharge resistor | **REMOVE** | As above. Its un-routed pad (R3005.2) was deferred in Rev A anyway |

## 5. Removed subsystems (functions provided by XIAO or obsolete)

| Reference | Rev A value | Function | Rev B action | Reason |
|---|---|---|---|---|
| U7001 | MDBT50Q-1MV2 | nRF52840 MCU/BLE module | **REMOVE** | Replaced by the XIAO (MCU/radio) |
| C7001, C7002 | 4.7 µF, "TBD" | Module decoupling | **REMOVE** | — |
| U2001 | BQ24074RGTR | USB charger + DPPM | **REMOVE** | XIAO on-board charger (regression: 50 mA, no NTC, see Architecture S1) |
| C2001, C2002, C2003 | range values | Charger caps | **REMOVE** | — |
| R2001, R2002 | 3.57 k, 3.24 k | ISET / ILIM | **REMOVE** | — |
| J2001 | JST-PH 3p (BAT+/NTC/GND) | Battery with NTC | **REPLACE** | JST-PH **2-pin** SMD (BAT+/GND) next to the XIAO. The NTC has no consumer in Rev B |
| U4001 | TPS63031DSKR | Buck-boost 3V3 | **REMOVE** | The XIAO provides 3V3 (its own SGM6029 buck, off our board). Removes a PFM noise source from our board and 10 via-in-pad instances |
| L4001 | 1.5 µH 1008 | Buck-boost inductor | **REMOVE** | — |
| C4001–C4004 | 10 µF ×3, 100 nF | Buck-boost caps | **REMOVE** | — |
| J3001 | USB-C GCT USB4105 | USB-C receptacle | **REMOVE** | USB is on the XIAO. Eliminates the Phase 3C USB DFM problem entirely |
| U3001 | TPD4E05U06DQAR | USB ESD | **REMOVE** | XIAO handles USB ESD |
| R3001, R3002 | 5.1 k | CC Rd | **REMOVE** | — |
| J8001 | 2×5 1.27 mm SWD (DNP, B.Cu) | nRF debug | **REMOVE** | ESP32-S3 debug is over USB-Serial/JTAG on the XIAO USB-C |
| TP201 | BAT+ | Battery probe | **MODIFY** | Becomes the `VBAT` bare pad near J_BAT |
| TP401 | 3V3 | 3V3 probe | **REMOVE** | Duplicate of TP603 (now DVDD_F) |
| TP402 | GND | GND probe | **KEEP** | Second GND pad at the analog end for scope ground |
| — nets | `CHG_N`, `PGOOD_N`, `PACK_NTC`, `ICHG_SET_TBD`, `ILIM_SET_TBD`, `SYS_RAW`, `SW_L1/2`, `USB_D±`, `CC1/2`, `SWDIO/SWDCLK`, `MCU_RESET_N` | Charger/USB/debug signals | **REMOVE** | No consumer in Rev B |

## 6. Added in Rev B

| New ref (proposed) | Part | Function | Notes |
|---|---|---|---|
| U1 | Seeed XIAO ESP32S3 plain, unsoldered-header version (PN 202003751, v1.4) | Brain: MCU, BLE/Wi-Fi, USB-C, charger, 3V3 (SGM6029 buck) | RB-00.6 hand-solder footprint `ARTHUR:XIAO_ESP32S3_HANDSOLDER` (14 extended castellation pads). **DNP in the JLC BOM**; hand-soldered. JLC C9900124959 not used (0 stock / MOQ 445) |
| H_BAT | Plated hole Ø1.40 + Ø3.00 B.Cu pad (board feature, no part) | XIAO BAT+ post landing | RB-00.6; post = 6 mm AWG 24 solid tinned Cu, installed with the XIAO |
| J1 | **JST S2B-PH-SM4-TB(LF)(SN)**, JLC **C295747**, side entry (RB-01R frozen) | Battery BAT+/GND | Own JLC line (side entry ≠ the vertical B2B, C160352). 2 A / 100 V; polarity of the cell lead must be verified |
| X1 | **SCTF SX3M8.192M20F30TNN**, JLC **C2901557**, SMD3225-4P | ADC master clock | Frozen in RB-01R (replaced YXC C7425393): pin 1 OE → DVDD_F, 2 GND, 3 OUT, 4 VDD |
| D103/D104 … D403/D404 | BAV199 (same MPN as D101–D402) ×8 | Negative clamp on each ADC input (pin 1 GND, pin 3 CHx_y, pin 2 NC) | RB-00.5 R6. AIN ≥ −1.09 V worst case (RB-01R) |
| R_VCMIN | 10 k 1 % 0603 | Series R, divider node → U503A +IN | RB-00.5 R6b: limits back-drive to ≤ 0.16 mA |
| R_VBUSLD | 4.7 k 1 % 0603 | Load on XIAO 5V | RB-00.5: defeats XIAO D2 Schottky leakage (keeps 5V ≤ 0.42 V on battery) |
| C_X1 | 100 nF | X1 decoupling | — |
| R_CLK | 33 Ω | CLKIN source termination at X1 | — |
| R_PRE | 4.7 Ω 0603 | LDO input RC | 56 mV drop at 12 mA |
| C_PRE (= C4007, the **only** 22 µF part; there is no separate C_BAT) | 22 µF 10 V X5R 0805 | LDO input RC bulk | Effective ≈ 10 µF at 4 V; corner ≈ 1.5–3.4 kHz |
| FB1 | 600 Ω@100 MHz 0603, ≥ 200 mA | DVDD filter | Place at the XIAO 3V3 exit |
| C_DV1, C_DV2 | 10 µF, 100 nF | DVDD_F bulk/HF | — |
| R_EN_S | 10 k | D3 → EN series | — |
| R_EN_PD | 100 k | EN pull-down (fail-safe) | Replaces R3003 pull-up |
| R_VG_S | 10 k | XIAO 5V → Q3001 gate series | Gate protection / slew |
| R_SCLK, R_MOSI | 33 Ω | Source termination at the XIAO end | — |
| R_MISO | 33 Ω | Source termination at the ADC DOUT end | — |
| R_DRDY | 100 Ω | Series at the ADC DRDY | Limits contention during the ESP32 GPIO2 60 µs low glitch |
| R_CS_PU | 100 k → DVDD_F | CS_N idle-high | D7/GPIO44 is WPU at reset; external pull-up makes it deterministic |
| R_SYNC_PU | 10 k → DVDD_F | SYNC/RESET_N idle-high | A 60 µs GPIO3 glitch < 250 µs reset threshold (2048 tCLKIN) |
| R_VB1, R_VB2, C_VB | 1 M / 1 M / 100 nF | VBAT sense to D0 | The S3 has no on-board VBAT sense (Seeed wiki). Draw ≈ 2.1 µA |
| R_US1, R_US2 | 100 k / 150 k | 5V → D6 USB_PRESENT sense | 3.0 V at 5.0 V; firmware information only |
| ~~R_OPT0 (DNP)~~ | — | **OMITTED (RB-01R).** Obsolete since the RB-00.6 BAT+ post; fitting it would tie VBAT_AFE (VBAT via 4.7 Ω, up to 4.2 V) to the XIAO 3V3 buck output | Must not be re-added without a new review |
| TP set | Bare pads | VBAT, AFE_3V0, DVDD_F, VCM, RLD_SAFE, AFE_EN, GND ×2 | No vias in TP pads |
| ~~U_ID (DNP)~~ | — | **OMITTED (RB-01R)** | D4/D5 stay NC |
| ~~R_SDA/R_SCL (DNP)~~ | — | **OMITTED (RB-01R)** | — |

## 7. Count summary

| | Count |
|---|---|
| Rev A footprints on PCB | **138** = 117 CSV BOM rows + 21 `TP*` (not in CSV) |
| KEEP (incl. KEEP-review) | 91 = 88 parts + 3 TPs (TP601, TP602, TP402) |
| MODIFY | 7 = U503, J5001, U4002, C4005, Q3001 + TP603, TP201 |
| REPLACE | 2 = R3003 (→ pull-down), J2001 (→ 2-pin J1) |
| REMOVE | 38 = 22 BOM parts + 16 TPs |
| Check | 91 + 7 + 2 + 38 = 138 ✓ |
| ADDED (populated, excl. DNP) | ≈ 36 incl. XIAO, after RB-00.5 (+8 BAV199, +2 R) |
| Rev B EMG-board SMT placements (est.) | ≈ 128 (95 carried + ≈ 33 new, excl. XIAO and bare TPs) |
