# RB-04C — XIAO ESP32-S3 Electrical Compatibility Matrix

Date: 2026-10-12. Nothing modified, ordered, sent, committed or pushed.
**Basis:** Seeed schematic `202003751_XIAO ESP32S3_v1.4_SCH_260226.pdf.pdf` — byte-identical to the Sense v1.5 schematic (sha256 `15993097…9f9923c`, title "XIAO ESP32-S3-Sense", Rev V1.3, 2026-02-10, KiCad 9.0.6; 4 pages, read 2026-10-12; the circuit is on page 4).
The plain module is assumed to share the power path, regulator, GPIO assignment and castellation net names; **that assumption is unverified** (one difference is already documented: §3). Rev B side: canonical schematic via `kicad-cli` netlist.

## 1. Pin-by-pin mapping (14 castellations + BAT+)

| Pin | XIAO pad | ESP32-S3 pin | Rev B net | Rev B connections (not U1) | Direction | Boot / reset behaviour of the pin | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | D0/A0 | GPIO1 (ADC1_CH0) | VBAT_SENSE | R7107 1 MΩ from VBAT, R7108 1 MΩ to GND, C7103 100 nF | in (ADC) | floating at reset; node = VBAT/2 = 1.5–2.1 V (≤ 2.15 V at 4.3 V cell) | PASS (source impedance 500 kΩ ‖ 100 nF: needs long sampling / averaging) |
| 2 | D1/A1 | GPIO2 | DRDY_N | R6003 100 Ω from ADS131M04 DRDY | in | floating at reset, ADC idles high | PASS |
| 3 | D2/A2 | GPIO3 (**strapping**: JTAG signal source) | SYNC_RESET_N | R7104 10 kΩ pull-up, ADS131M04 pin 11 | out (open-drain use by firmware) | pulled **high** by R7104 during reset → ADC not reset; GPIO3 strap is only evaluated when the JTAG-source eFuse is programmed (not re-verified against the Espressif datasheet this session) | PASS — bench check |
| 4 | D3/A3 | GPIO4 | AFE_EN_REQ | R3007 10 kΩ → AFE_EN (R3008 100 kΩ pull-down, Q3001 drain, TPS7A2030 EN, TP6) | out | floating at reset → AFE_EN pulled low by R3008: **AFE off by default** | PASS |
| 5 | D4 | GPIO5 | (none) | — | — | NC, open | PASS |
| 6 | D5 | GPIO6 | (none) | — | — | NC, open | PASS |
| 7 | D6/TX | GPIO43 (U0TXD) | USB_PRESENT | R7105 100 kΩ from XIAO_5V, R7106 150 kΩ to GND | in | **UART0 TX: ROM boot log is driven here** at 3.3 V into a 60 kΩ divider (no damage; reading is meaningless until boot ends). USB present → 2.70–3.15 V | PASS — firmware must not use UART0 console on D6 |
| 8 | D7/RX | GPIO44 (U0RXD) | CS_N | R7103 100 kΩ pull-up, ADS131M04 CS | out | UART0 RX input at boot; pulled high = idle | PASS |
| 9 | D8/A8/SCK | GPIO7 | SCLK_MCU | R7101 33 Ω → ADC SCLK | out | floating at reset | PASS |
| 10 | D9/A9/MISO | GPIO8 | MISO | R6002 33 Ω ← ADC DOUT | in | — | PASS |
| 11 | D10/A10/MOSI | GPIO9 | MOSI_MCU | R7102 33 Ω → ADC DIN | out | — | PASS |
| 12 | 3V3 | VCC_3V3 (module buck U3, SGM6029CYG, 470 nH) | XIAO_3V3 | FB1 (Murata 600 Ω ferrite) → DVDD_F | **supply out** | Wiki: "can draw 700 mA"; Rev B load ≈ 11.4 mA | PASS |
| 13 | GND | GND | GND | plane | — | — | PASS |
| 14 | 5V | VBUS (USB-C VBUS before D2) | XIAO_5V | R3006 10 kΩ → VBUS_GATE (Q3001), R3009 4.7 kΩ load, R7105 100 kΩ | **sense only** (input from USB) | 0 V on battery power (wiki + schematic) | PASS |
| BAT+ | BAT0 pad (post) | VBAT (charger BAT, Q1 source side) | VBAT | J1 battery, R4001 → VBAT_AFE, R7107, TP1 | **bidirectional** (battery in, charge out) | — | CONDITIONAL (§3) |

Voltage domains: GPIO high = module 3V3 (3.25–3.4 V); ADS131M04 DVDD = DVDD_F (3V3 via FB1) so all SPI/control levels are 3.3 V CMOS on both ends; ADS131M04 AVDD = AFE_3V0 (3.0 V). Largest sensed voltage at any GPIO: USB_PRESENT 3.15 V (5.25 V VBUS), < 3.3 V; at 5.5 V VBUS 3.3 V (at the limit).
No direct connection between the module's 5V/VIN rail and any Rev B source: XIAO_5V only feeds resistors to ground. **No 5 V backfeed path exists from Rev B.**

## 2. Module power architecture (from the schematic, page 4)

| Block | Part (Seeed ref) | Behaviour | Consequence for Rev B |
|---|---|---|---|
| USB-C VBUS → VIN | D2 LMBR4010 Schottky | VBUS (castellation 14) is the connector rail **before** the diode | 5V pad = USB present detector ✓ (USB inhibit input) |
| Battery → VIN | Q1 LP0404N3T5G P-MOSFET, gate = VBUS (R9 100 kΩ to GND, C10 1 µF) | on battery power (VBUS = 0) Q1 conducts, VIN = VBAT; with USB, Q1 is off and VIN = VBUS − Vf | battery path and USB path never backfeed the 5V pad (D2 reverse-blocks) |
| 3V3 | U3 SGM6029CYG buck, 470 nH, EN tied to VIN | always on whenever VIN > UVLO | 3V3 pad is live whenever battery or USB exists; FB1 → ADC DVDD |
| Charger | U4 SGM40567-4.2XG, IREF R10 220 kΩ → "ICharge = 24000/220K = 110 mA", NCHG LED + R11 10 kΩ to VBUS | charges the cell on BAT+ from VBUS whenever USB present | the battery on J1 is charged by the module at ≈ 110 mA (Sense v1.5) |
| Battery pad | BAT0 (VBAT) / GND0, C26 1 µF | BAT+ is the pad farther from the USB connector; "closest to USB is negative" (wiki) | matches the Rev B post location |

## 3. Findings

1. **Charge current differs between plain and Sense** (wiki: plain "50 mA fast / 3.8 mA trickle", Sense "100 mA / 0.9 mA"; the available schematic sets 110 mA via R10 = 220 kΩ). Therefore the files Seeed serves as "plain" **are not the plain BOM**; at least R10 differs. This is direct evidence that the Sense CAD is not exact plain-module data (it does not show the *geometry* differs).
2. **Charger chemistry:** SGM40567-4.2 terminates at 4.2 V → the cell must be 4.2 V Li-ion/LiPo with its own protection (PCM). Rev B has no cell protection or reverse-polarity protection: swapping the JST-PH leads puts the battery in reverse on the module's BAT pad (documented in the install procedure as a check, not prevented).
3. **No Rev B path charges or powers the AFE from USB:** the hardware inhibit (Q3001 gate from XIAO_5V through R3006/R3004: 4.09–4.77 V at VBUS 4.5–5.25 V, ≫ VGS(th) ≤ 2.5 V; AFE_EN pulled to a few mV through Rdson ≈ 7.5 Ω against the 10 kΩ from D3) disables the AFE while USB is attached, independent of firmware.
4. **UART0 pins used as GPIO:** D6 (GPIO43 TX) and D7 (GPIO44 RX) carry USB_PRESENT / CS_N; the ROM bootloader writes its log on GPIO43 at boot. Harmless electrically; the console must be USB-CDC.
5. **GPIO3 (D2) is a strapping pin** with a 10 kΩ pull-up (R7104) — normal state high; to confirm on the real module that boot mode, USB-JTAG and download are unaffected.
6. **AFE off + MCU on:** ADS131M04 is then powered on DVDD only (AVDD = 0 V) while the MCU drives SCLK/MOSI/CS/SYNC. Input protection structures of the ADC were not re-read in this session → bench check of supply current and no latch-up (§5).
7. **VBAT_SENSE** 1 MΩ/1 MΩ: ≈ 2.1 µA continuous drain; accuracy limited by ADC input leakage and 100 nF settling (tens of ms).

## 4. Operating modes

| Mode | VBUS | VBAT | 3V3 | AFE_3V0 | Expected |
|---|---|---|---|---|---|
| Battery only | 0 V | 3.0–4.2 V | 3.3 V (buck from VBAT) | 0 until D3 high | normal operation; 5V pad < 0.5 V |
| USB only (no cell) | 4.5–5.25 V | charger output | 3.3 V | **0** (inhibited) | programming / debug; AFE cannot start |
| USB + cell | 4.5–5.25 V | charging at ≈ 110 mA | 3.3 V | **0** | charge; AFE inhibited |
| Reset / boot | any | any | 3.3 V | 0 (R3008 pull-down) | AFE_EN low until firmware drives D3 |
| Cell removed, USB absent | 0 | 0 | 0 | 0 | everything off |

## 5. Still requires bench testing on one real module (ordered by value)

1. Confirm the board marking / revision and measure which charger resistor and current the **plain** module has (R10; charge current at 3.8 V cell with a bench supply).
2. 5V pad: 0 V on battery, 4.5–5.25 V with USB, and that it reaches Q3001's gate threshold: AFE_3V0 < 0.3 V within 10 ms of plugging USB with D3 high (procedure Step 10.5).
3. Boot: D2/D3/D6/D7 levels during reset and boot-log activity on D6; AFE_EN stays < 0.1 V through reset and firmware start.
4. Supply current: module + Rev B at 3.8 V, AFE off (target sub-10 mA idle) and the 25–80 mA first-power window in the procedure; ADS131M04 with AVDD = 0 and DVDD = 3.3 V.
5. VBAT_SENSE accuracy against a DMM at 3.0 / 3.7 / 4.2 V.
6. BAT+ post joint resistance (< 5 mΩ loop) and the 12 neighbouring-castellation isolation checks (procedure Step 9).
7. Charger behaviour with the real cell (1S LiPo with PCM, 4.2 V termination, 110 mA vs the cell's C-rate) and thermal rise of U3/U4 on the module with the board's 4.7 Ω supply filter in series.

## 6. Classification (electrical)

| Item | Result |
|---|---|
| Pin numbering and function mapping, 14/14 | **PASS** (against the Sense v1.5 schematic / PCB net names) |
| Interface levels and boot-time states | **PASS** (analysis) — bench items 3 |
| Power architecture | **CONDITIONAL** (charger variant of the plain module unconfirmed; no cell protection on Rev B; polarity not protected) |
| USB inhibit | **PASS (analysis)**, bench item 2 mandatory before electrodes |
| 5 V backfeed / back-power through interface pins | none found (analysis); AFE-off/MCU-on case is a bench item |
