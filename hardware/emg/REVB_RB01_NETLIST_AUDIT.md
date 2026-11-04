# A.R.T.H.U.R EMG Rev B — RB-01 Netlist Audit

> **RB-01R (2026-10-10):** historical RB-01 audit. It relied on the generator's intended-net map for X0 and is not an independent oracle. It is superseded by `rev-b-xiao/tools/rb01r_netlist_audit.py` + `test_audit_mutations.py` (fresh KiCad export, REVB_RB01R_INDEPENDENT_REVIEW.md §2). X1 in row P2 is now the SCTF SX3M8.192M20F30TNN; connectivity is unchanged (357 pins identical).

Source: `hardware/emg/rev-b-xiao/kicad/ARTHUR_EMG_RevB/ARTHUR_EMG_RevB.kicad_sch`, netlist exported with
`kicad-cli sch export netlist --format kicadxml` (10.0.6) from the files in the repo location.

Totals: **135 components, 90 nets (incl. 18 single-pin `unconnected-*` nets for flagged NC pins), 357 pins.**

## Method

1. **Pin-by-pin cross-check (X0).** The generator records the intended net of every pin it connects. Every one of the 357 pins in KiCad's netlist is compared with it; any mismatch or any pin the spec does not mention fails X0.
2. **Named assertions (all others).** Computed **only from KiCad's netlist** (net membership, component values, footprints, the `dnp` / `exclude_from_bom` properties), not from the generator's intent. Resistive-path checks walk resistor/ferrite edges only (capacitors are DC-open; diodes and op-amp outputs are excluded), with GND treated as a sink.
3. **Mutation test.** To prove the checks fire, single seeded faults were written into copies of the netlist and the audit re-run. Every fault was caught by its specific check:

| Seeded fault | Checks that failed |
|---|---|
| J5001.1 moved onto GND (the Rev A defect) | X0, A1, A3 |
| D103.3 moved to the 2.2 µF/100 k node (clamp before the 1 k) | X0, C1, K2, K3 |
| R303 return moved from GND to VCM | X0, C1, K4 |
| U503.3 (+IN) moved onto VCM_DIV (10 k bypassed) | X0, V1 |
| R3008 pull-down disconnected | X0, I1, I4 (+K2 side effect of the chosen target net) |
| U1.7 (D6) wired into AFE_EN | X0, I5, X1 |
| U1.4 (D3) wired directly to AFE_EN | X0, I3, X1 |
| U6001.20 DVDD moved to AFE_3V0 | X0, P1 |
| U6001.17 CLKIN moved to the XIAO D8 net | X0, P2, S1 |
| TP4 moved onto /CH2/HIZ_P | X0, C1, T1 |
| U1.23 BAT+ post moved to VBAT_AFE | X0, P6, X1 |

## Summary

| ID | Assertion | Result |
|---|---|---|
| X0 | Every pin in the KiCad netlist matches the intended connection (pin-by-pin) | **PASS** |
| C1 | Four identical EMG channels with validated topology | **PASS** |
| A1 | J5001.1 has no net | **PASS** |
| A2 | J5001.2 -> R5002 100k -> VCM | **PASS** |
| A3 | No patient connector has a direct 0-ohm path to GND | **PASS** |
| K1 | 8 original electrode-protection BAV199 clamps exist | **PASS** |
| K2 | 8 new ADC-input BAV199 clamps exist (pin1 GND, pin3 AIN, pin2 NC) | **PASS** |
| K3 | Every new ADC clamp is after the 1k series resistor | **PASS** |
| K4 | ADC-side 100k returns remain GND-referenced (not VCM) | **PASS** |
| V1 | U503A +IN has the new 10k series protection; C5001/C5002 stay at the divider node | **PASS** |
| V2 | U503A is the VCM follower; B/C/D wired as VCM followers (TI unused-amp guidance, no DRL loop) | **PASS** |
| P1 | ADS AVDD = AFE_3V0, DVDD = DVDD_F, CAP = 220 nF, AGND/DGND = GND, 1 uF AVDD/DVDD decoupling | **PASS** |
| P2 | ADS CLKIN comes only from X1 (33 ohm source series, 100 nF, OE tied to DVDD_F) | **PASS** |
| P3 | XIAO 3V3 -> FB1 ferrite -> 10 uF + 100 nF -> DVDD_F (not from AFE_3V0) | **PASS** |
| P4 | VBAT -> R4001 4.7 ohm -> C4007 22 uF (+C4005 1 uF) -> TPS7A2030P -> AFE_3V0 | **PASS** |
| P5 | AFE_3V0 powers ADS AVDD, TLV9064 x3, VCM divider and the 8 hi-Z clamp rails only | **PASS** |
| P6 | XIAO BAT+ post (U1 pad 23) = VBAT; J1 pin 1 = VBAT (star), pin 2 = GND; BAT- via castellation 13 | **PASS** |
| I1 | AFE_EN has an external pull-down | **PASS** |
| I2 | USB VBUS (XIAO 5V) hardware can force AFE_EN low via Q3001 | **PASS** |
| I3 | XIAO D3 cannot override the VBUS inhibit | **PASS** |
| I4 | XIAO absent / unpowered leaves the AFE disabled | **PASS** |
| I5 | D6 (USB_PRESENT) is not part of the safety control path | **PASS** |
| I6 | 4.7k XIAO 5V/VBUS load (RB-00.5) | **PASS** |
| X1 | XIAO interface mapping (15 electrical pads: 14 castellations + BAT+ post), U1 DNP | **PASS** |
| S1 | SPI conditioning: 33 ohm SCLK/MOSI (XIAO end), 33 ohm MISO (ADC end), 100 ohm DRDY, CS_N/SYNC pull-ups to DVDD_F | **PASS** |
| B1 | VBAT_SENSE divider 1M/1M + 100 nF -> D0 (labelled VBAT_SENSE) | **PASS** |
| B2 | USB_PRESENT divider XIAO 5V -> 100k -> D6 -> 150k -> GND (sense only) | **PASS** |
| T1 | Test-point policy: only VBAT, AFE_3V0, DVDD_F, VCM, RLD_SAFE, AFE_EN, GND x2; none on hi-Z / AIN / SPI / CLKIN | **PASS** |
| D1 | Removed Rev A subsystems are absent | **PASS** |
| L1 | Every component has value, footprint, datasheet, description and MPN field | **PASS** |

## Evidence

### X0 — Every pin in the KiCad netlist matches the intended connection (pin-by-pin): **PASS**

```
357 netlist pins, 357 intended connections, mismatches=[], pins not in spec=[]
```

### C1 — Four identical EMG channels with validated topology: **PASS**

```
CH1P: U501 +IN=3 OUT=1 -> U6001.3; all topology checks OK
CH1N: U501 +IN=5 OUT=7 -> U6001.4; all topology checks OK
CH1: 10 nF differential C105 across U6001.3/4: True
CH2P: U501 +IN=10 OUT=8 -> U6001.6; all topology checks OK
CH2N: U501 +IN=12 OUT=14 -> U6001.5; all topology checks OK
CH2: 10 nF differential C205 across U6001.6/5: True
CH3P: U502 +IN=3 OUT=1 -> U6001.7; all topology checks OK
CH3N: U502 +IN=5 OUT=7 -> U6001.8; all topology checks OK
CH3: 10 nF differential C305 across U6001.7/8: True
CH4P: U502 +IN=10 OUT=8 -> U6001.10; all topology checks OK
CH4N: U502 +IN=12 OUT=14 -> U6001.9; all topology checks OK
CH4: 10 nF differential C405 across U6001.10/9: True
```

### A1 — J5001.1 has no net: **PASS**

```
J5001.1 -> unconnected-(J5001-Pad1) (single-node unconnected net: True)
```

### A2 — J5001.2 -> R5002 100k -> VCM: **PASS**

```
/Reference_VCM/RLD_SAFE: J5001.2, R5002.2, TP5.1 | R5002 value 100k footprint Resistor_SMD:R_0805_2012Metric | other side /VCM (U503.1 output on it: True)
```

### A3 — No patient connector has a direct 0-ohm path to GND: **PASS**

```
J101.1 net /CH1/ELEC_P: first series elements [('R101', '10k')]; min resistive path to GND = none (only via diodes/op-amp outputs)
J101.2 net /CH1/ELEC_N: first series elements [('R102', '10k')]; min resistive path to GND = none (only via diodes/op-amp outputs)
J201.1 net /CH2/ELEC_P: first series elements [('R201', '10k')]; min resistive path to GND = none (only via diodes/op-amp outputs)
J201.2 net /CH2/ELEC_N: first series elements [('R202', '10k')]; min resistive path to GND = none (only via diodes/op-amp outputs)
J301.1 net /CH3/ELEC_P: first series elements [('R301', '10k')]; min resistive path to GND = none (only via diodes/op-amp outputs)
J301.2 net /CH3/ELEC_N: first series elements [('R302', '10k')]; min resistive path to GND = none (only via diodes/op-amp outputs)
J401.1 net /CH4/ELEC_P: first series elements [('R401', '10k')]; min resistive path to GND = none (only via diodes/op-amp outputs)
J401.2 net /CH4/ELEC_N: first series elements [('R402', '10k')]; min resistive path to GND = none (only via diodes/op-amp outputs)
J5001.1: NC
J5001.2 net /Reference_VCM/RLD_SAFE: first series elements [('R5002', '100k')]; min resistive path to GND = none (only via diodes/op-amp outputs)
All connector MP pads unconnected: True
```

### K1 — 8 original electrode-protection BAV199 clamps exist: **PASS**

```
D101: pin1=GND pin2=AFE_3V0 pin3=/CH1/HIZ_P OK
D102: pin1=GND pin2=AFE_3V0 pin3=/CH1/HIZ_N OK
D201: pin1=GND pin2=AFE_3V0 pin3=/CH2/HIZ_P OK
D202: pin1=GND pin2=AFE_3V0 pin3=/CH2/HIZ_N OK
D301: pin1=GND pin2=AFE_3V0 pin3=/CH3/HIZ_P OK
D302: pin1=GND pin2=AFE_3V0 pin3=/CH3/HIZ_N OK
D401: pin1=GND pin2=AFE_3V0 pin3=/CH4/HIZ_P OK
D402: pin1=GND pin2=AFE_3V0 pin3=/CH4/HIZ_N OK
```

### K2 — 8 new ADC-input BAV199 clamps exist (pin1 GND, pin3 AIN, pin2 NC): **PASS**

```
D103: pin1=GND pin2=unconnected-(D103-K2-Pad2) pin3=/CH1_P (= U6001.3) OK
D104: pin1=GND pin2=unconnected-(D104-K2-Pad2) pin3=/CH1_N (= U6001.4) OK
D203: pin1=GND pin2=unconnected-(D203-K2-Pad2) pin3=/CH2_P (= U6001.6) OK
D204: pin1=GND pin2=unconnected-(D204-K2-Pad2) pin3=/CH2_N (= U6001.5) OK
D303: pin1=GND pin2=unconnected-(D303-K2-Pad2) pin3=/CH3_P (= U6001.7) OK
D304: pin1=GND pin2=unconnected-(D304-K2-Pad2) pin3=/CH3_N (= U6001.8) OK
D403: pin1=GND pin2=unconnected-(D403-K2-Pad2) pin3=/CH4_P (= U6001.10) OK
D404: pin1=GND pin2=unconnected-(D404-K2-Pad2) pin3=/CH4_N (= U6001.9) OK
```

### K3 — Every new ADC clamp is after the 1k series resistor: **PASS**

```
D103.3 on /CH1_P = ADC side of R107 (R107.2); R107.1 side is /CH1/ACN_P (C101.2, R103.1, R107.1) OK
D104.3 on /CH1_N = ADC side of R108 (R108.2); R108.1 side is /CH1/ACN_N (C102.2, R104.1, R108.1) OK
D203.3 on /CH2_P = ADC side of R207 (R207.2); R207.1 side is /CH2/ACN_P (C201.2, R203.1, R207.1) OK
D204.3 on /CH2_N = ADC side of R208 (R208.2); R208.1 side is /CH2/ACN_N (C202.2, R204.1, R208.1) OK
D303.3 on /CH3_P = ADC side of R307 (R307.2); R307.1 side is /CH3/ACN_P (C301.2, R303.1, R307.1) OK
D304.3 on /CH3_N = ADC side of R308 (R308.2); R308.1 side is /CH3/ACN_N (C302.2, R304.1, R308.1) OK
D403.3 on /CH4_P = ADC side of R407 (R407.2); R407.1 side is /CH4/ACN_P (C401.2, R403.1, R407.1) OK
D404.3 on /CH4_N = ADC side of R408 (R408.2); R408.1 side is /CH4/ACN_N (C402.2, R404.1, R408.1) OK
```

### K4 — ADC-side 100k returns remain GND-referenced (not VCM): **PASS**

```
R103 100k: /CH1/ACN_P -> GND OK
R104 100k: /CH1/ACN_N -> GND OK
R203 100k: /CH2/ACN_P -> GND OK
R204 100k: /CH2/ACN_N -> GND OK
R303 100k: /CH3/ACN_P -> GND OK
R304 100k: /CH3/ACN_N -> GND OK
R403 100k: /CH4/ACN_P -> GND OK
R404 100k: /CH4/ACN_N -> GND OK
```

### V1 — U503A +IN has the new 10k series protection; C5001/C5002 stay at the divider node: **PASS**

```
/Reference_VCM/VCM_BUF_IN: R5005.2, U503.3
/Reference_VCM/VCM_DIV: C5001.1, C5002.1, R5003.2, R5004.1, R5005.1
R5003 100k top=AFE_3V0; R5004 100k bottom=GND; C5001 1uF, C5002 100nF
```

### V2 — U503A is the VCM follower; B/C/D wired as VCM followers (TI unused-amp guidance, no DRL loop): **PASS**

```
U503A: OUT(1)=/VCM, -IN(2)=/VCM
U503B: +IN(5)=/VCM, -IN(6)=OUT(7)=/Reference_VCM/U503B_OUT OK
U503C: +IN(10)=/VCM, -IN(9)=OUT(8)=/Reference_VCM/U503C_OUT OK
U503D: +IN(12)=/VCM, -IN(13)=OUT(14)=/Reference_VCM/U503D_OUT OK
VCM members: 15 pins
```

### P1 — ADS AVDD = AFE_3V0, DVDD = DVDD_F, CAP = 220 nF, AGND/DGND = GND, 1 uF AVDD/DVDD decoupling: **PASS**

```
U6001.1 AVDD=AFE_3V0; U6001.20 DVDD=DVDD_F; U6001.2 AGND=GND; U6001.19 DGND=GND
/ADC/AFE_CAP: C6009.1, U6001.18 (C6009 220nF to GND)
C6007 1uF AFE_3V0/GND; C6008 1uF DVDD_F/GND
```

### P2 — ADS CLKIN comes only from X1 (33 ohm source series, 100 nF, OE tied to DVDD_F): **PASS**

```
/ADC/ADC_CLKIN: R6001.2, U6001.17
/ADC/X1_OUT: R6001.1, X1.3
X1 OT2JI-111-8.192M LCSC C7425393: OE(1)=DVDD_F GND(2)=GND VDD(4)=DVDD_F; C6010 100nF DVDD_F/GND
```

### P3 — XIAO 3V3 -> FB1 ferrite -> 10 uF + 100 nF -> DVDD_F (not from AFE_3V0): **PASS**

```
/XIAO_Brain_Interface/XIAO_3V3: FB1.1, U1.12
FB1 600R@100MHz pin2 -> DVDD_F
DVDD_F parts: ['C6008', 'C6010', 'C7101', 'C7102', 'FB1', 'R7103', 'R7104', 'TP3', 'U6001', 'X1']
```

### P4 — VBAT -> R4001 4.7 ohm -> C4007 22 uF (+C4005 1 uF) -> TPS7A2030P -> AFE_3V0: **PASS**

```
R4001 4.7: VBAT -> /Analog_Power_Interlock/VBAT_AFE
/Analog_Power_Interlock/VBAT_AFE: C4005.1, C4007.1, R4001.2, U4002.1
U4002 TPS7A2030PDBVR: IN=/Analog_Power_Interlock/VBAT_AFE GND=GND EN=/Analog_Power_Interlock/AFE_EN NC(4)=unconnected-(U4002-NC-Pad4) OUT=AFE_3V0; C4006 1uF AFE_3V0/GND
```

### P5 — AFE_3V0 powers ADS AVDD, TLV9064 x3, VCM divider and the 8 hi-Z clamp rails only: **PASS**

```
AFE_3V0 parts: ['C4006', 'C501', 'C502', 'C503', 'C6007', 'D101', 'D102', 'D201', 'D202', 'D301', 'D302', 'D401', 'D402', 'R5003', 'TP2', 'U4002', 'U501', 'U502', 'U503', 'U6001']
```

### P6 — XIAO BAT+ post (U1 pad 23) = VBAT; J1 pin 1 = VBAT (star), pin 2 = GND; BAT- via castellation 13: **PASS**

```
U1.23 (BAT+ POST) -> VBAT; J1.1 -> VBAT; J1.2 -> GND; U1.13 -> GND
VBAT parts: ['J1', 'R4001', 'R7107', 'TP1', 'U1']
```

### I1 — AFE_EN has an external pull-down: **PASS**

```
/Analog_Power_Interlock/AFE_EN: Q3001.3, R3007.2, R3008.1, TP6.1, U4002.3
R3008 100k: /Analog_Power_Interlock/AFE_EN -> GND
```

### I2 — USB VBUS (XIAO 5V) hardware can force AFE_EN low via Q3001: **PASS**

```
Q3001 2N7002: D(3)=/Analog_Power_Interlock/AFE_EN S(2)=GND G(1)=/Analog_Power_Interlock/VBUS_GATE
/Analog_Power_Interlock/VBUS_GATE: Q3001.1, R3004.1, R3006.2
/XIAO_5V: R3006.1, R3009.1, R7105.1, U1.14
Gate with USB 5.0 V: 5.0 x 100k/(10k+100k) = 4.55 V (VGS(th) max 2.5 V)
```

### I3 — XIAO D3 cannot override the VBUS inhibit: **PASS**

```
/AFE_EN_REQ: R3007.1, U1.4 (D3 reaches AFE_EN only through R3007 10k)
USB present + D3 = 3.3 V: AFE_EN = 3.3 x Rds(on)/(10k + Rds(on)) = 2.5 mV with Rds(on) = 7.5 ohm (2N7002 max class value) << TPS7A20 VEN(LOW) 0.3 V. D3 source current 0.33 mA
```

### I4 — XIAO absent / unpowered leaves the AFE disabled: **PASS**

```
Nets resistively reachable from AFE_EN with U1 removed: ['/AFE_EN_REQ', '/Analog_Power_Interlock/AFE_EN', 'GND']
Supply rails reachable: none; active parts: ['Q3001'] (Q3001 gate then sits on R3004 100k -> GND = off)
=> AFE_EN = 0 V through R3008 100k (+ TPS7A20 internal 500k) -> EN < 0.3 V -> LDO off, 150 ohm output discharge
```

### I5 — D6 (USB_PRESENT) is not part of the safety control path: **PASS**

```
/XIAO_Brain_Interface/USB_PRESENT: R7105.2, R7106.1, U1.7
D6 net is not AFE_EN / VBUS_GATE / AFE_EN_REQ. Worst-case coupling: D6 (GPIO43 UART TX) driven high with USB absent lifts XIAO_5V via 100k into 4.7k||(10k+100k) -> VBUS_GATE ~ 129 mV (< 0.8 V VGS(th) min, and would only ever inhibit). With USB present, XIAO_5V is source-driven; D6 cannot pull the gate below 4.5 V.
```

### I6 — 4.7k XIAO 5V/VBUS load (RB-00.5): **PASS**

```
R3009 4.7k: /XIAO_5V -> GND
```

### X1 — XIAO interface mapping (15 electrical pads: 14 castellations + BAT+ post), U1 DNP: **PASS**

```
U1.1 D0        -> /XIAO_Brain_Interface/VBAT_SENSE OK
U1.2 D1        -> /DRDY_N OK
U1.3 D2        -> /SYNC_RESET_N OK
U1.4 D3        -> /AFE_EN_REQ OK
U1.5 D4        -> unconnected-(U1-D4/GPIO5/SDA-Pad5) OK
U1.6 D5        -> unconnected-(U1-D5/GPIO6/SCL-Pad6) OK
U1.7 D6        -> /XIAO_Brain_Interface/USB_PRESENT OK
U1.8 D7        -> /CS_N OK
U1.9 D8        -> /XIAO_Brain_Interface/SCLK_MCU OK
U1.10 D9        -> /MISO OK
U1.11 D10       -> /XIAO_Brain_Interface/MOSI_MCU OK
U1.12 3V3       -> /XIAO_Brain_Interface/XIAO_3V3 OK
U1.13 GND       -> GND OK
U1.14 5V        -> /XIAO_5V OK
U1.23 BAT+ post -> VBAT OK
U1 pads present in netlist: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '23']; DNP property set: True; footprint ARTHUR:XIAO_ESP32S3_HANDSOLDER
```

### S1 — SPI conditioning: 33 ohm SCLK/MOSI (XIAO end), 33 ohm MISO (ADC end), 100 ohm DRDY, CS_N/SYNC pull-ups to DVDD_F: **PASS**

```
SCLK: U1.9 -> R7101 33 ohm -> R7101.2, U6001.14 OK
MOSI: U1.11 -> R7102 33 ohm -> R7102.2, U6001.16 OK
MISO: U6001.15 -> R6002 33 ohm -> R6002.2, U1.10 OK
DRDY: U6001.13 -> R6003 100 ohm -> R6003.2, U1.2 OK
CS_N: pull-up R7103 100k to DVDD_F; net /CS_N: R7103.2, U1.8, U6001.12 OK
SYNC/RESET_N: pull-up R7104 10k to DVDD_F; net /SYNC_RESET_N: R7104.2, U1.3, U6001.11 OK
```

### B1 — VBAT_SENSE divider 1M/1M + 100 nF -> D0 (labelled VBAT_SENSE): **PASS**

```
/XIAO_Brain_Interface/VBAT_SENSE: C7103.1, R7107.2, R7108.1, U1.1; R7107 1M from VBAT; R7108 1M to GND; C7103 100nF; draw = 4.2 V / 2 Mohm = 2.1 uA
```

### B2 — USB_PRESENT divider XIAO 5V -> 100k -> D6 -> 150k -> GND (sense only): **PASS**

```
R7105 100k: /XIAO_5V -> /XIAO_Brain_Interface/USB_PRESENT; R7106 150k: /XIAO_Brain_Interface/USB_PRESENT -> GND; D6 = 5.0 x 150/250 = 3.0 V
```

### T1 — Test-point policy: only VBAT, AFE_3V0, DVDD_F, VCM, RLD_SAFE, AFE_EN, GND x2; none on hi-Z / AIN / SPI / CLKIN: **PASS**

```
TP1 (VBAT) -> VBAT OK; excluded from BOM: True
TP2 (AFE_3V0) -> AFE_3V0 OK; excluded from BOM: True
TP3 (DVDD_F) -> DVDD_F OK; excluded from BOM: True
TP4 (VCM) -> /VCM OK; excluded from BOM: True
TP5 (RLD_SAFE) -> /Reference_VCM/RLD_SAFE OK; excluded from BOM: True
TP6 (AFE_EN) -> /Analog_Power_Interlock/AFE_EN OK; excluded from BOM: True
TP7 (GND) -> GND OK; excluded from BOM: True
TP8 (GND) -> GND OK; excluded from BOM: True
Test pads on forbidden nets (33 nets scanned): none
```

### D1 — Removed Rev A subsystems are absent: **PASS**

```
Q3002 absent: OK
R3005 absent: OK
no MDBT50Q / U7001: OK
no BQ24074 (U2001): OK
no TPS63031 (U4001/L4001): OK
no USB-C connector (J3001): OK
no USB CC resistors (R3001/R3002): OK
no USB data / ESD network (U3001, USB_D+/-): OK
no SWD connector (J8001, SWDIO/SWDCLK): OK
no charger-status nets (CHG_N, PGOOD_N, PACK_NTC, ISET, ILIM): OK
no obsolete Rev A test points (TP111..TP412, TP601..TP610, TP201, TP401, TP402): OK
no ADS1294-era circuitry (ADS1294, LVC1G125, VREFP, VCAP, RLDINV, RLDOUT, WCT): OK
no Rev A AFE_ENABLE pull-up (R3003) / no nRF clock: OK
```

### L1 — Every component has value, footprint, datasheet, description and MPN field: **PASS**

```
all 135 components carry value/footprint/datasheet/description/MPN
Intentional NC pins (each has an explicit no-connect flag in the schematic): D103.2, D104.2, D203.2, D204.2, D303.2, D304.2, D403.2, D404.2, J1.MP, J101.MP, J201.MP, J301.MP, J401.MP, J5001.1, J5001.MP, U1.5, U1.6, U4002.4
```

## Appendix — complete netlist (net → pins)

| Net | Pins | Members |
|---|---|---|
| `/ADC/ADC_CLKIN` | 2 | R6001.2, U6001.17 |
| `/ADC/ADC_DOUT` | 2 | R6002.1, U6001.15 |
| `/ADC/ADC_DRDY_N` | 2 | R6003.1, U6001.13 |
| `/ADC/AFE_CAP` | 2 | C6009.1, U6001.18 |
| `/ADC/X1_OUT` | 2 | R6001.1, X1.3 |
| `/AFE_EN_REQ` | 2 | R3007.1, U1.4 |
| `/Analog_Power_Interlock/AFE_EN` | 5 | Q3001.3, R3007.2, R3008.1, TP6.1, U4002.3 |
| `/Analog_Power_Interlock/VBAT_AFE` | 4 | C4005.1, C4007.1, R4001.2, U4002.1 |
| `/Analog_Power_Interlock/VBUS_GATE` | 3 | Q3001.1, R3004.1, R3006.2 |
| `/CH1/ACN_N` | 3 | C102.2, R104.1, R108.1 |
| `/CH1/ACN_P` | 3 | C101.2, R103.1, R107.1 |
| `/CH1/BUF_N` | 3 | C102.1, U501.6, U501.7 |
| `/CH1/BUF_P` | 3 | C101.1, U501.1, U501.2 |
| `/CH1/ELEC_N` | 2 | J101.2, R102.1 |
| `/CH1/ELEC_P` | 2 | J101.1, R101.1 |
| `/CH1/HIZ_N` | 5 | C104.1, D102.3, R102.2, R106.2, U501.5 |
| `/CH1/HIZ_P` | 5 | C103.1, D101.3, R101.2, R105.2, U501.3 |
| `/CH1_N` | 5 | C105.2, C107.1, D104.3, R108.2, U6001.4 |
| `/CH1_P` | 5 | C105.1, C106.1, D103.3, R107.2, U6001.3 |
| `/CH2/ACN_N` | 3 | C202.2, R204.1, R208.1 |
| `/CH2/ACN_P` | 3 | C201.2, R203.1, R207.1 |
| `/CH2/BUF_N` | 3 | C202.1, U501.13, U501.14 |
| `/CH2/BUF_P` | 3 | C201.1, U501.8, U501.9 |
| `/CH2/ELEC_N` | 2 | J201.2, R202.1 |
| `/CH2/ELEC_P` | 2 | J201.1, R201.1 |
| `/CH2/HIZ_N` | 5 | C204.1, D202.3, R202.2, R206.2, U501.12 |
| `/CH2/HIZ_P` | 5 | C203.1, D201.3, R201.2, R205.2, U501.10 |
| `/CH2_N` | 5 | C205.2, C207.1, D204.3, R208.2, U6001.5 |
| `/CH2_P` | 5 | C205.1, C206.1, D203.3, R207.2, U6001.6 |
| `/CH3/ACN_N` | 3 | C302.2, R304.1, R308.1 |
| `/CH3/ACN_P` | 3 | C301.2, R303.1, R307.1 |
| `/CH3/BUF_N` | 3 | C302.1, U502.6, U502.7 |
| `/CH3/BUF_P` | 3 | C301.1, U502.1, U502.2 |
| `/CH3/ELEC_N` | 2 | J301.2, R302.1 |
| `/CH3/ELEC_P` | 2 | J301.1, R301.1 |
| `/CH3/HIZ_N` | 5 | C304.1, D302.3, R302.2, R306.2, U502.5 |
| `/CH3/HIZ_P` | 5 | C303.1, D301.3, R301.2, R305.2, U502.3 |
| `/CH3_N` | 5 | C305.2, C307.1, D304.3, R308.2, U6001.8 |
| `/CH3_P` | 5 | C305.1, C306.1, D303.3, R307.2, U6001.7 |
| `/CH4/ACN_N` | 3 | C402.2, R404.1, R408.1 |
| `/CH4/ACN_P` | 3 | C401.2, R403.1, R407.1 |
| `/CH4/BUF_N` | 3 | C402.1, U502.13, U502.14 |
| `/CH4/BUF_P` | 3 | C401.1, U502.8, U502.9 |
| `/CH4/ELEC_N` | 2 | J401.2, R402.1 |
| `/CH4/ELEC_P` | 2 | J401.1, R401.1 |
| `/CH4/HIZ_N` | 5 | C404.1, D402.3, R402.2, R406.2, U502.12 |
| `/CH4/HIZ_P` | 5 | C403.1, D401.3, R401.2, R405.2, U502.10 |
| `/CH4_N` | 5 | C405.2, C407.1, D404.3, R408.2, U6001.9 |
| `/CH4_P` | 5 | C405.1, C406.1, D403.3, R407.2, U6001.10 |
| `/CS_N` | 3 | R7103.2, U1.8, U6001.12 |
| `/DRDY_N` | 2 | R6003.2, U1.2 |
| `/MISO` | 2 | R6002.2, U1.10 |
| `/MOSI` | 2 | R7102.2, U6001.16 |
| `/Reference_VCM/RLD_SAFE` | 3 | J5001.2, R5002.2, TP5.1 |
| `/Reference_VCM/U503B_OUT` | 2 | U503.6, U503.7 |
| `/Reference_VCM/U503C_OUT` | 2 | U503.8, U503.9 |
| `/Reference_VCM/U503D_OUT` | 2 | U503.13, U503.14 |
| `/Reference_VCM/VCM_BUF_IN` | 2 | R5005.2, U503.3 |
| `/Reference_VCM/VCM_DIV` | 5 | C5001.1, C5002.1, R5003.2, R5004.1, R5005.1 |
| `/SCLK` | 2 | R7101.2, U6001.14 |
| `/SYNC_RESET_N` | 3 | R7104.2, U1.3, U6001.11 |
| `/VCM` | 15 | R105.1, R106.1, R205.1, R206.1, R305.1, R306.1, R405.1, R406.1, R5002.1, TP4.1, U503.1, U503.10, U503.12, U503.2, U503.5 |
| `/XIAO_5V` | 4 | R3006.1, R3009.1, R7105.1, U1.14 |
| `/XIAO_Brain_Interface/MOSI_MCU` | 2 | R7102.1, U1.11 |
| `/XIAO_Brain_Interface/SCLK_MCU` | 2 | R7101.1, U1.9 |
| `/XIAO_Brain_Interface/USB_PRESENT` | 3 | R7105.2, R7106.1, U1.7 |
| `/XIAO_Brain_Interface/VBAT_SENSE` | 4 | C7103.1, R7107.2, R7108.1, U1.1 |
| `/XIAO_Brain_Interface/XIAO_3V3` | 2 | FB1.1, U1.12 |
| `AFE_3V0` | 20 | C4006.1, C501.1, C502.1, C503.1, C6007.1, D101.2, D102.2, D201.2, D202.2, D301.2, D302.2, D401.2, D402.2, R5003.1, TP2.1, U4002.5, U501.4, U502.4, U503.4, U6001.1 |
| `DVDD_F` | 11 | C6008.1, C6010.1, C7101.1, C7102.1, FB1.2, R7103.1, R7104.1, TP3.1, U6001.20, X1.1, X1.4 |
| `GND` | 73 | C103.2, C104.2, C106.2, C107.2, C203.2, C204.2, C206.2, C207.2, C303.2, C304.2, C306.2, C307.2, C4005.2, C4006.2, C4007.2, C403.2, C404.2, C406.2, C407.2, C5001.2, C5002.2, C501.2, C502.2, C503.2, C6007.2, C6008.2, C6009.2, C6010.2, C7101.2, C7102.2, C7103.2, D101.1, D102.1, D103.1, D104.1, D201.1, D202.1, D203.1, D204.1, D301.1, D302.1, D303.1, D304.1, D401.1, D402.1, D403.1, D404.1, J1.2, Q3001.2, R103.2, R104.2, R203.2, R204.2, R3004.2, R3008.2, R3009.2, R303.2, R304.2, R403.2, R404.2, R5004.2, R7106.2, R7108.2, TP7.1, TP8.1, U1.13, U4002.2, U501.11, U502.11, U503.11, U6001.19, U6001.2, X1.2 |
| `VBAT` | 5 | J1.1, R4001.1, R7107.1, TP1.1, U1.23 |
| `unconnected-(D103-K2-Pad2)` | 1 | D103.2 |
| `unconnected-(D104-K2-Pad2)` | 1 | D104.2 |
| `unconnected-(D203-K2-Pad2)` | 1 | D203.2 |
| `unconnected-(D204-K2-Pad2)` | 1 | D204.2 |
| `unconnected-(D303-K2-Pad2)` | 1 | D303.2 |
| `unconnected-(D304-K2-Pad2)` | 1 | D304.2 |
| `unconnected-(D403-K2-Pad2)` | 1 | D403.2 |
| `unconnected-(D404-K2-Pad2)` | 1 | D404.2 |
| `unconnected-(J1-PadMP)` | 1 | J1.MP |
| `unconnected-(J101-PadMP)` | 1 | J101.MP |
| `unconnected-(J201-PadMP)` | 1 | J201.MP |
| `unconnected-(J301-PadMP)` | 1 | J301.MP |
| `unconnected-(J401-PadMP)` | 1 | J401.MP |
| `unconnected-(J5001-Pad1)` | 1 | J5001.1 |
| `unconnected-(J5001-PadMP)` | 1 | J5001.MP |
| `unconnected-(U1-D4/GPIO5/SDA-Pad5)` | 1 | U1.5 |
| `unconnected-(U1-D5/GPIO6/SCL-Pad6)` | 1 | U1.6 |
| `unconnected-(U4002-NC-Pad4)` | 1 | U4002.4 |
