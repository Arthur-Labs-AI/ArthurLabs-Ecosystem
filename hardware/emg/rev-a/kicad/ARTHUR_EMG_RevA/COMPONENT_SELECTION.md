# ARTHUR EMG Rev A - Component Selection (freeze)

Footprints are JLCPCB-basic-flow compatible: 0603/0805 passives, SOT-23/SOT-23-5, VQFN-16, DSK-10, SOT-23-5 LDO, TQFP-64 ADC, module LCC castellations. Verify every footprint against the chosen MPN datasheet at layout (court/yard + paste).

## Frozen values (new Rev A decisions)

| Ref | Value | Example MPN class | Footprint | DNP | Source |
|---|---|---|---|---|---|
| R101/R102 (x4 ch) | 2.2k 1% | RC0603FR-072K2L-class | 0603 | No | EMG front-end calc (Sec 2) |
| R103/R104 (x4 ch) | 390k 1% | RC0603FR-07390KL-class | 0603 | No | bias calc |
| C101 (x4 ch) | 4.7nF C0G 50V | GCM1885C1H472JA16-class | 0603 | No | diff-pole calc |
| C_CM (x4 ch, 2/ch) | 470pF C0G 50V | GCM1885C1H471JA16-class | 0603 | YES (RFI option) | RFI plan |
| D1xx (x4 ch) | dual TVS 3.3V VRWM | PESD3V3S1UL / SP0502BA-class | SOT-23-3L | YES | protection option |
| R_RLD_SAFETY | 100k 1% | RC0805FR-07100KL-class (HV/long-creepage pref) | 0805 | No | Sec 3 (NOT a 60601 finding) |
| R_RLD_FB / C_RLD_FB | 1M 1% / 1.5nF C0G | 0603 | No | ADS129x Fig 94 class |
| R_ISET | 3.57k 1% | RC0603FR-073K57L-class | 0603 | No | KISET=890 typ, 250mA |
| R_ILIM | 3.24k 1% | RC0603FR-073K24L-class | 0603 | No | KILIM=1610 typ, 500mA |
| TS | 10k NTC (cell) | 103AT-4/B3435-class in battery pack | pack | No | BQ24074 TS |
| R_ENABLE (AFE pull-up) | 100k 1% | RC0603-class | 0603 | No | interlock pull-up (new) |
| R_GATE (VBUS discharge) | 100k 1% | RC0603-class | 0603 | No | gate bleed (new) |
| NMOS interlock | 2N7002-class | 2N7002-7-F-class | SOT-23 | No | AFE_DISABLE |
| U9xx buffers x6 | SN74LVC1G125-class | SN74LVC1G125DBVR-class | SOT-23-5 | No | Ioff back-power fix |
| AFE_PWR_GOOD divider | REMOVED (Audit 1) | - | - | - | buffer OE tied GND; 1.5 V divider violates VIH/VIL, deleted from design |

## Retained architecture parts (verify live stock at order - BLOCKER)

| Part | MPN | Package | Notes |
|---|---|---|---|
| ADC | ADS1294IPAG | TQFP-64 | TI |
| Charger | BQ24074RGTR | VQFN-16 | TI |
| Buck-boost | TPS63031DSKR | DSK-10 | fixed 3.3V |
| LDO | TPS7A2030PDBVR | SOT-23-5 | fixed 3.0V |
| ESD | TPD4E05U06DQAR | WSON-10 | USB |
| MCU | MDBT50Q-1MV2 (KEEP; vs 1MEN: keep 1MV2 for pin-contract/antenna/stock continuity) | LCC module | Raytac/nRF52840 |
| L 1.5uH | 1.5uH shielded, Isat>1.5A | 2520/1008-class | TPS63031 typical |
| USB-C | 16p USB2 receptacle, shell TBD | USB-C-16 | shield TBD |
| LiPo conn | 3-pin JST-class + NTC | TBD | keying TBD |
| EMG conn x4 | bipolar keyed | TBD | keying TBD |
| RLD conn | single + GND | TBD | keying TBD |
| SWD | 10-pin Cortex 1.27mm | SMD-10 | J8001 |

## DNP / config table

- C_CM (all channels), D1xx TVS (all channels): DNP at first build.
- WCT/TEST/GPIO: unconnected spares.
- ITERM/TMR: open (default termination/timers).
- P0.22 AFE_DISABLE_REQ: reserved, unconnected.
- Cell MPN, NTC curve doc, PCM, connector keying: BLOCKERS, not frozen.
