# ARTHUR EMG Rev A - Electrical Design Freeze

Status: freeze candidate. NOT approved for connection to a person. NOT IEC 60601 compliant.
Scope: schematic only. No PCB placement/routing. No Gerbers/BOM/CPL.
Date: 2026-09-20. Tool: KiCad CLI 10.0.6. Datasheet: TI ADS129x SBAS459K.

## 1. ADS1294 freeze

- 64-pin symbol rechecked vs datasheet pin table: IN1-8P/N, TESTP/N, AVDD/AVSS banks, VREFP/N, VCAP1-4, DVDD/DGND, DIN/CS/SCLK/DOUT/DAISY_IN/GPIO1-4/DRDY_N, PWDN/RESET/CLK/START, CLKSEL, RLDREF/RLDINV/RLDIN/RLDOUT, WCT, RESV1, NC.
- DAISY_IN -> DGND when unused. RESV1 -> DGND. TESTP/N, WCT unconnected. GPIO1-4 unconnected (firmware spare).
- Absmax: AVDD-AVSS -0.3..5.5V; DVDD-DGND -0.3..3.9V; analog in AVSS-0.3..AVDD+0.3V; digital in DGND-0.3..DVDD+0.3V; momentary 100mA; continuous 10mA.
- Oper: AVDD 2.7..5.25V (3.0V nominal); DVDD 1.65..3.6V (3.3V nominal). HBM/CDM ratings are manufacturing-only, not patient protection.
- CH5-CH8 correction: footnote (1) says connect unused pins to AVDD; CH5SET/CH6SET and CH7SET/CH8SET registers do not exist on ADS1294; RLD/LOFF bits 4-7 unavailable. Freeze: IN5-8P/N tied AVDD, CH5-8 registers untouched, RLD/LOFF bits 4-7 written 0.
- VCAP1 22uF to AVSS; VCAP2/3/4 1uF each to AVSS. Local AVDD/DVDD 1uF+0.1uF at pins.
- Reference: internal 2.4V (CONFIG3 VREF_4V=0, PD_REFBUF=1). VREFN=AVSS. 4V ref NOT used (needs 5V AVDD).
- AVSS/DGND single-point join at ADC (layout rule).
- Bring-up follows Figure 93 flow (POR/VCAP1>1.1V wait, CLKSEL settled, SDATAC before WREG, input-short noise check). Exact Section 11.1 sequencing text still to confirm (blocker).
- Clock internal 2.048MHz (CLKSEL=1, CLK_EN=0). HR mode: fMOD=fCLK/4=512kHz.
- Nominal 2kSPS: DR=100, fMOD/256. BW=0.262xfDR=524Hz. No 50Hz analog notch (DSP only).
- Debug 4kSPS: DR=011, fMOD/128. BW=1048Hz. Firmware-only switch, same analog network.
## 2. EMG input network (x4 identical)

Topology: ELECTRODE_P/N -> R_SER 2.2k (x2) -> node -> C_CM 470pF to GND DNP (x2) -> ADC_P/N; C_DIFF 4.7nF across ADC_P/N; R_BIAS 390k each node to VCM.
Basis: ADS129x Sec 10.1.3 / Fig 96 (gentle RC anti-alias, mismatch-to-CMRR warning) and Fig 94 RLD loop class.

Freeze values: R_SER 2.2k 1% 0603; C_CM 470pF C0G 0603 DNP; C_DIFF 4.7nF C0G 0603; R_BIAS 390k 1% 0603; clamp dual-TVS SOT-23-3L footprint DNP (3.3V VRWM class).

Calculations:
- Diff pole: R=2x2.2k=4.4k, C=4.7nF -> f=1/(2*pi*4400*4.7e-9) ~= 7.7kHz. Above 524Hz BW, gentle anti-alias with PGA+decimation per datasheet.
- CM pole (if populated): 1/(2*pi*2200*470e-12) ~= 154kHz RFI shunt, negligible in-band shift.
- Bias offset: 200pA bias x 390k = 78nV. 10mV electrode mismatch -> ~56uV after divider, inside PGA headroom at gain<=12, 2.4V ref.
- Resistor noise per 2.2k leg over 524Hz ~= 138nVrms; pair ~= 195nVrms differential; below ADC shorted-input noise class.
- Fault (defense only, NOT safety rating): 3.3V/2.2k=1.5mA per leg; AVDD+0.3V overdrive stays under 10mA continuous absmax.
- CMRR: 1% mismatch into 390k + 500MOhm ADC Zin keeps mismatch error small pre-RLD; RLD adds active suppression. Full budget needs measured electrode Z (blocker).
- Offset/motion: NO series blocking cap (avoids tails/bias fight). Handled by PGA headroom + digital HP/detrend + RLD centering + bias Rs. Blocking-cap variant is Rev B if measured artifact demands it.
- RFI: series 2.2k + optional 470pF + symmetric short routing; no ferrite in signal path.

## 3. RLD / reference

- RLDREF internal (RLDREF_INT=1, PD_REFBUF=1): (AVDD-AVSS)/2 = 1.5V nominal. VCM net = RLDREF-derived bias star.
- RLDIN tied RLDOUT on-board (loop closed) per sample flow.
- RLDINV comp: 1M 1% + 1.5nF C0G (Fig 94 class).
- Derivation: RLD_SENSP/SENSN = CH1-4 P+N (0x0F each); bits 4-7 = 0 (unavailable).
- R_RLD_SAFETY = 100k 1% 0805 long-creepage class. 3.0V/100k=30uA DC worst single-fault; order-of-magnitude thinking only, NOT an IEC finding. Loop still drives (100k << servo AC load). Cable C beyond ~1nF needs stability re-check (blocker).
- Shared topology: one RLD electrode + one VCM star for 4 forearm channels; per-channel bias returns to VCM star at ADC.

## 4. USB / body safety

- RULE: electrodes MUST NOT be connected while USB is attached. Charge/data only off-body with electrodes disconnected.
- AFE_DISABLE (VBUS NFET -> AFE_ENABLE low -> TPS7A20 off) is defense-in-depth ONLY. Not isolation, not leakage control, not a disconnect.
- Back-power fix: 6x Ioff 3-state buffers (SN74LVC1G125-class SOT-23-5) in MCU->ADC control lines (SCLK, MOSI, CS_N, START, RESET_N, PWDN_N). Buffer VCC=AFE_3V0, OE tied GND (Audit 1: always enabled; powered-down output Hi-Z comes from VCC=0, not from OE). MISO/DRDY_N ADC->MCU unbuffered. AFE_3V0=0 -> Ioff blocks reverse current into the AFE rail.
- No galvanic isolation claimed. No IEC 60601 claimed. USB_SHIELD unconnected (ERC warning retained) until enclosure/EMC plan.

## 5. Power

- Battery assumption: 1S LiPo 3.7V nom 500mAh (503040 class), 10k NTC (103AT-4/B3435 class) + PCM. Assumption only; cell MPN is a blocker.
- BQ24074 USB500 mode (EN1=1/EN2=0, 475mA typ). ICHG=KISET/RISET (KISET typ 890); IIN-MAX=KILIM/RILIM (KILIM typ 1610 for 500mA-1.5A).
- 0.5C 250mA: RISET=890/0.25=3560 -> 3.57k 1%. Input 500mA: RILIM=1610/0.5=3220 -> 3.24k 1%. TS=10k NTC (0-50C default window). ITERM open (10% default). TMR open (default timers).
- TPS63031 fixed 3.3V: startup >=1.8V typ, 500mA at 3.3V boost class, 1.5uH + 10uF in + 2x10uF out + 0.1uF VINA. SYS_RAW (3.0-4.2V batt + 5V USB path) inside range.
- TPS7A2030 fixed 3.0V: 300mA, 7uVRMS noise class, 95dB PSRR@1kHz class, 300mV headroom from 3.3V, 1uF in/out min, EN=AFE_ENABLE.
- Budget: POWER_BUDGET.md. TPS7A20 ~15mA/300mA; TPS63031 peak ~120mA vs 500mA+ capability; USB500 covers system+charge via DPPM.

## 6. MCU

- Keep nRF52840; keep MDBT50Q-1MV2 (integrated antenna). NO CHANGE.
- Vs MDBT50Q-1MEN: 1MEN is a size/antenna-detail variant; 1MV2 matches existing symbol/pin contract + LCSC C608478-class path. Reason documented; re-check live stock at order (blocker).
- P0.22 AFE_DISABLE_REQ stays reserved-unconnected (wired-OR review open, no copper committed).

## 7. Manufacturing

- MPNs/footprints: COMPONENT_SELECTION.md. LCSC/JLCPCB preferred for passives/inductor/buffers/connectors; modules/ICs via LCSC/DK/Mouser as available.
- All DNP/config options flagged (C_CM, TVS, WCT/TEST/GPIO spares, ITERM/TMR opens).
- No Gerbers/BOM/CPL in this pass.

## 8. Verification

- Final ERC (Audit 1): 0 errors / 1 warning / 0 exclusions, no suppressions. Machine report: `ARTHUR_EMG_RevA-erc.json`; human log: `ERC_UNRESOLVED.md`.
- The single warning is the intentional `USB_SHIELD` open. The 20 former co-located `MCU_*` pair warnings are gone with the ADC-side hierarchy cleanup; each `MCU_*` net is netlist-verified end to end (MCU pin <-> buffer A pin).
- Buffer integration (Audit 1 corrected): 6x SN74LVC1G125-class `BUF_IOFF` (SOT-23-5, VCC=`AFE_3V0`, OE tied `GND`) isolate MCU `SCLK/MOSI/CS_N/START/RESET_N/PWDN_N` from ADS1294; `MISO/DRDY_N` stay direct. No `AFE_PWR_GOOD` divider exists (the documented 100k/100k scheme is void: 1.5 V sits inside the OE forbidden band at VCC=3.0 V). `BUF_IOFF` symbol: A upper-left, OE_N lower-left, Y right, VCC bottom-rendered, GND top-rendered; pad mapping by pin number (pad 5 = VCC = `AFE_3V0`, pad 3 = GND). ADC-side `MCU_*` nets run globals-only (no hierarchical ports); see `ERC_UNRESOLVED.md`.

## 9. Blockers

1. Battery MPN + NTC + PCM + connector. 2. Live LCSC/JLCPCB stock at order. 3. IEC 60601 risk file + creepage/coating + leakage allocation. 4. RFI campaign + measured electrode Z/artifact. 5. ADS1294 Sec 11.1 sequencing confirm + firmware register review + APPROTECT. 6. Enclosure/EMC shield strategy. 7. Apply schematic edits + clean ERC before layout.
