# ARTHUR EMG Rev A - Power Budget

Assumes: 1S LiPo 500mAh (assumption, MPN TBD); USB500 input (475mA typ); BQ24074 DPPM; TPS63031 3.3V; TPS7A2030 3.0V AFE rail.
Sources: BQ24074/TPS63031/TPS7A20/ADS1294 datasheets (this-pass extraction) + nRF52840-class radio figures (order-of-magnitude; confirm from Nordic PS at order).

## Rails and loads (typical / peak)

| Load | Rail | Typ | Peak | Notes |
|---|---|---|---|---|
| ADS1294 analog (4ch, HR, 2kSPS) | AFE_3V0 | 3mA | 5mA | 0.75mW/ch class + ref/RLD buffers |
| ADS1294 digital | 3V3 | 1mA | 3mA | SPI/clock dependent |
| nRF52840 MCU run + BLE adv/conn | 3V3 | 8mA avg | 15mA radio TX peak (0dBm class; +8dBm higher, confirm) | TX peaks are ms-class; bulk caps cover |
| TPS7A20 quiescent + losses | SYS/3V3 | 0.5mA | 1mA | LDO GND pin + headroom loss |
| TPS63031 quiescent + switching loss | SYS_RAW | 1mA | 5mA equiv | <50uA Iq class + efficiency 85-90% at light load |
| Charger status/dividers/leakage | SYS/USB | 0.5mA | 1mA | PGOOD/CHG pull-ups, TS bias |
| Buffers 6x LVC1G125 static | AFE_3V0 | 0.06mA | 0.5mA dyn | negligible static |
| Total system (battery-powered, BLE connected) | — | ~14mA | ~30mA + TX peaks | |

## Regulator headroom

- TPS7A2030: load ~4-6mA vs 300mA rating (~50x). Dissipation (3.3-3.0)x6mA ~= 2mW. Fine.
- TPS63031: average input ~15-20mA (batt) vs 500mA+ capability; TX-peak + ADC simultaneous << limit. Bulk 2x10uF + 1uF HF covers transient.
- Battery life (estimate, not a guarantee): 500mAh / 14mA ~= 35h advertising-connected idle-class; gesture-streaming + TX duty raises average — measure at bring-up.

## USB500 allocation (electrodes OFF, charging allowed)

- Input limit 500mA (RILIM 3.24k). DPPM prioritizes SYS_RAW; charge tapers as system load rises.
- Charge 250mA (RISET 3.57k, 0.5C) + system 30mA peak << 475mA typ input. Simultaneous full-TX + full-charge is safe by DPPM foldback.
- ITERM default 10% (~25mA). Timers default (TMR open).

## Operating-range checks

- TPS63031 startup >=1.8V typ: battery 3.0V cut-off and USB 5V both start. Battery below 3.0V is cut off by use policy (no deep-discharge operation).
- TPS7A20: 3.3V->3.0V headroom 300mV >> dropout at 6mA (tens of mV class). PSRR 95dB@1kHz class cleans buck-boost ripple for AFE.
- BQ24074: IN 5V USB; OUT tracks battery+; thermal regulation at 125C junction folds back charge (layout thermal rule).
