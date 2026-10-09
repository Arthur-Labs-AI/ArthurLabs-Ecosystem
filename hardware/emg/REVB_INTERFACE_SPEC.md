# A.R.T.H.U.R EMG Rev B — Interface Specification (RB-00)

Target brain: **Seeed Studio XIAO ESP32S3 plain (Seeed PN 202003751, v1.4; not Sense, not Plus)**, frozen in RB-00.5. See §8 for the pad contract and [REVB_RB00_CLOSURE.md](REVB_RB00_CLOSURE.md) for the residual geometry check.
Pin facts verified against the Seeed Wiki (XIAO ESP32S3 getting started) and the Espressif ESP32-S3 Datasheet v2.2 (Table 2-2 power-up glitches, strapping pins).

## 1. XIAO pin map (Rev B, direct mount)

| XIAO pin | ESP32-S3 GPIO | Rev B signal | Dir (brain view) | Board-side network | Boot-state hazard (verified) | Verdict |
|---|---|---|---|---|---|---|
| D0 | GPIO1 (ADC1) | VBAT_SENSE | in (analog) | 1 M/1 M + 100 nF from VBAT | 60 µs low glitch at power-up: dips the divider node only | **OK** |
| D1 | GPIO2 | DRDY_N | in (IRQ) | 100 Ω series at the ADC DRDY | 60 µs **low-drive** glitch while the ADC may drive high → contention limited by 100 Ω. ADC is in POR at the same moment (same 3V3) | **OK with R_DRDY** |
| D2 | GPIO3 | SYNC/RESET_N | out | 10 k pull-up to DVDD_F | GPIO3 is a strapping pin (JTAG source select); it only matters if EFUSE_STRAP_JTAG_SEL is burned, which it is not by default. The 60 µs low glitch is shorter than the 2048 tCLKIN = 250 µs reset threshold → at most a SYNC | **OK** (never burn the JTAG strap efuse) |
| D3 | GPIO4 | AFE_EN_REQ | out | 10 k series → EN; 100 k pull-down on EN | The 60 µs low glitch is the **safe** direction | **OK** |
| D4 | GPIO5 | SDA (optional) | i/o | DNP 4.7 k pull-ups, DNP ID EEPROM | — | Reserved |
| D5 | GPIO6 | SCL (optional) | out | same | — | Reserved |
| D6 | GPIO43 (U0TXD) | USB_PRESENT (sense only) | in | 5V → 100 k → D6 → 150 k → GND | **UART0 TX drives the boot log** (WPU at reset). Must never feed EN or any control node. Only ≈ 33 µA contention into the divider | **OK, sense only** |
| D7 | GPIO44 (U0RXD) | CS_N | out | 100 k pull-up to DVDD_F | WPU at reset, input during boot → CS stays high | **OK** |
| D8 | GPIO7 | SCLK | out | 33 Ω at the XIAO end | 60 µs low glitch = idle level (CPOL = 0) | **OK** |
| D9 | GPIO8 | MISO ← DOUT | in | 33 Ω at the ADC end | 60 µs low glitch vs DOUT; DOUT is idle/POR at that time; 33 Ω limits | **OK** |
| D10 | GPIO9 | MOSI → DIN | out | 33 Ω at the XIAO end | Low glitch harmless (CS high) | **OK** |
| 5V | USB VBUS | VBUS_SENSE (inhibit + D6 divider) | — | **4.7 k to GND**; 10 k → Q3001 gate, 100 k gate PD; 100 k/150 k → D6 | Verified from Seeed's module netlist: pin 14 = raw VBUS (XIAO R9 100 k to GND). The XIAO D2 Schottky (LMBR4010, IR ≤ 30 µA @10 V) leaks VIN→VBUS on battery. The 4.7 k keeps it ≤ 0.42 V (100 µA allowance) → Q3001 off | **OK** (confirm at bring-up) |
| 3V3 | — | 3V3 → FB1 → DVDD_F | out (power) | ferrite + 10 µF + 100 nF | SGM6029 **buck** output (not an LDO); ≤ 700 mA available (wiki); Rev B uses ≤ 5.5 mA | **OK** |
| GND | — | GND | — | solid plane | — | **OK** |
| BAT+ (bottom pad) | — | VBAT | bidirectional | J_BAT pin 1, LDO feed | RB-00.6: AWG 24 post soldered to the pad before mounting → plated hole → underside joint | **OK** |
| BAT− (bottom pad) | — | GND | — | — | **Not soldered** (RB-00.6); BAT− current returns via castellation pin 13 (same module GND net) | **OK** |

The proposed mapping from the RB-00 prompt is **confirmed**, with three amendments:
1. D6 may only be a sense input; it can never be a control output.
2. Add a 100 Ω DRDY series R.
3. Never burn the GPIO3 JTAG strap efuse.

SPI pins D8–D10 map to GPIO7/8/9, which are routable to the S3's FSPI/SPI2 through the GPIO matrix. At the planned SCLK (≤ 8 MHz), matrix routing is fine.

## 2. ADC interface (ADS131M04, verified SBAS890D)

| Signal | ADC pin (TSSOP-20) | Level | Notes |
|---|---|---|---|
| SYNC/RESET_N | 11 | DVDD CMOS | Reset ≥ 2048 tCLKIN (250 µs) |
| CS_N | 12 | " | |
| DRDY_N | 13 | output | push-pull |
| SCLK | 14 | " | tc(SC) ≥ 40 ns (25 MHz). **Rev B SCLK = 4–8 MHz** |
| DOUT | 15 | output | |
| DIN | 16 | " | |
| CLKIN | 17 | " | 0.3–8.4 MHz HR mode, duty 40–60 % |
| CAP | 18 | — | 220 nF |
| DGND | 19 | — | |
| DVDD | 20 | 2.7–3.6 V | |

Data rate check: frame = status + 4 ch + CRC = 6 words × 24 bit = 144 bit.
- At 4 kSPS: 576 kbit/s. At SCLK 8 MHz a frame takes 18 µs (7 % duty); at 4 MHz, 36 µs (14 %).

## 3. Clock architecture (verified)

- The ADS131M04 has **no crystal oscillator input**, only CLKIN (the datasheet pin table shows CLKIN only; no XTAL pin exists on the TSSOP-20).
- An external clock is mandatory, and it must run **before and during** a pin reset.
- **Decision: local 8.192 MHz CMOS XO on DVDD_F**, ≤ 5 mm from pin 17, 33 Ω source series.
- **X1 frozen (RB-00.5): YXC OT2JI-111-8.192M, JLC C7425393, SMD3225-4P.**
  - Pin 1 OE → DVDD_F (never float), 2 GND, 3 OUT → 33 Ω → CLKIN, 4 VDD with 100 nF.
  - Checked: VOH ≥ 0.9·VDD, VOL ≤ 0.1·VDD, duty 45–55 %, start-up ≤ 3 ms, ≤ 5 mA, 15 pF load, ±20 ppm.
  - Land pattern: pads 1.3 × 1.2 mm, gaps 0.8/0.7 mm.
- Rejected alternative: ESP32 LEDC/CLK_OUT. It gives an 8.000 MHz fractional/integer clock, which is not 8.192, with jitter. It routes a continuous clock across the boundary, needs a spare pin (none free), and ties sample timing to the brain.
- With the local XO, ODR = 8.192 MHz / (2 × OSR) gives the exact binary rates (e.g., OSR 1024 → 4 kSPS, OSR 2048 → 2 kSPS).

## 4. Fail-safe AFE enable truth table

Circuit:
- D3 → 10 k → **AFE_EN** (TPS7A20 EN).
- AFE_EN → 100 k → GND (plus the internal 500 k smart pull-down).
- Q3001 2N7002: drain = AFE_EN, source = GND, gate = VBUS_GATE.
- XIAO 5V → 10 k → VBUS_GATE, with 100 k → GND.

TPS7A20: ON if EN > 0.9 V, OFF if EN < 0.3 V.

| # | Scenario | D3 | XIAO 5V | Q3001 | AFE_EN | AFE_3V0 | Hardware-guaranteed? |
|---|---|---|---|---|---|---|---|
| 1 | Normal acquisition, battery only | High (3.3 V) | 0 V | off | ≈ 3.0 V (10 k/100 k ‖ 500 k divider) | **ON** | — |
| 2 | FW idle / not requesting | Low | 0 V | off | 0 V | OFF | yes |
| 3 | USB inserted, FW requests | High | 5 V | on | ≈ 1 mV | **OFF** | **yes**, independent of FW |
| 4 | USB inserted, FW crashed with D3 stuck high | High | 5 V | on | ≈ 1 mV | OFF | yes |
| 5 | MCU in reset / boot ROM / download mode | Hi-Z | any | any | 0 V (pull-downs) | OFF | yes |
| 6 | Power-up glitch on GPIO4 | Low 60 µs | any | any | 0 V | OFF | yes (glitch is low) |
| 7 | Deep sleep (no GPIO hold) | Hi-Z | any | any | 0 V | OFF | yes |
| 8 | XIAO unpowered / 3V3 dead, battery present | 0 V | 0 V | off | 0 V | OFF | yes |
| 9 | XIAO physically removed | open | open (R3004 → 0 V) | off | 0 V | OFF | yes |
| 10 | USB present, XIAO dead/unprogrammed | Hi-Z/low | 5 V | on | 0 V | OFF | yes |
| 11 | Battery removed, USB present | any | 5 V | on | 0 V | OFF (and LDO IN = 0) | yes |
| 12 | Future FPC brain unplugged | open | open | off | 0 V | OFF (no VIO, no VBAT) | yes |
| 13 | D3 shorted to 3V3 (fault), USB absent | High | 0 V | off | 3.0 V | **ON** | single fault. Acceptable: this is the same as a valid request with no USB |
| 14 | Q3001 open-circuit fault, USB present, D3 high | High | 5 V | off | 3.0 V | **ON** | **Not covered**. Single point. FW backup: D6 USB_PRESENT → FW drops D3. Defense-in-depth only |
| 15 | XIAO D2 reverse leakage lifts 5V on battery | High | ≤ 0.42 V (4.7 k load) | off | 3.0 V | ON (correct) | Resolved in RB-00.5. Without the 4.7 k it would be a false permanent inhibit (fail-safe) |

This remains **defense-in-depth**, not a safety barrier. The Rev A operating rule is unchanged: no electrodes on the body while USB is connected, and no isolation is claimed.

## 5. Required interconnect signal set (Rev B, minimum)

| # | Signal | Needed because |
|---|---|---|
| 1 | GND | reference/return |
| 2 | VBAT | AFE LDO supply, XIAO battery |
| 3 | 3V3 (VIO) | DVDD, XO, pull-ups; defines the logic level |
| 4 | 5V/VBUS sense | hardware inhibit |
| 5 | SCLK | SPI |
| 6 | MOSI | SPI |
| 7 | MISO | SPI |
| 8 | CS_N | SPI |
| 9 | DRDY_N | sample timing IRQ |
| 10 | SYNC/RESET_N | reset + multi-device sync |
| 11 | AFE_EN_REQ | MCU half of the AND interlock |
| 12 | VBAT_SENSE | low-battery cutoff (S3 has none onboard) |
| 13 | USB_PRESENT | FW visibility of the inhibit (optional) |
| 14–15 | SDA/SCL | optional ID / future sensors |

**Not needed:** CLKIN (local), PWDN, START (the ADS131M04 has neither pin), UART, SWD.

## 6. Test pads (bare copper, no vias in pads, no stubs on hi-Z/clock/SPI)

| Pad | Net | Side |
|---|---|---|
| TP1 | VBAT | B.Cu (fab-only, no assembly) |
| TP2 | AFE_3V0 | B.Cu |
| TP3 | DVDD_F | B.Cu |
| TP4 | VCM | B.Cu (via ≥ 0.3 mm from any pad) |
| TP5 | RLD_SAFE | B.Cu |
| TP6 | AFE_EN | B.Cu |
| TP7, TP8 | GND (analog end, brain end) | B.Cu |

SPI, DRDY, SYNC and CLKIN are probed at the XIAO castellations, the series resistors or the XO pad.

## 7. Future Sensor Bus (16-pin 0.5 mm FPC): assessment

Proposed pinout reviewed:

| Pin | Signal | Comment |
|---|---|---|
| 1 | VBAT | **Single pin is weak** for a brain drawing 300 mA bursts (0.5 mm FPC ≈ 0.5 A/contact). OK for the AFE only (≤ 15 mA). If the brain is remote and the battery lives on the EMG side, use 2 pins |
| 2 | GND | |
| 3 | VIO | Must be **2.7–3.6 V** (ADS DVDD constraint). Document this, because a 1.8 V brain is not supported without a DVDD/CAP change or level shifting |
| 4 | GND | |
| 5 | SCLK | GND-flanked ✓ |
| 6 | GND | |
| 7 | MOSI | |
| 8 | MISO | MOSI and MISO are adjacent, with no GND between. Acceptable ≤ 10 cm at ≤ 8 MHz |
| 9 | GND | |
| 10 | CS_N | |
| 11 | DRDY_N | |
| 12 | SYNC/RESET_N | |
| 13 | AFE_EN_REQ | Needs a pull-down on the EMG side (it has one) → an unplugged cable = OFF ✓ |
| 14 | INHIBIT | Define as **brain-driven, active-high** (high = USB present or brain-side fault). The EMG side ORs it into the Q3001 gate (diode-OR or a second NFET in parallel) with a 100 k pull-down. With an unplugged cable, VIO is lost too → OFF ✓ |
| 15 | SDA | |
| 16 | SCL | |

Verdict: **reasonable** as an in-enclosure bus (≤ 10 cm, ≤ 8 MHz SCLK), with three changes:
- Document VIO ≥ 2.7 V.
- Consider a second VBAT or GND contact if the brain draws its burst current through it.
- Specify INHIBIT as brain-driven, active-high, ORed into the hardware inhibit.

**Not populated in Rev B.** There is no strong reason: it adds an extended part, cost and an unused high-impedance connector near the SPI. Keep it as a documented contract only.

## 8. XIAO pad contract (RB-00.6 hand-solder footprint `ARTHUR:XIAO_ESP32S3_HANDSOLDER`; see [REVB_XIAO_MOUNTING_SPEC.md](REVB_XIAO_MOUNTING_SPEC.md))

RB-00.6 solders **only pads 1–14 and the BAT+ post**. The table keeps all module features for reference; "not soldered" rows get F.Cu keep-out and no vias.

| Pad | Function (module netlist) | Rev B net |
|---|---|---|
| 1–7 | D0 … D6 | per §1 |
| 8–11 | D7, D8, D9, D10 | CS_N, SCLK, MISO, MOSI |
| 12 | 3V3 (SGM6029 buck output) | XIAO_3V3 → FB1 |
| 13 | GND | GND |
| 14 | 5V = raw VBUS | XIAO_5V |
| 15 / 16 | MTDI (IO41) / MTDO (IO40) | **Not soldered**; F.Cu keep-out |
| 17 | EN (chip reset) | **Not soldered**; F.Cu keep-out |
| 18 | GND | **Not soldered**; F.Cu keep-out |
| 19 / 20 | MTMS (IO42) / MTCK (IO39) | **Not soldered**; F.Cu keep-out |
| 21 / 22 | ESP_USB_D− / D+ | **Not soldered**; F.Cu keep-out |
| 23 (BAT0) | BAT+ | VBAT through the **post** into the plated Ø1.40 hole at board (68.335, 21.862) |
| 24 (GND0) | BAT− | **Not soldered**; F.Cu keep-out (BAT− via pin 13) |
| 25 | Exposed GND window (2.75 × 2.5) | **Not soldered**; F.Cu keep-out |

## 9. ADC gain contract

- PGA gain **≥ 4** on all channels while the ADC-input clamps are fitted. **Planned gain is 8–32.**
- At gain ≥ 8 the AIN window is AGND − 1.3 V … AVDD − 1.8 V (≈ 1.155 V min AVDD). The GND-referenced input bias (≈ 0 V) is inside it.
