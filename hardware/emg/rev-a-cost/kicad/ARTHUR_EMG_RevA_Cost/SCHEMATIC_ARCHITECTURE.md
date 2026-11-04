# ARTHUR EMG Rev A schematic architecture

Status: **architecture draft; not approved for connection to a person**  
Scope: schematic hierarchy only. The existing PCB file and all manufacturing outputs are unchanged.

## Hierarchy and ownership

| Sheet | Owns | Interfaces |
|---|---|---|
| `power_charging.kicad_sch` | LiPo connector, BQ24074 charger/power path, raw system rail | `USB_VBUS` in; `SYS_RAW`, `BAT+`, `CHG_N`, `PGOOD_N` out |
| `usb_c_interlock.kicad_sch` | USB-C receptacle, CC termination, ESD device, USB-present analog-disable path | `USB_VBUS`, `USB_D+`, `USB_D-`, `AFE_ENABLE` |
| `analog_power.kicad_sch` | TPS63031 3.3 V converter and TPS7A2030 low-noise 3.0 V AFE rail | `SYS_RAW`, `AFE_ENABLE` in; `3V3`, `AFE_3V0` out |
| `reference_vcm.kicad_sch` | Shared ADS1294 common-mode/reference distribution and driven-reference electrode interface | `VCM`, `RLDOUT` in |
| `emg_channel.kicad_sch` | One bipolar electrode input and its symmetric input/bias/filter network | Instantiated four times; `VCM` in; `ADC_P`, `ADC_N` out |
| `adc.kicad_sch` | ADS1294, reference/bypass capacitors, four simultaneous input pairs, SPI/control | Four differential channels, `VCM`, `RLDOUT`, SPI/control, `AFE_3V0`, `3V3` |
| `mcu_ble.kicad_sch` | MDBT50Q-1MV2 nRF52840 module, USB device endpoint, ADC control/status | USB, SPI/control, charge status, SWD |
| `debug.kicad_sch` | ARM Cortex 10-pin SWD target connector | `SWDIO`, `SWDCLK`, `MCU_RESET_N`, target `3V3`, `GND` |

Power and signal dependencies flow from the external sources to the charger, system rails, AFE/MCU, and then the digital data path. The only intended feedback loop is the ADS1294 right-leg-drive/reference loop. `USB_VBUS`, the BQ24074 power path, the TPS63031 rail, the TPS7A2030 AFE rail, and the ADS1294 reference each have one owning sheet.

## Verified parts and pin contracts

The following manufacturer sources were checked before the symbols were connected. The symbol pin numbers in the schematic follow these sources directly.

| Part | Role | Source checked |
|---|---|---|
| BQ24074RGTR | Li-ion charger and power path | [TI BQ24074 datasheet](https://www.ti.com/lit/ds/symlink/bq24074.pdf) and [current product page](https://www.ti.com/product/BQ24074) |
| TPS63031DSKR | Fixed 3.3 V buck-boost | [TI TPS63031 datasheet](https://www.ti.com/lit/ds/symlink/tps63031.pdf) |
| TPS7A2030PDBVR | Fixed 3.0 V low-noise LDO | [TI TPS7A20 datasheet](https://www.ti.com/lit/ds/symlink/tps7a20.pdf) |
| ADS1294IPAG | Four-channel simultaneous 24-bit biopotential ADC | [TI ADS1294 datasheet](https://www.ti.com/lit/ds/symlink/ads1294.pdf) and [current product page](https://www.ti.com/product/ADS1294) |
| TPD4E05U06DQAR | Four-channel USB/CC ESD protection | [TI TPD4E05U06 datasheet](https://www.ti.com/lit/ds/symlink/tpd4e05u06.pdf) |
| MDBT50Q-1MV2 | nRF52840 BLE/USB module | [Raytac product/specification page](https://www.raytac.com/product/ins.php?index_id=89) and [Nordic nRF52840 product specification](https://docs.nordicsemi.com/bundle/ps_nrf52840/page/keyfeatures_html5.html) |
| USB-C receptacle | USB 2.0 sink/device | [USB-IF USB Type-C specification](https://www.usb.org/document-library/usb-type-cr-cable-and-connector-specification-release-25) |
| ARM Cortex debug connector | SWD target interface | [Arm Cortex Debug 10-pin definition](https://developer.arm.com/documentation/101416/latest/Hardware-Description/Target-Connectors/Cortex-Debug--10-pin) |

Verified implementation details used without extrapolation:

- TPS63031 passives are the fixed-3.3 V typical-circuit values: 1.5 µH, 10 µF input, 0.1 µF VINA bypass, and two 10 µF output capacitors. Final part numbers and derating still require layout-stage review.
- TPS7A2030 has the datasheet-minimum 1 µF input and output capacitors.
- ADS1294 supply/reference capacitors follow its Figure 106 values. The internal 2.4 V reference and internal RLD common-mode source require firmware configuration and are not power-on defaults.
- The RLD feedback values are the 1 MΩ and 1.5 nF values shown in the ADS1294 typical application. The patient-side series safety resistor remains unspecified.
- The USB-C CC1 and CC2 sink terminations are each 5.1 kΩ.
- nRF52840 normal-voltage mode ties `VDD` and `VDDH` to `3V3`; USB `VBUS`, `D+`, `D-`, SWDIO, and SWDCLK use their dedicated module pins.
- The selected nRF52840 GPIOs are configurable digital GPIOs: P0.13 SCLK, P0.14 MOSI, P0.15 MISO, P0.16 CS, P0.17 DRDY, P0.19 START, P0.20 RESET, P0.21 PWDN, P0.22 reserved AFE disable, P0.23 charge status, and P0.24 power-good.

## Hardware interlock behavior

USB VBUS drives an N-channel MOSFET gate. When USB is present, the MOSFET pulls `AFE_ENABLE` low and disables the TPS7A2030 analog rail independently of firmware. The pull-up and gate-discharge resistor values, MOSFET vendor/footprint, and failure analysis are still open.

This interlock removes AFE power. It does **not** provide galvanic isolation, enforce patient leakage current limits by itself, or physically disconnect the electrodes. USB operation while electrodes are attached therefore remains prohibited until the full safety architecture is reviewed and validated.

## Deliberately unresolved electrical work

These items are visible as `TBD` values or explicit notes in the schematic and must be resolved before PCB layout:

1. Select the LiPo cell/pack, capacity, permitted charge C-rate, connector pin order, NTC curve, and protection arrangement; then calculate BQ24074 `ISET` and `ILIM` from the datasheet.
2. Allocate USB current, inrush, cable-drop, and battery/system load budgets. Confirm the fixed BQ24074 `EN1`/`EN2` mode and start-up behavior over the complete battery range.
3. Define electrode impedance, wanted EMG passband, input-referred-noise budget, recovery time, ESD/defibrillation exposure, leakage current, creepage/clearance, and single-fault limits. Only then select each channel's series resistors, bias resistors, differential capacitor, and clamp/protection device.
4. Complete the IEC 60601 risk analysis. Select the driven-reference series resistor and determine whether electrode disconnection, isolation, current limiting, or a different charging/use architecture is required.
5. Verify that USB insertion cannot back-power the unpowered ADS1294 through SPI/control or analog pins. Add series isolation, level isolation, or sequencing if required.
6. Decide whether a later revision needs an MCU-requested AFE shutdown in addition to the USB-present hardware path; no MCU GPIO is connected to `AFE_ENABLE` in this architecture.
7. Select the exact USB-C receptacle, LiPo/electrode/reference connectors, 2N7002 vendor, capacitor/inductor parts, and all footprints. USB shield/chassis coupling waits for the enclosure and EMC plan.
8. Confirm ADS1294 clock/start strategy and firmware initialization, including `PD_REFBUF`, reference voltage selection, `RLDREF_INT`, `PD_RLD`, channel configuration, lead-off behavior, and safe fault states.
9. Define production SWD access, APPROTECT/debug-lock policy, and recovery method.

## Verification and observability

The design exposes charger `CHG_N` and `PGOOD_N`, ADS1294 `DRDY_N`, USB VBUS presence, SWD, and the explicit AFE enable contract. ADS1294 internal test sources can provide a digital/acquisition test seam after firmware initialization is defined.

KiCad 10.0.6 parses and upgrades all sheets. ERC is run without exclusions; its machine-readable report is `ARTHUR_EMG_RevA-erc.json`. The remaining report is intentionally retained and summarized in `ERC_UNRESOLVED.md` rather than suppressed.
