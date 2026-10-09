# ARTHUR EMG Rev A - Safety Assumptions (NOT compliance)

This device is NOT body-safe, NOT galvanically isolated, and NOT IEC 60601 compliant. Electrodes MUST NOT be connected while USB is attached.

## Assumed operating rule

- OFF-BODY charging/data only, electrodes disconnected. ON-BODY acquisition battery-only, USB physically detached.
- AFE_DISABLE (VBUS -> NFET -> AFE_ENABLE low -> TPS7A20 off) is defense-in-depth only. It removes AFE power; it does not isolate, limit leakage, or disconnect electrodes.
- No single-fault claim. No leakage-current allocation. No creepage/clearance finding. No coating/potting decision.

## Conductive paths (USB connected, electrodes hypothetically attached - FORBIDDEN state)

1. ELECTRODE_P/N -> 2.2k series -> ADC_P/N -> ADS1294 IN1-4 -> AVSS/DGND -> GND -> USB-C GND + TPD4E05U06 ground.
2. ELECTRODE_P/N -> 390k bias -> VCM (RLDREF) -> ADS1294 -> GND -> USB ground.
3. RLD_ELECTRODE -> 100k R_RLD_SAFETY -> RLDOUT -> ADS1294 -> GND -> USB ground.
4. MCU SPI/control -> 6x Ioff buffers (Hi-Z when AFE down) -> ADS1294 digital pins; MISO/DRDY_N reverse direction unbuffered. Without buffers this path back-powers the ADC; buffers are the Rev A fix.
5. USB_VBUS -> BQ24074 IN -> SYS_RAW -> TPS63031 -> 3V3 -> all IC grounds; USB_D+/D- -> ESD -> MCU USB pins; USB_SHIELD floating (ERC warning, TBD).
6. SWD GND common with target ground.

## RLD safety-resistor assumption (NOT a finding)

- 100k bounds DC single-fault to ~30uA at 3.0V. This is order-of-magnitude reasoning, not a 60601 auxiliary-current verdict. RLD loop AC drive is preserved (100k << servo load at EMG frequencies with expected cable C).
- Stability with cable capacitance >~1nF unproven. Protection-device leakage (if TVS populated) shifts bias and adds noise - default DNP.

## What must happen before any on-body test

- IEC 60601 risk file, leakage/single-fault allocation, creepage/coating, connector keying, enclosure/shield plan, charger-fault analysis, firmware safe-state review, and independent safety review.
